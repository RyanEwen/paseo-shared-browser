import { type BrowserState, browserTabSchema, DEFAULT_VIEWPORT } from "../shared/browser";
import { browserGraphicsStateSchema } from "../shared/browser-graphics";
import type { SessionPolicyContext } from "./browser-session-context";
import {
  asRecord,
  type BrowserSession,
  boundedText,
  MAX_VIEWERS_PER_SESSION,
  type Viewer,
} from "./browser-session-types";
import type { BrowserViewerPolicy } from "./browser-viewer-policy";
import type { JsonValue } from "./runtime-protocol";

/**
 * Browser sessions by workspace and tab: creation, attachment, lost-runtime replacement,
 * retirement and viewer moves between sessions.
 */
export class SessionRegistry {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  async connect(): Promise<void> {
    const lease = await this.context.client.connect();
    this.context.bridgeEpoch = lease.epoch;
  }

  setBridgeEpoch(epoch: number): void {
    this.context.bridgeEpoch = epoch;
    for (const session of this.context.sessions.values()) {
      if (session.bridgeEpoch !== epoch) {
        void this.context.input.cancelGesture(session);
        // A new bridge cannot admit a token issued by the previous attachment.
        this.context.frames.invalidateFrames(session);
      }
      session.bridgeEpoch = epoch;
    }
  }

  async attachWithPolicy(
    workspaceId: string,
    viewerLabel: string,
    tabId: string | undefined,
    options: { replaceLost?: boolean },
    policy: BrowserViewerPolicy,
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    this.context.assertOpen();
    const label = viewerLabel.trim();
    if (!label || label.length > 64) throw new Error("Viewer label is invalid");
    const validation = await this.context.validateWorkspace(workspaceId);
    if (validation === false) throw new Error("Workspace not found");
    this.context.assertOpen();
    const replaceLost = options.replaceLost === true;
    let session = await this.getOrCreateSession(workspaceId, tabId, replaceLost);
    let replaced = false;
    if (session.runtimeLost && replaceLost) {
      session = await this.replaceLostRuntime(session);
      replaced = true;
    }
    const attached = await this.attachViewer(session, label, policy);
    if (session.runtimeLost && replaceLost && !replaced) {
      // The loss was first observed by this very attach. One fenced replacement, no input replay.
      session = await this.replaceLostRuntime(session);
      return this.attachViewer(session, label, policy);
    }
    return attached;
  }

  /**
   * Discards every page session of the dead workspace runtime behind fresh session and
   * runtime ids; nothing is replayed. Page ids belong to the old browser, so the
   * replacement attaches to the new browser's launch page.
   */
  private async replaceLostRuntime(lost: BrowserSession): Promise<BrowserSession> {
    for (const candidate of [...this.context.sessions.values()]) {
      if (candidate.workspaceId !== lost.workspaceId) continue;
      await this.context.input.cancelGesture(candidate);
      this.retireSession(candidate);
      this.context.sessions.delete(candidate.key);
    }
    return this.getOrCreateSession(lost.workspaceId, undefined, true);
  }

  private attachViewer(
    session: BrowserSession,
    label: string,
    policy: BrowserViewerPolicy,
  ): Promise<{ viewerToken: string; state: BrowserState }> {
    return this.context.serialize(session, async () => {
      if (session.archived) throw new Error("Browser session is closed");
      this.context.leases.pruneExpired(session);
      if (session.viewers.size >= MAX_VIEWERS_PER_SESSION)
        throw new Error(`Shared browser viewer limit (${MAX_VIEWERS_PER_SESSION}) reached`);
      const viewerToken = this.context.issueUniqueToken();
      session.viewers.set(viewerToken, {
        label,
        policy,
        expiresAt: this.context.now() + policy.viewerTtlMs,
      });
      this.context.viewerSessions.set(viewerToken, session);
      // Actual image reads lazily own JPEG capture. Attaching a desktop video
      // viewer or an agent doing status-only work does not start a second stream.
      try {
        return { viewerToken, state: await this.context.snapshotState(session, viewerToken) };
      } catch (error) {
        session.viewers.delete(viewerToken);
        this.context.viewerSessions.delete(viewerToken);
        throw error;
      }
    });
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.context.assertOpen();
    this.context.archived.add(workspaceId);
    await this.context.client.archiveWorkspace(workspaceId);
    const pending = [...this.context.sessionCreations.entries()]
      .filter(([key]) => key === workspaceId || key.startsWith(`${workspaceId}/`))
      .map(([, creation]) => creation);
    await Promise.allSettled(pending);
    for (const session of this.context.sessions.values()) {
      if (session.workspaceId !== workspaceId) continue;
      await this.context.input.cancelGesture(session);
      this.retireSession(session);
      this.context.sessions.delete(session.key);
    }
  }

  /** List retained browser sessions even after their last viewer leaves or expires. */
  async listOpenWorkspaceIds(): Promise<string[]> {
    this.context.assertOpen();
    const result = new Set<string>();
    for (const session of this.context.sessions.values()) {
      await this.context.serialize(session, async () => {
        this.context.leases.pruneExpired(session);
        // Viewer leases control access and capture, not the lifetime of the browser.
        // Keep an idle browser discoverable so another device can reattach to it.
        // An empty reservation runs no browser, so it is not listed as open.
        if (!session.archived && !session.empty) result.add(session.workspaceId);
      });
    }
    return [...result];
  }

  /**
   * Move one viewer attachment, and its control when it holds it, to another page session of
   * the same workspace. Enforces the destination's viewer limit.
   */
  moveViewer(from: BrowserSession, to: BrowserSession, viewerToken: string): void {
    const viewer = from.viewers.get(viewerToken);
    if (!viewer) throw new Error("Browser viewer attachment changed");
    if (to.viewers.size >= MAX_VIEWERS_PER_SESSION)
      throw new Error(`Shared browser viewer limit (${MAX_VIEWERS_PER_SESSION}) reached`);
    this.releaseViewerState(from, viewerToken);
    from.viewers.delete(viewerToken);
    to.viewers.set(viewerToken, viewer);
    if (from.controller?.viewerToken === viewerToken) {
      to.controller = from.controller;
      from.controller = null;
    }
    this.context.viewerSessions.set(viewerToken, to);
  }

  /**
   * End a page session: stop its media, detach every viewer and drop control. `onViewer` lets a
   * caller record why each viewer ended. Gesture cancellation and removal from the session map
   * stay with callers, whose ordering differs (closeBrowser defers removal until close starts).
   */
  retireSession(
    session: BrowserSession,
    onViewer?: (viewerToken: string, viewer: Viewer) => void,
  ): void {
    session.archived = true;
    session.videoLifetime?.cancel();
    session.displayDemand?.dispose();
    for (const [token, viewer] of session.viewers) {
      this.context.viewerSessions.delete(token);
      onViewer?.(token, viewer);
    }
    session.viewers.clear();
    session.controller = null;
  }

  /** Drop per-viewer state a page session keeps outside its viewer map. */
  releaseViewerState(session: BrowserSession, viewerToken: string): void {
    session.domSnapshots.delete(viewerToken);
    session.displayDemand?.remove(viewerToken);
  }

  reset(): void {
    this.context.lifecycleGeneration += 1;
    for (const session of this.context.sessions.values()) {
      session.videoLifetime?.cancel();
      session.displayDemand?.dispose();
      void this.context.input.cancelGesture(session);
    }
    this.context.sessions.clear();
    this.context.sessionCreations.clear();
    this.context.viewerSessions.clear();
    this.context.closedViewerWorkspaces.clear();
    this.context.closedViewerTabs.clear();
  }

  disconnect(): void {
    if (this.context.closed) return;
    this.context.closed = true;
    this.context.client.disconnect();
    this.reset();
  }

  async getOrCreateSession(
    workspaceId: string,
    tabId?: string,
    replaceLost = false,
    beforePageMutation?: () => void,
  ): Promise<BrowserSession> {
    if (this.context.archived.has(workspaceId)) throw new Error("Workspace was archived");
    const closing = this.context.sessionClosures.get(workspaceId);
    if (closing) await closing.catch(() => undefined);
    if (this.context.deliberatelyClosed.has(workspaceId)) throw new Error("Browser is closed");
    const existing = [...this.context.sessions.values()].find(
      (session) => session.workspaceId === workspaceId && (!tabId || session.tabId === tabId),
    );
    if (existing) {
      if (existing.empty && !existing.runtimeLost && !tabId) {
        // Another viewer may have explicitly opened a page since this empty
        // attachment was created. New attachments use normal page discovery;
        // existing empty viewers keep their independent selection.
        let targets: JsonValue;
        try {
          targets = await this.context.request(existing, "tabs.list", null);
        } catch (error) {
          if (existing.runtimeLost) return existing;
          throw error;
        }
        if (Array.isArray(targets) && targets.length) {
          const target = asRecord(targets[0]!);
          return this.getOrCreateSession(
            workspaceId,
            browserTabSchema.shape.id.parse(target.targetId),
            replaceLost,
          );
        }
      }
      return existing;
    }

    // The launch page has no known target ID until identity returns. Wait for
    // another first attachment before deciding whether this target needs a
    // second policy session, so control and presence cannot split in two.
    const workspaceCreation = [...this.context.sessionCreations.entries()].find(
      ([pendingKey]) => pendingKey === workspaceId || pendingKey.startsWith(`${workspaceId}/`),
    )?.[1];
    if (workspaceCreation) {
      await workspaceCreation.catch(() => undefined);
      return this.getOrCreateSession(workspaceId, tabId, replaceLost, beforePageMutation);
    }
    const key = tabId ? `${workspaceId}/${tabId}` : workspaceId;
    if (this.context.sessions.size + this.context.sessionCreations.size >= this.context.maxSessions)
      throw new Error(`Shared browser session limit (${this.context.maxSessions}) reached`);
    const lifecycleGeneration = this.context.lifecycleGeneration;
    const creation = this.createSession(workspaceId, key, tabId, replaceLost, beforePageMutation);
    this.context.sessionCreations.set(key, creation);
    try {
      const session = await creation;
      if (this.context.closed) throw new Error("Shared browser manager is closed");
      if (this.context.archived.has(workspaceId)) throw new Error("Workspace was archived");
      if (this.context.deliberatelyClosed.has(workspaceId)) throw new Error("Browser is closed");
      if (lifecycleGeneration !== this.context.lifecycleGeneration) {
        throw new Error("Shared browser manager was reset");
      }
      this.context.sessions.set(key, session);
      return session;
    } catch (error) {
      if (this.context.archived.has(workspaceId)) throw new Error("Workspace was archived");
      throw error;
    } finally {
      if (this.context.sessionCreations.get(key) === creation)
        this.context.sessionCreations.delete(key);
    }
  }

  private async createSession(
    workspaceId: string,
    key: string,
    requestedTabId?: string,
    replaceLost = false,
    beforePageMutation?: () => void,
  ): Promise<BrowserSession> {
    let runtimeId: string | null = null;
    try {
      const descriptor = await this.context.client.ensureWorkspace(workspaceId, { replaceLost });
      runtimeId = descriptor.runtimeId;
      const initialTarget = requestedTabId ? { targetId: requestedTabId } : null;
      const identity = asRecord(
        await this.context.client.requestWorkspace(workspaceId, "identity", initialTarget),
      );
      const tabId =
        requestedTabId ?? (typeof identity.targetId === "string" ? identity.targetId : null);
      const userAgent = boundedText(String(identity.userAgent ?? "Chromium"), 512);
      const empty = identity.empty === true;
      if (empty && requestedTabId) throw new Error("Browser tab is no longer available");
      if (!empty)
        await this.context.client.requestWorkspace(
          workspaceId,
          "emulate",
          {
            ...DEFAULT_VIEWPORT,
            deviceScaleFactor: 1,
            mobile: false,
            touch: false,
            // Reapplying even the native UA string would suppress Chromium's client hints.
            userAgent: "",
            platform: "",
            ...(tabId ? { targetId: tabId } : {}),
          },
          beforePageMutation ? { runtimeId, assertCurrent: beforePageMutation } : undefined,
        );
      const state = asRecord(
        await this.context.client.requestWorkspace(
          workspaceId,
          "state",
          tabId ? { targetId: tabId } : null,
        ),
      );
      return {
        empty,
        key,
        workspaceId,
        tabId,
        sessionId: this.context.issueUniqueToken(),
        runtimeId: descriptor.runtimeId,
        runtimeCreatedAt: descriptor.createdAt,
        bridgeEpoch: this.context.bridgeEpoch,
        viewport: { ...DEFAULT_VIEWPORT },
        captureScale: 1,
        navigationGeneration: 0,
        viewportGeneration: 0,
        devicePresetId: null,
        userAgent,
        defaultUserAgent: userAgent,
        ...(typeof identity.videoCaptureEnabled === "boolean"
          ? { videoCaptureEnabled: identity.videoCaptureEnabled }
          : {}),
        canPrint: identity.canPrint === true,
        ...(browserGraphicsStateSchema.safeParse(identity.graphics).success
          ? { graphics: browserGraphicsStateSchema.parse(identity.graphics) }
          : {}),
        viewers: new Map(),
        controller: null,
        mutationTail: Promise.resolve(),
        frameCache: new Map(),
        recentFrames: new Map(),
        domSnapshots: new Map(),
        frameRevision: 0,
        videoNotBefore: null,
        videoInputNotBefore: null,
        videoReads: new Set(),
        videoLifetime: null,
        videoReceipts: new Map(),
        lastUrl: boundedText(String(state.url ?? ""), 8192),
        lastTitle: boundedText(String(state.title ?? ""), 1024),
        canGoBack: Boolean(state.canGoBack),
        canGoForward: Boolean(state.canGoForward),
        error: null,
        notice:
          typeof identity.displayNotice === "string"
            ? boundedText(identity.displayNotice, 256)
            : null,
        runtimeLost: false,
        archived: false,
        gesture: null,
        inputGeneration: typeof state.inputGeneration === "string" ? state.inputGeneration : null,
      };
    } catch (error) {
      const hasOtherSession = [...this.context.sessions.values()].some(
        (session) => session.workspaceId === workspaceId && session.key !== key,
      );
      const hasOtherCreation = [...this.context.sessionCreations.keys()].some(
        (pendingKey) =>
          pendingKey !== key &&
          (pendingKey === workspaceId || pendingKey.startsWith(`${workspaceId}/`)),
      );
      // An invalid explicit tab must never tear down a workspace runtime that
      // another participant may already be using without a policy session.
      if (runtimeId && !requestedTabId && !hasOtherSession && !hasOtherCreation) {
        await this.context.client.closeWorkspace(workspaceId, runtimeId).catch(() => undefined);
      }
      throw error;
    }
  }
}
