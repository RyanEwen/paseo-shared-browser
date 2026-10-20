/** One scoped WebRTC peer. Authenticated Paseo RPC owns signaling, not this socket. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  BROWSER_MEDIA_MESSAGE_BYTES,
  BROWSER_MEDIA_PROTOCOL,
  readBrowserMediaObservationEpoch,
  writeBrowserMediaObservationEpoch,
} from "../shared/browser-media-wire";
import type { BrowserVideoMetadata } from "../shared/browser-video";
import { type BrowserMediaChannel, createBrowserMediaSender } from "./browser-media-sender";

export interface NativeMediaChannel extends BrowserMediaChannel {
  close(): void;
  onOpen(callback: () => void): void;
  onClosed(callback: () => void): void;
  onError(callback: (reason: string) => void): void;
  onMessage(callback: (value: string | Uint8Array | ArrayBuffer) => void): void;
}
export interface NativeMediaPeer {
  close(): void;
  setRemoteDescription(sdp: string, type: "offer"): void;
  setLocalDescription(type: "answer"): void;
  localDescription(): { sdp: string; type: string } | null;
  createDataChannel(
    label: string,
    options: { negotiated: true; id: 0; unordered: true; maxRetransmits: 0; protocol: string },
  ): NativeMediaChannel;
  onLocalDescription(callback: () => void): void;
  onGatheringStateChange(callback: (state: string) => void): void;
  onStateChange(callback: (state: string) => void): void;
  onDataChannel(callback: (channel: NativeMediaChannel) => void): void;
}
export interface BrowserMediaPeerOptions {
  observationEpoch?: number;
  onObservationEpoch?(epoch: number): void;
  /** Trusted native binding/worker factory. Never supplied by a remote request. */
  createPeer(
    name: string,
    configuration: {
      iceServers: [];
      enableIceTcp: false;
      disableAutoNegotiation: true;
      maxMessageSize: number;
      bindAddress?: string;
    },
  ): NativeMediaPeer;
  offer: string;
  /** Trusted development/host binding, never interpreted from SDP or page content. */
  bindAddress?: string;
  signal: AbortSignal;
  /** Exact viewer/session/runtime/tab/generation binding must remain current. */
  isCurrent(): boolean;
  onReady(): void;
  onFailure(): void;
}
const MAX_SDP_BYTES = 65_536;

/** Bound signaling before creating a native peer. Only one application transport is
 * accepted, with fingerprint verification left enabled and no external ICE services. */
export function validateBrowserMediaOffer(offer: string): void {
  if (typeof offer !== "string" || Buffer.byteLength(offer) > MAX_SDP_BYTES || offer.includes("\0"))
    throw new Error("Invalid media offer");
  const lines = offer.split(/\r?\n/),
    media = lines.filter((line) => line.startsWith("m="));
  if (
    media.length !== 1 ||
    !/^m=application [0-9]+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]!) ||
    !lines.some((line) =>
      /^a=fingerprint:sha-256 (?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/.test(line),
    ) ||
    lines.filter((line) => line.startsWith("a=candidate:")).length > 32
  )
    throw new Error("Unsupported media offer");
}

/** Allocate a single credit-paced media peer after the owner authenticates a viewer.
 * close() synchronously fences callbacks, aborts gathering and tears down only this
 * peer. Signaling/ICE/native errors become fixed reasons and never expose SDP secrets. */
export function createBrowserMediaPeer(options: BrowserMediaPeerOptions) {
  validateBrowserMediaOffer(options.offer);
  let observationEpoch = options.observationEpoch ?? 0;
  writeBrowserMediaObservationEpoch(observationEpoch);
  let epochWindow = performance.now(),
    epochUpdates = 0;
  if (options.signal.aborted || !options.isCurrent()) throw new Error("Media viewer changed");
  const peer = options.createPeer(`shared-browser-media-${randomUUID()}`, {
    iceServers: [],
    enableIceTcp: false,
    disableAutoNegotiation: true,
    maxMessageSize: BROWSER_MEDIA_MESSAGE_BYTES,
    ...(options.bindAddress ? { bindAddress: options.bindAddress } : {}),
  });
  let channel: NativeMediaChannel | null = null,
    sender: ReturnType<typeof createBrowserMediaSender> | null = null;
  let closed = false,
    answered = false,
    ready = false;
  const result = Promise.withResolvers<string>();
  // A caller may close before it begins awaiting the answer. Never leak a global rejection.
  void result.promise.catch(() => undefined);
  let gathering: ReturnType<typeof setTimeout> | null = null;
  let connecting: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", close);
    if (gathering !== null) clearTimeout(gathering);
    gathering = null;
    if (connecting !== null) clearTimeout(connecting);
    connecting = null;
    sender?.close();
    sender = null;
    if (!answered) result.reject(new Error("Media negotiation ended"));
    try {
      channel?.close();
    } catch {
      /* Native failure must not skip releasing the peer or escape its callback. */
    } finally {
      channel = null;
      try {
        peer.close();
      } catch {
        /* The worker process remains the final bounded native-resource owner. */
      }
    }
  };
  const fail = () => {
    if (closed) return;
    close();
    try {
      options.onFailure();
    } catch {
      /* A diagnostic callback cannot escape a native event. */
    }
  };
  const current = () => !closed && !options.signal.aborted && options.isCurrent();
  const answer = () => {
    if (!current()) {
      fail();
      return;
    }
    const description = peer.localDescription();
    if (answered || !description) return;
    if (description.type !== "answer" || Buffer.byteLength(description.sdp) > MAX_SDP_BYTES) {
      fail();
      return;
    }
    answered = true;
    result.resolve(description.sdp);
    if (gathering !== null) clearTimeout(gathering);
    gathering = null;
  };
  try {
    peer.onLocalDescription(() => {});
    peer.onGatheringStateChange((state) => {
      if (state === "complete") answer();
    });
    peer.onStateChange((state) => {
      if (state === "closed" || state === "failed" || state === "disconnected") fail();
    });
    // No remote peer may open an auxiliary channel or use this transport for control.
    peer.onDataChannel((extra) => extra.close());
    channel = peer.createDataChannel("shared-browser-media", {
      negotiated: true,
      id: 0,
      unordered: true,
      maxRetransmits: 0,
      protocol: BROWSER_MEDIA_PROTOCOL,
    });
    sender = createBrowserMediaSender(channel, current);
    channel.onOpen(() => {
      if (!current()) {
        fail();
        return;
      }
      if (ready) return;
      ready = true;
      if (connecting !== null) clearTimeout(connecting);
      connecting = null;
      try {
        options.onReady();
      } catch {
        fail();
      }
    });
    channel.onClosed(fail);
    channel.onError(fail);
    channel.onMessage((value) => {
      if (!current()) {
        fail();
        return;
      }
      if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
        fail();
        return;
      }
      try {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (bytes.byteLength === 12) {
          const next = readBrowserMediaObservationEpoch(bytes);
          if (next <= observationEpoch) return;
          const now = performance.now();
          if (now - epochWindow >= 1000) {
            epochWindow = now;
            epochUpdates = 0;
          }
          if (++epochUpdates > 240) {
            fail();
            return;
          }
          observationEpoch = next;
          options.onObservationEpoch?.(next);
        } else {
          sender?.credit(bytes);
        }
      } catch {
        fail();
      }
    });
    options.signal.addEventListener("abort", close, { once: true });
    gathering = setTimeout(fail, 5000);
    connecting = setTimeout(fail, 8000);
    peer.setRemoteDescription(options.offer, "offer");
    peer.setLocalDescription("answer");
    if (options.signal.aborted) close();
  } catch {
    fail();
    throw new Error("Media negotiation is unavailable");
  }
  return {
    answer: result.promise,
    send(metadata: BrowserVideoMetadata, bytes: Uint8Array, epoch = 0): number | null {
      if (!current()) {
        close();
        return null;
      }
      try {
        return sender?.send(metadata, bytes, epoch) ?? null;
      } catch {
        fail();
        return null;
      }
    },
    close,
  };
}
