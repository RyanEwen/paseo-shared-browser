import { execFile } from "node:child_process";
import { chmod, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentBrowserIncompatibleError, AgentBrowserUnavailableError } from "./agent-browser-types";
import type { BrowserGraphicsConfiguration } from "./browser-graphics";
import { CdpUnknownOutcomeError } from "./cdp";
import { NATIVE_VIDEO_EXTENSION_ID } from "./native-video-extension";
import {
  type ProcessIdentity,
  probeProcess,
  processExists,
  RUNTIME_OWNER_VARIABLE,
} from "./process-identity";

/**
 * The agent-browser process boundary: its sanitized environment, CLI invocation, Chromium
 * launch arguments, and ownership of the session daemon it launches.
 */

const execFileAsync = promisify(execFile);
export const AGENT_BROWSER_VERSION = "0.38.2";
const PRIVATE_FILE_MODE = 0o600;
/** Poll interval while waiting for the session daemon to exit. */
const DAEMON_EXIT_POLL_MS = 25;

/** Resolve a configured path, refusing a relative one. */
export function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new AgentBrowserIncompatibleError(`${label} must be absolute`);
  return resolve(path);
}

/**
 * Build the child environment: a fixed allowlist of host variables, an optional validated
 * private display (Wayland or X11, never both), and this runtime's owner nonce and IPC settings.
 *
 * @param ipcDirectory Private directory for the session's socket and metadata.
 * @param launchEnvironment Trusted private display variables, or undefined for the host display.
 * @param ownerNonce Marks the daemon so only this runtime ever signals it.
 */
export function runtimeEnvironment(
  ipcDirectory: string,
  launchEnvironment: Readonly<Record<string, string>> | undefined,
  ownerNonce: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (launchEnvironment !== undefined) {
    const keys = Object.keys(launchEnvironment);
    const display = launchEnvironment.DISPLAY;
    const authority = launchEnvironment.XAUTHORITY;
    const wayland = launchEnvironment.WAYLAND_DISPLAY;
    const directory = launchEnvironment.XDG_RUNTIME_DIR;
    const privateWayland =
      keys.length === 2 &&
      keys.every((key) => key === "WAYLAND_DISPLAY" || key === "XDG_RUNTIME_DIR") &&
      typeof wayland === "string" &&
      /^wayland-[a-z0-9-]{1,32}$/.test(wayland) &&
      typeof directory === "string" &&
      isAbsolute(directory) &&
      [...directory].every((character) => character.charCodeAt(0) >= 32);
    const privateX11 = !(
      keys.length !== 2 ||
      keys.some((key) => key !== "DISPLAY" && key !== "XAUTHORITY") ||
      typeof display !== "string" ||
      !/^:[0-9]{1,5}(?:\.[0-9]{1,2})?$/.test(display) ||
      typeof authority !== "string" ||
      !isAbsolute(authority)
    );
    if (!privateWayland && !privateX11) {
      // Do not include display/authentication values in errors or child arguments.
      throw new AgentBrowserIncompatibleError("Private browser display environment is invalid");
    }
    if (privateWayland) {
      environment.WAYLAND_DISPLAY = wayland;
      environment.XDG_RUNTIME_DIR = directory;
      delete environment.DISPLAY;
      delete environment.XAUTHORITY;
    } else {
      environment.DISPLAY = display;
      environment.XAUTHORITY = authority;
      // A private X11 display must not inherit an unrelated host Wayland session.
      delete environment.WAYLAND_DISPLAY;
    }
  }
  environment[RUNTIME_OWNER_VARIABLE] = ownerNonce;
  environment.AGENT_BROWSER_SOCKET_DIR = ipcDirectory;
  environment.AGENT_BROWSER_IDLE_TIMEOUT_MS = "0";
  environment.AGENT_BROWSER_STREAM_PORT = "0";
  environment.AGENT_BROWSER_NO_AUTO_DIALOG = "1";
  return environment;
}

/** Parse the last JSON line agent-browser printed. */
function parseJsonOutput(stdout: string): unknown {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new AgentBrowserIncompatibleError("agent-browser returned invalid JSON");
}

/** Find the first string value under any of `keys`, searching nested objects depth first. */
export function findString(value: unknown, keys: readonly string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return null;
}

/** The display and capture choices that shape Chromium's command line. */
export interface ChromiumLaunchChoices {
  graphics: BrowserGraphicsConfiguration;
  headed: boolean;
  privateDisplay: boolean;
  nativeVideo: boolean;
}

/**
 * The comma-joined Chromium arguments for `agent-browser --args`, including any extra arguments
 * from `PASEO_SHARED_BROWSER_CHROMIUM_ARGS`.
 */
export function chromiumLaunchArguments({
  graphics,
  headed,
  privateDisplay,
  nativeVideo,
}: ChromiumLaunchChoices): string {
  const existingArguments = process.env.PASEO_SHARED_BROWSER_CHROMIUM_ARGS;
  return [
    ...graphics.chromiumArguments,
    existingArguments,
    // agent-browser suppresses headless flags whenever an extension is present.
    // This helper has no content scripts and works in modern headless Chrome;
    // preserve the selected display mode while keeping capture ready but idle.
    !headed ? "--headless=new" : undefined,
    // Tab capture copies the native compositor surface. Page emulation's DPR
    // alone can leave it rasterized at 1x, then enlarged to a nominal 2x stream.
    // Prepare the surface for our maximum capture density; each tab still
    // independently controls its CSS size, emulated DPR and 1x/2x output.
    nativeVideo && graphics.mode !== "wayland" ? "--force-device-scale-factor=2" : undefined,
    // Retain the image-only headless path's software WebGL fallback, including
    // on a private display. WSL hardware mode retains its renderer requirement.
    (!headed || privateDisplay) && graphics.mode === "default"
      ? "--enable-unsafe-swiftshader"
      : undefined,
    // agent-browser creates the launch page itself. Chromium's default
    // startup window otherwise leaves an additional chrome://newtab page.
    "--no-startup-window",
    `--allowlisted-extension-id=${NATIVE_VIDEO_EXTENSION_ID}`,
  ]
    .filter(Boolean)
    .join(",");
}

/** Runs the pinned agent-browser binary with this runtime's environment and timeout. */
export class AgentBrowserCli {
  /**
   * @param binaryPath Absolute agent-browser binary.
   * @param environment Complete child environment; never merged with the host's.
   * @param timeoutMs Bound for each command; a timeout is an unknown outcome.
   */
  constructor(
    readonly binaryPath: string,
    readonly environment: NodeJS.ProcessEnv,
    private readonly timeoutMs: number,
  ) {}

  /** Refuse any agent-browser other than the exact supported version. */
  async assertVersion(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, ["--version"], {
        env: this.environment,
        timeout: this.timeoutMs,
        encoding: "utf8",
      });
      const version = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
      if (version !== AGENT_BROWSER_VERSION) {
        throw new AgentBrowserIncompatibleError(
          `Expected agent-browser ${AGENT_BROWSER_VERSION}, received ${version ?? "unknown"}`,
        );
      }
    } catch (error) {
      if (error instanceof AgentBrowserIncompatibleError) throw error;
      throw new AgentBrowserUnavailableError(
        `agent-browser is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Run one agent-browser CLI command and parse its JSON output. Bounded by the runtime timeout
   * and a 1 MiB output buffer; a timeout or non-zero exit becomes a descriptive error.
   */
  async invoke(arguments_: string[]): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.binaryPath, arguments_, {
        env: this.environment,
        timeout: this.timeoutMs,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return parseJsonOutput(stdout);
    } catch (error) {
      const typed = error as NodeJS.ErrnoException & {
        killed?: boolean;
        stderr?: string;
        stdout?: string;
      };
      if (typed.killed) {
        throw new CdpUnknownOutcomeError("agent-browser command timed out; outcome is unknown");
      }
      console.error(
        "Shared Browser agent-browser command failed:",
        typed.stderr?.trim() || typed.stdout?.trim() || typed.message || "unknown error",
      );
      throw new AgentBrowserUnavailableError("agent-browser command failed");
    }
  }
}

/**
 * The session daemon this runtime launched. Only a process carrying this runtime's owner nonce
 * is ever signalled, and stopping it requires observed exit.
 */
export class AgentBrowserDaemon {
  /** The PID-file daemon, with a verified identity only when it carries our nonce. */
  record: { pid: number; identity: ProcessIdentity | null } | null = null;
  /** A daemon was launched for this session, so absence of evidence is not proof of exit. */
  launched = false;

  /**
   * @param cli Runs the graceful `close` command.
   * @param ipcDirectory Directory holding the session's socket and PID metadata.
   * @param session agent-browser session name.
   * @param ownerNonce This runtime's marker in the daemon's environment.
   * @param exitWaitMs Bound for the daemon to exit after close or SIGKILL.
   */
  constructor(
    private readonly cli: AgentBrowserCli,
    private readonly ipcDirectory: string,
    private readonly session: string,
    readonly ownerNonce: string,
    private readonly exitWaitMs: number,
  ) {}

  /** From here a nonce-owned daemon may exist even if open rejects (e.g. navigation failure). */
  markLaunched(): void {
    this.launched = true;
    this.record = null;
  }

  /** Close, then require observed exit; escalate to a verified-owned SIGKILL and observe that too. */
  async stop(force: boolean): Promise<void> {
    let forced = force;
    if (!forced) {
      try {
        await this.cli.invoke(["--session", this.session, "--json", "close"]);
      } catch {
        forced = true;
      }
      // close returns before the session daemon exits. A same-session relaunch would reach
      // that daemon with its original launch environment (e.g. a stopped private display).
      if (!forced && !(await this.exited())) forced = true;
    }
    if (forced) await this.terminate();
    if (forced || this.launched) await this.removeIpcMetadata();
    this.launched = false;
    this.record = null;
  }

  /**
   * Records the PID-file daemon. Only a PID whose environment carries this runtime's own
   * nonce gets a verified identity; anything else is observable but never signalled.
   */
  async capture(): Promise<void> {
    const pid = await this.pid();
    if (pid === null) return;
    const probe = await probeProcess(pid, this.ownerNonce);
    this.record = { pid, identity: probe.status === "owned" ? probe.identity : null };
  }

  /**
   * Observes the daemon this runtime launched. Only `gone` is a positive exit; `unknown`
   * (no PID record, unreadable identity) is never success and never authorises a signal.
   */
  async state(): Promise<"gone" | "owned" | "alive" | "unknown"> {
    if (!this.launched) return "gone";
    if (!this.record) {
      await this.capture();
      if (!this.record) return "unknown";
    }
    const { pid, identity } = this.record;
    if (!identity) return processExists(pid) ? "alive" : "gone";
    const probe = await probeProcess(pid, this.ownerNonce);
    if (probe.status === "absent" || probe.status === "foreign") return "gone";
    if (probe.status === "owned")
      return probe.identity.startTicks === identity.startTicks ? "owned" : "gone";
    return processExists(pid) ? "unknown" : "gone";
  }

  /** True only after positive observation of exit, within the bound. */
  async exited(): Promise<boolean> {
    for (const deadline = Date.now() + this.exitWaitMs; Date.now() < deadline; ) {
      if ((await this.state()) === "gone") return true;
      await new Promise((resolve) => setTimeout(resolve, DAEMON_EXIT_POLL_MS));
    }
    return (await this.state()) === "gone";
  }

  /** Signals only a daemon freshly re-verified as owned, then confirms its exit. */
  async terminate(): Promise<void> {
    if ((await this.state()) === "owned" && this.record) {
      try {
        process.kill(this.record.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    // Unverified or unknown daemons are never signalled, but exit must still be observed.
    if (!(await this.exited()))
      throw new AgentBrowserUnavailableError("agent-browser daemon exit was not confirmed");
  }

  async pid(): Promise<number | null> {
    try {
      const value = await readFile(resolve(this.ipcDirectory, `${this.session}.pid`), "utf8");
      const pid = Number.parseInt(value.trim(), 10);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Restrict the daemon's IPC socket and metadata files to this user; missing files are ignored. */
  async protectIpcMetadata(): Promise<void> {
    await Promise.all(
      ["sock", "pid", "version", "config", "stream"]
        .map((extension) => resolve(this.ipcDirectory, `${this.session}.${extension}`))
        .map((path) => chmod(path, PRIVATE_FILE_MODE).catch(() => undefined)),
    );
  }

  /** Delete this session's daemon IPC files after shutdown; missing files are ignored. */
  async removeIpcMetadata(): Promise<void> {
    await Promise.all(
      ["sock", "pid", "version", "config", "stream", "engine", "provider", "extensions"]
        .map((extension) => resolve(this.ipcDirectory, `${this.session}.${extension}`))
        .map((path) => rm(path, { force: true }).catch(() => undefined)),
    );
  }
}
