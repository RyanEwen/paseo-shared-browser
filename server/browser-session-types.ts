import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type applyDevicePresetRpc,
  type BrowserFrame,
  type BrowserState,
  type beginBrowserGestureRpc,
  type captureBrowserRpc,
  type closeBrowserRpc,
  type closeBrowserTabRpc,
  type DevicePresetId,
  type endBrowserGestureRpc,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  type navigateBrowserRpc,
  type printBrowserRpc,
  type resizeBrowserRpc,
  type sendBrowserInputRpc,
  type setCaptureDensityRpc,
  type updateBrowserGestureRpc,
  type Viewport,
} from "../shared/browser";
import type { BrowserFrameAuthority } from "../shared/browser-video";
import type { CaptureQuality } from "../shared/capture-settings";
import type { AgentPointerPresence } from "./agent-pointer";
import type { BrowserGesture } from "./browser-gesture";
import type { BrowserViewerPolicy } from "./browser-viewer-policy";
import { type JsonValue, RuntimeProtocolError, requireJsonObject } from "./runtime-protocol";
import type { ViewerCaptureLifetime } from "./viewer-capture-lifetime";
import type { ViewerDisplayDemand } from "./viewer-display-demand";

/**
 * Types, limits and validation helpers shared by the browser session policy modules. The
 * public names are re-exported from `browser-policy.ts`, which remains the import path for
 * callers.
 */

export type WorkspaceValidator = (workspaceId: string) => Promise<void | boolean>;
export type CaptureReply = Omit<RpcOutput<typeof captureBrowserRpc>, "state"> & {
  state: BrowserState;
  /** Trusted agents receive the actual observation deadline, not a TTL guessed from source pixels. */
  frameExpiresAt?: string;
};
export type DensityInput = RpcInput<typeof setCaptureDensityRpc>;
export type CloseInput = RpcInput<typeof closeBrowserRpc>;
export type CloseTabInput = RpcInput<typeof closeBrowserTabRpc>;
export type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
export type PrintInput = RpcInput<typeof printBrowserRpc>;
export type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
export type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
export type SendInput = RpcInput<typeof sendBrowserInputRpc>;
export type BeginGestureInput = RpcInput<typeof beginBrowserGestureRpc>;
export type UpdateGestureInput = RpcInput<typeof updateBrowserGestureRpc>;
export type UpdateGestureReply = Omit<RpcOutput<typeof updateBrowserGestureRpc>, "state"> & {
  state: BrowserState;
};
export type EndGestureInput = RpcInput<typeof endBrowserGestureRpc>;

export const FRAME_CACHE_MS = 100;
export const MAX_RECENT_FRAMES = 512;
export const MAX_VIEWERS_PER_SESSION = 16;
export const MAX_SESSIONS = 64;
export const SCREENCAST_WAIT_MS = 500;

/** Process-local authority that must survive queued work and awaited native metadata. */
export interface BrowserRuntimeMutationGuard {
  runtimeId: string;
  /** Refuse before mutation publication if the caller's original viewer/selection expired. */
  assertCurrent(): void;
}

export interface BrowserRuntimeClient {
  connect(): Promise<{ epoch: number }>;
  /** `replaceLost` is internal authority; without it a lost runtime is reported, never replaced. */
  ensureWorkspace(
    workspaceId: string,
    options?: { replaceLost?: boolean },
  ): Promise<{
    workspaceId: string;
    runtimeId: string;
    createdAt: number;
  }>;
  /** A guarded mutation must recheck its runtime and caller immediately before native dispatch. */
  requestWorkspace(
    workspaceId: string,
    operation: string,
    input: JsonValue,
    guard?: BrowserRuntimeMutationGuard,
  ): Promise<JsonValue>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  closeWorkspace(workspaceId: string, runtimeId: string): Promise<void>;
  /** Check the exact sole target and call onClosing synchronously within the workspace queue before stopping. */
  closeLastTab?(
    workspaceId: string,
    runtimeId: string,
    tabId: string,
    onClosing: () => void,
  ): Promise<void>;
  disconnect(): void;
}

export interface SessionManagerOptions {
  validateWorkspace: WorkspaceValidator;
  client: BrowserRuntimeClient;
  now?: () => number;
  /** Same process-local elapsed clock as native capture, injectable for deterministic tests. */
  monotonicNow?: () => number;
  issueToken?: () => string;
  viewerTtlMs?: number;
  controlLeaseMs?: number;
  frameCacheMs?: number;
  maxSessions?: number;
}

export interface Viewer {
  label: string;
  policy: BrowserViewerPolicy;
  expiresAt: number;
}
export interface Controller {
  viewerToken: string;
  controlToken: string;
  expiresAt: number;
}
export interface FrameObservation {
  navigationGeneration: number;
  viewportGeneration: number;
  expiresAt: number;
  expiresAtMonotonicMs?: number;
  observedAt: number;
  observedAtMonotonicMs?: number;
}
export interface BrowserSession {
  /** An attached workspace with no selected content page; observation must not launch it. */
  empty: boolean;
  agentPointer?: AgentPointerPresence;
  displayDemand?: ViewerDisplayDemand;
  key: string;
  workspaceId: string;
  tabId: string | null;
  sessionId: string;
  runtimeId: string;
  runtimeCreatedAt: number;
  bridgeEpoch: number;
  viewport: Viewport;
  captureScale: number;
  videoCaptureEnabled?: boolean;
  canPrint?: boolean;
  graphics?: import("../shared/browser-graphics").BrowserGraphicsState;
  navigationGeneration: number;
  viewportGeneration: number;
  devicePresetId: DevicePresetId | null;
  userAgent: string;
  defaultUserAgent: string;
  viewers: Map<string, Viewer>;
  controller: Controller | null;
  mutationTail: Promise<void>;
  frameCache: Map<
    CaptureQuality,
    {
      frame: BrowserFrame;
      cachedAt: number;
      /** Exact runtime receipt, distinct from its normalized public frame fields. */
      rawFrame: Record<string, JsonValue>;
    }
  >;
  recentFrames: Map<string, FrameObservation>;
  domSnapshots: Map<
    string,
    { snapshotId: string; state: BrowserState; inputGeneration: string; expiresAt: number }
  >;
  lastUrl: string;
  lastTitle: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  notice: string | null;
  /** Set when the runtime reported it can never serve again; the next explicit attach replaces it. */
  runtimeLost: boolean;
  archived: boolean;
  gesture: BrowserGesture | null;
  inputGeneration: string | null;
  frameRevision: number;
  /** Playback and input fences use the native capture's Node elapsed clock. */
  videoNotBefore: number | null;
  /** Older native pixels may play, but cannot renew press authority after input. */
  videoInputNotBefore: number | null;
  videoReads: Set<string>;
  videoLifetime: ViewerCaptureLifetime | null;
  videoReceipts: Map<string, { frame: BrowserFrameAuthority; capturedAtMonotonicMs: number }>;
}

/** Truncate untrusted text to a bounded length. */
export function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/** Refuse a viewport outside the supported bounds. */
export function assertViewport(viewport: Viewport): void {
  if (
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < MIN_VIEWPORT.width ||
    viewport.width > MAX_VIEWPORT.width ||
    viewport.height < MIN_VIEWPORT.height ||
    viewport.height > MAX_VIEWPORT.height
  ) {
    throw new Error("Viewport is outside the supported bounds");
  }
}

/** Require a runtime reply to be a JSON object. */
export function asRecord(value: JsonValue): Record<string, JsonValue> {
  return requireJsonObject(value, () => new Error("Runtime returned an invalid response"));
}

/**
 * Normalize a typed address to an HTTP(S) URL, adding `https://` when no scheme is given.
 * Only HTTP, HTTPS and `about:blank` are accepted.
 */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (value === "about:blank") return value;
  const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
  const looksLikeHostWithPort = /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value);
  const candidate = hasScheme && !looksLikeHostWithPort ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Only HTTP, HTTPS, and about:blank URLs are supported");
  return parsed.href;
}

/**
 * The first page exists and the requesting viewer now owns it, but its navigation did not
 * complete. Carries that viewer's new state so callers can follow the page instead of acting
 * on the empty session they started from. A timed-out navigation is an unknown outcome.
 */
export class FirstPageNavigationError extends RuntimeProtocolError {
  readonly state: BrowserState;

  constructor(message: string, state: BrowserState, unknown: boolean) {
    super(
      unknown ? "UNKNOWN_OUTCOME" : "RUNTIME_FAILURE",
      `${message}. The new tab stays open and is now selected; observe it before another action.`,
    );
    this.name = "FirstPageNavigationError";
    this.state = state;
  }
}
