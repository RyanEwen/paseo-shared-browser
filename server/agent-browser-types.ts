import type { BrowserGraphicsMode } from "./browser-graphics";
import type { CdpTarget } from "./cdp";
import type { NativePyrowaveAssets } from "./native-pyrowave-cohort";

/**
 * Public types and errors of `AgentBrowserRuntime`, shared by its collaborator modules.
 * `agent-browser-runtime.ts` re-exports them, so importers keep using that module.
 */

/** agent-browser is missing, failed, or did not confirm an operation it was asked to perform. */
export class AgentBrowserUnavailableError extends Error {
  override readonly name = "AgentBrowserUnavailableError";
}

/** agent-browser or its configuration is not the exact supported contract. */
export class AgentBrowserIncompatibleError extends Error {
  override readonly name = "AgentBrowserIncompatibleError";
}

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  /** Capture density does not change the emulated layout or pointer coordinate system. */
  captureScale?: number;
  mobile: boolean;
  touch: boolean;
  /** Explicit device identity; empty or omitted restores native UA, platform and client hints. */
  userAgent?: string;
  platform?: string;
}

export interface RuntimeIdentity {
  agentBrowserVersion: string;
  browserProduct: string;
  browserRevision: string;
  userAgent: string;
  protocolVersion: string;
  processId: number | null;
  targetId: string;
  graphics?: {
    mode: BrowserGraphicsMode;
    renderer: string | null;
    hardware: boolean | null;
  };
}

export interface RuntimeHealth {
  ready: boolean;
  session: string;
  profilePath: string;
  targetCount: number;
  identity: RuntimeIdentity | null;
  error: string | null;
}

export interface RuntimeTarget extends CdpTarget {
  openerId?: string;
}

export interface RuntimePageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Process-local attachment/document revision, including same-URL reloads. */
  inputGeneration: string;
}

export interface RuntimeFrame {
  dataBase64: string;
  byteLength: number;
  width: number;
  height: number;
  transport: "cdp-screencast" | "screenshot";
  capturedAt: string;
}

export interface DeviceEmulation extends BrowserViewport {
  screenWidth?: number;
  screenHeight?: number;
}

export type MouseButton = "left" | "middle" | "right";

export interface AgentBrowserRuntimeOptions {
  /** First-page admission after awaited preparation; never used to replay a launch. */
  beforeLaunch?: () => void;
  /** Trusted immutable native assets, absent until optional codec qualification. */
  pyrowave?: NativePyrowaveAssets;
  /** Host-persisted mode; omission uses the explicit graphics environment override or default. */
  graphicsMode?: BrowserGraphicsMode;
  binaryPath: string;
  executablePath: string;
  profilePath: string;
  ipcDirectory: string;
  session: string;
  initialUrl?: string;
  headed?: boolean;
  /** Trusted per-instance private X11 context, only DISPLAY/XAUTHORITY; never mutates host environment. */
  launchEnvironment?: Readonly<Record<string, string>>;
  /** Prepare the capture helper. The current host choice separately authorizes capture. */
  nativeVideo?: boolean;
  /** Current host choice, checked before and after asynchronous video acquisition. */
  nativeVideoAllowed?: () => boolean;
  timeoutMs?: number;
  /** Bound for the session daemon to exit after close or SIGKILL. */
  daemonExitWaitMs?: number;
}
