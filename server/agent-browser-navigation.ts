import type { RuntimeAttachment } from "./agent-browser-attachment";
import type { RuntimePageState } from "./agent-browser-types";
import { type CdpSession, CdpUnavailableError } from "./cdp";
import { formatRuntimeInputGeneration } from "./input-generation";
import {
  NAVIGATION_ACK_TIMEOUT_MS,
  NAVIGATION_COMMIT_TIMEOUT_MS,
  NAVIGATION_METADATA_TIMEOUT_MS,
} from "./navigation-budget";
import { waitForNavigationCommit } from "./navigation-commit";

/** Largest caller-chosen metadata budget; matches the runtime's default command timeout. */
/** Upper bound for a caller-supplied metadata timeout; the runtime's default timeout. */
export const MAX_METADATA_TIMEOUT_MS = 15_000;

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}

/** Page operations navigation needs from its runtime. */
export interface RuntimeNavigationHost {
  /** The current page, restored and settled; may reconnect. */
  requirePage(): Promise<CdpSession>;
  /** Repair browser-management transport on a safe observation. */
  recoverWindowManagement(expectedTargetId?: string): Promise<void>;
  /** Run a page mutation that invalidates captured pixels around it. */
  withInvalidatedScreencast(
    mutation: (page: CdpSession) => Promise<unknown>,
    options?: { preserveStream?: boolean },
  ): Promise<void>;
}

/**
 * Navigation and page metadata for one page controller. Mutations wait for the native
 * acknowledgement and main-frame commit on the original attachment; an unconfirmed commit is
 * an unknown outcome and is never replayed.
 */
export class RuntimeNavigation {
  /**
   * @param attachment The controller's shared page attachment.
   * @param host Page operations owned by the runtime.
   */
  constructor(
    private readonly attachment: RuntimeAttachment,
    private readonly host: RuntimeNavigationHost,
  ) {}

  async navigationHistory(
    page: CdpSession,
    timeoutMs = this.attachment.timeoutMs,
  ): Promise<NavigationHistory> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new CdpUnavailableError("Browser navigation history observation timed out");
      try {
        return await page.send<NavigationHistory>(
          "Page.getNavigationHistory",
          {},
          { timeoutMs: remaining },
        );
      } catch (error) {
        if (!String(error).includes("Not attached to an active page") || Date.now() >= deadline) {
          throw error;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
  }

  /** Read fresh metadata concurrently, discarding both replies if the document changes.
   * One same-attachment reread shares the original monotonic timeout budget in
   * milliseconds. Failed reads, replacement attachments and repeated document
   * changes reject; this read-only recovery never repeats a native mutation. */
  async state(options: { timeoutMs?: number } = {}): Promise<RuntimePageState> {
    await this.host.recoverWindowManagement(this.attachment.targetId ?? undefined);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > MAX_METADATA_TIMEOUT_MS)
    ) {
      throw new RangeError("Browser metadata timeout must be an integer from 1 to 15000ms");
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.attachment.timeoutMs,
      this.attachment.timeoutMs,
    );
    const page = await this.host.requirePage();
    const attachmentGeneration = this.attachment.attachmentGeneration;
    const deadline = performance.now() + timeoutMs;

    for (let attempt = 0; attempt < 2; attempt++) {
      this.attachment.assertRuntimeOpen();
      const remaining = attempt === 0 ? timeoutMs : deadline - performance.now();
      if (remaining <= 0) {
        throw new CdpUnavailableError("Browser metadata observation timed out");
      }
      const documentGeneration = this.attachment.documentGeneration;
      // Both observations must describe the same document. A navigation discards
      // the entire pair; neither native history nor DOM metadata is cached.
      const [history, evaluated] = await Promise.all([
        this.navigationHistory(page, remaining),
        page.send<{
          result: { value?: { url?: string; title?: string } };
        }>(
          "Runtime.evaluate",
          {
            expression: "({url: location.href, title: document.title})",
            returnByValue: true,
          },
          { timeoutMs: remaining },
        ),
      ]);
      this.attachment.assertRuntimeOpen();
      if (
        page !== this.attachment.page ||
        attachmentGeneration !== this.attachment.attachmentGeneration
      ) {
        throw new CdpUnavailableError("Browser metadata changed while being read");
      }
      // Successful replies can beat an overdue CDP timer in the event queue.
      // Their metadata still cannot outlive the original shared phase budget.
      if (performance.now() >= deadline) {
        throw new CdpUnavailableError("Browser metadata observation timed out");
      }
      if (documentGeneration !== this.attachment.documentGeneration) {
        if (attempt === 0) continue;
        throw new CdpUnavailableError("Browser metadata changed while being read");
      }
      return {
        url: evaluated.result.value?.url ?? history.entries[history.currentIndex]?.url ?? "",
        title: evaluated.result.value?.title ?? history.entries[history.currentIndex]?.title ?? "",
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
        inputGeneration: formatRuntimeInputGeneration(attachmentGeneration, documentGeneration),
      };
    }
    throw new CdpUnavailableError("Browser metadata changed while being read");
  }

  /** Await native ACK and its main-frame commit, without waiting for scripts or
   * DOMContentLoaded. A missing commit remains uncertain and is never replayed. */
  async navigate(url: string): Promise<void> {
    await this.host.withInvalidatedScreencast(
      async (page) => {
        const assertCurrent = this.navigationAttachmentGuard(page);
        await waitForNavigationCommit(
          page,
          async () => {
            const result = await page.send<{
              frameId: string;
              errorText?: string;
              loaderId?: string;
              isDownload?: boolean;
            }>(
              "Page.navigate",
              { url },
              {
                mutation: true,
                timeoutMs: Math.min(this.attachment.timeoutMs, NAVIGATION_ACK_TIMEOUT_MS),
              },
            );
            // Chromium can abort document navigation because the accepted
            // response is a download. This does not replace the current page.
            if (result.errorText && !result.isDownload) {
              throw new Error(`Navigation failed: ${result.errorText}`);
            }
            return {
              frameId: result.frameId,
              ...(result.loaderId ? { loaderId: result.loaderId } : {}),
              url,
              ...(result.isDownload ? { download: true } : {}),
            };
          },
          assertCurrent,
          Math.min(this.attachment.timeoutMs, NAVIGATION_COMMIT_TIMEOUT_MS),
        );
      },
      { preserveStream: true },
    );
  }

  async back(): Promise<void> {
    await this.navigateHistory(-1);
  }

  async forward(): Promise<void> {
    await this.navigateHistory(1);
  }

  /** History's ACK has no loader receipt. Capture its root loader and target URL
   * in one parallel bounded preflight, then admit only the matching new commit. */
  private async navigateHistory(direction: -1 | 1): Promise<void> {
    await this.host.withInvalidatedScreencast(
      async (page) => {
        const assertCurrent = this.navigationAttachmentGuard(page);
        const [history, root] = await Promise.all([
          this.navigationHistory(
            page,
            Math.min(this.attachment.timeoutMs, NAVIGATION_METADATA_TIMEOUT_MS),
          ),
          this.navigationRoot(page),
        ]);
        assertCurrent();
        const entry = history.entries[history.currentIndex + direction];
        if (!entry)
          throw new Error(
            direction === -1 ? "Browser cannot go back" : "Browser cannot go forward",
          );
        await waitForNavigationCommit(
          page,
          async () => {
            await page.send(
              "Page.navigateToHistoryEntry",
              { entryId: entry.id },
              {
                mutation: true,
                timeoutMs: Math.min(this.attachment.timeoutMs, NAVIGATION_ACK_TIMEOUT_MS),
              },
            );
            return { frameId: root.id, previousLoaderId: root.loaderId, url: entry.url };
          },
          assertCurrent,
          Math.min(this.attachment.timeoutMs, NAVIGATION_COMMIT_TIMEOUT_MS),
        );
      },
      { preserveStream: true },
    );
  }

  async reload(ignoreCache = false): Promise<void> {
    await this.host.withInvalidatedScreencast(
      async (page) => {
        const assertCurrent = this.navigationAttachmentGuard(page);
        const root = await this.navigationRoot(page);
        assertCurrent();
        await waitForNavigationCommit(
          page,
          async () => {
            await page.send(
              "Page.reload",
              { ignoreCache },
              {
                mutation: true,
                timeoutMs: Math.min(this.attachment.timeoutMs, NAVIGATION_ACK_TIMEOUT_MS),
              },
            );
            return { frameId: root.id, previousLoaderId: root.loaderId };
          },
          assertCurrent,
          Math.min(this.attachment.timeoutMs, NAVIGATION_COMMIT_TIMEOUT_MS),
        );
      },
      { preserveStream: true },
    );
  }

  /** A root snapshot is observation only, bounded before mutation publication. */
  private async navigationRoot(page: CdpSession): Promise<{ id: string; loaderId: string }> {
    const result = await page.send<{ frameTree: { frame: { id: string; loaderId: string } } }>(
      "Page.getFrameTree",
      {},
      { timeoutMs: Math.min(this.attachment.timeoutMs, NAVIGATION_METADATA_TIMEOUT_MS) },
    );
    const root = result.frameTree.frame;
    if (!root.id || !root.loaderId)
      throw new CdpUnavailableError("Browser main frame is unavailable");
    return root;
  }

  /** Keep commit observation on the original attachment, including shutdown. */
  private navigationAttachmentGuard(page: CdpSession): () => void {
    const attachmentGeneration = this.attachment.attachmentGeneration;
    return () => {
      this.attachment.assertAttachmentCurrent(page.connection, attachmentGeneration);
      if (this.attachment.page !== page)
        throw new CdpUnavailableError("Browser page changed during navigation");
    };
  }
}
