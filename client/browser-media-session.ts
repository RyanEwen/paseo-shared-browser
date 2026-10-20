/** WebRTC reader lifecycle, separate from decode/paint and existing input ownership. */

import type { BrowserState } from "../shared/browser";
import {
  type BrowserMediaSource,
  browserMediaSourceSchema,
  isBrowserMediaSourceCurrent,
  type OpenBrowserMediaInput,
  type OpenBrowserMediaReply,
  type PollBrowserMediaInput,
  type PollBrowserMediaReply,
} from "../shared/browser-media";
import {
  BROWSER_MEDIA_PROTOCOL,
  writeBrowserMediaObservationEpoch,
} from "../shared/browser-media-wire";
import type {
  BrowserVideoMetadata,
  BrowserVideoPicture,
  BrowserVideoReadReply,
} from "../shared/browser-video";
import { createBrowserMediaReceiver } from "./browser-media-receiver";

export interface BrowserMediaClientChannel {
  binaryType: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(bytes: Uint8Array): void;
  close(): void;
  addEventListener(type: string, callback: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, callback: (event: { data?: unknown }) => void): void;
}
export interface BrowserMediaClientPeer {
  readonly localDescription: { sdp: string } | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  createDataChannel(
    label: string,
    options: { negotiated: true; id: 0; ordered: false; maxRetransmits: 0; protocol: string },
  ): BrowserMediaClientChannel;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  addEventListener(type: string, callback: () => void): void;
  removeEventListener(type: string, callback: () => void): void;
  close(): void;
}
export interface BrowserMediaClientEnvironment {
  createPeer(): BrowserMediaClientPeer;
  now(): number;
}
export interface BrowserMediaReaderOptions {
  environment: BrowserMediaClientEnvironment;
  viewerToken: string;
  source(): BrowserState | null;
  epoch(): number;
  bitrate: OpenBrowserMediaInput["bitrate"];
  fps: OpenBrowserMediaInput["fps"];
  isSourceCurrent(packet: BrowserVideoMetadata): boolean;
  open(input: OpenBrowserMediaInput): Promise<OpenBrowserMediaReply>;
  poll(input: PollBrowserMediaInput): Promise<PollBrowserMediaReply>;
  close(input: PollBrowserMediaInput): Promise<unknown>;
}
export interface BrowserMediaRead {
  reply: Omit<BrowserVideoReadReply, "packets"> & { packets: BrowserVideoPicture[] };
  observationEpoch: number;
}

/** Own a single source incarnation. The reader wrapper replaces it only after a
 * reset state has reached the panel. Late signaling completion closes its original
 * remote ID and cannot attach another viewer or restore discarded packets. */
function createSession(
  options: BrowserMediaReaderOptions,
  source: BrowserMediaSource,
  initial: BrowserState,
) {
  const peer = options.environment.createPeer(),
    channel = peer.createDataChannel("shared-browser-media", {
      negotiated: true,
      id: 0,
      ordered: false,
      maxRetransmits: 0,
      protocol: BROWSER_MEDIA_PROTOCOL,
    });
  channel.binaryType = "arraybuffer";
  let closed = false,
    failure: Error | null = null,
    state = initial,
    transportId: string | null = null;
  let terminal: BrowserMediaRead["reply"] | null = null,
    queued: { packet: BrowserVideoPicture; epoch: number } | null = null;
  let streamId: string | null = null,
    lastPoll = options.environment.now(),
    sentEpoch = -1;
  let pollTimer: ReturnType<typeof setTimeout> | null = null,
    polling: Promise<void> | null = null;
  let remoteClose: Promise<void> | null = null;
  const wakeups = new Set<() => void>();
  const wake = () => {
    for (const callback of wakeups) callback();
    wakeups.clear();
  };
  const assertOpen = () => {
    if (closed) throw new Error("Media viewer ended");
  };
  const fail = (error: unknown) => {
    if (closed) return;
    failure = error instanceof Error ? error : new Error("PyroWave media is unavailable");
    wake();
  };
  const send = (bytes: Uint8Array) => {
    if (closed || failure || channel.readyState !== "open") return;
    if (channel.bufferedAmount > 4096) {
      fail(new Error("Media acknowledgements are congested"));
      return;
    }
    try {
      channel.send(bytes);
    } catch {
      fail(new Error("Media channel ended"));
    }
  };
  const setEpoch = (epoch: number) => {
    if (epoch === sentEpoch || closed || failure || channel.readyState !== "open") return;
    send(writeBrowserMediaObservationEpoch(epoch));
    sentEpoch = epoch;
  };
  const receiver = createBrowserMediaReceiver({
    now: options.environment.now,
    isCurrent: (packet) =>
      !closed &&
      !failure &&
      options.isSourceCurrent(packet) &&
      packet.codec === "pyrowave" &&
      packet.frame.sessionId === source.sessionId &&
      packet.frame.runtimeId === source.runtimeId &&
      packet.frame.captureEpoch === source.bridgeEpoch &&
      packet.frame.navigationGeneration === source.navigationGeneration &&
      packet.frame.viewportGeneration === source.viewportGeneration &&
      packet.frame.width === packet.width &&
      packet.frame.height === packet.height,
    onPicture: (packet, epoch) => {
      queued = { packet, epoch };
      streamId = packet.streamId;
      wake();
    },
    sendCredit: send,
  });
  channel.addEventListener("message", (event) => {
    if (closed || failure) return;
    try {
      if (!(event.data instanceof ArrayBuffer)) throw new Error("Invalid binary media message");
      receiver.receive(new Uint8Array(event.data));
    } catch (error) {
      fail(error);
    }
  });
  channel.addEventListener("open", () => {
    setEpoch(options.epoch());
    wake();
  });
  channel.addEventListener("close", () => fail(new Error("PyroWave media disconnected")));
  channel.addEventListener("error", () => fail(new Error("PyroWave media disconnected")));
  peer.addEventListener("connectionstatechange", () => {
    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "disconnected" ||
      peer.connectionState === "closed"
    )
      fail(new Error("PyroWave media disconnected"));
  });

  /** One owned deadline per wait, canceled on settlement or local closure. */
  const wait = async (predicate: () => boolean, milliseconds: number) => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        if (!closed && !predicate()) return;
        cleanup();
        resolve();
      };
      const changed = () => done();
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Media connection timed out"));
      }, milliseconds);
      const cleanup = () => {
        clearTimeout(timer);
        wakeups.delete(done);
        peer.removeEventListener("icegatheringstatechange", changed);
      };
      wakeups.add(done);
      peer.addEventListener("icegatheringstatechange", changed);
      done();
    });
    assertOpen();
  };
  const poll = (): Promise<void> => {
    if (polling) return polling;
    const operation = (async () => {
      if (closed || !transportId) return;
      // The media channel intentionally has no retransmissions. Carry the
      // latest epoch on the existing reliable heartbeat as well, so one lost
      // fast-path update cannot leave future input observations stale forever.
      const reply = await options.poll({
        viewerToken: options.viewerToken,
        transportId,
        observationEpoch: options.epoch(),
      });
      if (closed) return;
      state = reply.state;
      lastPoll = options.environment.now();
      if (!isBrowserMediaSourceCurrent(source, state))
        terminal = { state, status: "reset", streamId: null, packets: [] };
      else if (reply.status === "unsupported")
        terminal = {
          state,
          status: "unsupported",
          streamId: null,
          packets: [],
          reason: reply.reason ?? "PyroWave media is unavailable",
        };
      else if (reply.status === "reset")
        failure = new Error(reply.reason ?? "PyroWave media ended");
      wake();
    })();
    polling = operation;
    void operation
      .finally(() => {
        if (polling === operation) polling = null;
      })
      .catch(() => {});
    return operation;
  };
  const schedulePoll = () => {
    if (closed || terminal) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void (async () => {
        try {
          await poll();
        } catch (error) {
          fail(error);
        } finally {
          schedulePoll();
        }
      })();
    }, 750);
  };
  const closeRemote = (): Promise<void> => {
    if (!transportId) return Promise.resolve();
    remoteClose ??= options.close({ viewerToken: options.viewerToken, transportId }).then(
      () => undefined,
      () => undefined,
    );
    return remoteClose;
  };
  const start = (async () => {
    const gathered = wait(() => peer.iceGatheringState === "complete", 5000);
    try {
      const offer = await peer.createOffer();
      assertOpen();
      await peer.setLocalDescription(offer);
      await gathered;
      assertOpen();
    } catch (error) {
      void gathered.catch(() => {});
      throw error;
    }
    const offer = peer.localDescription?.sdp;
    if (!offer) throw new Error("Media offer is unavailable");
    const opened = await options.open({
      viewerToken: options.viewerToken,
      source,
      offer,
      observationEpoch: options.epoch(),
      bitrate: options.bitrate,
      fps: options.fps,
    });
    transportId = opened.transportId;
    state = opened.state;
    lastPoll = options.environment.now();
    if (closed) {
      await closeRemote();
      assertOpen();
    }
    if (opened.status !== "ready" || !opened.answer || !transportId) {
      terminal = {
        state,
        status: opened.status === "reset" ? "reset" : "unsupported",
        streamId: null,
        packets: [],
        ...(opened.reason ? { reason: opened.reason } : {}),
      };
      wake();
      return;
    }
    schedulePoll();
    await peer.setRemoteDescription({ type: "answer", sdp: opened.answer });
    assertOpen();
    await wait(() => channel.readyState === "open" || failure !== null, 8000);
    if (failure) throw failure;
    setEpoch(options.epoch());
  })();
  void start.catch(fail);
  return {
    async read(): Promise<BrowserMediaRead> {
      await start;
      assertOpen();
      setEpoch(options.epoch());
      if (failure && !terminal) {
        try {
          await poll();
        } catch {
          /* The original bounded failure remains the viewing reason. */
        }
      }
      if (terminal) return { reply: terminal, observationEpoch: options.epoch() };
      if (failure) throw failure;
      if (!queued)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wakeups.delete(done);
            resolve();
          };
          const timer = setTimeout(done, 250);
          wakeups.add(done);
        });
      assertOpen();
      if (failure && !terminal) {
        try {
          await poll();
        } catch {
          /* A genuine source reset may still be reconciled by the original poll. */
        }
      }
      if (terminal) return { reply: terminal, observationEpoch: options.epoch() };
      if (failure) throw failure;
      if (options.environment.now() - lastPoll > 2000)
        throw new Error("Media heartbeat is unavailable");
      const picture = queued;
      queued = null;
      return {
        reply: {
          state,
          status: picture ? "ready" : "waiting",
          streamId,
          packets: picture ? [picture.packet] : [],
        },
        observationEpoch: picture?.epoch ?? options.epoch(),
      };
    },
    presented: (packet: BrowserVideoMetadata) => receiver.presented(packet),
    setEpoch,
    async close() {
      if (!closed) {
        closed = true;
        if (pollTimer !== null) clearTimeout(pollTimer);
        receiver.close();
        queued = null;
        wake();
        try {
          channel.close();
        } catch {
          /* Peer cleanup must continue. */
        }
        try {
          peer.close();
        } catch {
          /* Remote cleanup must continue. */
        }
      }
      await start.catch(() => {});
      await closeRemote();
    },
  };
}

/** Single-flight reader. A source reset is returned before a new source is opened,
 * letting the existing panel commit its new authority before fresh decode starts. */
export function createBrowserMediaReader(options: BrowserMediaReaderOptions) {
  let active: ReturnType<typeof createSession> | null = null,
    closed = false;
  return {
    async read(): Promise<BrowserMediaRead> {
      if (closed) throw new Error("Media reader ended");
      if (!active) {
        const state = options.source();
        if (!state) throw new Error("Browser source is unavailable");
        active = createSession(options, browserMediaSourceSchema.parse(state), state);
      }
      const session = active;
      try {
        const result = await session.read();
        if (result.reply.status === "reset" || result.reply.status === "unsupported") {
          if (active === session) active = null;
          await session.close();
        }
        return result;
      } catch (error) {
        if (active === session) active = null;
        await session.close();
        throw error;
      }
    },
    presented: (packet: BrowserVideoMetadata) => active?.presented(packet),
    setEpoch: (epoch: number) => active?.setEpoch(epoch),
    async close() {
      closed = true;
      const session = active;
      active = null;
      await session?.close();
    },
  };
}
