import type { CdpSession } from "./cdp";

/**
 * Activate the pinned source, then call real window.print exactly once.
 * The caller must prove private-display ownership before invoking this helper.
 * A modal print can withhold evaluation's reply; preserve its unknown outcome
 * instead of assuming a preview opened or scheduling a second print attempt.
 */
export async function openPrintPreview(page: CdpSession, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  const tree = await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
  assertCurrent();
  // The built-in Window.print in this world cannot be replaced by site scripts.
  // Native beforeprint/afterprint events still reach the shared document.
  const world = await page.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "shared-browser-print",
  });
  assertCurrent();
  await page.send("Page.bringToFront", {}, { mutation: true });
  assertCurrent();
  const result = await page.send<{ exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    {
      expression: "window.print()",
      contextId: world.executionContextId,
      userGesture: true,
      returnByValue: true,
    },
    // Printing pauses this evaluation until dismissal. Bound only this explicit
    // operation so callers can list/select the preview while it remains open.
    { mutation: true, timeoutMs: 1500 },
  );
  assertCurrent();
  if (result.exceptionDetails)
    throw new Error("The page's print call failed; inspect tabs before retrying");
}

/**
 * Dismiss the exact attached Chromium preview using its Cancel control.
 * Validate the attachment before sending once. The pinned session cannot adopt
 * another page, and successful cancellation can destroy it before the reply;
 * the caller confirms target removal instead of asserting a surviving attachment.
 */
export async function cancelPrintPreview(
  page: CdpSession,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const result = await page.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>(
    "Runtime.evaluate",
    {
      expression: `(() => {
      if (location.href !== 'chrome://print/') throw new Error('Not a Chromium print preview');
      const app = document.querySelector('print-preview-app');
      const sidebar = app?.shadowRoot?.querySelector('print-preview-sidebar');
      const strip = sidebar?.shadowRoot?.querySelector('print-preview-button-strip');
      const cancel = strip?.shadowRoot?.querySelector('.cancel-button');
      if (!cancel || cancel.disabled || !cancel.getClientRects().length) throw new Error('Print preview Cancel control unavailable');
      cancel.click();
      return true;
    })()`,
      returnByValue: true,
      userGesture: true,
      timeout: 1000,
    },
    { mutation: true, timeoutMs: 1500 },
  );
  if (result.exceptionDetails || result.result?.value !== true)
    throw new Error("Print preview Cancel control was not acknowledged");
}
