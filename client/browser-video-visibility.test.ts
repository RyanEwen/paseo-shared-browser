/** Real EventTarget envelopes exercise host suspension without a decoder or DOM shim. */
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { type BrowserVideoCanvasNode, bindBrowserVideoVisibility } from "./web";

it("tracks hidden documents and page-cache suspension and removes every listener", () => {
  const document = Object.assign(new EventTarget(), { hidden: false });
  const view = new EventTarget();
  const changes: boolean[] = [];
  const cleanup = bindBrowserVideoVisibility(
    {
      ownerDocument: Object.assign(document, { defaultView: view }),
    } as unknown as BrowserVideoCanvasNode,
    (value) => changes.push(value),
  );
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  document.hidden = false;
  view.dispatchEvent(new Event("pagehide"));
  document.dispatchEvent(new Event("visibilitychange"));
  view.dispatchEvent(new Event("pageshow"));
  expect(changes).toEqual([true, false, false, false, true]);
  cleanup();
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  view.dispatchEvent(new Event("pageshow"));
  expect(changes).toHaveLength(5);
});
