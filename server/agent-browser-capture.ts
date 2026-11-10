import { captureDimensions, DEFAULT_JPEG_QUALITY } from "../shared/capture-settings";
import { resolveVideoCodecSettings } from "../shared/video-codec-settings";
import type { RuntimeAttachment } from "./agent-browser-attachment";
import type { DeviceEmulation, RuntimeFrame } from "./agent-browser-types";
import { CAPTURE_MAX_AGE_MS, createCaptureTransportPolicy } from "./capture-transport-policy";
import { type CdpSession, CdpUnavailableError } from "./cdp";
import { createJpegCaptureDemand } from "./jpeg-capture-demand";
import { readJpegFrameDimensions } from "./jpeg-frame";
import type { NativePyrowaveAssets } from "./native-pyrowave-cohort";
import {
  NativeVideoCapture,
  type NativeVideoQuality,
  type NativeVideoRead,
} from "./native-video-capture";
import { createScreencastSourceTime } from "./screencast-source-time";
import { createVideoSourceRecovery } from "./video-source-recovery";

const SCREENCAST_SETUP_RETRY_MS = 25;

/** A `Page.screencastFrame` event. */
export interface ScreencastFrame {
  data: string;
  metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
  sessionId: number;
}

/** Page attachment operations capture needs from its runtime. */
export interface RuntimeCaptureHost {
  /** The current page, restored and settled; may reconnect. */
  requirePage(): Promise<CdpSession>;
  /** Reapply configured device intent to a session that has not had it applied. */
  restoreConfiguredEmulation(page: CdpSession): Promise<void>;
  /** Apply a device contract to one session without changing saved intent. */
  applyEmulation(page: CdpSession, device: DeviceEmulation): Promise<void>;
  /** Replace a page session that could not start a screencast, returning the current page. */
  reattachPageForScreencast(previous: CdpSession): Promise<CdpSession>;
  /** Read navigation history, retrying while the page is still attaching. */
  navigationHistory(page: CdpSession): Promise<unknown>;
}

/** Native video and its configuration choices. */
export interface RuntimeCaptureOptions {
  /** Prepare the capture helper. The current host choice separately authorizes capture. */
  nativeVideo: boolean;
  /** Current host choice, checked before and after asynchronous video acquisition. */
  nativeVideoAllowed: () => boolean;
  /** Trusted immutable native assets, absent until optional codec qualification. */
  pyrowave: NativePyrowaveAssets | undefined;
}

/**
 * Pixels for one page controller: the shared JPEG screencast with its screenshot fallback, and
 * native video. Every result is fenced on the attachment it was captured from; any mutation or
 * transport change invalidates pending and cached pixels rather than relabelling them.
 */
export class RuntimeCapture {
  private readonly capturePolicy = createCaptureTransportPolicy();
  private readonly screencastSourceTime = createScreencastSourceTime();
  private screencastFrame: RuntimeFrame | null = null;
  private screencastFrameReceivedAt: number | null = null;
  private screencastWaiters = new Set<(frame: RuntimeFrame | null) => void>();
  /** Whether this controller wants the JPEG screencast running on its page. */
  screencastActive = false;
  private screencastQuality: number = DEFAULT_JPEG_QUALITY;
  private screencastStartFailed = false;
  private readonly jpegDemand = createJpegCaptureDemand({
    now: () => performance.now(),
    retire: () => this.stopScreencastSession(),
    onError: () => console.warn("Shared Browser could not retire unused JPEG capture"),
  });
  private readonly nativeVideo: boolean;
  private readonly pyrowave: NativePyrowaveAssets | undefined;
  private readonly nativeVideoAllowed: () => boolean;
  /** Set from startup graphics observation; applies to helpers created afterwards. */
  softwareCaptureColorCorrection = false;
  private video: NativeVideoCapture | null = null;
  private videoRetirement: Promise<void> | null = null;
  private readonly videoRecovery = createVideoSourceRecovery();
  private videoTransitionDepth = 0;
  private videoTransitionEpoch = 0;

  /**
   * @param attachment The controller's shared page attachment.
   * @param host Attachment operations owned by the runtime.
   * @param options Native video choices.
   */
  constructor(
    private readonly attachment: RuntimeAttachment,
    private readonly host: RuntimeCaptureHost,
    options: RuntimeCaptureOptions,
  ) {
    this.nativeVideo = options.nativeVideo;
    this.nativeVideoAllowed = options.nativeVideoAllowed;
    this.pyrowave = options.pyrowave;
  }

  /** Begin terminal shutdown: retire JPEG demand and every cached or awaited frame. */
  beginShutdown(): void {
    this.jpegDemand.close();
    this.screencastActive = false;
    this.invalidateScreencastFrame();
  }

  /** Starts only exact restored native tab capture, lazily adding this viewer's quality encoder. */
  async startVideo(quality: NativeVideoQuality = "high"): Promise<NativeVideoRead> {
    return this.readVideo({ quality, waitMs: 0 });
  }

  /** Long-poll outside the input queue. The caller must fence returned inputGeneration before publication. */
  async readVideo(input: {
    codec?: "webcodecs" | "pyrowave";
    quality: NativeVideoQuality;
    bitrate?: number;
    fps?: number;
    streamId?: string | null;
    afterSequence?: number;
    waitMs?: number;
    requestKeyFrame?: boolean;
  }): Promise<NativeVideoRead & { inputGeneration: string }> {
    if (!this.nativeVideo || !this.nativeVideoAllowed()) {
      if (this.video) this.retireVideoForRead();
      return {
        ...this.videoReset(),
        status: "unsupported",
        reasonCode: "video-disabled",
        reason: this.nativeVideo
          ? "Live video is off"
          : "Live video is unavailable in this browser; screenshots remain available",
      };
    }
    const settings = resolveVideoCodecSettings(input);
    const transitionEpoch = this.videoTransitionEpoch;
    if (!this.videoMayStart(transitionEpoch)) return this.videoReset();

    // Retirement uses the same stop barrier as viewport changes. The next read
    // resumes from current configuration instead of treating idle expiry as a
    // permanent codec failure or creating a replacement while the old track closes.
    if (this.video?.idleExpired) {
      this.retireVideoForRead();
      return this.videoReset();
    }

    const page = await this.host.requirePage();
    // requirePage can itself restore or reconnect. Retry on the next read rather
    // than creating a helper from a configuration that changed across its await.
    if (!this.videoMayStart(transitionEpoch)) return this.videoReset();
    const connection = this.attachment.requireConnection();
    const generation = this.attachment.attachmentGeneration;
    const viewport = this.attachment.requireViewport();
    const recoveryContext = { connection, page, viewport, attachmentGeneration: generation };
    const blocked = this.videoRecovery.blocked(recoveryContext);
    if (blocked === "source-dimensions") {
      return {
        ...this.videoReset(),
        status: "unsupported",
        reason: "Native video dimensions do not match the configured viewport",
      };
    }
    if (blocked) {
      return this.videoReset();
    }
    if (!this.video) {
      const pixels = captureDimensions(viewport, viewport.captureScale ?? 1);
      this.video = new NativeVideoCapture({
        ...(this.pyrowave ? { pyrowave: this.pyrowave } : {}),
        connection,
        targetId: page.targetId,
        softwareColorCorrection: this.softwareCaptureColorCorrection,
        width: pixels.width,
        height: pixels.height,
        isCurrent: () =>
          this.nativeVideoAllowed() &&
          this.videoMayStart(transitionEpoch) &&
          connection === this.attachment.connection &&
          page === this.attachment.page &&
          viewport === this.attachment.viewport &&
          generation === this.attachment.attachmentGeneration &&
          this.attachment.emulationAppliedPage === page,
      });
    }
    const video = this.video;
    const documentGeneration = this.attachment.documentGeneration;
    const result = await video.read({ ...input, bitrate: settings.bitrate, fps: settings.fps });
    if (!this.nativeVideoAllowed()) {
      this.retireVideoForRead();
      return {
        ...this.videoReset(),
        status: "unsupported",
        reasonCode: "video-disabled",
        reason: "Live video is off",
      };
    }
    if (
      !this.videoMayStart(transitionEpoch) ||
      video.idleExpired ||
      video !== this.video ||
      connection !== this.attachment.connection ||
      page !== this.attachment.page ||
      viewport !== this.attachment.viewport ||
      generation !== this.attachment.attachmentGeneration ||
      documentGeneration !== this.attachment.documentGeneration
    ) {
      return this.videoReset();
    }
    if (video.sourceFailure) {
      // Store failure admission before opening the existing stop barrier. A
      // concurrent read sees either that barrier or the cooldown, never a second
      // track while the failed source/helper is still being retired.
      this.videoRecovery.failed(recoveryContext, video.sourceFailure);
      const permanent = video.sourceFailure === "source-dimensions";
      this.retireVideoForRead();
      if (
        this.attachment.stopping ||
        connection !== this.attachment.connection ||
        page !== this.attachment.page ||
        viewport !== this.attachment.viewport ||
        generation !== this.attachment.attachmentGeneration
      ) {
        return this.videoReset();
      }
      if (permanent) {
        return {
          ...this.videoReset(),
          status: "unsupported",
          reason: "Native video dimensions do not match the configured viewport",
        };
      }
      return this.videoReset();
    }
    return {
      ...result,
      inputGeneration: this.attachment.inputGeneration(),
    };
  }

  /** Explicit action barrier; pointer samples preserve the native track and encoder continuity. */
  invalidateQueuedVideoFrames(): void {
    this.video?.invalidateQueuedFrames();
  }

  /** Establish the stop barrier now, but do not hold a viewing RPC across slow
   * helper teardown. stopVideo owns barrier release; no replacement can start
   * until it settles. Explicit stop callers still await their cleanup. */
  private retireVideoForRead(): void {
    const retirement = this.stopVideo();
    this.videoRetirement = retirement;
    const complete = () => {
      if (this.videoRetirement === retirement) this.videoRetirement = null;
    };
    void retirement.then(complete, () => {
      complete();
      console.warn("[shared-browser] Video retirement failed");
    });
  }

  /** Stop admission too: a concurrent reader cannot replace a source still closing. */
  async stopVideo(): Promise<void> {
    if (this.videoRetirement) {
      await this.videoRetirement;
      return;
    }
    await this.withVideoTransition(async () => {});
  }

  /** Nested device/attachment phases keep one continuous barrier until all phases finish. */
  async withVideoTransition<T>(transition: () => Promise<T>): Promise<T> {
    const releaseJpeg = this.attachment.stopping ? () => {} : this.jpegDemand.pin(false);
    this.videoTransitionDepth += 1;
    this.videoTransitionEpoch += 1;
    const video = this.video;
    this.video = null;
    try {
      if (video) await video.stop();
      return await transition();
    } finally {
      this.videoTransitionDepth -= 1;
      releaseJpeg();
    }
  }

  private videoMayStart(epoch: number): boolean {
    return (
      !this.attachment.stopping &&
      this.videoTransitionDepth === 0 &&
      epoch === this.videoTransitionEpoch
    );
  }

  private videoReset(): NativeVideoRead & { inputGeneration: string } {
    return {
      status: "reset",
      streamId: null,
      packets: [],
      inputGeneration: this.attachment.inputGeneration(),
    };
  }

  /** Explicit viewing start remains supported, but does not keep unused JPEG work alive. */
  async startScreencast(quality: number = DEFAULT_JPEG_QUALITY): Promise<void> {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new RangeError("Screencast quality must be an integer from 1 to 100");
    }
    const release = this.jpegDemand.pin();
    try {
      await this.jpegDemand.serialize(async () => {
        const page = await this.host.requirePage();
        if (this.screencastActive && this.screencastQuality === quality) return;
        this.screencastQuality = quality;
        this.screencastStartFailed = false;
        this.screencastActive = true;
        try {
          await this.startScreencastSession(page);
        } catch (error) {
          this.screencastActive = false;
          this.screencastStartFailed = true;
          throw error;
        }
      });
    } finally {
      release();
    }
  }

  /** Explicit detach cleanup and idle retirement use the same native transition FIFO. */
  async stopScreencast(): Promise<void> {
    this.jpegDemand.cancel();
    await this.jpegDemand.serialize(() => this.stopScreencastSession());
  }

  private async stopScreencastSession(): Promise<void> {
    const wasActive = this.screencastActive;
    this.screencastActive = false;
    this.screencastStartFailed = false;
    this.invalidateScreencastFrame();
    if (!wasActive || !this.attachment.page) return;
    try {
      await this.attachment.page.send("Page.stopScreencast", {}, { mutation: true });
    } finally {
      this.invalidateScreencastFrame();
    }
  }

  /** Return truthful fresh stream/fallback pixels; mutation/session changes revoke pending captures. */
  async frame(
    maxBytes: number,
    quality: number = DEFAULT_JPEG_QUALITY,
    waitMs = 500,
  ): Promise<RuntimeFrame> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be positive");
    }
    if (!Number.isFinite(quality)) throw new RangeError("JPEG quality must be finite");
    const requestedQuality = Math.max(1, Math.min(100, Math.round(quality)));
    // All reads protect in-flight pixels, but screenshot-only qualities do not
    // renew the shared JPEG stream when a viewer changes their preference.
    const release = this.jpegDemand.pin(requestedQuality === this.screencastQuality);
    try {
      await this.jpegDemand.serialize(async () => {
        const page = await this.host.requirePage();
        // Nonmatching quality keeps the existing screenshot-only path. A video
        // viewer choosing JPEG100 must not start an unused JPEG95 stream.
        if (
          requestedQuality !== this.screencastQuality ||
          this.screencastActive ||
          this.screencastStartFailed
        ) {
          return;
        }
        this.screencastActive = true;
        try {
          await this.startScreencastSession(page);
        } catch {
          // Shutdown is terminal, not an optional stream failure to fall back from.
          this.attachment.assertRuntimeOpen();
          // Stream support is optional. Preserve fresh screenshots, and avoid
          // retrying a failed setup at every 250ms poll in the same demand period.
          console.warn("Shared Browser JPEG screencast is unavailable; using screenshot fallback");
          this.screencastActive = false;
          this.screencastStartFailed = true;
        }
      });
      this.attachment.assertRuntimeOpen();
      if (requestedQuality !== this.screencastQuality) {
        // Viewers choose their own quality; never restart the shared stream or
        // classify its health from another viewer's screenshot preference.
        const cached = this.capturePolicy.readScreenshot(
          performance.now(),
          requestedQuality,
          maxBytes,
        );
        return cached ?? (await this.captureScreenshot(maxBytes, requestedQuality, true));
      }
      // Expiry discards pixels without resetting fallback dwell/recovery evidence.
      // Mutations and connection changes use the stronger invalidation below.
      const generation = this.capturePolicy.currentGeneration();
      const receivedAt = this.screencastFrameReceivedAt;
      if (receivedAt === null || performance.now() - receivedAt > CAPTURE_MAX_AGE_MS) {
        this.screencastFrame = null;
        this.screencastFrameReceivedAt = null;
      }
      if (this.screencastActive && this.capturePolicy.canUseStream(performance.now())) {
        const streamed = this.screencastFrame ?? (await this.waitForFrame(waitMs));
        this.attachment.assertRuntimeOpen();
        if (!this.capturePolicy.isCurrent(generation)) {
          throw new CdpUnavailableError(
            "Browser capture was invalidated while waiting for a frame",
          );
        }
        if (streamed && streamed.byteLength <= maxBytes) {
          return streamed;
        }
      }

      this.capturePolicy.enterFallback(performance.now());
      const cached = this.capturePolicy.readScreenshot(
        performance.now(),
        requestedQuality,
        maxBytes,
      );
      if (cached) {
        return cached;
      }
      return await this.captureScreenshot(maxBytes, requestedQuality);
    } finally {
      release();
    }
  }

  /** Capture the configured viewport and cache only an unchanged-session/mutation completion. */
  private async captureScreenshot(
    maxBytes: number,
    requestedQuality: number,
    preserveStreamRecovery = false,
  ): Promise<RuntimeFrame> {
    const page = await this.host.requirePage();
    const screenshotGeneration = this.capturePolicy.beginScreenshot({
      preserveRecovery: preserveStreamRecovery,
    });
    try {
      const viewport = this.attachment.requireViewport();
      const expectedPixels = captureDimensions(viewport, viewport.captureScale);
      const readClip = async () => {
        const metrics = await page.send<{ cssVisualViewport: { pageX: number; pageY: number } }>(
          "Page.getLayoutMetrics",
        );
        this.assertCaptureCurrent(page, screenshotGeneration);
        return {
          x: metrics.cssVisualViewport.pageX,
          y: metrics.cssVisualViewport.pageY,
          width: viewport.width,
          height: viewport.height,
          scale: (viewport.captureScale ?? 1) / viewport.deviceScaleFactor,
        };
      };
      // Explicitly capture the visible CSS viewport, independent of the native window size.
      // Preserve scroll position and normalize device pixel ratio to the frame/input contract.
      let clip = await readClip();
      let resynced = false;
      // Reduce quality gradually only when a detailed frame exceeds the byte budget.
      const initialQuality = requestedQuality;
      const candidates = [...new Set([initialQuality, 90, 85, 75, 65, 50, 35, 20, 10, 1])].filter(
        (candidate) => candidate <= initialQuality,
      );
      const capture = async (quality: number) => {
        this.assertCaptureCurrent(page, screenshotGeneration);
        const result = await page.send<{ data: string }>("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          fromSurface: true,
          // Beyond-viewport capture replaces emulation and resets enabled touch.
          captureBeyondViewport: false,
          clip,
        });
        this.assertCaptureCurrent(page, screenshotGeneration);
        const dimensions = readJpegFrameDimensions(result.data);
        if (!dimensions) throw new Error("Chromium returned a malformed JPEG screenshot");
        return {
          data: result.data,
          dimensions,
          byteLength: Buffer.byteLength(result.data, "base64"),
        };
      };
      const matchesViewport = (dimensions: { width: number; height: number }) =>
        dimensions.width === expectedPixels.width && dimensions.height === expectedPixels.height;

      for (const candidate of candidates) {
        const boundedQuality = Math.max(1, Math.min(100, Math.round(candidate)));
        let pixels = await capture(boundedQuality);
        if (!matchesViewport(pixels.dimensions) && !resynced) {
          // Retain upstream viewport recovery, with captureScale rather than DPR:
          // mobile CSS emulation and image density are independently configured.
          // Recapture pixels only; uncertain input is never replayed.
          resynced = true;
          const attachmentGeneration = this.attachment.attachmentGeneration;
          await this.host.applyEmulation(page, viewport);
          this.attachment.assertAttachmentCurrent(page.connection, attachmentGeneration);
          this.assertCaptureCurrent(page, screenshotGeneration);
          if (viewport !== this.attachment.viewport)
            throw new CdpUnavailableError("Browser viewport changed during resync");
          this.attachment.emulationAppliedPage = page;
          clip = await readClip();
          pixels = await capture(boundedQuality);
        }
        if (!matchesViewport(pixels.dimensions)) {
          throw new Error(
            `Chromium returned a ${pixels.dimensions.width}x${pixels.dimensions.height} JPEG instead of ${expectedPixels.width}x${expectedPixels.height}`,
          );
        }
        if (pixels.byteLength > maxBytes) continue;

        const frame: RuntimeFrame = {
          dataBase64: pixels.data,
          byteLength: pixels.byteLength,
          width: pixels.dimensions.width,
          height: pixels.dimensions.height,
          transport: "screenshot",
          capturedAt: new Date().toISOString(),
        };
        this.capturePolicy.rememberScreenshot(
          screenshotGeneration,
          frame,
          performance.now(),
          requestedQuality,
          maxBytes,
        );
        return frame;
      }
      throw new Error(`JPEG screenshot exceeds ${maxBytes} bytes at minimum quality`);
    } finally {
      this.capturePolicy.endScreenshot(screenshotGeneration, performance.now());
    }
  }

  /** Refuse async pixels from a superseded session or mutation, without silently replaying capture. */
  private assertCaptureCurrent(page: CdpSession, generation: number): void {
    this.attachment.assertRuntimeOpen();
    if (page !== this.attachment.page || !this.capturePolicy.isCurrent(generation)) {
      throw new CdpUnavailableError("Browser capture was invalidated while taking a screenshot");
    }
  }

  /**
   * Prepare the current page (domains, history, emulation) and start its JPEG screencast. If the
   * attached page changes during preparation it retries on the new page until the runtime timeout.
   */
  async startScreencastSession(page: CdpSession): Promise<void> {
    const deadline = Date.now() + this.attachment.timeoutMs;
    let candidate = page;
    for (;;) {
      try {
        this.attachment.assertRuntimeOpen();
        await Promise.all([candidate.send("Page.enable"), candidate.send("Runtime.enable")]);
        this.attachment.assertRuntimeOpen();
        await this.host.navigationHistory(candidate);
        this.attachment.assertRuntimeOpen();
        if (this.attachment.page !== candidate) {
          candidate = await this.host.requirePage();
          continue;
        }
        await this.host.restoreConfiguredEmulation(candidate);
        this.attachment.assertRuntimeOpen();
        if (this.attachment.page !== candidate) {
          throw new CdpUnavailableError("Browser page changed before screencast start");
        }
        await candidate.send("Page.startScreencast", this.screencastParameters(), {
          mutation: true,
        });
        this.attachment.assertRuntimeOpen();
        return;
      } catch (error) {
        this.attachment.assertRuntimeOpen();
        if (Date.now() >= deadline) throw error;
        try {
          candidate = await this.host.reattachPageForScreencast(candidate);
        } catch (reattachError) {
          this.attachment.assertRuntimeOpen();
          if (Date.now() >= deadline) throw reattachError;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, SCREENCAST_SETUP_RETRY_MS);
        await promise;
      }
    }
  }

  /**
   * `Page.startScreencast` parameters, bounded to the capture contract of the configured viewport.
   * Chromium emits screencast frames at the compositor surface size. That size follows the native
   * display scale (the runtime forces 2x for native video) and device emulation, not the configured
   * capture density: a Pixel 7 at capture scale 1 produced 824x1678 frames against a 412x839
   * contract, so `onScreencastFrame` rejected every frame and fallback could never recover.
   * Chromium scales frames down to fit these bounds and never scales up, so a frame that still
   * mismatches keeps using the bounded screenshot fallback. The viewport is read at start time;
   * every emulation change restarts the stream through `withInvalidatedScreencast`.
   */
  private screencastParameters(): Record<string, unknown> {
    const viewport = this.attachment.viewport;
    const bounds = viewport ? captureDimensions(viewport, viewport.captureScale) : null;
    return {
      format: "jpeg",
      quality: this.screencastQuality,
      everyNthFrame: 1,
      ...(bounds ? { maxWidth: bounds.width, maxHeight: bounds.height } : {}),
    };
  }

  /**
   * Run a page mutation with capture receipts invalidated, so no frame taken before it can admit
   * later input. The stream is restarted afterwards unless `preserveStream` keeps it running.
   */
  async withInvalidatedScreencast(
    mutation: (page: CdpSession) => Promise<unknown>,
    options: { preserveStream?: boolean } = {},
  ): Promise<void> {
    const releaseJpeg = this.jpegDemand.pin(false);
    try {
      const page = await this.host.requirePage();
      // Ordinary navigation is observed by the same native stream. Optional
      // capture teardown/setup must not consume the navigation ACK budget.
      const restart = this.screencastActive && !options.preserveStream;
      this.invalidateScreencastFrame();
      if (restart) await page.send("Page.stopScreencast", {}, { mutation: true });
      this.attachment.assertRuntimeOpen();
      try {
        await mutation(page);
        this.invalidateQueuedVideoFrames();
      } finally {
        this.invalidateScreencastFrame();
        if (restart && this.attachment.page === page) {
          this.attachment.assertRuntimeOpen();
          await this.host.restoreConfiguredEmulation(page);
          await this.startScreencastSession(page);
        }
      }
    } finally {
      releaseJpeg();
    }
  }

  /** Clear JPEG stream/screenshot receipts after input or transport changes. */
  invalidateScreencastFrame(): void {
    this.capturePolicy.invalidate();
    this.screencastSourceTime.invalidate(Date.now());
    this.screencastFrame = null;
    this.screencastFrameReceivedAt = null;
    this.resolveFrameWaiters(null);
  }

  /** Accept one screencast frame from its emitting session and acknowledge it to Chromium. */
  onScreencastFrame(page: CdpSession, event: ScreencastFrame): void {
    // A late frame belongs to its emitting session, even after page reattachment.
    void page
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => undefined);
    if (
      this.attachment.stopping ||
      page !== this.attachment.page ||
      !this.screencastActive ||
      this.attachment.emulationAppliedPage !== page
    )
      return;
    const dimensions = readJpegFrameDimensions(event.data);
    const viewport = this.attachment.viewport;
    // Chromium can report the new device dimensions while emitting a clipped transition image.
    // Reject those pixels and use the bounded screenshot fallback rather than mislabeling them.
    if (!viewport || !dimensions) return;
    const expectedPixels = captureDimensions(viewport, viewport.captureScale);
    if (dimensions.width !== expectedPixels.width || dimensions.height !== expectedPixels.height)
      return;
    const now = performance.now();
    const source = this.screencastSourceTime.accept(event.metadata.timestamp, Date.now(), now);
    if (!source) return;
    const { width, height } = dimensions;
    const frame: RuntimeFrame = {
      dataBase64: event.data,
      byteLength: Buffer.byteLength(event.data, "base64"),
      width,
      height,
      transport: "cdp-screencast",
      capturedAt: source.capturedAt,
    };
    this.capturePolicy.observeStream(`provider:${event.metadata.timestamp}`, now);
    this.screencastFrame = frame;
    this.screencastFrameReceivedAt = source.receivedAt;
    this.resolveFrameWaiters(frame);
  }

  private waitForFrame(waitMs: number): Promise<RuntimeFrame | null> {
    const { promise, resolve } = Promise.withResolvers<RuntimeFrame | null>();
    const timer = setTimeout(() => {
      this.screencastWaiters.delete(done);
      resolve(null);
    }, waitMs);
    const done = (frame: RuntimeFrame | null): void => {
      clearTimeout(timer);
      resolve(frame);
    };
    this.screencastWaiters.add(done);
    return promise;
  }

  private resolveFrameWaiters(frame: RuntimeFrame | null): void {
    const waiters = [...this.screencastWaiters];
    this.screencastWaiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter(frame);
  }
}
