import type { RuntimeAttachment } from "./agent-browser-attachment";
import { BrowserWindowIsolation } from "./browser-window-isolation";
import { CdpUnavailableError, listPageTargets } from "./cdp";

/** Process and connection operations window management recovery needs from its runtime. */
export interface RuntimeWindowHost {
  /** Observe the launched session daemon; only `owned` permits reconnecting management. */
  daemonState(): Promise<"gone" | "owned" | "alive" | "unknown">;
  /** Connect to the browser, optionally for management only, without adopting another page. */
  connectCdp(
    preferredTargetId: string | null,
    activate: boolean,
    managementOnly: boolean,
  ): Promise<void>;
}

/**
 * The hidden native-window manager that keeps one invisible window per content tab. It belongs
 * to the controller whose connection created it; other controllers of the same browser
 * delegate to that owner rather than discovering it by URL.
 */
export class RuntimeWindowManager {
  /** The manager on this controller's connection; null while reconnecting or unavailable. */
  isolation: BrowserWindowIsolation | null = null;
  /** Set once a connection exists; afterwards page access refuses while no manager is available. */
  required = false;
  private owner: RuntimeWindowManager | null = null;
  private recovery: Promise<void> | null = null;

  /**
   * @param attachment The controller's shared page attachment.
   * @param host Process and connection operations owned by the runtime.
   */
  constructor(
    private readonly attachment: RuntimeAttachment,
    private readonly host: RuntimeWindowHost,
  ) {}

  /** Use the launching controller's manager for every later recovery and settle. */
  delegateTo(owner: RuntimeWindowManager): void {
    this.owner = owner;
  }

  /** Repair only browser-management transport on safe observations, including after the launch tab closes.
   * No content page is adopted, no browser process is launched, and no input is replayed.
   */
  async recover(expectedTargetId?: string): Promise<void> {
    this.attachment.assertRuntimeOpen();
    if (this.owner) {
      await this.owner.recover(expectedTargetId);
      return;
    }
    if (!this.required || this.isolation?.isAvailable) return;
    if (this.recovery) {
      await this.recovery;
      return;
    }
    const operation = (async () => {
      const connection = this.attachment.connection;
      if (connection?.isOpen) {
        if (
          expectedTargetId &&
          !(await listPageTargets(connection)).some(
            (target) => target.targetId === expectedTargetId,
          )
        ) {
          throw new CdpUnavailableError("The selected browser page is no longer available");
        }
        const previous = this.isolation;
        this.isolation = null;
        await previous?.dispose();
        this.isolation = await BrowserWindowIsolation.connect(connection, true);
        return;
      }
      // Never let a CLI discovery command implicitly replace a lost session daemon.
      // The original nonce-owned process must still be alive before reconnecting.
      if ((await this.host.daemonState()) !== "owned") {
        throw new CdpUnavailableError("Existing browser management process is unavailable");
      }
      await this.host.connectCdp(expectedTargetId ?? null, false, true);
    })();
    this.recovery = operation;
    try {
      await operation;
    } finally {
      if (this.recovery === operation) this.recovery = null;
    }
  }

  /** The hidden manager belongs to its creator connection; share owner authority directly, never discover it by URL from another controller. */
  async settle(targetId?: string): Promise<void> {
    if (this.owner) {
      await this.owner.settle(targetId);
      return;
    }
    if (this.required && !this.isolation) {
      throw new CdpUnavailableError("Browser window manager is reconnecting or unavailable");
    }
    await this.isolation?.settle(targetId);
  }
}
