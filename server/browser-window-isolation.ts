/** One trusted hidden window manager per invisible Chromium profile, shared by every page controller. */
import {
  attachToTarget,
  type CdpConnection,
  type CdpSession,
  CdpUnavailableError,
  listPageTargets,
} from "./cdp";
import { NATIVE_VIDEO_EXTENSION_ID } from "./native-video-extension";

const MANAGER_URL = `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/windows.html`;

export class BrowserWindowIsolation {
  private dirty = true;
  private revision = 0;
  private available = true;
  private targetIds = new Set<string>();
  private pending: Promise<void> | null = null;
  private readonly disposers: (() => void)[] = [];
  private constructor(private readonly helper: CdpSession) {}

  /** Only the browser owner may create the helper; attached controllers reuse its exact target. */
  static async connect(
    connection: CdpConnection,
    create: boolean,
  ): Promise<BrowserWindowIsolation> {
    const existing = (await listPageTargets(connection)).filter(
      (target) => target.url === MANAGER_URL,
    );
    if (existing.length > 1)
      throw new CdpUnavailableError("Browser window manager identity is ambiguous");
    let targetId = existing[0]?.targetId;
    if (!targetId) {
      if (!create) throw new CdpUnavailableError("Browser window manager is unavailable");
      const created = await connection.send<{ targetId: string }>(
        "Target.createTarget",
        { url: MANAGER_URL, hidden: true, background: true },
        { mutation: true },
      );
      targetId = created.targetId;
    }
    const helper = await attachToTarget(connection, targetId);
    const manager = new BrowserWindowIsolation(helper);
    try {
      await manager.evaluate(
        `document.readyState === 'complete' ? true : new Promise(resolve => addEventListener('load', () => resolve(true), {once:true}))`,
      );
      const dirty = (event: { name: string }) => {
        if (event.name === "sharedBrowserWindowDirty") {
          manager.dirty = true;
          manager.revision++;
        }
      };
      helper.on("Runtime.bindingCalled", dirty);
      const unavailable = () => {
        manager.available = false;
        manager.targetIds.clear();
      };
      helper.on("Runtime.executionContextsCleared", unavailable);
      helper.on("Page.frameNavigated", unavailable);
      const detached = (event: { sessionId: string }) => {
        if (event.sessionId === helper.sessionId) unavailable();
      };
      connection.on("Target.detachedFromTarget", detached);
      manager.disposers.push(() => {
        helper.off("Runtime.bindingCalled", dirty);
        helper.off("Runtime.executionContextsCleared", unavailable);
        helper.off("Page.frameNavigated", unavailable);
        connection.off("Target.detachedFromTarget", detached);
      });
      await helper.send("Runtime.addBinding", { name: "sharedBrowserWindowDirty" });
      await helper.send("Runtime.enable");
      await helper.send("Page.enable");
      await manager.settle();
      return manager;
    } catch (error) {
      await manager.dispose();
      throw error;
    }
  }

  /** A browser-management recovery can replace this adapter without selecting any content page. */
  get isAvailable(): boolean {
    return this.available && this.helper.connection.isOpen;
  }

  /** Retire only this CDP attachment/listeners; the browser connection owns helper lifetime. */
  async dispose(): Promise<void> {
    this.available = false;
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.helper.detach().catch(() => undefined);
  }

  /** Await automatic popup/restored-tab relocation before exposing or controlling a target. */
  async settle(targetId?: string): Promise<void> {
    if (this.pending) await this.pending;
    this.assertAvailable();
    // Stable frame and pointer reads share a settled generation. Only native tab
    // events and first access to a target require a helper/CDP round trip.
    if (!this.dirty && (!targetId || this.targetIds.has(targetId))) return;
    const operation = this.refresh(targetId);
    this.pending = operation;
    try {
      await operation;
    } finally {
      if (this.pending === operation) this.pending = null;
    }
  }

  /** A late binding cannot be cleared by an older evaluation reply. */
  private async refresh(targetId?: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const revision = this.revision;
      this.assertAvailable();
      const result = await this.evaluate<{ targetId?: string; targetIds: string[] }>(
        `sharedBrowserWindows.settle(${JSON.stringify(targetId ?? null)})`,
      );
      this.assertAvailable();
      if (
        !result ||
        !Array.isArray(result.targetIds) ||
        (targetId && result.targetId !== targetId)
      ) {
        throw new CdpUnavailableError("Browser window target changed during isolation");
      }
      this.targetIds = new Set(result.targetIds);
      this.dirty = revision !== this.revision;
      if (!this.dirty) return;
    }
    throw new CdpUnavailableError("Browser window events did not settle");
  }

  /** Cached readiness is never valid after helper document/session loss. */
  private assertAvailable(): void {
    if (!this.available || !this.helper.connection.isOpen) {
      throw new CdpUnavailableError("Browser window manager attachment is unavailable");
    }
  }

  /** Only fixed trusted helper code runs here; site content and credentials are never evaluated. */
  private async evaluate<T>(expression: string): Promise<T> {
    const result = await this.helper.send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      { mutation: true },
    );
    if (result.exceptionDetails) throw new CdpUnavailableError("Browser window isolation failed");
    return result.result.value;
  }
}
