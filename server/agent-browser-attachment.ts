import {
  AgentBrowserIncompatibleError,
  type BrowserViewport,
  type DeviceEmulation,
} from "./agent-browser-types";
import { type CdpConnection, type CdpSession, CdpUnavailableError } from "./cdp";
import { formatRuntimeInputGeneration } from "./input-generation";

/**
 * The page attachment one `AgentBrowserRuntime` controller shares with its capture, input and
 * navigation collaborators.
 *
 * Every asynchronous step captures `page`, `attachmentGeneration` or `documentGeneration`
 * before awaiting and compares them afterwards. A replaced attachment or a new document makes
 * the late result fail closed instead of publishing pixels or input against another page.
 */
export class RuntimeAttachment {
  /** Browser-level CDP connection; null while disconnected. */
  connection: CdpConnection | null = null;
  /** Session attached to the selected page; null between attachments. */
  page: CdpSession | null = null;
  /** The selected page's identity, kept across transport loss so recovery never adopts another tab. */
  targetId: string | null = null;
  /** False while the selected page is a print preview. */
  contentTarget = true;
  /** Incremented whenever the page attachment or connection is replaced. */
  attachmentGeneration = 0;
  /** Incremented when the selected page's main document changes, including same-document navigation. */
  documentGeneration = 0;
  /** Configured device intent, retained across attachments. */
  viewport: DeviceEmulation | null = null;
  /** The session on which `viewport` was last applied; any other session must restore it first. */
  emulationAppliedPage: CdpSession | null = null;
  /** Set once shutdown starts; every later acquisition refuses. */
  stopping = false;

  /** @param timeoutMs Bound for each CDP command and metadata observation, in milliseconds. */
  constructor(readonly timeoutMs: number) {}

  /** Shutdown cleanup uses captured attachments directly; acquisition cannot revive them. */
  assertRuntimeOpen(): void {
    if (this.stopping) throw new CdpUnavailableError("Browser runtime is shutting down");
  }

  /** The open browser connection, refusing during shutdown or while disconnected. */
  requireConnection(): CdpConnection {
    this.assertRuntimeOpen();
    if (!this.connection?.isOpen) throw new CdpUnavailableError("Browser runtime is disconnected");
    return this.connection;
  }

  /** The configured device intent; emulation must have been configured first. */
  requireViewport(): BrowserViewport {
    if (!this.viewport) throw new AgentBrowserIncompatibleError("Viewport has not been configured");
    return this.viewport;
  }

  /** Reject late configuration completions after a disconnect or newer target selection. */
  assertAttachmentCurrent(connection: CdpConnection, generation: number): void {
    this.assertRuntimeOpen();
    if (
      connection !== this.connection ||
      !connection.isOpen ||
      generation !== this.attachmentGeneration
    ) {
      throw new CdpUnavailableError("Browser attachment changed during emulation restoration");
    }
  }

  /** The opaque attachment/document revision that input and DOM callers fence on. */
  inputGeneration(): string {
    return formatRuntimeInputGeneration(this.attachmentGeneration, this.documentGeneration);
  }
}
