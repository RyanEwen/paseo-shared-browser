/** Viewer-bound media lifetime. All pictures/receipts still originate in browser policy. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import type { BrowserState } from "../shared/browser";
import {
  type BrowserMediaSource,
  isBrowserMediaSourceCurrent,
  type OpenBrowserMediaInput,
  type OpenBrowserMediaReply,
  type PollBrowserMediaInput,
  type PollBrowserMediaReply,
} from "../shared/browser-media";
import type { BrowserVideoReadInput, BrowserVideoReadReply } from "../shared/browser-video";
import { captureDimensions } from "../shared/capture-settings";
import { pyrowaveDimensionsSchema } from "../shared/pyrowave-settings";
import {
  type BrowserMediaWorkerAssets,
  BrowserMediaWorkerClient,
} from "./browser-media-worker-client";
import { MEDIA_WORKER_MAX_PEERS } from "./browser-media-worker-protocol";

interface Session {
  id: string;
  viewerToken: string;
  source: BrowserMediaSource;
  state: BrowserState;
  abort: AbortController;
  peer: Awaited<ReturnType<BrowserMediaWorkerClient["open"]>> | null;
  heartbeat: number;
  streaming: boolean;
  sequence: number;
  observationEpoch: number;
  feed: Promise<void> | null;
}
type MediaWorker = Pick<BrowserMediaWorkerClient, "open" | "close" | "stopped">;
export interface BrowserMediaBrokerOptions {
  assets(): Promise<BrowserMediaWorkerAssets | null>;
  enabled(): boolean;
  readState(viewerToken: string): Promise<{ state: BrowserState }>;
  readVideo(input: BrowserVideoReadInput): Promise<BrowserVideoReadReply>;
  /** Isolated tests may supply a worker double, never remote RPC input. */
  createWorker?(assets: BrowserMediaWorkerAssets): MediaWorker;
  now?(): number;
}
const HEARTBEAT_TTL_MS = 15_000;

/** Own at most eight media peers. Source changes and absent client heartbeats revoke
 * admission independently from video reads, so background streaming cannot immortalize
 * an abandoned viewer. Control stays exclusively with existing browser-policy RPCs. */
export function createBrowserMediaBroker(options: BrowserMediaBrokerOptions) {
  const sessions = new Map<string, Session>(),
    byViewer = new Map<string, Session>(),
    openers = new Map<string, object>();
  const retired = new Map<string, { viewerToken: string; reason: string; expires: number }>();
  const draining = new Map<string, { transportId: string; done: Promise<void> }>();
  let worker: MediaWorker | null = null,
    closed = false,
    opening = 0;
  let workerTail: Promise<void> = Promise.resolve();
  const now = () => options.now?.() ?? performance.now();
  const current = (session: Session) =>
    !closed &&
    !session.abort.signal.aborted &&
    sessions.get(session.id) === session &&
    options.enabled() &&
    now() - session.heartbeat < HEARTBEAT_TTL_MS;
  /** Fence first, then release only this peer. Pending bounded reads may settle but cannot publish. */
  const remove = (session: Session, reason?: string) => {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    if (byViewer.get(session.viewerToken) === session) byViewer.delete(session.viewerToken);
    // A channel can disappear before the client's explicit close reaches us.
    // Keep its uncancelable source read discoverable after retiring the peer ID.
    if (session.feed) {
      const done = session.feed.then(
        () => {},
        () => {},
      );
      const entry = { transportId: session.id, done };
      draining.set(session.viewerToken, entry);
      void done.then(() => {
        if (draining.get(session.viewerToken) === entry) draining.delete(session.viewerToken);
      });
    }
    session.abort.abort();
    session.peer?.close();
    if (reason && !closed) {
      retired.set(session.id, {
        viewerToken: session.viewerToken,
        reason,
        expires: now() + HEARTBEAT_TTL_MS,
      });
      while (retired.size > 32) retired.delete(retired.keys().next().value!);
    }
  };
  const maintenance = setInterval(() => {
    for (const session of sessions.values()) if (!current(session)) remove(session);
    for (const [id, ended] of retired) if (now() >= ended.expires) retired.delete(id);
  }, 1000);
  maintenance.unref();

  /** Native capture and source-age validation remain on the supervisor lane. The worker
   * receives no control token, viewer credential or private runtime operation. */
  const feed = async (session: Session, input: OpenBrowserMediaInput) => {
    let streamId: string | null = null,
      sequence = 0;
    try {
      while (current(session)) {
        // Preserve the epoch from before this source read. Arrival must never
        // relabel pre-settlement pixels as a new local observation.
        const observationEpoch = session.observationEpoch;
        const reply = await options.readVideo({
          viewerToken: session.viewerToken,
          codec: "pyrowave",
          quality: "high",
          bitrate: input.bitrate,
          fps: input.fps,
          streamId,
          afterSequence: sequence,
          requestKeyFrame: sequence === 0,
          waitMs: 500,
        });
        if (!current(session)) return;
        session.state = reply.state;
        if (!isBrowserMediaSourceCurrent(session.source, reply.state)) {
          remove(session);
          return;
        }
        if (reply.status === "unsupported") {
          remove(session, reply.reason ?? "PyroWave video is unavailable");
          return;
        }
        streamId = reply.streamId;
        for (const packet of reply.packets) {
          if (packet.codec !== "pyrowave") {
            remove(session);
            return;
          }
          sequence = packet.sequence;
          if (!current(session)) return;
          const { dataBase64, ...metadata } = packet;
          if (
            await session.peer?.send(metadata, Buffer.from(dataBase64, "base64"), observationEpoch)
          )
            session.sequence = sequence;
        }
        // Waiting/static sources and congested viewers cannot spin a synchronous RPC loop.
        if (!reply.packets.length) await pause(40, undefined, { signal: session.abort.signal });
      }
    } catch {
      remove(session, "PyroWave video stopped; standard video remains available");
    }
  };
  const unavailable = (state: BrowserState, reason: string): OpenBrowserMediaReply => ({
    state,
    status: "unsupported",
    transportId: null,
    answer: null,
    reason,
  });
  const reset = (state: BrowserState): OpenBrowserMediaReply => ({
    state,
    status: "reset",
    transportId: null,
    answer: null,
    reason: "Browser source changed",
  });

  /** Serialize only worker retirement/allocation. Each opener rechecks ownership after
   * draining a stopped worker, so concurrent opens cannot lose a replacement handle.
   * A failed teardown retains the old handle and never silently creates a sibling. */
  const acquireWorker = (
    assets: BrowserMediaWorkerAssets,
    ownsOpen: () => boolean,
  ): Promise<MediaWorker | null> => {
    const allocation = workerTail.then(async () => {
      const retiring = worker;
      if (retiring?.stopped) {
        await retiring.close();
        if (worker === retiring) worker = null;
      }
      if (!ownsOpen() || !options.enabled()) return null;
      if (sessions.size + draining.size >= MEDIA_WORKER_MAX_PEERS) return null;
      worker ??= options.createWorker?.(assets) ?? new BrowserMediaWorkerClient(assets);
      return worker;
    });
    workerTail = allocation.then(
      () => {},
      () => {},
    );
    return allocation;
  };

  return {
    async capabilities() {
      const assets = await options.assets();
      return assets
        ? { pyrowave: true }
        : { pyrowave: false, reason: "PyroWave is not installed for this host" };
    },
    /** A newer open for this same viewer supersedes pending allocation before any await can publish. */
    async open(input: OpenBrowserMediaInput): Promise<OpenBrowserMediaReply> {
      if (closed || opening >= MEDIA_WORKER_MAX_PEERS)
        throw new Error("Media connection capacity reached");
      opening++;
      const marker = {};
      openers.set(input.viewerToken, marker);
      let session: Session | null = null;
      const ownsOpen = () => !closed && openers.get(input.viewerToken) === marker;
      try {
        let { state } = await options.readState(input.viewerToken);
        if (!ownsOpen() || !isBrowserMediaSourceCurrent(input.source, state)) return reset(state);
        if (!options.enabled()) return unavailable(state, "Live video is off");
        if (
          !pyrowaveDimensionsSchema.safeParse(captureDimensions(state.viewport, state.captureScale))
            .success
        ) {
          return unavailable(
            state,
            "PyroWave needs even capture dimensions up to 3840 pixels; standard video remains available",
          );
        }
        const assets = await options.assets();
        if (!ownsOpen()) return reset(state);
        if (!assets) return unavailable(state, "PyroWave is not installed for this host");
        const previous = byViewer.get(input.viewerToken);
        if (previous) {
          remove(previous);
          await previous.feed;
        }
        await draining.get(input.viewerToken)?.done;
        ({ state } = await options.readState(input.viewerToken));
        if (!ownsOpen() || !isBrowserMediaSourceCurrent(input.source, state)) return reset(state);
        if (sessions.size + draining.size >= MEDIA_WORKER_MAX_PEERS)
          return unavailable(state, "Media viewer capacity reached");
        const activeWorker = await acquireWorker(assets, ownsOpen);
        if (!ownsOpen()) return reset(state);
        if (!options.enabled()) return unavailable(state, "Live video is off");
        // Allocation awaited shared retirement. Revalidate capacity before reserving
        // this session, including peers allocated by another concurrent opener.
        if (!activeWorker || sessions.size + draining.size >= MEDIA_WORKER_MAX_PEERS)
          return unavailable(state, "Media viewer capacity reached");
        session = {
          id: randomUUID(),
          viewerToken: input.viewerToken,
          source: input.source,
          state,
          abort: new AbortController(),
          peer: null,
          heartbeat: now(),
          streaming: false,
          sequence: 0,
          observationEpoch: input.observationEpoch,
          feed: null,
        };
        sessions.set(session.id, session);
        byViewer.set(session.viewerToken, session);
        const owned = session;
        session.peer = await activeWorker.open(input.offer, {
          observationEpoch: input.observationEpoch,
          onObservationEpoch: (epoch) => {
            if (current(owned) && epoch >= owned.observationEpoch) owned.observationEpoch = epoch;
          },
          signal: session.abort.signal,
          isCurrent: () => current(owned),
          onReady: () => {
            if (current(owned) && !owned.streaming) {
              owned.streaming = true;
              owned.feed = feed(owned, input);
            }
          },
          onFailure: () =>
            remove(owned, "PyroWave transport stopped; standard video remains available"),
        });
        const answer = await session.peer.answer;
        ({ state } = await options.readState(input.viewerToken));
        if (!isBrowserMediaSourceCurrent(input.source, state)) {
          remove(session);
          return reset(state);
        }
        if (!ownsOpen() || !current(session)) {
          remove(session);
          return reset(state);
        }
        return { state, status: "ready", transportId: session.id, answer };
      } catch {
        if (session) remove(session);
        // Preserve expired/invalid viewer errors through the normal status path; never attach a replacement.
        const { state } = await options.readState(input.viewerToken);
        return unavailable(
          state,
          "PyroWave media could not connect; standard video remains available",
        );
      } finally {
        opening--;
        if (openers.get(input.viewerToken) === marker) openers.delete(input.viewerToken);
      }
    },
    /** Only the original viewer may heartbeat a transport. A closed ID can never reopen it. */
    async poll(input: PollBrowserMediaInput): Promise<PollBrowserMediaReply> {
      const { state } = await options.readState(input.viewerToken),
        session = sessions.get(input.transportId);
      const ended = retired.get(input.transportId);
      if (ended?.viewerToken === input.viewerToken && now() < ended.expires)
        return { state, status: "unsupported", sequence: 0, reason: ended.reason };
      if (!session || session.viewerToken !== input.viewerToken)
        return { state, status: "reset", sequence: 0, reason: "Media stream ended" };
      if (!current(session) || !isBrowserMediaSourceCurrent(session.source, state)) {
        remove(session);
        return { state, status: "reset", sequence: 0, reason: "Browser source changed" };
      }
      session.heartbeat = now();
      session.state = state;
      if (input.observationEpoch !== undefined)
        session.observationEpoch = Math.max(session.observationEpoch, input.observationEpoch);
      return {
        state,
        status: session.streaming ? "streaming" : "connecting",
        sequence: session.sequence,
      };
    },
    async closeViewer(input: PollBrowserMediaInput) {
      const session = sessions.get(input.transportId);
      if (session?.viewerToken === input.viewerToken) {
        remove(session);
        // The next codec incarnation must not overlap this viewer's uncancelable
        // bounded supervisor read. It may settle, but cannot publish after removal.
        await session.feed;
      }
      const pending = draining.get(input.viewerToken);
      if (pending?.transportId === input.transportId) await pending.done;
      if (retired.get(input.transportId)?.viewerToken === input.viewerToken)
        retired.delete(input.transportId);
      return { closed: true as const };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenance);
      openers.clear();
      retired.clear();
      for (const session of sessions.values()) remove(session);
      // In-flight allocation sees closed=true before it may create a worker.
      await workerTail;
      await worker?.close();
      worker = null;
    },
  };
}
