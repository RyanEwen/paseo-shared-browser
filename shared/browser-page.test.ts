import { expect, it } from "vitest";
import { listBrowserTabsRpc, MAX_BROWSER_PAGE_TARGETS, MAX_BROWSER_TABS } from "./browser";
import { browserPageTitle, isPrintPreviewUrl } from "./browser-page";

it("labels only the real top-level Chromium preview, without inferring its source", () => {
  expect(browserPageTitle("Invoice", "chrome://print/")).toBe("Print preview: Invoice");
  for (const url of [
    "https://print/",
    "https://example.com/chrome://print/",
    "chrome-untrusted://print/x/print.pdf",
    "chrome://print/other",
    "invalid",
  ])
    expect(isPrintPreviewUrl(url)).toBe(false);
});

it("admits eight original tabs and their transient previews without changing the content limit", () => {
  expect(MAX_BROWSER_TABS).toBe(8);
  const tabs = Array.from({ length: MAX_BROWSER_PAGE_TARGETS }, (_, index) => ({
    id: `page-${index}`,
    title: "Document",
    url: index < MAX_BROWSER_TABS ? "about:blank" : "chrome://print/",
    viewerCount: 0,
    controllerLabel: null,
  }));
  expect(listBrowserTabsRpc.output.parse({ tabs }).tabs).toHaveLength(16);
  expect(listBrowserTabsRpc.output.safeParse({ tabs: [...tabs, tabs[0]] }).success).toBe(false);
});
