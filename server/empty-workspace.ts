/**
 * Shared vocabulary for a workspace that has a reserved browser identity but no page yet.
 * Used by the lazy runtime owner (supervisor side) and the session policy (viewer side).
 */

/** The one message every empty-workspace refusal uses, on the server and in agent replies. */
export const NO_PAGE_OPEN_MESSAGE = "No page is open. Open a URL or new tab first.";

/**
 * Operations an empty workspace answers without a page. Anything else is refused with
 * `NO_PAGE_OPEN_MESSAGE` until a URL or New Tab creates the first page.
 */
export const EMPTY_WORKSPACE_OPERATIONS: ReadonlySet<string> = new Set([
  "tabs.list",
  "tabs.create",
  "tabs.open",
  "screencast.stop",
  "video.stop",
]);

/**
 * Wire 2 adapters still describe the old behaviour, where a workspace always had a page. Add a
 * plain instruction to their replies about an empty workspace, using those adapters' tool names.
 *
 * @param reply An agent reply as returned to the adapter.
 * @returns The same reply, with a `hint` when its state reports an empty workspace.
 */
export function withLegacyEmptyWorkspaceHint<Reply>(reply: Reply): Reply {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return reply;
  const state = (reply as { state?: unknown }).state;
  if (!state || typeof state !== "object" || (state as { status?: unknown }).status !== "empty")
    return reply;
  return {
    ...reply,
    hint: "No page is open in this workspace. Call shared_browser_acquire_control, then shared_browser_navigate with a URL (or shared_browser_tab_open for a blank tab) to open the first page.",
  };
}
