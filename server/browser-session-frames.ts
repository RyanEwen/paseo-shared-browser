import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type BrowserFrame,
  type BrowserState,
  canUseCaptureDensity,
  DEVICE_PRESETS,
  FRAME_MAX_BYTES,
} from "../shared/browser";
import type { browserDisplayDemandRpc } from "../shared/browser-display-demand";
import {
  type BrowserFrameAuthority,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../shared/browser-video";
import {
  type CaptureQuality,
  captureDimensions,
  DEFAULT_CAPTURE_QUALITY,
  JPEG_QUALITY,
} from "../shared/capture-settings";
import { frameMatchesBrowserContext } from "./browser-frame-context";
import { createBrowserFrameRejection } from "./browser-frame-rejection";
import type { SessionPolicyContext } from "./browser-session-context";
import {
  asRecord,
  type BrowserSession,
  type CaptureReply,
  type DensityInput,
  type FrameObservation,
  MAX_RECENT_FRAMES,
  SCREENCAST_WAIT_MS,
} from "./browser-session-types";
import { createViewerDisplayDemand, type ViewerDisplayDemand } from "./viewer-display-demand";

/**
 * Captured JPEG frames and the receipts that authorise coordinate input against them, plus
 * display demand and capture density.
 */
export class CaptureAuthority {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  async capture(
    viewerToken: string,
    quality: CaptureQuality = DEFAULT_CAPTURE_QUALITY,
    knownFrameId: string | null = null,
  ): Promise<CaptureReply> {
    const session = this.context.leases.requireViewer(viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.pruneExpired(session);
      this.context.leases.heartbeatViewer(session, viewerToken);
      // Reconcile native document identity before capturing and again before
      // issuing authority. A same-URL reload can invalidate the captured pixels.
      const before = await this.context.snapshotState(session, viewerToken);
      if (session.empty) return { state: before, frame: null };
      if (before.error) throw this.context.metadataFailure(session, before.error);
      const inputGeneration = session.inputGeneration;
      const revision = session.frameRevision;
      const frame = await this.frameForQuality(session, quality);
      const observedAt = this.context.now();
      const state = await this.context.snapshotState(session, viewerToken);
      if (state.error) throw this.context.metadataFailure(session, state.error);
      if (
        inputGeneration !== session.inputGeneration ||
        revision !== session.frameRevision ||
        !frameMatchesBrowserContext(frame, before) ||
        !frameMatchesBrowserContext(frame, state)
      ) {
        throw new Error("Browser changed during capture; request another frame");
      }
      if (
        observedAt + this.context.leases.policyForViewer(session, viewerToken).frameTtlMs <=
        this.context.now()
      ) {
        throw new Error("Browser capture expired during validation; request another frame");
      }
      this.rememberFrame(session, viewerToken, frame, undefined, observedAt);
      const policy = this.context.leases.policyForViewer(session, viewerToken);
      return {
        state,
        frame: knownFrameId === frame.frameId ? null : frame,
        ...(policy.kind === "agent"
          ? { frameExpiresAt: new Date(observedAt + policy.frameTtlMs).toISOString() }
          : {}),
      };
    });
  }

  /** Register view-only physical image demand. The viewer token binds its tab;
   * complete source fences reject late reports without acquiring browser control. */
  async reportDisplayDemand(
    input: RpcInput<typeof browserDisplayDemandRpc>,
  ): Promise<RpcOutput<typeof browserDisplayDemandRpc>> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      if (this.context.leases.requireViewer(input.viewerToken) !== session || session.archived)
        throw new Error("Browser viewer changed");
      const expected = input.expected;
      const accepted =
        expected.sessionId === session.sessionId &&
        expected.runtimeId === session.runtimeId &&
        expected.bridgeEpoch === session.bridgeEpoch &&
        expected.navigationGeneration === session.navigationGeneration &&
        expected.viewportGeneration === session.viewportGeneration &&
        !session.runtimeLost;
      if (accepted) {
        this.context.leases.heartbeatViewer(session, input.viewerToken);
        this.displayDemandFor(session).report(input.viewerToken, input.display);
      }
      return { state: this.context.projectState(session, input.viewerToken), accepted };
    });
  }

  /** Lazy demand ownership leaves legacy/agent-only sessions at their explicit density. */
  private displayDemandFor(session: BrowserSession): ViewerDisplayDemand {
    session.displayDemand ??= createViewerDisplayDemand({
      now: this.context.now,
      viewport: () => session.viewport,
      density: () => session.captureScale,
      current: () =>
        this.context.sessions.get(session.key) === session &&
        !session.archived &&
        !session.runtimeLost,
      viewerCurrent: (token) => (session.viewers.get(token)?.expiresAt ?? 0) > this.context.now(),
      apply: (density) =>
        this.context.serialize(session, async () => {
          if (
            this.context.sessions.get(session.key) !== session ||
            session.archived ||
            session.runtimeLost
          )
            return true;
          this.context.leases.pruneExpired(session);
          if (session.gesture || session.displayDemand?.target() !== density) return false;
          if (!canUseCaptureDensity(session.viewport, density)) return true;
          await this.applySourceDensity(session, density);
          if (session.notice === "Browser image scaling could not update.") session.notice = null;
          return true;
        }),
      failed: () => {
        session.notice ??= "Browser image scaling could not update.";
      },
    });
    return session.displayDemand;
  }

  /** Serialized source-only transition; callers own gesture admission and control policy. */
  private async applySourceDensity(session: BrowserSession, density: 1 | 2): Promise<void> {
    if (session.captureScale === density) return;
    const preset = DEVICE_PRESETS.find(({ id }) => id === session.devicePresetId);
    await this.context.request(session, "capture.density", {
      density,
      deviceScaleFactor: preset?.deviceScaleFactor ?? 1,
    });
    session.captureScale = density;
    session.viewportGeneration += 1;
    this.invalidateFrames(session);
  }

  /** Change physical density without navigating, switching input mode, or resizing CSS layout. */
  async setCaptureDensity(input: DensityInput): Promise<{ state: BrowserState }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.requireMutationAccess(session, input);
      const automaticDensity = session.displayDemand?.target();
      if (automaticDensity != null && automaticDensity !== input.density)
        throw new Error("Image detail follows the active viewers' displays");
      if (!canUseCaptureDensity(session.viewport, input.density))
        throw new RangeError("Capture density exceeds the supported image bounds");
      if (session.captureScale !== input.density) {
        await this.context.input.cancelGesture(session);
        await this.applySourceDensity(session, input.density);
        session.displayDemand?.refresh();
      }
      this.context.leases.renewController(session, input.viewerToken);
      return { state: await this.context.snapshotState(session, input.viewerToken) };
    });
  }

  /** Shared cached pixels retain independent human/agent observations and deadlines. */
  private frameReceiptKey(session: BrowserSession, viewerToken: string, frameId: string): string {
    return this.context.leases.policyForViewer(session, viewerToken).kind === "agent"
      ? `agent:${frameId}`
      : frameId;
  }

  /** Use the same elapsed clock as the issued receipt, including video observations. */
  private frameAge(frame: FrameObservation): number {
    return frame.observedAtMonotonicMs === undefined
      ? this.context.now() - frame.observedAt
      : this.context.monotonicNow() - frame.observedAtMonotonicMs;
  }

  requireRecentFrame(
    session: BrowserSession,
    viewerToken: string,
    target: { frameId: string; navigationGeneration: number; viewportGeneration: number },
  ): void {
    // Retain diagnostic evidence before validation prunes expired receipts.
    // An absent receipt cannot distinguish expiry from an earlier revocation.
    const frame = session.recentFrames.get(
      this.frameReceiptKey(session, viewerToken, target.frameId),
    );
    if (this.isRecentFrame(session, viewerToken, target)) return;
    if (!frame) throw createBrowserFrameRejection("admission", "missing-or-revoked");

    const ageMs = this.frameAge(frame);
    const expired =
      ageMs >= this.context.leases.policyForViewer(session, viewerToken).frameTtlMs ||
      (frame.expiresAtMonotonicMs === undefined
        ? this.context.now() >= frame.expiresAt
        : this.context.monotonicNow() >= frame.expiresAtMonotonicMs);
    const reason = expired ? "expired" : "context-changed";
    throw createBrowserFrameRejection("admission", reason, ageMs);
  }

  /** Check issued frame authority without admitting or cancelling a live channel. */
  isRecentFrame(
    session: BrowserSession,
    viewerToken: string,
    target: { frameId: string; navigationGeneration: number; viewportGeneration: number },
  ): boolean {
    this.pruneRecentFrames(session);
    const frame = session.recentFrames.get(
      this.frameReceiptKey(session, viewerToken, target.frameId),
    );
    return Boolean(
      frame &&
        this.frameAge(frame) <
          this.context.leases.policyForViewer(session, viewerToken).frameTtlMs &&
        target.navigationGeneration === session.navigationGeneration &&
        target.viewportGeneration === session.viewportGeneration &&
        frame.navigationGeneration === session.navigationGeneration &&
        frame.viewportGeneration === session.viewportGeneration,
    );
  }

  private pruneRecentFrames(session: BrowserSession): void {
    const now = this.context.now();
    const monotonicNow = this.context.monotonicNow();
    for (const [id, frame] of session.recentFrames) {
      const expired =
        frame.expiresAtMonotonicMs === undefined
          ? frame.expiresAt <= now
          : frame.expiresAtMonotonicMs <= monotonicNow;
      if (expired) session.recentFrames.delete(id);
    }
  }

  invalidateFrames(session: BrowserSession): void {
    session.frameRevision += 1;
    session.videoNotBefore = this.context.monotonicNow();
    session.videoInputNotBefore = session.videoNotBefore;
    session.frameCache.clear();
    session.recentFrames.clear();
    session.videoReceipts.clear();
  }

  private async frameForQuality(
    session: BrowserSession,
    quality: CaptureQuality,
  ): Promise<BrowserFrame> {
    const cached = session.frameCache.get(quality);
    if (
      cached &&
      frameMatchesBrowserContext(cached.frame, session) &&
      this.context.now() - cached.cachedAt <= this.context.frameCacheMs
    )
      return cached.frame;
    const generation = {
      sessionId: session.sessionId,
      runtimeId: session.runtimeId,
      captureEpoch: session.bridgeEpoch,
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
    };
    const raw = asRecord(
      await this.context.request(session, "frame", {
        maxBytes: FRAME_MAX_BYTES,
        quality: JPEG_QUALITY[quality],
        waitMs: SCREENCAST_WAIT_MS,
      }),
    );
    if (!frameMatchesBrowserContext(generation, session))
      throw new Error("Browser changed during capture; request another frame");
    const byteLength = Number(raw.byteLength);
    const dataBase64 = String(raw.dataBase64 ?? "");
    if (
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > FRAME_MAX_BYTES ||
      Buffer.byteLength(dataBase64, "base64") !== byteLength
    )
      throw new Error("Browser returned an invalid frame");
    const expectedPixels = captureDimensions(session.viewport, session.captureScale);
    if (Number(raw.width) !== expectedPixels.width || Number(raw.height) !== expectedPixels.height)
      throw new Error("Browser returned a frame for a stale viewport");

    // Runtime fallback receipts remain fresh for at most one second. A 100ms
    // policy-cache expiry must not create a new token and resend the same large
    // JPEG at every poll. Reuse only its exact receipt, not merely equal pixels.
    if (
      cached &&
      typeof raw.capturedAt === "string" &&
      Number.isFinite(Date.parse(raw.capturedAt)) &&
      (raw.transport === "screenshot" || raw.transport === "cdp-screencast") &&
      session.frameCache.get(quality) === cached &&
      cached.frame.sessionId === generation.sessionId &&
      cached.frame.runtimeId === generation.runtimeId &&
      cached.frame.captureEpoch === generation.captureEpoch &&
      cached.frame.navigationGeneration === generation.navigationGeneration &&
      cached.frame.viewportGeneration === generation.viewportGeneration &&
      (["dataBase64", "byteLength", "width", "height", "capturedAt", "transport"] as const).every(
        (key) => cached.rawFrame[key] === raw[key],
      )
    ) {
      cached.cachedAt = this.context.now();
      return cached.frame;
    }

    const frame: BrowserFrame = {
      frameId: this.context.issueUniqueToken(),
      mimeType: "image/jpeg",
      transport: raw.transport === "cdp-screencast" ? "cdp-screencast" : "screenshot",
      dataBase64,
      byteLength,
      width: Number(raw.width),
      height: Number(raw.height),
      ...generation,
      capturedAt: String(raw.capturedAt),
    };
    session.frameCache.set(quality, { frame, cachedAt: this.context.now(), rawFrame: { ...raw } });
    return frame;
  }

  /** Native source clocks have bounded uncertainty. Displaying a late packet
   * must never resurrect the press token revoked by acknowledged live input.
   * JPEG receipts retain the runtime's existing post-input capture-generation fence. */
  rememberFrame(
    session: BrowserSession,
    viewerToken: string,
    frame: BrowserFrameAuthority,
    capturedAtMonotonicMs?: number,
    observedAt = this.context.now(),
  ): boolean {
    if (capturedAtMonotonicMs !== undefined && session.videoInputNotBefore !== null) {
      const exclusiveFloor = session.videoInputNotBefore + VIDEO_SOURCE_CLOCK_TOLERANCE_MS;
      if (!Number.isFinite(capturedAtMonotonicMs) || capturedAtMonotonicMs <= exclusiveFloor) {
        session.recentFrames.delete(this.frameReceiptKey(session, viewerToken, frame.frameId));
        return false;
      }
    }
    this.pruneRecentFrames(session);
    const frameTtlMs = this.context.leases.policyForViewer(session, viewerToken).frameTtlMs;
    const observedAtMonotonicMs = this.context.monotonicNow();
    const receiptKey = this.frameReceiptKey(session, viewerToken, frame.frameId);
    session.recentFrames.set(receiptKey, {
      observedAt,
      navigationGeneration: frame.navigationGeneration,
      viewportGeneration: frame.viewportGeneration,
      expiresAt: observedAt + frameTtlMs,
      ...(capturedAtMonotonicMs === undefined
        ? {}
        : {
            observedAtMonotonicMs,
            expiresAtMonotonicMs: observedAtMonotonicMs + frameTtlMs,
          }),
    });
    while (session.recentFrames.size > MAX_RECENT_FRAMES) {
      const oldest = session.recentFrames.keys().next().value;
      if (!oldest) break;
      session.recentFrames.delete(oldest);
    }
    return session.recentFrames.has(receiptKey);
  }
}
