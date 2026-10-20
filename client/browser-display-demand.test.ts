import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserState } from "../shared/browser";
import {
  type BrowserDisplayDemandOptions,
  createBrowserDisplayDemandReporter,
  physicalBrowserDisplaySize,
} from "./browser-display-demand";

const state = {} as BrowserState;
const expected = {
  sessionId: "session",
  runtimeId: "runtime",
  bridgeEpoch: 1,
  navigationGeneration: 1,
  viewportGeneration: 1,
};
function fixture() {
  const reporter = createBrowserDisplayDemandReporter();
  const report = vi.fn(async (_input: Parameters<BrowserDisplayDemandOptions["report"]>[0]) => ({
    state,
    accepted: true,
  }));
  const onState = vi.fn();
  const options: BrowserDisplayDemandOptions = {
    identity: "host/workspace/viewer",
    viewerToken: "viewer",
    expected,
    display: { width: 1200, height: 800 },
    active: true,
    report,
    onState,
  };
  return { reporter, report, onState, options };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("reports only painted physical image dimensions and refuses invalid/unmeasured bounds", () => {
  expect(physicalBrowserDisplaySize({ width: 400, height: 225 }, 3)).toEqual({
    width: 1200,
    height: 675,
  });
  for (const scale of [0, Number.NaN, Infinity])
    expect(physicalBrowserDisplaySize({ width: 400, height: 225 }, scale)).toBeNull();
  expect(physicalBrowserDisplaySize(null, 2)).toBeNull();
  expect(physicalBrowserDisplaySize({ width: 0, height: 225 }, 2)).toBeNull();
  expect(physicalBrowserDisplaySize({ width: 20000, height: 100 }, 2)).toBeNull();
});

it("coalesces geometry and heartbeats measured observer demand without any control token", async () => {
  const f = fixture();
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(100);
  f.reporter.update({ ...f.options, display: { width: 2400, height: 1600 } });
  await vi.advanceTimersByTimeAsync(249);
  expect(f.report).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.report).toHaveBeenCalledExactlyOnceWith({
    viewerToken: "viewer",
    expected,
    display: { width: 2400, height: 1600 },
  });
  expect(f.onState).toHaveBeenCalledExactlyOnceWith(state);
  await vi.advanceTimersByTimeAsync(4750);
  expect(f.report).toHaveBeenCalledTimes(2);
  f.reporter.stop();
});

it("keeps one report in flight and sends the latest stable geometry after it settles", async () => {
  const f = fixture();
  const held = deferred<{ state: BrowserState; accepted: boolean }>();
  f.report.mockImplementationOnce(() => held.promise);
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  f.reporter.update({ ...f.options, display: { width: 2000, height: 1000 } });
  await vi.advanceTimersByTimeAsync(5500);
  expect(f.report).toHaveBeenCalledOnce();
  held.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.report).toHaveBeenCalledTimes(2);
  expect(f.report.mock.calls[1]![0].display).toEqual({ width: 2000, height: 1000 });
  f.reporter.stop();
});

it("clears hidden demand after an in-flight report, drops its late state, and stops heartbeats", async () => {
  const f = fixture();
  const held = deferred<{ state: BrowserState; accepted: boolean }>();
  f.report.mockImplementationOnce(() => held.promise);
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  f.reporter.update({ ...f.options, active: false });
  expect(f.report).toHaveBeenCalledOnce();
  held.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.onState).not.toHaveBeenCalled();
  expect(f.report.mock.calls[1]![0].display).toBeNull();
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.report).toHaveBeenCalledTimes(2);
  f.reporter.stop();
});

it("retires an old attachment through its original host callback before reporting the replacement", async () => {
  const f = fixture();
  const held = deferred<{ state: BrowserState; accepted: boolean }>();
  f.report.mockImplementationOnce(() => held.promise);
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  const replacement = vi.fn(async () => ({ state, accepted: true }));
  f.reporter.update({
    ...f.options,
    identity: "host2/workspace/viewer2",
    viewerToken: "viewer2",
    report: replacement,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(replacement).not.toHaveBeenCalled();
  held.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.report.mock.calls[1]![0]).toEqual({ viewerToken: "viewer", expected, display: null });
  expect(replacement).toHaveBeenCalledOnce();
  expect(f.onState).toHaveBeenCalledOnce();
  f.reporter.stop();
});

it("treats accepted:false as fresh state and waits for a committed source change instead of looping", async () => {
  const f = fixture();
  f.report.mockResolvedValueOnce({ state, accepted: false });
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.onState).toHaveBeenCalledExactlyOnceWith(state);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.report).toHaveBeenCalledOnce();
  const next = { ...expected, viewportGeneration: 2 };
  f.reporter.update({ ...f.options, expected: next });
  await vi.advanceTimersByTimeAsync(250);
  expect(f.report.mock.calls[1]![0].expected).toEqual(next);
  f.reporter.stop();
});

it("serializes unmount cleanup and React effect restart without reviving the retired report", async () => {
  const f = fixture();
  const held = deferred<{ state: BrowserState; accepted: boolean }>();
  f.report.mockImplementationOnce(() => held.promise);
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  f.reporter.stop();
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  held.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.report.mock.calls.map(([input]) => input.display)).toEqual([
    f.options.display,
    null,
    f.options.display,
  ]);
  expect(f.onState).toHaveBeenCalledOnce();
  f.reporter.stop();
});

it("drops an old runtime's late result even when the viewer token and attachment stay the same", async () => {
  const f = fixture();
  const held = deferred<{ state: BrowserState; accepted: boolean }>();
  f.report.mockImplementationOnce(() => held.promise);
  f.reporter.update(f.options);
  await vi.advanceTimersByTimeAsync(250);
  f.reporter.update({ ...f.options, expected: { ...expected, runtimeId: "replacement" } });
  held.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.onState).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.report.mock.calls[1]![0].expected.runtimeId).toBe("replacement");
  f.reporter.stop();
});
