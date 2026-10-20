/** Private IPC owner for the native transport worker, with per-peer and global byte bounds. */
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { browserMediaObservationEpochSchema } from "../shared/browser-media-wire";
import type { BrowserVideoMetadata } from "../shared/browser-video";
import { VIDEO_MAX_PACKET_BYTES } from "../shared/browser-video";
import { validateBrowserMediaOffer } from "./browser-media-peer";
import {
  MEDIA_WORKER_MAX_PEERS,
  type MediaWorkerRequest,
  mediaWorkerReplySchema,
} from "./browser-media-worker-protocol";
import { stopOwnedChild } from "./owned-child";

export interface BrowserMediaWorkerAssets {
  workerPath: string;
  datachannelDirectory: string;
}
export interface BrowserMediaWorkerPeerOptions {
  observationEpoch?: number;
  onObservationEpoch?(epoch: number): void;
  signal: AbortSignal;
  isCurrent(): boolean;
  onReady(): void;
  onFailure(): void;
  bindAddress?: string;
}
interface PeerRecord {
  id: string;
  options: BrowserMediaWorkerPeerOptions;
  abort(): void;
  answer: ReturnType<typeof Promise.withResolvers<string>>;
  startup: ReturnType<typeof setTimeout> | null;
  nextRequest: number;
  ready: boolean;
  frame: {
    id: number;
    resolve(accepted: boolean): void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
}
const MAX_PENDING_IPC_FRAME_BYTES = 4 * 1024 * 1024;

/** Lazily constructed by the authenticated broker. The worker gets no inherited agent
 * credentials, Node options or stdio logs. Each peer owns at most one outstanding
 * frame command, and aggregate raw IPC bytes are bounded before serialization. */
export class BrowserMediaWorkerClient {
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private readonly ready = Promise.withResolvers<void>();
  private readonly peers = new Map<string, PeerRecord>();
  private pendingFrameBytes = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly startup: ReturnType<typeof setTimeout>;
  constructor(assets: BrowserMediaWorkerAssets) {
    if (!isAbsolute(assets.workerPath) || !isAbsolute(assets.datachannelDirectory))
      throw new Error("Media worker paths must be absolute");
    this.child = fork(assets.workerPath, [assets.datachannelDirectory], {
      execArgv: [],
      serialization: "advanced",
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, HOME: homedir(), ELECTRON_RUN_AS_NODE: "1" },
    });
    void this.ready.promise.catch(() => undefined);
    this.startup = setTimeout(() => void this.shutdown(true).catch(() => {}), 5000);
    this.exited = new Promise((resolve) => {
      const ended = () => {
        resolve();
        void this.shutdown(true).catch(() => {});
      };
      this.child.once("exit", ended);
      this.child.once("error", ended);
    });
    this.child.on("message", (value) => this.receive(value));
  }
  /** Open only after the parent authenticates its viewer and source binding. */
  async open(offer: string, options: BrowserMediaWorkerPeerOptions) {
    validateBrowserMediaOffer(offer);
    browserMediaObservationEpochSchema.parse(options.observationEpoch ?? 0);
    await this.ready.promise;
    if (this.closed || options.signal.aborted || !options.isCurrent())
      throw new Error("Media viewer changed");
    if (this.peers.size >= MEDIA_WORKER_MAX_PEERS) throw new Error("Media viewer capacity reached");
    const id = randomUUID(),
      answer = Promise.withResolvers<string>();
    void answer.promise.catch(() => undefined);
    const record: PeerRecord = {
      id,
      options,
      answer,
      abort: () => this.remove(id),
      startup: null,
      nextRequest: 0,
      ready: false,
      frame: null,
    };
    this.peers.set(id, record);
    options.signal.addEventListener("abort", record.abort, { once: true });
    record.startup = setTimeout(() => this.remove(id, true), 10000);
    if (
      !this.post({
        kind: "open",
        id,
        offer,
        observationEpoch: options.observationEpoch ?? 0,
        ...(options.bindAddress ? { bindAddress: options.bindAddress } : {}),
      })
    )
      this.remove(id, true);
    if (options.signal.aborted) this.remove(id);
    return {
      id,
      answer: answer.promise,
      send: (metadata: BrowserVideoMetadata, data: Uint8Array, observationEpoch = 0) =>
        this.frame(record, metadata, data, observationEpoch),
      close: () => this.remove(id),
    };
  }
  /** The Node send callback releases byte accounting only after IPC has flushed. */
  private post(message: MediaWorkerRequest): boolean {
    if (this.closed || !this.child.connected) return false;
    const bytes = message.kind === "frame" ? message.data.byteLength + 32768 : 0;
    if (bytes > MAX_PENDING_IPC_FRAME_BYTES - this.pendingFrameBytes) return false;
    this.pendingFrameBytes += bytes;
    try {
      this.child.send(message, (error) => {
        this.pendingFrameBytes -= bytes;
        if (error) void this.shutdown(true).catch(() => {});
      });
      return true;
    } catch {
      this.pendingFrameBytes -= bytes;
      return false;
    }
  }
  /** No slow peer can queue another binary frame while its previous worker command waits. */
  private frame(
    record: PeerRecord,
    metadata: BrowserVideoMetadata,
    data: Uint8Array,
    observationEpoch: number,
  ): Promise<boolean> {
    if (
      this.closed ||
      this.peers.get(record.id) !== record ||
      record.frame ||
      !record.options.isCurrent() ||
      !data.byteLength ||
      data.byteLength > VIDEO_MAX_PACKET_BYTES ||
      !browserMediaObservationEpochSchema.safeParse(observationEpoch).success
    )
      return Promise.resolve(false);
    if (record.nextRequest === 0xffffffff) {
      this.remove(record.id, true);
      return Promise.resolve(false);
    }
    const id = ++record.nextRequest;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.remove(record.id, true), 1000);
      record.frame = { id, resolve, timer };
      if (
        !this.post({
          kind: "frame",
          id: record.id,
          requestId: id,
          metadata,
          data,
          observationEpoch,
        })
      ) {
        clearTimeout(timer);
        record.frame = null;
        resolve(false);
      }
    });
  }
  /** Native worker replies have no free-form diagnostics or authority-changing commands. */
  private receive(value: unknown): void {
    if (this.closed) return;
    const parsed = mediaWorkerReplySchema.safeParse(value);
    if (!parsed.success) {
      void this.shutdown(true).catch(() => {});
      return;
    }
    const message = parsed.data;
    if (message.kind === "started") {
      clearTimeout(this.startup);
      this.ready.resolve();
      return;
    }
    const record = this.peers.get(message.id);
    if (!record) return;
    if (!record.options.isCurrent()) {
      this.remove(record.id);
      return;
    }
    if (message.kind === "failed") {
      this.remove(record.id, true);
      return;
    }
    if (message.kind === "answer") {
      if (record.startup !== null) clearTimeout(record.startup);
      record.startup = null;
      record.answer.resolve(message.sdp);
      return;
    }
    if (message.kind === "ready") {
      if (record.ready) return;
      record.ready = true;
      try {
        record.options.onReady();
      } catch {
        this.remove(record.id, true);
      }
      return;
    }
    if (message.kind === "epoch") {
      try {
        record.options.onObservationEpoch?.(message.observationEpoch);
      } catch {
        this.remove(record.id, true);
      }
      return;
    }
    const frame = record.frame;
    if (!frame || frame.id !== message.requestId) {
      this.remove(record.id, true);
      return;
    }
    clearTimeout(frame.timer);
    record.frame = null;
    frame.resolve(message.accepted);
  }
  /** Revoke callbacks and pending promises before asking the worker to close this peer. */
  private remove(id: string, failed = false): void {
    const record = this.peers.get(id);
    if (!record) return;
    this.peers.delete(id);
    record.options.signal.removeEventListener("abort", record.abort);
    if (record.startup !== null) clearTimeout(record.startup);
    if (record.frame) {
      clearTimeout(record.frame.timer);
      record.frame.resolve(false);
      record.frame = null;
    }
    record.answer.reject(new Error("Media viewer ended"));
    this.post({ kind: "close", id });
    if (failed) {
      try {
        record.options.onFailure();
      } catch {
        /* Keep callback failures inside the peer owner. */
      }
    }
  }
  /** Failures retire only this worker's peers; no Paseo, supervisor or browser signal is sent. */
  private shutdown(failed: boolean): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.startup);
    this.ready.reject(new Error("Media worker is unavailable"));
    for (const id of this.peers.keys()) this.remove(id, failed);
    this.closing = stopOwnedChild(this.child, this.exited, () => {
      if (this.child.connected) this.child.disconnect();
    });
    return this.closing;
  }
  close(): Promise<void> {
    return this.shutdown(false);
  }
  /** A failed worker can be replaced without restarting its browser or supervisor. */
  get stopped(): boolean {
    return this.closed;
  }
}
