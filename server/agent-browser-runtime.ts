import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { isPrintPreviewUrl } from "../shared/browser-page";
import { canUseCaptureDensity, captureDensitySchema } from "../shared/capture-density";
import { captureDimensions } from "../shared/capture-settings";
import { MAX_VIEWPORT } from "../shared/viewport-limits";
import { RuntimeAttachment } from "./agent-browser-attachment";
import { RuntimeCapture, type ScreencastFrame } from "./agent-browser-capture";
import { RuntimeInput } from "./agent-browser-input";
import { MAX_METADATA_TIMEOUT_MS, RuntimeNavigation } from "./agent-browser-navigation";
import {
  AGENT_BROWSER_VERSION,
  AgentBrowserCli,
  AgentBrowserDaemon,
  chromiumLaunchArguments,
  findString,
  requireAbsolute,
  runtimeEnvironment,
} from "./agent-browser-process";
import {
  AgentBrowserIncompatibleError,
  type AgentBrowserRuntimeOptions,
  type BrowserViewport,
  type DeviceEmulation,
  type RuntimeHealth,
  type RuntimeIdentity,
  type RuntimeTarget,
} from "./agent-browser-types";
import { RuntimeWindowManager } from "./agent-browser-windows";
import { AgentDomRuntime } from "./agent-dom-runtime";
import {
  assertVulkanHardwareRenderer,
  assertWslHardwareRenderer,
  type BrowserGraphicsConfiguration,
  isHardwareRenderer,
  resolveBrowserGraphics,
} from "./browser-graphics";
import { BrowserWindowIsolation } from "./browser-window-isolation";
import {
  attachToTarget,
  CdpConnection,
  type CdpEvent,
  type CdpSession,
  CdpUnavailableError,
  CdpUnknownOutcomeError,
  listPageTargets,
} from "./cdp";
import { NATIVE_VIDEO_EXTENSION_ID, prepareNativeVideoExtension } from "./native-video-extension";
import { cancelPrintPreview, openPrintPreview } from "./print-preview";
import { needsSoftwareCaptureColorCorrection } from "./video-capture-color-policy";

export { AGENT_BROWSER_VERSION } from "./agent-browser-process";
export {
  AgentBrowserIncompatibleError,
  type AgentBrowserRuntimeOptions,
  AgentBrowserUnavailableError,
  type BrowserViewport,
  type DeviceEmulation,
  type MouseButton,
  type RuntimeFrame,
  type RuntimeHealth,
  type RuntimeIdentity,
  type RuntimePageState,
  type RuntimeTarget,
} from "./agent-browser-types";
export { readJpegFrameDimensions as jpegDimensions } from "./jpeg-frame";
export { CdpUnknownOutcomeError as UnknownMutationOutcomeError };

const PRIVATE_DIRECTORY_MODE = 0o700;
// Shares the navigation ceiling so the default and the maximum cannot drift apart.
const DEFAULT_TIMEOUT_MS = MAX_METADATA_TIMEOUT_MS;
/** Bound for the agent-browser session daemon to exit after close or SIGKILL. */
const DAEMON_EXIT_WAIT_MS = 5_000;

interface VersionResult {
  protocolVersion: string;
  product: string;
  revision: string;
  userAgent: string;
}

/**
 * One page controller of an agent-browser Chromium session.
 *
 * The controller that launched the browser owns its process; others attach to its pages.
 * This class owns the page attachment itself: connection, window isolation, target selection
 * and device emulation. It delegates process control to `agent-browser-process.ts`, pixels to
 * `RuntimeCapture`, input to `RuntimeInput` and navigation to `RuntimeNavigation`, all of which
 * share one `RuntimeAttachment` and fence their results on it.
 */
export class AgentBrowserRuntime {
  private readonly graphics: BrowserGraphicsConfiguration;
  readonly binaryPath: string;
  readonly executablePath: string;
  readonly profilePath: string;
  readonly ipcDirectory: string;
  readonly session: string;
  private readonly initialUrl: string;
  private readonly beforeLaunch: (() => void) | undefined;
  private readonly headed: boolean;
  private readonly nativeVideo: boolean;
  private readonly privateDisplay: boolean;
  private readonly cli: AgentBrowserCli;
  private readonly daemon: AgentBrowserDaemon;
  private readonly attachment: RuntimeAttachment;
  private readonly windows: RuntimeWindowManager;
  private readonly capture: RuntimeCapture;
  private readonly input: RuntimeInput;
  private readonly navigation: RuntimeNavigation;
  private readonly agentDom = new AgentDomRuntime();
  private shutdownInFlight: Promise<void> | null = null;
  private shutDown = false;
  private ownsBrowser = true;
  private graphicsObservation: RuntimeIdentity["graphics"];

  constructor(options: AgentBrowserRuntimeOptions) {
    this.beforeLaunch = options.beforeLaunch;
    this.binaryPath = requireAbsolute(options.binaryPath, "agent-browser binary path");
    this.executablePath = requireAbsolute(options.executablePath, "Chromium executable path");
    this.profilePath = requireAbsolute(options.profilePath, "profile path");
    this.ipcDirectory = requireAbsolute(options.ipcDirectory, "IPC directory");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.session)) {
      throw new AgentBrowserIncompatibleError("agent-browser session name is invalid");
    }
    this.session = options.session;
    this.headed = options.headed ?? false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.graphics = resolveBrowserGraphics(options.graphicsMode);
    const ownerNonce = randomUUID();
    this.cli = new AgentBrowserCli(
      this.binaryPath,
      {
        ...runtimeEnvironment(this.ipcDirectory, options.launchEnvironment, ownerNonce),
        ...this.graphics.environment,
      },
      timeoutMs,
    );
    this.daemon = new AgentBrowserDaemon(
      this.cli,
      this.ipcDirectory,
      this.session,
      ownerNonce,
      options.daemonExitWaitMs ?? DAEMON_EXIT_WAIT_MS,
    );
    this.initialUrl = options.initialUrl ?? "about:blank";
    this.nativeVideo = options.nativeVideo === true;
    this.privateDisplay = options.launchEnvironment !== undefined;

    // Collaborators call back through this instance, so every page access takes the same
    // restoring, reconnecting path.
    this.attachment = new RuntimeAttachment(timeoutMs);
    this.windows = new RuntimeWindowManager(this.attachment, {
      daemonState: () => this.daemon.state(),
      connectCdp: (preferredTargetId, activate, managementOnly) =>
        this.connectCdp(preferredTargetId, activate, managementOnly),
    });
    this.capture = new RuntimeCapture(
      this.attachment,
      {
        requirePage: () => this.requirePage(),
        restoreConfiguredEmulation: (page) => this.restoreConfiguredEmulation(page),
        applyEmulation: (page, device) => this.applyEmulation(page, device),
        reattachPageForScreencast: (previous) => this.reattachPageForScreencast(previous),
        navigationHistory: (page) => this.navigation.navigationHistory(page),
      },
      {
        nativeVideo: this.nativeVideo,
        nativeVideoAllowed: options.nativeVideoAllowed ?? (() => this.nativeVideo),
        pyrowave: options.pyrowave,
      },
    );
    this.input = new RuntimeInput(this.attachment, {
      requirePage: () => this.requirePage(),
      invalidateScreencastFrame: () => this.capture.invalidateScreencastFrame(),
    });
    this.navigation = new RuntimeNavigation(this.attachment, {
      requirePage: () => this.requirePage(),
      recoverWindowManagement: (expectedTargetId) => this.windows.recover(expectedTargetId),
      withInvalidatedScreencast: (mutation, options) =>
        this.capture.withInvalidatedScreencast(mutation, options),
    });
  }

  async launch(): Promise<void> {
    this.attachment.assertRuntimeOpen();
    if (this.attachment.connection?.isOpen) return;
    if (this.headed && !this.privateDisplay) {
      throw new AgentBrowserIncompatibleError(
        "Independent browser windows require headless mode or an owned private display",
      );
    }
    this.capture.invalidateScreencastFrame();
    await mkdir(this.profilePath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await mkdir(this.ipcDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await Promise.all([
      chmod(this.profilePath, PRIVATE_DIRECTORY_MODE),
      chmod(this.ipcDirectory, PRIVATE_DIRECTORY_MODE),
    ]);
    this.attachment.assertRuntimeOpen();
    await this.cli.assertVersion();
    this.attachment.assertRuntimeOpen();
    // The window manager uses the same trusted extension in image-only mode.
    // Its hidden management page never starts a capture stream or encoder.
    const runtimeExtension = await prepareNativeVideoExtension(this.ipcDirectory);
    this.attachment.assertRuntimeOpen();
    const chromiumArguments = chromiumLaunchArguments({
      graphics: this.graphics,
      headed: this.headed,
      privateDisplay: this.privateDisplay,
      nativeVideo: this.nativeVideo,
    });
    this.beforeLaunch?.();
    this.ownsBrowser = true;
    // From here a nonce-owned daemon may exist even if open rejects (e.g. navigation failure).
    this.daemon.markLaunched();
    const opened = await this.cli.invoke([
      "--session",
      this.session,
      "--profile",
      this.profilePath,
      "--executable-path",
      this.executablePath,
      "--extension",
      runtimeExtension,
      "--hide-scrollbars",
      "false",
      ...(this.headed ? ["--headed"] : []),
      ...(chromiumArguments ? ["--args", chromiumArguments] : []),
      "--json",
      "open",
      this.initialUrl,
    ]);
    this.attachment.assertRuntimeOpen();
    const targetId = findString(opened, ["targetId", "target_id"]);
    await this.daemon.protectIpcMetadata();
    await this.daemon.capture();
    this.attachment.assertRuntimeOpen();
    await this.connectCdp(targetId);
    await this.observeGraphics();
  }

  /** Observe startup graphics once per controller; no page access or focus change. */
  private async observeGraphics(): Promise<NonNullable<RuntimeIdentity["graphics"]>> {
    if (this.graphicsObservation) return this.graphicsObservation;
    let renderer: string | null = null;
    try {
      const info = await this.attachment.requireConnection().send<{
        gpu?: {
          auxAttributes?: { glRenderer?: string };
          featureStatus?: { gpu_compositing?: string };
        };
      }>("SystemInfo.getInfo");
      const value = info.gpu?.auxAttributes?.glRenderer;
      if (typeof value === "string") renderer = value.slice(0, 512);
      if (this.graphics.mode === "vulkan" && !this.headed) {
        const version = await this.attachment
          .requireConnection()
          .send<{ product?: string }>("Browser.getVersion")
          .catch(() => ({ product: "" }));
        this.capture.softwareCaptureColorCorrection = needsSoftwareCaptureColorCorrection({
          platform: process.platform,
          graphicsMode: this.graphics.mode,
          headless: !this.headed,
          product: version?.product ?? "",
          gpuCompositing: info.gpu?.featureStatus?.gpu_compositing,
        });
      }
    } catch (error) {
      if (this.graphics.mode !== "default") throw error;
    }
    if (this.graphics.mode === "wsl-d3d12") assertWslHardwareRenderer(renderer);
    if (this.graphics.mode === "vulkan") assertVulkanHardwareRenderer(renderer);
    if (this.graphics.mode === "wayland" && !isHardwareRenderer(renderer)) {
      throw new Error("Wayland GPU graphics did not select a hardware GPU");
    }
    this.graphicsObservation = {
      mode: this.graphics.mode,
      renderer,
      hardware: renderer === null ? null : isHardwareRenderer(renderer),
    };
    return this.graphicsObservation;
  }

  /** Attach an independent page controller to an existing browser session. */
  async attachTarget(targetId: string, owner: AgentBrowserRuntime): Promise<void> {
    this.attachment.assertRuntimeOpen();
    if (
      owner === this ||
      !owner.ownsBrowser ||
      owner.session !== this.session ||
      owner.ipcDirectory !== this.ipcDirectory ||
      owner.profilePath !== this.profilePath
    ) {
      throw new AgentBrowserIncompatibleError("Browser window owner does not match this session");
    }
    this.ownsBrowser = false;
    this.windows.delegateTo(owner.windows);
    await this.connectCdp(targetId, false);
  }

  /** Create a page in the existing profile without changing another controller's selected page. */
  async createTarget(url = "about:blank", beforeMutation?: () => void): Promise<string> {
    await this.windows.settle();
    beforeMutation?.();
    const result = await this.attachment
      .requireConnection()
      .send<{ targetId: string }>(
        "Target.createTarget",
        { url, newWindow: true, background: true },
        { mutation: true },
      );
    try {
      await this.windows.settle(result.targetId);
    } catch {
      throw new CdpUnknownOutcomeError(
        "Browser tab was created but its native window readiness is unknown; refresh the tab list before creating again",
      );
    }
    return result.targetId;
  }

  /** Close only the named page. The caller must keep another page in the browser. */
  async closeTarget(targetId: string): Promise<void> {
    const result = await this.attachment
      .requireConnection()
      .send<{ success: boolean }>("Target.closeTarget", { targetId }, { mutation: true });
    if (!result.success) throw new CdpUnavailableError("Browser tab could not be closed");
  }

  /** Close the exact attached preview through Chromium's Cancel UI, never an OS dialog or source tab. */
  async cancelPrintPreview(assertCurrent?: () => void): Promise<void> {
    const page = await this.requirePage();
    const generation = this.attachment.attachmentGeneration;
    await cancelPrintPreview(page, () => {
      assertCurrent?.();
      this.attachment.assertRuntimeOpen();
      if (this.attachment.page !== page || this.attachment.attachmentGeneration !== generation)
        throw new CdpUnavailableError("Print preview attachment changed");
    });
    this.capture.invalidateScreencastFrame();
  }

  /** Open print on this exact document; the owner supplies its private-display authority check. */
  async print(expectedInputGeneration: string, assertPrivateDisplay: () => void): Promise<void> {
    const page = await this.requirePage();
    const assertCurrent = () => {
      assertPrivateDisplay();
      this.attachment.assertRuntimeOpen();
      if (
        this.attachment.page !== page ||
        expectedInputGeneration !== this.attachment.inputGeneration()
      )
        throw new CdpUnavailableError("Print source document or attachment changed");
    };
    try {
      await openPrintPreview(page, assertCurrent);
    } finally {
      this.capture.invalidateScreencastFrame();
    }
  }

  /**
   * Retire this page controller while retaining its browser connection and process ownership.
   * Closing the launch tab must not attach a second controller to a surviving page: that
   * would restore this tab's device settings over the survivor's independent settings.
   * The retired target identity stays pinned, so later page access cannot adopt another tab.
   */
  async releaseTarget(): Promise<void> {
    this.attachment.assertRuntimeOpen();
    await this.capture.withVideoTransition(async () => {
      const page = this.attachment.page;
      if (!page) return;
      await this.input.endCurrentLiveInput();
      await this.input.releaseHeldInput(page);
      if (this.capture.screencastActive) {
        await page.send("Page.stopScreencast", {}, { mutation: true });
      }
      this.capture.screencastActive = false;
      this.attachment.attachmentGeneration += 1;
      this.attachment.page = null;
      this.attachment.emulationAppliedPage = null;
      // Retain this page's intent in case close fails and the same target still exists.
      // requirePage remains pinned to that target; it cannot apply this to a survivor.
      this.capture.invalidateScreencastFrame();
      await page.detach();
    });
  }

  async reconnect(): Promise<void> {
    this.attachment.assertRuntimeOpen();
    await this.capture.withVideoTransition(async () => {
      const targetId = this.attachment.targetId;
      this.attachment.attachmentGeneration += 1;
      this.capture.invalidateScreencastFrame();
      this.attachment.connection?.close();
      this.attachment.connection = null;
      this.windows.isolation = null;
      this.attachment.page = null;
      await this.cli.assertVersion();
      this.attachment.assertRuntimeOpen();
      await this.connectCdp(targetId);
    });
  }

  async health(): Promise<RuntimeHealth> {
    try {
      if (!this.attachment.connection?.isOpen) await this.reconnect();
      const targets = await this.targets();
      return {
        ready: true,
        session: this.session,
        profilePath: this.profilePath,
        targetCount: targets.length,
        identity: await this.identity(),
        error: null,
      };
    } catch (error) {
      return {
        ready: false,
        session: this.session,
        profilePath: this.profilePath,
        targetCount: 0,
        identity: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async domRequest(operation: string, input: import("./runtime-protocol").JsonValue) {
    const data = input as Record<string, import("./runtime-protocol").JsonValue>;
    const page = await this.requirePage();
    const generation = this.attachment.inputGeneration();
    const assertCurrent = () => {
      this.attachment.assertRuntimeOpen();
      if (
        page !== this.attachment.page ||
        generation !== this.attachment.inputGeneration() ||
        data.expectedInputGeneration !== generation
      )
        throw new CdpUnavailableError("DOM document or attachment changed; take a fresh snapshot");
      if (operation !== "dom.snapshot" && !this.input.liveInputAdmits(data.gestureId, page))
        throw new CdpUnavailableError("DOM action input channel expired");
    };
    assertCurrent();
    if (operation === "dom.snapshot")
      return this.agentDom.snapshot(page, generation, assertCurrent);
    try {
      return operation === "dom.action"
        ? await this.agentDom.action(page, generation, input, assertCurrent)
        : await this.agentDom.evaluate(page, generation, input, assertCurrent);
    } finally {
      if (operation === "dom.action") this.capture.invalidateScreencastFrame();
    }
  }

  async identity(): Promise<RuntimeIdentity> {
    await this.windows.recover(this.attachment.targetId ?? undefined);
    const connection = this.attachment.requireConnection();
    const version = await connection.send<VersionResult>("Browser.getVersion");
    const processId = await this.daemon.pid();
    const page = await this.requirePage();
    return {
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      browserProduct: version.product,
      browserRevision: version.revision,
      userAgent: version.userAgent,
      protocolVersion: version.protocolVersion,
      processId,
      targetId: page.targetId,
      graphics: await this.observeGraphics(),
    };
  }

  async targets(): Promise<RuntimeTarget[]> {
    await this.windows.recover();
    await this.windows.settle();
    const targets = (await listPageTargets(this.attachment.requireConnection())).filter(
      (target) => !target.url.startsWith(`chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/`),
    );
    for (const target of targets) {
      if (!isPrintPreviewUrl(target.url)) await this.windows.settle(target.targetId);
    }
    return targets;
  }

  async selectTarget(targetId: string, activate = true): Promise<void> {
    await this.capture.withVideoTransition(async () => {
      const attachmentGeneration = ++this.attachment.attachmentGeneration;
      const connection = this.attachment.requireConnection();
      const target = (await this.targets()).find((candidate) => candidate.targetId === targetId);
      this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
      if (!target) throw new CdpUnavailableError(`Unknown page target: ${targetId}`);
      this.capture.invalidateScreencastFrame();
      const previous = this.attachment.page;
      if (previous) {
        if (this.capture.screencastActive) {
          await previous.send("Page.stopScreencast", {}, { mutation: true });
          this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        }
        await previous.detach();
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
      }
      this.capture.invalidateScreencastFrame();
      if (activate) {
        await connection.send("Target.activateTarget", { targetId }, { mutation: true });
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
      }
      // CDP emulation is session-owned: detaching the former session restores native
      // window metrics. Publish a replacement only after its retained settings succeed.
      this.attachment.page = null;
      this.attachment.emulationAppliedPage = null;
      const replacement = await attachToTarget(connection, targetId);
      try {
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.bindPageEvents(replacement);
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.restoreConfiguredEmulation(replacement);
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        this.attachment.page = replacement;
        this.attachment.targetId = targetId;
        this.attachment.contentTarget = !isPrintPreviewUrl(target.url);
      } catch (error) {
        await replacement.detach().catch(() => undefined);
        // Detaching a partial emulation can clear target metrics even if a newer
        // attachment won. Its next access must restore intent before admitting pixels.
        this.attachment.emulationAppliedPage = null;
        this.capture.invalidateScreencastFrame();
        throw error;
      }
      if (this.capture.screencastActive) await this.capture.startScreencastSession(replacement);
    });
  }

  async emulate(device: DeviceEmulation): Promise<void> {
    this.assertViewport(device);
    await this.capture.withVideoTransition(async () => {
      await this.capture.withInvalidatedScreencast(async (page) => {
        const attachmentGeneration = this.attachment.attachmentGeneration;
        this.attachment.emulationAppliedPage = null;
        await this.applyEmulation(page, device);
        this.attachment.assertAttachmentCurrent(page.connection, attachmentGeneration);
        if (this.attachment.page !== page)
          throw new CdpUnavailableError("Browser page changed during emulation");
        this.attachment.viewport = { ...device };
        this.attachment.emulationAppliedPage = page;
      });
    });
  }

  /** Retain the full mode/UA/screen intent while rendering enough real source pixels for the chosen density. */
  async setCaptureDensity(density: number, baseDeviceScaleFactor: number): Promise<void> {
    const scale = captureDensitySchema.parse(density);
    const viewport = this.attachment.requireViewport();
    if (!canUseCaptureDensity(viewport, scale))
      throw new RangeError("Capture density exceeds the supported image bounds");
    if (
      !Number.isFinite(baseDeviceScaleFactor) ||
      baseDeviceScaleFactor < 1 ||
      baseDeviceScaleFactor > 4
    )
      throw new RangeError("Invalid device pixel ratio");
    await this.emulate({
      ...viewport,
      captureScale: scale,
      deviceScaleFactor: Math.max(baseDeviceScaleFactor, scale),
    });
  }

  /** Apply the entire device contract to one CDP session without changing saved intent. */
  private async applyEmulation(page: CdpSession, device: DeviceEmulation): Promise<void> {
    await page.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.deviceScaleFactor,
        mobile: device.mobile,
        screenWidth: device.screenWidth ?? device.width,
        screenHeight: device.screenHeight ?? device.height,
        screenOrientation: {
          type: device.width > device.height ? "landscapePrimary" : "portraitPrimary",
          angle: device.width > device.height ? 90 : 0,
        },
      },
      { mutation: true },
    );
    await page.send(
      "Emulation.setTouchEmulationEnabled",
      { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 },
      { mutation: true },
    );
    // An independently visible native window can still be inactive. Retain renderer
    // focus and prompt pointer acknowledgements without raising it or changing a viewer's
    // selection. Browser-side WebAuthn visibility comes from native window isolation;
    // this renderer override alone cannot satisfy that security check.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { mutation: true });
    // An empty override restores Chromium's real identity after device emulation.
    // Sending its native UA as a nonempty override would still remove client hints.
    await page.send(
      "Emulation.setUserAgentOverride",
      { userAgent: device.userAgent ?? "", platform: device.platform ?? "" },
      { mutation: true },
    );
  }

  /** No frame/input may use a session whose emulated viewport has not been restored. */
  private async restoreConfiguredEmulation(page: CdpSession): Promise<void> {
    const device = this.attachment.viewport;
    if (!device || this.attachment.emulationAppliedPage === page) return;
    await this.capture.withVideoTransition(async () => {
      const attachmentGeneration = this.attachment.attachmentGeneration;
      this.capture.invalidateScreencastFrame();
      this.attachment.emulationAppliedPage = null;
      await this.applyEmulation(page, device);
      this.attachment.assertAttachmentCurrent(page.connection, attachmentGeneration);
      if (device !== this.attachment.viewport) {
        throw new CdpUnavailableError("Browser device settings changed during restoration");
      }
      this.attachment.emulationAppliedPage = page;
      this.capture.invalidateScreencastFrame();
    });
  }

  /**
   * Concurrent callers share one in-flight shutdown; a failed one is not remembered as
   * success, so a later call retries and reports the same unconfirmed state.
   */
  async shutdown(force = false): Promise<void> {
    if (this.shutDown) return;
    if (this.shutdownInFlight) return this.shutdownInFlight;
    const operation = this.performShutdown(force);
    this.shutdownInFlight = operation;
    try {
      await operation;
      this.shutDown = true;
    } finally {
      if (this.shutdownInFlight === operation) this.shutdownInFlight = null;
    }
  }

  private async performShutdown(force: boolean): Promise<void> {
    this.attachment.stopping = true;
    this.capture.beginShutdown();
    await this.capture.withVideoTransition(async () => {
      await this.input.endCurrentLiveInput();
      await this.input.releaseHeldInput();
      this.capture.invalidateScreencastFrame();
      // Only the controller that launched the browser owns its session daemon.
      if (this.ownsBrowser) await this.daemon.stop(force);
      this.attachment.connection?.close();
      this.attachment.connection = null;
      this.windows.isolation = null;
      this.attachment.page = null;
      this.attachment.targetId = null;
      this.capture.invalidateScreencastFrame();
    });
  }

  private async connectCdp(
    preferredTargetId: string | null = null,
    activate = this.ownsBrowser,
    managementOnly = false,
  ): Promise<void> {
    this.attachment.assertRuntimeOpen();
    // A launch-selected page remains the intended target even if its first
    // attachment fails. Otherwise a retry could silently adopt another tab.
    if (!managementOnly && this.attachment.targetId === null && preferredTargetId !== null) {
      this.attachment.targetId = preferredTargetId;
    }
    const response = await this.cli.invoke(["--session", this.session, "--json", "get", "cdp-url"]);
    this.attachment.assertRuntimeOpen();
    const url = findString(response, ["cdpUrl", "cdp_url", "url"]);
    if (!url) throw new AgentBrowserIncompatibleError("agent-browser did not return a CDP URL");
    const endpoint = new URL(url);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
      throw new AgentBrowserIncompatibleError("agent-browser exposed a non-loopback CDP endpoint");
    }
    const connection = await CdpConnection.connect(url, {
      commandTimeoutMs: this.attachment.timeoutMs,
      connectTimeoutMs: this.attachment.timeoutMs,
    });
    if (this.attachment.stopping) {
      connection.close();
      this.attachment.assertRuntimeOpen();
    }
    this.attachment.connection = connection;
    this.windows.required = true;
    connection.once("disconnect", () => {
      if (this.attachment.connection !== connection) return;
      this.attachment.page = null;
      this.windows.isolation = null;
      // Keep the selected page identity. A transport loss does not authorize
      // adopting another tab, even when the original page still exists.
      this.attachment.emulationAppliedPage = null;
      this.attachment.attachmentGeneration += 1;
      this.capture.invalidateScreencastFrame();
    });
    try {
      const targets = await listPageTargets(connection);
      this.attachment.assertRuntimeOpen();
      if (managementOnly) {
        if (preferredTargetId && !targets.some((target) => target.targetId === preferredTargetId)) {
          throw new CdpUnavailableError("The selected browser page is no longer available");
        }
        this.windows.isolation = await BrowserWindowIsolation.connect(connection, true);
        return;
      }
      const expectedTargetId = preferredTargetId ?? this.attachment.targetId;
      const target =
        expectedTargetId === null
          ? targets.find(
              (target) =>
                !target.url.startsWith(`chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/`),
            )
          : targets.find((candidate) => candidate.targetId === expectedTargetId);
      if (expectedTargetId !== null && !target) {
        throw new CdpUnavailableError("The selected browser page is no longer available");
      }
      if (!target) throw new CdpUnavailableError("Chromium has no page target");
      // A missing selected page must refuse before creating helpers or moving any
      // surviving tab. Partial helper initialization never leaves a usable connection.
      if (this.ownsBrowser)
        this.windows.isolation = await BrowserWindowIsolation.connect(connection, true);
      await this.selectTarget(target.targetId, activate);
    } catch (error) {
      connection.close();
      if (this.attachment.connection === connection) {
        this.attachment.connection = null;
        this.windows.isolation = null;
      }
      throw error;
    }
  }

  private async requirePage(): Promise<CdpSession> {
    this.attachment.assertRuntimeOpen();
    if (this.attachment.page && this.attachment.connection?.isOpen) {
      const page = this.attachment.page;
      await this.windows.settle(this.attachment.contentTarget ? page.targetId : undefined);
      await this.restoreConfiguredEmulation(page);
      this.attachment.assertRuntimeOpen();
      if (this.attachment.page !== page || !this.attachment.connection?.isOpen) {
        throw new CdpUnavailableError("Browser page changed during emulation restoration");
      }
      return page;
    }
    await this.reconnect();
    this.attachment.assertRuntimeOpen();
    if (!this.attachment.page) throw new CdpUnavailableError("No page target is attached");
    return this.attachment.page;
  }

  private async bindPageEvents(page: CdpSession): Promise<void> {
    // URL equality is insufficient for reload. Main-document and same-document
    // navigation revoke the channel without treating child-frame loads as a reset.
    let rootFrameId: string | undefined;
    page.on("Page.frameNavigated", (event: { frame: { id: string; parentId?: string } }) => {
      if (page !== this.attachment.page || event.frame.parentId) return;
      rootFrameId = event.frame.id;
      this.attachment.documentGeneration += 1;
      this.capture.invalidateScreencastFrame();
      this.capture.invalidateQueuedVideoFrames();
      this.input.abandonLiveInput();
    });
    page.on("Page.navigatedWithinDocument", (event: { frameId: string }) => {
      if (page !== this.attachment.page || event.frameId !== rootFrameId) return;
      this.attachment.documentGeneration += 1;
      this.capture.invalidateScreencastFrame();
      this.capture.invalidateQueuedVideoFrames();
      this.input.abandonLiveInput();
    });
    page.on("Page.screencastFrame", (event: ScreencastFrame) =>
      this.capture.onScreencastFrame(page, event),
    );
    page.on("event", (event: CdpEvent) => {
      if (event.method === "Inspector.targetCrashed" && this.attachment.page === page) {
        this.attachment.documentGeneration += 1;
        void this.capture.stopVideo();
        this.input.abandonLiveInput();
        this.attachment.emulationAppliedPage = null;
        this.capture.invalidateScreencastFrame();
      }
    });
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable")]);
    const tree = await page.send<{ frameTree?: { frame: { id: string } } }>("Page.getFrameTree");
    rootFrameId = tree.frameTree?.frame.id ?? rootFrameId;
    await this.navigation.navigationHistory(page);
  }

  private async reattachPageForScreencast(previous: CdpSession): Promise<CdpSession> {
    this.attachment.assertRuntimeOpen();
    if (this.attachment.page !== previous) {
      if (!this.attachment.page)
        throw new CdpUnavailableError("Browser page changed during reattachment");
      return this.attachment.page;
    }
    return this.capture.withVideoTransition(async () => {
      const attachmentGeneration = ++this.attachment.attachmentGeneration;
      const connection = this.attachment.requireConnection();
      const targets = await listPageTargets(connection);
      this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
      const target = targets.find((candidate) => candidate.targetId === previous.targetId);
      if (!target)
        throw new CdpUnavailableError("The selected browser page is no longer available");
      await connection.send(
        "Target.activateTarget",
        { targetId: target.targetId },
        { mutation: true },
      );
      this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
      const replacement = await attachToTarget(connection, target.targetId);
      if (
        this.attachment.page !== previous ||
        attachmentGeneration !== this.attachment.attachmentGeneration
      ) {
        await replacement.detach().catch(() => undefined);
        // The losing controller's detach may clear target overrides. Repair the
        // current controller on its next access rather than trust earlier pixels.
        this.attachment.emulationAppliedPage = null;
        this.capture.invalidateScreencastFrame();
        if (!this.attachment.page)
          throw new CdpUnavailableError("Browser page changed during reattachment");
        return this.attachment.page;
      }
      this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);

      this.capture.invalidateScreencastFrame();
      // Detaching drops the session that holds any pressed button; release there first.
      await this.input.endCurrentLiveInput();
      await this.input.releaseHeldInput(previous);
      this.attachment.page = null;
      this.attachment.emulationAppliedPage = null;
      // Detach first: the former session can otherwise clear the newly applied override.
      try {
        await previous.detach();
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.bindPageEvents(replacement);
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        await this.restoreConfiguredEmulation(replacement);
        this.attachment.assertAttachmentCurrent(connection, attachmentGeneration);
        this.attachment.page = replacement;
        this.attachment.targetId = target.targetId;
        return replacement;
      } catch (error) {
        await replacement.detach().catch(() => undefined);
        // Detaching a partial emulation can clear target metrics even if a newer
        // attachment won. Its next access must restore intent before admitting pixels.
        this.attachment.emulationAppliedPage = null;
        this.capture.invalidateScreencastFrame();
        throw error;
      }
    });
  }

  private assertViewport(viewport: BrowserViewport): void {
    const captureScale = viewport.captureScale ?? 1;
    const pixels = captureDimensions(viewport, captureScale);
    if (
      !Number.isFinite(captureScale) ||
      captureScale < 1 ||
      captureScale > 2 ||
      pixels.width > MAX_VIEWPORT.width ||
      pixels.height > MAX_VIEWPORT.height
    ) {
      throw new RangeError("Capture density exceeds the supported image bounds");
    }
    if (
      !Number.isInteger(viewport.width) ||
      viewport.width < 1 ||
      viewport.width > 16_384 ||
      !Number.isInteger(viewport.height) ||
      viewport.height < 1 ||
      viewport.height > 16_384 ||
      !Number.isFinite(viewport.deviceScaleFactor) ||
      viewport.deviceScaleFactor <= 0 ||
      viewport.deviceScaleFactor > 10
    )
      throw new RangeError("Invalid viewport emulation values");
  }

  /** Starts only exact restored native tab capture, lazily adding this viewer's quality encoder. */
  startVideo(...args: Parameters<RuntimeCapture["startVideo"]>) {
    return this.capture.startVideo(...args);
  }

  /** Long-poll outside the input queue. The caller must fence returned inputGeneration before publication. */
  readVideo(...args: Parameters<RuntimeCapture["readVideo"]>) {
    return this.capture.readVideo(...args);
  }

  /** Explicit action barrier; pointer samples preserve the native track and encoder continuity. */
  invalidateQueuedVideoFrames(): void {
    this.capture.invalidateQueuedVideoFrames();
  }

  /** Stop admission too: a concurrent reader cannot replace a source still closing. */
  stopVideo(): Promise<void> {
    return this.capture.stopVideo();
  }

  /** Explicit viewing start remains supported, but does not keep unused JPEG work alive. */
  startScreencast(...args: Parameters<RuntimeCapture["startScreencast"]>): Promise<void> {
    return this.capture.startScreencast(...args);
  }

  /** Explicit detach cleanup and idle retirement use the same native transition FIFO. */
  stopScreencast(): Promise<void> {
    return this.capture.stopScreencast();
  }

  /** Return truthful fresh stream/fallback pixels; mutation/session changes revoke pending captures. */
  frame(...args: Parameters<RuntimeCapture["frame"]>) {
    return this.capture.frame(...args);
  }

  /** Read fresh page metadata; see `RuntimeNavigation.state`. */
  state(...args: Parameters<RuntimeNavigation["state"]>) {
    return this.navigation.state(...args);
  }

  /** Navigate and await the main-frame commit; see `RuntimeNavigation.navigate`. */
  navigate(url: string): Promise<void> {
    return this.navigation.navigate(url);
  }

  back(): Promise<void> {
    return this.navigation.back();
  }

  forward(): Promise<void> {
    return this.navigation.forward();
  }

  reload(ignoreCache = false): Promise<void> {
    return this.navigation.reload(ignoreCache);
  }

  mouseMove(...args: Parameters<RuntimeInput["mouseMove"]>): Promise<void> {
    return this.input.mouseMove(...args);
  }

  /** Fixed native mouse departure; never maps an outside point to a page control. */
  mouseLeave(gestureId: string): Promise<void> {
    return this.input.mouseLeave(gestureId);
  }

  mouseDown(...args: Parameters<RuntimeInput["mouseDown"]>): Promise<void> {
    return this.input.mouseDown(...args);
  }

  mouseUp(...args: Parameters<RuntimeInput["mouseUp"]>): Promise<void> {
    return this.input.mouseUp(...args);
  }

  wheel(...args: Parameters<RuntimeInput["wheel"]>): Promise<void> {
    return this.input.wheel(...args);
  }

  /** Insert a committed paste/IME value on the original guarded attachment. */
  insertText(...args: Parameters<RuntimeInput["insertText"]>): Promise<void> {
    return this.input.insertText(...args);
  }

  /** Track cleanup intent before publication, including an uncertain key-down reply. */
  dispatchKey(...args: Parameters<RuntimeInput["dispatchKey"]>): Promise<void> {
    return this.input.dispatchKey(...args);
  }

  keyDown(...args: Parameters<RuntimeInput["keyDown"]>): Promise<void> {
    return this.input.keyDown(...args);
  }

  keyUp(...args: Parameters<RuntimeInput["keyUp"]>): Promise<void> {
    return this.input.keyUp(...args);
  }

  /** Publish a complete touch contact set; see `RuntimeInput.touch`. */
  touch(...args: Parameters<RuntimeInput["touch"]>): Promise<void> {
    return this.input.touch(...args);
  }

  /** Bind a live input channel to the exact current attachment and document. */
  beginLiveInput(id: string, expectedInputGeneration: string): Promise<void> {
    return this.input.beginLiveInput(id, expectedInputGeneration);
  }

  /** Compare after every asynchronous transport boundary, including automatic reconnect/reattach. */
  assertLiveInput(id: string): Promise<void> {
    return this.input.assertLiveInput(id);
  }

  /** Cleanup is idempotent and targets the original attachment, never whatever is currently active. */
  endLiveInput(id: string): Promise<void> {
    return this.input.endLiveInput(id);
  }

  /** Fixed hit-test, safe cursor names only. Cursor failures cannot fail an acknowledged input. */
  cursorAt(...args: Parameters<RuntimeInput["cursorAt"]>) {
    return this.input.cursorAt(...args);
  }

  /** Release only what `page` itself holds; defaults to the current page. */
  releaseHeldInput(page?: CdpSession | null): Promise<void> {
    return this.input.releaseHeldInput(page);
  }
}
