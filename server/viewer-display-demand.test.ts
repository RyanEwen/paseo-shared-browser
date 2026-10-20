import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewerDisplayDemand } from "./viewer-display-demand";

const owners: ReturnType<typeof createViewerDisplayDemand>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});

/** Simulate only source transitions; timing and ownership remain the real coordinator. */
function fixture() {
  vi.useFakeTimers();
  let density = 1;
  let gesture = false;
  const viewers = new Set(["a", "b"]);
  const apply = vi.fn(async (next: 1 | 2) => {
    if (gesture) return false;
    density = next;
    return true;
  });
  const failed = vi.fn();
  const owner = createViewerDisplayDemand({
    now: () => Date.now(),
    viewport: () => ({ width: 1280, height: 800 }),
    density: () => density,
    current: () => true,
    viewerCurrent: (token) => viewers.has(token),
    apply,
    failed,
  });
  owners.push(owner);
  return {
    owner,
    apply,
    failed,
    viewers,
    density: () => density,
    gesture: (active: boolean) => {
      gesture = active;
    },
  };
}

describe("visible viewer display demand", () => {
  it("aggregates observers, coalesces updates and expires independently of other reads", async () => {
    const f = fixture();
    f.owner.report("a", { width: 1280, height: 800 });
    f.owner.report("b", { width: 2560, height: 1600 });
    await vi.advanceTimersByTimeAsync(250);
    expect(f.density()).toBe(2);
    expect(f.apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    f.owner.report("a", { width: 1280, height: 800 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.density()).toBe(1);
    expect(f.owner.target()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.owner.target()).toBeNull();
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it("drops hidden or detached demand and releases automatic ownership after settling", async () => {
    const f = fixture();
    f.owner.report("a", { width: 2560, height: 1600 });
    await vi.advanceTimersByTimeAsync(250);
    f.owner.report("a", null);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.density()).toBe(1);
    expect(f.owner.target()).toBeNull();
    f.owner.report("b", { width: 2560, height: 1600 });
    await vi.advanceTimersByTimeAsync(250);
    f.viewers.delete("b");
    f.owner.refresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.density()).toBe(1);
    expect(f.owner.target()).toBeNull();
  });

  it("uses proposed CSS viewport bounds and defers detail changes during gestures", async () => {
    const f = fixture();
    f.gesture(true);
    f.owner.report("a", { width: 3000, height: 2000 });
    expect(f.owner.targetFor({ width: 2400, height: 1600 })).toBe(1);
    await vi.advanceTimersByTimeAsync(750);
    expect(f.density()).toBe(1);
    f.gesture(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.density()).toBe(2);
    f.owner.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.density()).toBe(2);
  });

  it("does not let frequent heartbeats postpone the first transition", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) {
      f.owner.report("a", { width: 2560, height: 1600 });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(f.density()).toBe(2);
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it("pauses a failed target and retries only after a different demand", async () => {
    const f = fixture();
    f.apply.mockRejectedValueOnce(new Error("runtime unavailable"));
    f.owner.report("a", { width: 2560, height: 1600 });
    await vi.advanceTimersByTimeAsync(250);
    f.owner.report("a", { width: 2560, height: 1600 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledOnce();
    f.owner.report("a", { width: 1280, height: 800 });
    await vi.advanceTimersByTimeAsync(250);
    f.owner.report("a", { width: 2560, height: 1600 });
    await vi.advanceTimersByTimeAsync(250);
    expect(f.density()).toBe(2);
  });

  it("never imposes automatic policy on an unreported agent-only session", async () => {
    const f = fixture();
    f.owner.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.owner.target()).toBeNull();
    expect(f.apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
