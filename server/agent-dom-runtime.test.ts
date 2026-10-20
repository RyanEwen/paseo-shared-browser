import { afterEach, expect, it, vi } from "vitest";
import { AgentDomRuntime } from "./agent-dom-runtime";
import type { CdpSession } from "./cdp";

afterEach(() => vi.restoreAllMocks());
function pageFixture() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const page = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: calls.length };
      if (
        typeof params.expression === "string" &&
        params.expression.includes("function(snapshotId)")
      ) {
        return {
          result: {
            value: {
              snapshotId: params.expression.match(/[a-f0-9-]{36}/)![0],
              entries: [],
              truncated: false,
            },
          },
        };
      }
      return { result: { value: true } };
    },
  } as unknown as CdpSession;
  return { page, calls };
}

it("refuses a handle on another runtime/page even with equal native counters", async () => {
  const dom = new AgentDomRuntime();
  const a = pageFixture();
  const b = pageFixture();
  const s = await dom.snapshot(a.page, "1:1", () => {});
  await expect(
    dom.action(
      b.page,
      "1:1",
      { snapshotId: s.snapshotId, action: { kind: "click", ref: "e1" } },
      () => {},
    ),
  ).rejects.toThrow("stale");
  expect(b.calls).toEqual([]);
});

it("refuses expired and replacement attachment/document receipts before CDP publication", async () => {
  const dom = new AgentDomRuntime();
  const { page, calls } = pageFixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const s = await dom.snapshot(page, "1:1", () => {});
  const count = calls.length;
  const input = { snapshotId: s.snapshotId, action: { kind: "click", ref: "e1" } };
  await expect(dom.action(page, "2:1", input, () => {})).rejects.toThrow("stale");
  const fresh = await dom.snapshot(page, "1:1", () => {});
  clock.mockReturnValue(61_001);
  const before = calls.length;
  await expect(
    dom.action(page, "1:1", { ...input, snapshotId: fresh.snapshotId }, () => {}),
  ).rejects.toThrow("stale");
  expect(calls).toHaveLength(before);
  expect(count).toBeGreaterThan(0);
});

it("bounds retained snapshots and rejects evicted references", async () => {
  const dom = new AgentDomRuntime();
  const { page } = pageFixture();
  const first = await dom.snapshot(page, "1:1", () => {});
  for (let i = 0; i < 16; i++) await dom.snapshot(page, "1:1", () => {});
  await expect(
    dom.action(
      page,
      "1:1",
      { snapshotId: first.snapshotId, action: { kind: "click", ref: "e1" } },
      () => {},
    ),
  ).rejects.toThrow("stale");
});

it("checks cancellation after every snapshot setup await and publishes no receipt", async () => {
  const dom = new AgentDomRuntime();
  const { page, calls } = pageFixture();
  let checks = 0;
  await expect(
    dom.snapshot(page, "1:1", () => {
      if (++checks === 3) throw new Error("Cancelled");
    }),
  ).rejects.toThrow("Cancelled");
  expect(calls.map((c) => c.method)).toEqual(["Page.getFrameTree", "Page.createIsolatedWorld"]);
});
