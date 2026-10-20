import { expect, it, vi } from "vitest";
import { type CdpSession, CdpUnknownOutcomeError } from "./cdp";
import { openPrintPreview } from "./print-preview";

/** A pinned source with a separate built-in print world, without a live display. */
function fixture() {
  const send = vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "source-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 73 };
    return {};
  });
  return { send, page: { send } as unknown as CdpSession };
}

it("opens built-in print only in the exact source's isolated world after activation", async () => {
  const f = fixture();
  await openPrintPreview(f.page, () => {});
  expect(f.send.mock.calls.map(([method]) => method)).toEqual([
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Page.bringToFront",
    "Runtime.evaluate",
  ]);
  expect(f.send).toHaveBeenNthCalledWith(2, "Page.createIsolatedWorld", {
    frameId: "source-frame",
    worldName: "shared-browser-print",
  });
  expect(f.send).toHaveBeenLastCalledWith(
    "Runtime.evaluate",
    { expression: "window.print()", contextId: 73, userGesture: true, returnByValue: true },
    { mutation: true, timeoutMs: 1500 },
  );
});

it("preserves unknown modal outcomes and never replays print", async () => {
  const f = fixture();
  const unknown = new CdpUnknownOutcomeError("Print acknowledgement unavailable");
  f.send.mockImplementation(async (method) => {
    if (method === "Runtime.evaluate") throw unknown;
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "source-frame" } } };
    return { executionContextId: 73 };
  });
  await expect(openPrintPreview(f.page, () => {})).rejects.toBe(unknown);
  expect(f.send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(1);
});

it("rechecks source and private-display authority after awaits before invoking print", async () => {
  const f = fixture();
  const check = vi.fn(() => {
    if (check.mock.calls.length === 4) throw new Error("Source changed during activation");
  });
  await expect(openPrintPreview(f.page, check)).rejects.toThrow("Source changed");
  expect(f.send.mock.calls.map(([method]) => method)).toEqual([
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Page.bringToFront",
  ]);
});
