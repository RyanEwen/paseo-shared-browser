import type { BrowserState } from "../shared/browser";

/**
 * What an empty tab list means. An attached workspace with no pages is a resting state, not a
 * connection in progress; the canvas offers the URL field and New Tab for the first page.
 */
export function emptyTabListLabel(selectedState: BrowserState | null): string {
  if (selectedState?.status === "empty") return "No pages open";
  if (selectedState?.status === "error") return "Browser unavailable";
  return "Connecting browser…";
}
