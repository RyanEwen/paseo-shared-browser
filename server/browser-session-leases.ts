import type { BrowserState } from "../shared/browser";
import type { SessionPolicyContext } from "./browser-session-context";
import type { BrowserSession, Controller } from "./browser-session-types";
import type { BrowserViewerPolicy } from "./browser-viewer-policy";

/**
 * Viewer leases and the single control lease of each session: issuing, heartbeats, expiry and
 * the authority checks every mutation passes.
 */
export class ViewerLeases {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  async detach(viewerToken: string): Promise<{ detached: boolean }> {
    const session = this.context.viewerSessions.get(viewerToken);
    if (!session) return { detached: false };
    return this.context.serialize(session, async () => {
      this.pruneExpired(session);
      this.context.registry.releaseViewerState(session, viewerToken);
      const detached = session.viewers.delete(viewerToken);
      this.context.viewerSessions.delete(viewerToken);
      if (session.controller?.viewerToken === viewerToken) {
        await this.context.input.cancelGesture(session);
        session.controller = null;
      }
      if (session.viewers.size === 0) {
        await this.context.request(session, "screencast.stop", null).catch(() => undefined);
        await this.context.video.stopUnusedVideo(session);
      }
      return { detached };
    });
  }

  async status(viewerToken: string): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.context.serialize(session, async () => {
      if (session.archived) throw new Error("Browser session is closed");
      this.pruneExpired(session);
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.context.snapshotState(session, viewerToken) };
    });
  }

  async acquireControl(
    viewerToken: string,
    takeover = false,
  ): Promise<{ controlToken: string; state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.context.serialize(session, async () => {
      this.heartbeat(session, viewerToken);
      const current = session.controller;
      if (current && current.viewerToken !== viewerToken && !takeover)
        throw new Error("Browser control is held by another viewer");
      if (current?.viewerToken !== viewerToken) {
        await this.context.input.cancelGesture(session);
      }
      const controller =
        current?.viewerToken === viewerToken
          ? current
          : { viewerToken, controlToken: this.context.issueUniqueToken(), expiresAt: 0 };
      controller.expiresAt =
        this.context.now() + this.policyForViewer(session, viewerToken).controlLeaseMs;
      session.controller = controller;
      return {
        controlToken: controller.controlToken,
        state: await this.context.snapshotState(session, viewerToken),
      };
    });
  }

  async releaseControl(
    viewerToken: string,
    controlToken: string,
  ): Promise<{ state: BrowserState }> {
    const session = this.requireViewer(viewerToken);
    return this.context.serialize(session, async () => {
      this.requireController(session, viewerToken, controlToken);
      await this.context.input.cancelGesture(session);
      session.controller = null;
      this.heartbeatViewer(session, viewerToken);
      return { state: await this.context.snapshotState(session, viewerToken) };
    });
  }

  requireViewer(token: string): BrowserSession {
    if (this.context.closedViewerWorkspaces.has(token)) throw new Error("Browser is closed");
    const closedTabExpiry = this.context.closedViewerTabs.get(token);
    if (closedTabExpiry !== undefined) {
      if (closedTabExpiry > this.context.now()) throw new Error("Browser tab is closed");
      this.context.closedViewerTabs.delete(token);
    }
    const session = this.context.viewerSessions.get(token);
    const viewer = session?.viewers.get(token);
    // Expiry is enforced at the authentication boundary itself: an unpruned lapsed lease
    // never authorizes an entrypoint that does not run pruneExpired first.
    if (!session || !viewer || viewer.expiresAt <= this.context.now())
      throw new Error("Viewer token is invalid or expired");
    return session;
  }

  private heartbeat(session: BrowserSession, token: string): void {
    this.pruneExpired(session);
    this.heartbeatViewer(session, token);
    if (session.controller?.viewerToken === token)
      session.controller.expiresAt =
        this.context.now() + this.policyForViewer(session, token).controlLeaseMs;
  }

  heartbeatViewer(session: BrowserSession, token: string): void {
    const viewer = session.viewers.get(token);
    if (!viewer) throw new Error("Viewer token is invalid or expired");
    viewer.expiresAt = this.context.now() + viewer.policy.viewerTtlMs;
  }

  pruneExpired(session: BrowserSession): void {
    const now = this.context.now();
    for (const [token, viewer] of session.viewers)
      if (viewer.expiresAt <= now) {
        session.domSnapshots.delete(token);
        session.viewers.delete(token);
        session.displayDemand?.remove(token);
        this.context.viewerSessions.delete(token);
      }
    if (
      session.controller &&
      (session.controller.expiresAt <= now || !session.viewers.has(session.controller.viewerToken))
    ) {
      session.controller = null;
      void this.context
        .serialize(session, () => this.context.input.cancelGesture(session))
        .catch(() => undefined);
    }
  }

  requireController(
    session: BrowserSession,
    viewerToken: string,
    controlToken: string,
  ): Controller {
    this.pruneExpired(session);
    const value = session.controller;
    if (!value || value.viewerToken !== viewerToken || value.controlToken !== controlToken)
      throw new Error("Browser control lease is invalid or expired");
    return value;
  }

  requireMutationAccess(
    session: BrowserSession,
    input: {
      viewerToken: string;
      controlToken: string;
      expected: {
        sessionId: string;
        navigationGeneration: number;
        viewportGeneration: number;
        runtimeId?: string | undefined;
        bridgeEpoch?: number | undefined;
      };
    },
  ): void {
    this.requireController(session, input.viewerToken, input.controlToken);
    if (input.expected.sessionId !== session.sessionId) throw new Error("Browser session is stale");
    if (input.expected.navigationGeneration !== session.navigationGeneration)
      throw new Error("Browser navigation state is stale");
    if (input.expected.viewportGeneration !== session.viewportGeneration)
      throw new Error("Browser viewport state is stale");
    if (input.expected.runtimeId && input.expected.runtimeId !== session.runtimeId)
      throw new Error("Browser runtime is stale");
    if (
      input.expected.bridgeEpoch !== undefined &&
      input.expected.bridgeEpoch !== session.bridgeEpoch
    )
      throw new Error("Browser bridge state is stale");
  }

  /** Policy belongs to the registered route, never its caller-controlled display label. */
  policyForViewer(session: BrowserSession, viewerToken: string): BrowserViewerPolicy {
    const viewer = session.viewers.get(viewerToken);
    if (!viewer) throw new Error("Viewer token is invalid or expired");
    return viewer.policy;
  }

  renewController(session: BrowserSession, token: string): void {
    this.heartbeatViewer(session, token);
    const controller = session.controller;
    if (!controller || controller.viewerToken !== token)
      throw new Error("Browser control lease is invalid or expired");
    controller.expiresAt = this.context.now() + this.policyForViewer(session, token).controlLeaseMs;
  }
}
