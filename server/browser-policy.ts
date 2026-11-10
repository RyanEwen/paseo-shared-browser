import type { BrowserState } from "../shared/browser";
import { SessionPolicyContext } from "./browser-session-context";
import type { CaptureAuthority } from "./browser-session-frames";
import type { InputDispatch } from "./browser-session-input";
import type { ViewerLeases } from "./browser-session-leases";
import type { PageOperations } from "./browser-session-page";
import type { SessionRegistry } from "./browser-session-registry";
import type { TabLifecycle } from "./browser-session-tabs";
import type { SessionManagerOptions } from "./browser-session-types";
import type { VideoReads } from "./browser-session-video";
import { AGENT_VIEWER_POLICY } from "./browser-viewer-policy";

export {
  type BrowserRuntimeClient,
  type BrowserRuntimeMutationGuard,
  FirstPageNavigationError,
  normalizeBrowserUrl,
  type SessionManagerOptions,
  type WorkspaceValidator,
} from "./browser-session-types";

/**
 * The browser session policy: every viewer, agent and supervisor operation on workspace
 * browsers passes through here.
 *
 * This facade keeps the public method set stable. The policy itself is split by
 * responsibility and shares one `SessionPolicyContext`: sessions (`SessionRegistry`), viewer
 * and control leases (`ViewerLeases`), tabs (`TabLifecycle`), controlled page operations
 * (`PageOperations`), captured frames and their input receipts (`CaptureAuthority`), native
 * video (`VideoReads`) and input (`InputDispatch`).
 */
export class SessionManager {
  private readonly context: SessionPolicyContext;

  constructor(options: SessionManagerOptions) {
    this.context = new SessionPolicyContext(options);
  }

  /**
   * `replaceLost` is internal authority held only by the supervisor's explicit human attach
   * path. It lets this call replace a workspace runtime that reported it was lost (before or
   * while attaching) exactly once; every other caller observes the lost session without
   * restarting it.
   */
  attach(
    workspaceId: string,
    viewerLabel: string,
    tabId?: string,
    options: { replaceLost?: boolean } = {},
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    return this.context.registry.attachWithPolicy(
      workspaceId,
      viewerLabel,
      tabId,
      options,
      this.context.humanViewerPolicy,
    );
  }

  /** Internal agent route; viewer labels and public attach payloads never select this policy. */
  attachAgent(workspaceId: string, viewerLabel: string, tabId?: string) {
    return this.context.registry.attachWithPolicy(
      workspaceId,
      viewerLabel,
      tabId,
      {},
      AGENT_VIEWER_POLICY,
    );
  }

  connect(...args: Parameters<SessionRegistry["connect"]>): ReturnType<SessionRegistry["connect"]> {
    return this.context.registry.connect(...args);
  }

  setBridgeEpoch(
    ...args: Parameters<SessionRegistry["setBridgeEpoch"]>
  ): ReturnType<SessionRegistry["setBridgeEpoch"]> {
    return this.context.registry.setBridgeEpoch(...args);
  }

  detach(...args: Parameters<ViewerLeases["detach"]>): ReturnType<ViewerLeases["detach"]> {
    return this.context.leases.detach(...args);
  }

  /** Enumerate pages in this viewer's workspace without changing any selected page. */
  listTabs(...args: Parameters<TabLifecycle["listTabs"]>): ReturnType<TabLifecycle["listTabs"]> {
    return this.context.tabs.listTabs(...args);
  }

  /** Expose tab metadata to a client only through its active viewer lease. */
  listTabsForViewer(
    ...args: Parameters<TabLifecycle["listTabsForViewer"]>
  ): ReturnType<TabLifecycle["listTabsForViewer"]> {
    return this.context.tabs.listTabsForViewer(...args);
  }

  /** A new blank page shares the workspace profile but does not change any viewer's selection. */
  createTab(...args: Parameters<TabLifecycle["createTab"]>): ReturnType<TabLifecycle["createTab"]> {
    return this.context.tabs.createTab(...args);
  }

  /** Close the confirmed page, or the whole workspace only with explicit final-tab authority. */
  closeTab(...args: Parameters<TabLifecycle["closeTab"]>): ReturnType<TabLifecycle["closeTab"]> {
    return this.context.tabs.closeTab(...args);
  }

  /** Stop one runtime and invalidate every viewer without archiving its workspace or profile. */
  closeBrowser(
    ...args: Parameters<TabLifecycle["closeBrowser"]>
  ): ReturnType<TabLifecycle["closeBrowser"]> {
    return this.context.tabs.closeBrowser(...args);
  }

  /** Only an explicit human reopen removes the close fence used by viewer and agent attach. */
  reopenBrowser(
    ...args: Parameters<TabLifecycle["reopenBrowser"]>
  ): ReturnType<TabLifecycle["reopenBrowser"]> {
    return this.context.tabs.reopenBrowser(...args);
  }

  archiveWorkspace(
    ...args: Parameters<SessionRegistry["archiveWorkspace"]>
  ): ReturnType<SessionRegistry["archiveWorkspace"]> {
    return this.context.registry.archiveWorkspace(...args);
  }

  /** List retained browser sessions even after their last viewer leaves or expires. */
  listOpenWorkspaceIds(
    ...args: Parameters<SessionRegistry["listOpenWorkspaceIds"]>
  ): ReturnType<SessionRegistry["listOpenWorkspaceIds"]> {
    return this.context.registry.listOpenWorkspaceIds(...args);
  }

  status(...args: Parameters<ViewerLeases["status"]>): ReturnType<ViewerLeases["status"]> {
    return this.context.leases.status(...args);
  }

  capture(
    ...args: Parameters<CaptureAuthority["capture"]>
  ): ReturnType<CaptureAuthority["capture"]> {
    return this.context.frames.capture(...args);
  }

  /** Register view-only physical image demand. The viewer token binds its tab;
   * complete source fences reject late reports without acquiring browser control. */
  reportDisplayDemand(
    ...args: Parameters<CaptureAuthority["reportDisplayDemand"]>
  ): ReturnType<CaptureAuthority["reportDisplayDemand"]> {
    return this.context.frames.reportDisplayDemand(...args);
  }

  /** Change physical density without navigating, switching input mode, or resizing CSS layout. */
  setCaptureDensity(
    ...args: Parameters<CaptureAuthority["setCaptureDensity"]>
  ): ReturnType<CaptureAuthority["setCaptureDensity"]> {
    return this.context.frames.setCaptureDensity(...args);
  }

  /**
   * Wait outside mutation serialization. Normal media reads use cached policy
   * state and native generation fences. A newly observed native document needs
   * one bounded reconciliation because video viewers may not request JPEG/status.
   * The transition read never admits packets, even after reconciliation succeeds.
   */
  readVideo(...args: Parameters<VideoReads["readVideo"]>): ReturnType<VideoReads["readVideo"]> {
    return this.context.video.readVideo(...args);
  }

  acquireControl(
    ...args: Parameters<ViewerLeases["acquireControl"]>
  ): ReturnType<ViewerLeases["acquireControl"]> {
    return this.context.leases.acquireControl(...args);
  }

  releaseControl(
    ...args: Parameters<ViewerLeases["releaseControl"]>
  ): ReturnType<ViewerLeases["releaseControl"]> {
    return this.context.leases.releaseControl(...args);
  }

  /** Open real print on the exact controlled source; preview discovery stays explicit. */
  print(...args: Parameters<PageOperations["print"]>): ReturnType<PageOperations["print"]> {
    return this.context.page.print(...args);
  }

  navigate(
    ...args: Parameters<PageOperations["navigate"]>
  ): ReturnType<PageOperations["navigate"]> {
    return this.context.page.navigate(...args);
  }

  /** Resize CSS layout under the control lease; panel following preserves device behavior and density. */
  resize(...args: Parameters<PageOperations["resize"]>): ReturnType<PageOperations["resize"]> {
    return this.context.page.resize(...args);
  }

  applyDevicePreset(
    ...args: Parameters<PageOperations["applyDevicePreset"]>
  ): ReturnType<PageOperations["applyDevicePreset"]> {
    return this.context.page.applyDevicePreset(...args);
  }

  /** Agent-only semantic observations are independent of screenshot receipt consumption. */
  domSnapshot(
    ...args: Parameters<PageOperations["domSnapshot"]>
  ): ReturnType<PageOperations["domSnapshot"]> {
    return this.context.page.domSnapshot(...args);
  }

  /** Both element mutation and pure inspection require a current controller and document receipt. */
  domOperation(
    ...args: Parameters<PageOperations["domOperation"]>
  ): ReturnType<PageOperations["domOperation"]> {
    return this.context.page.domOperation(...args);
  }

  sendInput(
    ...args: Parameters<InputDispatch["sendInput"]>
  ): ReturnType<InputDispatch["sendInput"]> {
    return this.context.input.sendInput(...args);
  }

  /**
   * Admit one human channel from a decoded frame receipt that is still fresh.
   * A receipt is bounded by its TTL and cleared by acknowledged input; an idle
   * reopen therefore needs new pixels, never a retained earlier admission. Native
   * begin pins the attachment/document. This never admits agent input.
   */
  beginGesture(
    ...args: Parameters<InputDispatch["beginGesture"]>
  ): ReturnType<InputDispatch["beginGesture"]> {
    return this.context.input.beginGesture(...args);
  }

  /**
   * Continue an admitted human channel independently of decoded-frame catchup.
   * Exact control/document/geometry/native checks fence every ordered packet, and
   * every new press (mouse down or first touch contact) needs its own fresh decoded
   * receipt. Held motion and releases reuse the channel. Uncertain publication
   * revokes observations and is never replayed.
   */
  updateGesture(
    ...args: Parameters<InputDispatch["updateGesture"]>
  ): ReturnType<InputDispatch["updateGesture"]> {
    return this.context.input.updateGesture(...args);
  }

  /** Cancellation releases only this channel, even after a lost update reply or navigation drift. */
  endGesture(
    ...args: Parameters<InputDispatch["endGesture"]>
  ): ReturnType<InputDispatch["endGesture"]> {
    return this.context.input.endGesture(...args);
  }

  reset(...args: Parameters<SessionRegistry["reset"]>): ReturnType<SessionRegistry["reset"]> {
    return this.context.registry.reset(...args);
  }

  disconnect(
    ...args: Parameters<SessionRegistry["disconnect"]>
  ): ReturnType<SessionRegistry["disconnect"]> {
    return this.context.registry.disconnect(...args);
  }
}
