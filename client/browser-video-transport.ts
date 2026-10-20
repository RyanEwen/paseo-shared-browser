/** Select and retire video transports without changing decode or input authority policy. */
import type { BrowserState } from "../shared/browser";
import { browserMediaSourceSchema, isBrowserMediaSourceCurrent } from "../shared/browser-media";
import type {
  BrowserVideoMetadata,
  BrowserVideoReadInput,
  BrowserVideoReadReply,
} from "../shared/browser-video";
import { captureDimensions } from "../shared/capture-settings";
import { pyrowaveDimensionsSchema } from "../shared/pyrowave-settings";
import type { VideoEncoderSettings } from "../shared/video-settings";
import {
  type BrowserMediaClientEnvironment,
  type BrowserMediaRead,
  type BrowserMediaReaderOptions,
  createBrowserMediaReader,
} from "./browser-media-session";

export interface BrowserVideoTransportOptions {
  viewerToken: string;
  quality: BrowserVideoReadInput["quality"];
  bitrate?: VideoEncoderSettings["bitrate"];
  fps?: 15 | 30 | 60;
  codec?: "webcodecs" | "pyrowave";
  pyrowaveBitrate?: 100000000 | 200000000 | 250000000;
  source(): BrowserState | null;
  epoch(): number;
  isSourceCurrent(packet: BrowserVideoMetadata): boolean;
  isStopped(): boolean;
  environment: BrowserMediaClientEnvironment | null;
  readRpc(input: BrowserVideoReadInput): Promise<BrowserVideoReadReply>;
  mediaRpcs: Pick<BrowserMediaReaderOptions, "open" | "poll" | "close">;
  pendingRead: { current: Promise<BrowserVideoReadReply> | null };
  pendingClose: { current: Promise<void> | null };
  onFallback(reason: string): void;
  /** Reset the compatible decoder and fallback notice before a recovered LAN source opens. */
  onMediaResume(): void;
}

/** Retain single-flight RPC/close barriers across viewer incarnations. Optional LAN
 * failure switches only viewing to compatible video; no mutation is replayed.
 * A mode generation prevents a late LAN read from reactivating its retired codec. */
export function createBrowserVideoTransport(options: BrowserVideoTransportOptions) {
  let closed = false,
    generation = 0,
    usingMedia = options.codec === "pyrowave";
  let media: ReturnType<typeof createBrowserMediaReader> | null = null;
  let dimensionFallbackSource: BrowserState | null = null;
  const supportsDimensions = (state: BrowserState) =>
    pyrowaveDimensionsSchema.safeParse(captureDimensions(state.viewport, state.captureScale))
      .success;
  const retire = () => {
    const reader = media;
    media = null;
    if (!reader) return;
    const closing = reader.close().catch(() => {});
    options.pendingClose.current = closing;
    void closing.then(() => {
      if (options.pendingClose.current === closing) options.pendingClose.current = null;
    });
  };
  const fallback = (reason: string, rejectedSource?: BrowserState) => {
    if (closed || options.isStopped() || !usingMedia) return;
    usingMedia = false;
    // Only an explicit geometry refusal may recover automatically. Network/decoder
    // failures retain the ordinary manual retry policy, even after a resize.
    dimensionFallbackSource =
      rejectedSource && !supportsDimensions(rejectedSource) ? rejectedSource : null;
    generation++;
    retire();
    options.onFallback(reason);
  };
  /** Allocate a fresh reader only after prior remote teardown has drained. */
  const openMedia = () => {
    media = createBrowserMediaReader({
      environment: options.environment!,
      viewerToken: options.viewerToken,
      source: options.source,
      epoch: options.epoch,
      bitrate: options.pyrowaveBitrate ?? 100000000,
      fps: options.fps ?? 30,
      isSourceCurrent: options.isSourceCurrent,
      ...options.mediaRpcs,
    });
  };
  if (usingMedia) {
    if (!options.environment)
      fallback("This client needs WebGPU for PyroWave; using compatible video");
    else openMedia();
  }
  return {
    get usingMedia() {
      return usingMedia;
    },
    fallback,
    setEpoch: (epoch: number) => media?.setEpoch(epoch),
    presented: (packet: BrowserVideoMetadata) => media?.presented(packet),
    async read(input: {
      streamId: string | null;
      afterSequence: number;
      requestKeyFrame: boolean;
    }): Promise<BrowserMediaRead | null> {
      // SDK reads cannot be aborted. Wait for old source reads and explicit media
      // teardown before another transport issues a request for this viewer.
      if (options.pendingRead.current) await options.pendingRead.current.catch(() => {});
      if (options.pendingClose.current) await options.pendingClose.current;
      if (closed || options.isStopped()) return null;
      if (!usingMedia && dimensionFallbackSource) {
        const state = options.source();
        // The panel must commit a genuinely new ready source before retrying.
        // An unchanged unsupported viewport never spins signaling attempts.
        if (
          state?.status === "ready" &&
          !isBrowserMediaSourceCurrent(
            browserMediaSourceSchema.parse(dimensionFallbackSource),
            state,
          ) &&
          supportsDimensions(state)
        ) {
          dimensionFallbackSource = null;
          usingMedia = true;
          generation++;
          openMedia();
          options.onMediaResume();
        }
      }
      if (usingMedia && media) {
        const incarnation = generation,
          reader = media;
        try {
          const result = await reader.read();
          if (closed || incarnation !== generation || !usingMedia) return null;
          return result;
        } catch {
          if (!closed && !options.isStopped())
            fallback("PyroWave could not connect; using compatible video");
          return null;
        }
      }
      const observationEpoch = options.epoch();
      const request = options.readRpc({
        viewerToken: options.viewerToken,
        quality: options.quality,
        ...(options.bitrate === undefined ? {} : { bitrate: options.bitrate }),
        ...(options.fps === undefined ? {} : { fps: options.fps }),
        ...input,
        waitMs: 250,
      });
      options.pendingRead.current = request;
      try {
        return { reply: await request, observationEpoch };
      } finally {
        if (options.pendingRead.current === request) options.pendingRead.current = null;
      }
    },
    /** Revoke late reads synchronously; the shared close barrier owns remote cleanup. */
    close() {
      if (closed) return;
      closed = true;
      generation++;
      retire();
    },
  };
}
