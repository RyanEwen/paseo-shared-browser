import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BrowserState } from "../shared/browser";
import { isPrintPreviewUrl } from "../shared/browser-page";
import { CaptureAuthority } from "./browser-session-frames";
import { InputDispatch } from "./browser-session-input";
import { ViewerLeases } from "./browser-session-leases";
import { PageOperations } from "./browser-session-page";
import { SessionRegistry } from "./browser-session-registry";
import { TabLifecycle } from "./browser-session-tabs";
import {
  asRecord,
  type BrowserRuntimeClient,
  type BrowserRuntimeMutationGuard,
  type BrowserSession,
  boundedText,
  FRAME_CACHE_MS,
  MAX_SESSIONS,
  type SessionManagerOptions,
  type WorkspaceValidator,
} from "./browser-session-types";
import { VideoReads } from "./browser-session-video";
import { type BrowserViewerPolicy, HUMAN_VIEWER_POLICY } from "./browser-viewer-policy";
import { EMPTY_WORKSPACE_OPERATIONS, NO_PAGE_OPEN_MESSAGE } from "./empty-workspace";
import { type JsonValue, jsonObjectOrEmpty, RuntimeProtocolError } from "./runtime-protocol";

function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The state every session policy collaborator shares: configuration, the session and viewer
 * maps, lifecycle generation, and the runtime request, serialization and state projection
 * helpers they all use. Collaborators reach each other through this context.
 */
export class SessionPolicyContext {
  // Configuration fixed at construction.
  readonly validateWorkspace: WorkspaceValidator;
  readonly client: BrowserRuntimeClient;
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly issueToken: () => string;
  readonly humanViewerPolicy: BrowserViewerPolicy;
  readonly frameCacheMs: number;
  readonly maxSessions: number;

  // Sessions, viewers and lifecycle state shared by every collaborator.
  readonly sessions = new Map<string, BrowserSession>();
  readonly viewerSessions = new Map<string, BrowserSession>();
  readonly closedViewerWorkspaces = new Map<string, string>();
  readonly closedViewerTabs = new Map<string, number>();
  readonly sessionCreations = new Map<string, Promise<BrowserSession>>();
  readonly sessionClosures = new Map<string, Promise<void>>();
  readonly archived = new Set<string>();
  readonly deliberatelyClosed = new Set<string>();
  bridgeEpoch = 0;
  lifecycleGeneration = 0;
  closed = false;

  // Policy collaborators; each reaches the others through this context.
  readonly registry: SessionRegistry;
  readonly leases: ViewerLeases;
  readonly tabs: TabLifecycle;
  readonly page: PageOperations;
  readonly frames: CaptureAuthority;
  readonly video: VideoReads;
  readonly input: InputDispatch;

  constructor(options: SessionManagerOptions) {
    this.validateWorkspace = options.validateWorkspace;
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.issueToken = options.issueToken ?? defaultToken;
    this.humanViewerPolicy = {
      ...HUMAN_VIEWER_POLICY,
      viewerTtlMs: options.viewerTtlMs ?? HUMAN_VIEWER_POLICY.viewerTtlMs,
      controlLeaseMs: options.controlLeaseMs ?? HUMAN_VIEWER_POLICY.controlLeaseMs,
    };
    this.frameCacheMs = options.frameCacheMs ?? FRAME_CACHE_MS;
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1)
      throw new Error("maxSessions must be a positive integer");
    this.registry = new SessionRegistry(this);
    this.leases = new ViewerLeases(this);
    this.tabs = new TabLifecycle(this);
    this.page = new PageOperations(this);
    this.frames = new CaptureAuthority(this);
    this.video = new VideoReads(this);
    this.input = new InputDispatch(this);
  }

  /**
   * Send one runtime operation for a page session, scoped to its tab. Refuses archived sessions,
   * and page operations while the workspace is empty. A lost runtime marks every session of the
   * workspace lost, because they all share that one browser.
   */
  request(
    session: BrowserSession,
    operation: string,
    input: JsonValue,
    guard?: BrowserRuntimeMutationGuard,
  ): Promise<JsonValue> {
    if (session.archived) throw new Error("Workspace was archived");
    if (session.empty && !EMPTY_WORKSPACE_OPERATIONS.has(operation))
      throw new Error(NO_PAGE_OPEN_MESSAGE);
    const data = jsonObjectOrEmpty(input);
    return this.client
      .requestWorkspace(
        session.workspaceId,
        operation,
        session.tabId ? { ...data, targetId: session.tabId } : input,
        guard,
      )
      .catch((error) => {
        if (error instanceof RuntimeProtocolError && error.code === "RUNTIME_LOST") {
          // The workspace's single browser is gone, so every page session of it is gone.
          session.runtimeLost = true;
          for (const candidate of this.sessions.values())
            if (candidate.workspaceId === session.workspaceId) {
              candidate.runtimeLost = true;
              candidate.error = boundedText(error.message, 2048);
            }
        }
        throw error;
      });
  }

  /**
   * Run `operation` after every earlier operation on this session settles. A failure does not
   * break the queue: later work still runs, and only this caller sees the rejection.
   */
  serialize<T>(session: BrowserSession, operation: () => Promise<T>): Promise<T> {
    const result = session.mutationTail.then(operation, operation);
    session.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  assertOpen(): void {
    if (this.closed) throw new Error("Shared browser manager is closed");
  }

  issueUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.issueToken();
      if (token.length < 32 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token))
        throw new Error("Token issuer returned an invalid opaque token");
      if (
        !this.viewerSessions.has(token) &&
        ![...this.sessions.values()].some(
          (session) =>
            session.sessionId === token ||
            session.controller?.controlToken === token ||
            session.recentFrames.has(token) ||
            session.recentFrames.has(`agent:${token}`),
        )
      )
        return token;
    }
    throw new Error("Could not issue a unique opaque token");
  }

  async refreshPageMetadata(session: BrowserSession, timeoutMs?: number): Promise<void> {
    if (session.empty) return;
    const raw = asRecord(
      await this.request(session, "state", timeoutMs === undefined ? null : { timeoutMs }),
    );
    const url = boundedText(String(raw.url ?? ""), 8192);
    const inputGeneration = typeof raw.inputGeneration === "string" ? raw.inputGeneration : null;
    const documentChanged =
      session.inputGeneration !== null && inputGeneration !== session.inputGeneration;
    if ((session.lastUrl && session.lastUrl !== url) || documentChanged) {
      await this.input.cancelGesture(session);
      session.navigationGeneration += 1;
      this.frames.invalidateFrames(session);
    }
    session.inputGeneration = inputGeneration;
    session.lastUrl = url;
    session.lastTitle = boundedText(String(raw.title ?? ""), 1024);
    session.canGoBack = Boolean(raw.canGoBack);
    session.canGoForward = Boolean(raw.canGoForward);
  }

  /**
   * Reconcile and project one viewer's state, reading fresh page metadata when the page exists.
   * Throws when the viewer's lease is invalid or expired.
   */
  async snapshotState(
    session: BrowserSession,
    viewerToken: string,
    timeoutMs?: number,
  ): Promise<BrowserState> {
    this.leases.pruneExpired(session);
    if (!session.viewers.has(viewerToken)) throw new Error("Viewer token is invalid or expired");
    if (session.empty && session.runtimeLost) return this.projectState(session, viewerToken);
    try {
      await this.refreshPageMetadata(session, timeoutMs);
      session.error = null;
    } catch (error) {
      session.error = boundedText(error instanceof Error ? error.message : String(error), 2048);
    }
    return this.projectState(session, viewerToken);
  }

  /** Project the last reconciled state without a page RPC. Media generations independently fence late pixels. */
  projectState(session: BrowserSession, viewerToken: string): BrowserState {
    this.leases.pruneExpired(session);
    if (!session.viewers.has(viewerToken)) throw new Error("Viewer token is invalid or expired");
    const controller = session.controller;
    const controllerViewer = controller ? session.viewers.get(controller.viewerToken) : null;
    let status: BrowserState["status"] = session.empty ? "empty" : "ready";
    if (session.error) status = "error";
    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      ...(session.tabId ? { tabId: session.tabId } : {}),
      runtimeCreatedAt: session.runtimeCreatedAt,
      bridgeEpoch: session.bridgeEpoch,
      status,
      url: session.lastUrl,
      title: session.lastTitle,
      canGoBack: session.canGoBack,
      canGoForward: session.canGoForward,
      viewport: { ...session.viewport },
      captureScale: session.captureScale,
      ...(session.videoCaptureEnabled === undefined
        ? {}
        : { videoCaptureEnabled: session.videoCaptureEnabled }),
      ...(session.graphics ? { graphics: session.graphics } : {}),
      canPrint: session.canPrint === true,
      navigationGeneration: session.navigationGeneration,
      viewportGeneration: session.viewportGeneration,
      devicePresetId: session.devicePresetId,
      userAgent: session.userAgent,
      controller: !controller ? "none" : controller.viewerToken === viewerToken ? "self" : "other",
      controllerLabel: controllerViewer?.label ?? null,
      controllerExpiresAt: controller ? new Date(controller.expiresAt).toISOString() : null,
      agentPointer:
        session.agentPointer?.read(
          controller && controllerViewer?.policy.kind === "agent" && !session.error
            ? {
                runtimeId: session.runtimeId,
                bridgeEpoch: session.bridgeEpoch,
                controlToken: controller.controlToken,
                inputGeneration: session.inputGeneration,
                navigationGeneration: session.navigationGeneration,
                viewportGeneration: session.viewportGeneration,
              }
            : null,
          this.now(),
        ) ?? null,
      viewerCount: session.viewers.size,
      error: session.error,
      ...(session.notice || isPrintPreviewUrl(session.lastUrl)
        ? {
            notice:
              session.notice ??
              "Chromium print preview. Use Cancel or close this preview tab, then select your original tab. System print and save dialogs are unavailable.",
          }
        : {}),
    };
  }

  /** A lost runtime keeps its typed code so observers can tell it from a transient failure. */
  metadataFailure(session: BrowserSession, error: string): Error {
    const message = `Browser capture metadata failed: ${error}`;
    return session.runtimeLost
      ? new RuntimeProtocolError("RUNTIME_LOST", message)
      : new Error(message);
  }
}
