import { expect, it } from "vitest";
import type { BrowserState } from "../shared/browser";
import { emptyTabListLabel } from "./browser-tab-labels";

it("labels an empty workspace as having no pages instead of connecting forever", () => {
  expect(emptyTabListLabel({ status: "empty" } as BrowserState)).toBe("No pages open");
  expect(emptyTabListLabel({ status: "error" } as BrowserState)).toBe("Browser unavailable");
  expect(emptyTabListLabel({ status: "starting" } as BrowserState)).toBe("Connecting browser…");
  expect(emptyTabListLabel(null)).toBe("Connecting browser…");
});
