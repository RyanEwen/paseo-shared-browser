import {
  DOM_SNAPSHOT_TTL_MS,
  domActionInputSchema,
  domEvaluateInputSchema,
  domSnapshotSchema,
} from "../shared/agent-dom";
import { agentPointerPointSchema } from "../shared/agent-pointer";
import { type BrowserState, DEVICE_PRESETS, MAX_VIEWPORT } from "../shared/browser";
import { isPrintPreviewUrl } from "../shared/browser-page";
import type { SessionPolicyContext } from "./browser-session-context";
import {
  type ApplyDevicePresetInput,
  asRecord,
  assertViewport,
  type NavigateInput,
  normalizeBrowserUrl,
  type PrintInput,
  type ResizeInput,
} from "./browser-session-types";
import { NO_PAGE_OPEN_MESSAGE } from "./empty-workspace";
import { runWithInputCleanup } from "./input-cleanup";
import { NAVIGATION_METADATA_TIMEOUT_MS } from "./navigation-budget";
import type { JsonValue } from "./runtime-protocol";

/**
 * Controlled page operations: navigation, printing, viewport and device changes, and agent DOM
 * snapshot/actions.
 */
export class PageOperations {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  /** Open real print on the exact controlled source; preview discovery stays explicit. */
  async print(input: PrintInput): Promise<{ state: BrowserState }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.requireMutationAccess(session, input);
      if (!session.canPrint)
        throw new Error(
          "Print requires an owned private desktop; select Private desktop in Graphics and apply it",
        );
      await this.context.refreshPageMetadata(session);
      this.context.leases.requireMutationAccess(session, input);
      if (isPrintPreviewUrl(session.lastUrl))
        throw new Error("Select the original page before opening print");
      await this.context.input.cancelGesture(session);
      this.context.leases.requireMutationAccess(session, input);
      try {
        await this.context.request(session, "print", {
          expectedInputGeneration: session.inputGeneration,
        });
      } finally {
        // Even an unknown modal outcome revokes old input receipts, without
        // publishing a cursor position or replaying the print request.
        this.context.frames.invalidateFrames(session);
      }
      this.context.leases.renewController(session, input.viewerToken);
      return { state: this.context.projectState(session, input.viewerToken) };
    });
  }

  async navigate(input: NavigateInput): Promise<{ state: BrowserState }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.requireMutationAccess(session, input);
      if (session.empty) {
        if (input.action.kind !== "goto") throw new Error(NO_PAGE_OPEN_MESSAGE);
        return this.context.tabs.openFromEmpty(
          session,
          input,
          normalizeBrowserUrl(input.action.url),
        );
      }
      await this.context.input.cancelGesture(session);
      const navigationGeneration = session.navigationGeneration;
      if (input.action.kind === "goto")
        await this.context.request(session, "navigate", {
          url: normalizeBrowserUrl(input.action.url),
        });
      else if (input.action.kind === "back") {
        await this.context.refreshPageMetadata(session, NAVIGATION_METADATA_TIMEOUT_MS);
        if (!session.canGoBack) throw new Error("Browser cannot go back");
        await this.context.request(session, "back", null);
      } else if (input.action.kind === "forward") {
        await this.context.refreshPageMetadata(session, NAVIGATION_METADATA_TIMEOUT_MS);
        if (!session.canGoForward) throw new Error("Browser cannot go forward");
        await this.context.request(session, "forward", null);
      } else await this.context.request(session, "reload", null);
      // One authoritative post-navigation read. Loading is browser-native; an
      // unavailable observation remains an explicit error state, not cached-ready.
      await this.context.snapshotState(session, input.viewerToken, NAVIGATION_METADATA_TIMEOUT_MS);
      if (session.navigationGeneration === navigationGeneration) session.navigationGeneration += 1;
      this.context.frames.invalidateFrames(session);
      this.context.leases.renewController(session, input.viewerToken);
      return { state: this.context.projectState(session, input.viewerToken) };
    });
  }

  /** Resize CSS layout under the control lease; panel following preserves device behavior and density. */
  async resize(input: ResizeInput): Promise<{ state: BrowserState }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.requireMutationAccess(session, input);
      await this.context.input.cancelGesture(session);
      assertViewport(input.viewport);
      const preserveEmulation = input.preserveEmulation === true;
      // Resolve automatic detail against the proposed CSS viewport before validating
      // physical bounds. A previous 2x source must not prevent a larger layout.
      const captureScale =
        session.displayDemand?.targetFor(input.viewport) ??
        input.captureDensity ??
        (preserveEmulation ? session.captureScale : 1);
      if (
        input.viewport.width * captureScale > MAX_VIEWPORT.width ||
        input.viewport.height * captureScale > MAX_VIEWPORT.height
      ) {
        throw new RangeError(
          "Viewport at the current capture density exceeds supported image bounds",
        );
      }
      if (
        session.viewport.width !== input.viewport.width ||
        session.viewport.height !== input.viewport.height ||
        session.captureScale !== captureScale ||
        (!preserveEmulation && session.devicePresetId !== null)
      ) {
        const preset = preserveEmulation
          ? DEVICE_PRESETS.find(({ id }) => id === session.devicePresetId)
          : undefined;
        await this.context.request(session, "emulate", {
          ...input.viewport,
          deviceScaleFactor: Math.max(preset?.deviceScaleFactor ?? 1, captureScale),
          captureScale,
          mobile: preset?.isMobile ?? false,
          touch: preset?.hasTouch ?? false,
          userAgent: preset?.userAgent ?? "",
          platform: preset?.platform ?? "",
        });
        session.viewport = { ...input.viewport };
        session.displayDemand?.refresh();
        session.captureScale = captureScale;
        if (!preserveEmulation) {
          session.devicePresetId = null;
          session.userAgent = session.defaultUserAgent;
        }
        session.viewportGeneration += 1;
        this.context.frames.invalidateFrames(session);
      }
      this.context.leases.renewController(session, input.viewerToken);
      return { state: await this.context.snapshotState(session, input.viewerToken) };
    });
  }

  async applyDevicePreset(input: ApplyDevicePresetInput): Promise<{ state: BrowserState }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.requireMutationAccess(session, input);
      await this.context.input.cancelGesture(session);
      const preset = DEVICE_PRESETS.find(({ id }) => id === input.presetId);
      if (!preset) throw new Error("Unknown device preset");
      // Resolve the display under the session lock. A mode toggle must neither
      // replay remembered dimensions nor change the capture's pixel resolution.
      const viewport = input.preserveDisplay ? session.viewport : preset.viewport;
      const captureScale =
        session.displayDemand?.targetFor(viewport) ??
        (input.preserveDisplay ? session.captureScale : preset.captureScale);
      await this.context.request(session, "emulate", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: Math.max(preset.deviceScaleFactor, captureScale),
        captureScale,
        mobile: preset.isMobile,
        touch: preset.hasTouch,
        userAgent: preset.userAgent ?? "",
        platform: preset.platform ?? "",
      });
      session.viewport = { ...viewport };
      session.displayDemand?.refresh();
      session.devicePresetId = preset.id;
      session.captureScale = captureScale;
      session.userAgent = preset.userAgent ?? session.defaultUserAgent;
      session.viewportGeneration += 1;
      // Emulation invalidates input geometry even when display dimensions stay
      // fixed. UA-sniffing sites can use Reload; never discard a draft automatically.
      this.context.frames.invalidateFrames(session);
      this.context.leases.renewController(session, input.viewerToken);
      return { state: await this.context.snapshotState(session, input.viewerToken) };
    });
  }

  /** Agent-only semantic observations are independent of screenshot receipt consumption. */
  async domSnapshot(viewerToken: string) {
    const session = this.context.leases.requireViewer(viewerToken);
    return this.context.serialize(session, async () => {
      if (session.empty) throw new Error(NO_PAGE_OPEN_MESSAGE);
      if (this.context.leases.policyForViewer(session, viewerToken).kind !== "agent")
        throw new Error("Agent viewer required");
      this.context.leases.heartbeatViewer(session, viewerToken);
      await this.context.refreshPageMetadata(session);
      const generation = session.inputGeneration;
      if (!generation) throw new Error("Browser document identity is unavailable");
      const expiresAt = this.context.now() + DOM_SNAPSHOT_TTL_MS;
      const snapshot = domSnapshotSchema.parse(
        await this.context.request(session, "dom.snapshot", {
          expectedInputGeneration: generation,
        }),
      );
      await this.context.refreshPageMetadata(session);
      if (generation !== session.inputGeneration || expiresAt <= this.context.now())
        throw new Error("Browser changed during DOM snapshot");
      const state = this.context.projectState(session, viewerToken);
      session.domSnapshots.set(viewerToken, {
        snapshotId: snapshot.snapshotId,
        state,
        inputGeneration: generation,
        expiresAt,
      });
      return { state, ...snapshot, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  /** Both element mutation and pure inspection require a current controller and document receipt. */
  async domOperation(
    viewerToken: string,
    controlToken: string,
    operation: "dom.action" | "dom.evaluate",
    input: JsonValue,
  ) {
    const data =
      operation === "dom.action"
        ? domActionInputSchema.parse(input)
        : domEvaluateInputSchema.parse(input);
    const session = this.context.leases.requireViewer(viewerToken);
    return this.context.serialize(session, async () => {
      if (this.context.leases.policyForViewer(session, viewerToken).kind !== "agent")
        throw new Error("Agent viewer required");
      const receipt = session.domSnapshots.get(viewerToken);
      if (
        !receipt ||
        receipt.snapshotId !== data.snapshotId ||
        receipt.expiresAt <= this.context.now()
      )
        throw new Error("DOM snapshot is stale; take a fresh snapshot in the selected tab");
      const access = { viewerToken, controlToken, expected: receipt.state };
      this.context.leases.requireMutationAccess(session, access);
      await this.context.refreshPageMetadata(session);
      this.context.leases.requireMutationAccess(session, access);
      if (receipt.inputGeneration !== session.inputGeneration)
        throw new Error("DOM document was replaced");
      await this.context.input.cancelGesture(session);
      const gestureId = this.context.issueUniqueToken();
      let result: JsonValue = null;
      try {
        await runWithInputCleanup(
          async () => {
            await this.context.request(session, "input.begin", {
              gestureId,
              expectedInputGeneration: receipt.inputGeneration,
            });
            this.context.leases.requireMutationAccess(session, access);
            result = await this.context.request(session, operation, {
              ...data,
              gestureId,
              expectedInputGeneration: receipt.inputGeneration,
            });
          },
          () => this.context.request(session, "input.end", { gestureId }),
        );
      } catch (error) {
        if (operation === "dom.action") session.domSnapshots.delete(viewerToken);
        throw error;
      } finally {
        if (operation === "dom.action") {
          this.context.frames.invalidateFrames(session);
          await this.context.request(session, "video.invalidate", null).catch(() => undefined);
        }
      }
      this.context.leases.renewController(session, viewerToken);
      if (
        operation === "dom.action" &&
        "action" in data &&
        (data.action.kind === "click" || data.action.kind === "hover")
      ) {
        const point = agentPointerPointSchema.safeParse(asRecord(result).pointer);
        if (point.success)
          this.context.input.recordAgentPointer(
            session,
            point.data,
            "semantic",
            data.action.kind === "click",
          );
      }
      return { state: await this.context.snapshotState(session, viewerToken), result };
    });
  }
}
