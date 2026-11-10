import { type BrowserState, type BrowserTab, browserTabSchema } from "../shared/browser";
import { browserPageTitle } from "../shared/browser-page";
import type { SessionPolicyContext } from "./browser-session-context";
import {
  asRecord,
  type BrowserSession,
  boundedText,
  type CloseInput,
  type CloseTabInput,
  FirstPageNavigationError,
  type NavigateInput,
  normalizeBrowserUrl,
} from "./browser-session-types";
import { RuntimeProtocolError } from "./runtime-protocol";

/**
 * Tab lifecycle: listing, creating, closing a tab or the whole browser, reopening, and opening
 * the first page from an empty workspace.
 */
export class TabLifecycle {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  /** Enumerate pages in this viewer's workspace without changing any selected page. */
  async listTabs(workspaceId: string): Promise<{ tabs: BrowserTab[] }> {
    if (this.context.deliberatelyClosed.has(workspaceId)) throw new Error("Browser is closed");
    const targets = await this.context.client.requestWorkspace(workspaceId, "tabs.list", null);
    if (!Array.isArray(targets)) throw new Error("Browser returned an invalid tab list");
    const tabs = await Promise.all(
      targets.map(async (target) => {
        const value = asRecord(target);
        const tabId = browserTabSchema.shape.id.parse(value.targetId);
        const session = [...this.context.sessions.values()].find(
          (candidate) => candidate.workspaceId === workspaceId && candidate.tabId === tabId,
        );
        const presence = session
          ? await this.context.serialize(session, async () => {
              this.context.leases.pruneExpired(session);
              const controllerToken = session.controller?.viewerToken;
              return {
                viewerCount: session.viewers.size,
                controllerLabel: controllerToken
                  ? (session.viewers.get(controllerToken)?.label ?? null)
                  : null,
              };
            })
          : { viewerCount: 0, controllerLabel: null };
        return browserTabSchema.parse({
          id: tabId,
          title: boundedText(
            browserPageTitle(String(value.title ?? ""), String(value.url ?? "")),
            1_024,
          ),
          url: boundedText(String(value.url ?? ""), 8_192),
          ...presence,
        });
      }),
    );
    return { tabs };
  }

  /** Expose tab metadata to a client only through its active viewer lease. */
  async listTabsForViewer(viewerToken: string): Promise<{ tabs: BrowserTab[] }> {
    const session = this.context.leases.requireViewer(viewerToken);
    const listed = await this.listTabs(session.workspaceId);
    // The lease may have lapsed while the runtime answered; never return metadata then.
    let current = false;
    try {
      current = this.context.leases.requireViewer(viewerToken) === session && !session.archived;
    } catch {
      current = false;
    }
    if (!current) throw new Error("Browser viewer attachment changed while listing tabs");
    return listed;
  }

  /** A new blank page shares the workspace profile but does not change any viewer's selection. */
  async createTab(viewerToken: string): Promise<{ tabId: string }> {
    const { tabId } = await this.openTab(viewerToken, null);
    return { tabId };
  }

  /**
   * Create one page, blank or at a normalized URL, after rechecking the viewer (and the caller's
   * `beforeOpen` fence) immediately before publication. Once the page exists, a lost fence is an
   * unknown outcome so a recovering caller never creates it twice. A first page whose navigation
   * failed still exists and is returned with `navigationError`.
   */
  private async openTab(
    viewerToken: string,
    url: string | null,
    beforeOpen?: () => void,
  ): Promise<{ tabId: string; navigationError?: { message: string; unknown: boolean } }> {
    const session = this.context.leases.requireViewer(viewerToken);
    const assertCurrent = () => {
      if (this.context.leases.requireViewer(viewerToken) !== session || session.archived)
        throw new Error("Browser viewer attachment changed before tab creation");
      beforeOpen?.();
    };
    assertCurrent();
    const value = asRecord(
      await this.context.request(
        session,
        url === null ? "tabs.create" : "tabs.open",
        url === null ? null : { url: normalizeBrowserUrl(url) },
        { runtimeId: session.runtimeId, assertCurrent },
      ),
    );

    let current = false;
    try {
      assertCurrent();
      current = true;
    } catch {
      current = false;
    }
    if (!current)
      throw new RuntimeProtocolError(
        "UNKNOWN_OUTCOME",
        "Browser viewer attachment changed during tab creation; inspect tabs before another action",
      );
    const tabId = browserTabSchema.shape.id.parse(value.targetId);
    if (typeof value.navigationError !== "string") return { tabId };
    return {
      tabId,
      navigationError: {
        message: value.navigationError,
        unknown: value.navigationUnknown === true,
      },
    };
  }

  /** Close the confirmed page, or the whole workspace only with explicit final-tab authority. */
  async closeTab(input: CloseTabInput): Promise<{ closed: true; browserClosed: boolean }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    if (input.scope === "last-tab") {
      if (!input.controlToken)
        throw new Error("Browser control is required to close the final tab");
      await this.closeBrowser({ ...input, controlToken: input.controlToken }, input.tabId);
      return { closed: true, browserClosed: true };
    }
    return this.context.serialize(session, async () => {
      // Tab management needs an active viewer, independently of page input control.
      // Recheck after cleanup and again at native publication, including time in queues.
      const assertCurrent = () => {
        if (
          this.context.leases.requireViewer(input.viewerToken) !== session ||
          session.archived ||
          session.tabId !== input.tabId ||
          session.sessionId !== input.sessionId ||
          session.runtimeId !== input.runtimeId
        )
          throw new Error("Browser tab selection is stale");
      };
      assertCurrent();
      await this.context.input.cancelGesture(session);
      assertCurrent();
      await this.context.request(
        session,
        "tabs.close",
        { targetId: input.tabId },
        {
          runtimeId: input.runtimeId,
          assertCurrent,
        },
      );
      for (const [token, expiresAt] of this.context.closedViewerTabs) {
        if (expiresAt <= this.context.now()) this.context.closedViewerTabs.delete(token);
      }
      this.context.registry.retireSession(session, (token, viewer) => {
        this.context.closedViewerTabs.set(token, this.context.now() + viewer.policy.viewerTtlMs);
      });
      this.context.sessions.delete(session.key);
      return { closed: true, browserClosed: false };
    });
  }

  /** Stop one runtime and invalidate every viewer without archiving its workspace or profile. */
  async closeBrowser(input: CloseInput, onlyTabId?: string): Promise<{ closed: true }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    const closing = this.context.serialize(session, async () => {
      if (session.empty) throw new Error("Select a browser tab before closing the shared browser");
      this.context.leases.requireController(session, input.viewerToken, input.controlToken);
      if (session.sessionId !== input.sessionId || session.runtimeId !== input.runtimeId)
        throw new Error("Browser session is stale");
      if (onlyTabId && session.tabId !== onlyTabId)
        throw new Error("Browser tab selection is stale");
      if (onlyTabId && !this.context.client.closeLastTab)
        throw new Error("Final-tab browser close is unavailable in this runtime");

      const workspaceSessions = [...this.context.sessions.values()].filter(
        (candidate) => candidate.workspaceId === session.workspaceId,
      );
      // Cleanup can enqueue native releases, so finish it before entering the
      // supervisor's atomic check/stop. A refused guard keeps all viewers usable.
      for (const candidate of workspaceSessions) await this.context.input.cancelGesture(candidate);
      let closingStarted = false;
      const onClosing = () => {
        // The guard may have waited behind queued work or a CDP target read.
        // Expired/revoked authority must refuse before any viewer is invalidated.
        if (this.context.leases.requireViewer(input.viewerToken) !== session || session.archived)
          throw new Error("Browser session is stale");
        this.context.leases.requireController(session, input.viewerToken, input.controlToken);
        closingStarted = true;
        this.context.deliberatelyClosed.add(session.workspaceId);
        for (const candidate of workspaceSessions) {
          this.context.registry.retireSession(candidate, (token) => {
            this.context.closedViewerWorkspaces.set(token, session.workspaceId);
          });
        }
      };
      try {
        if (onlyTabId) {
          await this.context.client.closeLastTab!(
            session.workspaceId,
            session.runtimeId,
            onlyTabId,
            onClosing,
          );
        } else {
          onClosing();
          await this.context.client.closeWorkspace(session.workspaceId, session.runtimeId);
        }
      } finally {
        if (closingStarted)
          for (const candidate of workspaceSessions) this.context.sessions.delete(candidate.key);
      }
    });
    this.context.sessionClosures.set(session.workspaceId, closing);
    try {
      await closing;
      return { closed: true };
    } finally {
      if (this.context.sessionClosures.get(session.workspaceId) === closing)
        this.context.sessionClosures.delete(session.workspaceId);
    }
  }

  /** Only an explicit human reopen removes the close fence used by viewer and agent attach. */
  async reopenBrowser(workspaceId: string): Promise<{ opened: true }> {
    this.context.assertOpen();
    const validation = await this.context.validateWorkspace(workspaceId);
    if (validation === false) throw new Error("Workspace not found");
    const closing = this.context.sessionClosures.get(workspaceId);
    if (closing) await closing.catch(() => undefined);
    this.context.deliberatelyClosed.delete(workspaceId);
    try {
      await this.context.registry.getOrCreateSession(workspaceId);
    } catch (error) {
      this.context.deliberatelyClosed.add(workspaceId);
      throw error;
    }
    for (const [token, closedWorkspaceId] of this.context.closedViewerWorkspaces)
      if (closedWorkspaceId === workspaceId) this.context.closedViewerWorkspaces.delete(token);
    return { opened: true };
  }

  /** Move only this empty viewer to its explicitly created page after all awaited startup work.
   * Its lease and control must still be current; a published page is never replayed on refusal.
   */
  async openFromEmpty(session: BrowserSession, input: NavigateInput, url: string) {
    const assertCurrent = () => {
      if (
        this.context.leases.requireViewer(input.viewerToken) !== session ||
        !session.empty ||
        session.archived
      )
        throw new Error("Browser viewer or selection changed during first page open");
      this.context.leases.requireMutationAccess(session, input);
    };
    const created = await this.openTab(input.viewerToken, url, assertCurrent);

    let state: BrowserState;
    try {
      const page = await this.context.registry.getOrCreateSession(
        session.workspaceId,
        created.tabId,
        false,
        assertCurrent,
      );
      state = await this.context.serialize(page, async () => {
        assertCurrent();
        this.context.leases.pruneExpired(page);
        if (page.controller)
          throw new Error("The new page is already controlled by another viewer");
        this.context.registry.moveViewer(session, page, input.viewerToken);
        this.context.frames.invalidateFrames(session);
        this.context.frames.invalidateFrames(page);
        this.context.leases.renewController(page, input.viewerToken);
        return this.context.projectState(page, input.viewerToken);
      });
    } catch {
      throw new RuntimeProtocolError(
        "UNKNOWN_OUTCOME",
        "First page was opened but viewer publication changed; inspect tabs before another action",
      );
    }

    // The viewer now owns the page; an unreachable destination is an ordinary navigation error.
    if (created.navigationError)
      throw new FirstPageNavigationError(
        created.navigationError.message,
        state,
        created.navigationError.unknown,
      );
    return { state };
  }
}
