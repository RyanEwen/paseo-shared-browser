import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserState } from "../shared/browser";
import type { BrowserDisplayDemandOptions } from "./browser-display-demand";

const runtime = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  index: 0,
  layouts: [] as Array<() => void | (() => void)>,
  effects: [] as Array<() => void | (() => void)>,
  cleanup: [] as Array<() => void>,
  appState: null as null | ((state: string) => void),
}));
vi.mock("react", () => ({
  useRef(initial: unknown) {
    const index = runtime.index++;
    runtime.refs[index] ??= { current: initial };
    return runtime.refs[index];
  },
  useLayoutEffect(fn: () => void | (() => void)) {
    runtime.layouts.push(fn);
  },
  useEffect(fn: () => void | (() => void)) {
    runtime.effects.push(fn);
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    currentState: "active",
    addEventListener: (_name: string, fn: (state: string) => void) => {
      runtime.appState = fn;
      return {
        remove() {
          runtime.appState = null;
        },
      };
    },
  },
}));

import { useBrowserDisplayDemand } from "./use-browser-display-demand";

const state = {} as BrowserState;
function fixture() {
  const onState = vi.fn();
  let resolve!: (result: { state: BrowserState; accepted: boolean }) => void;
  const held = new Promise<{ state: BrowserState; accepted: boolean }>((done) => {
    resolve = done;
  });
  const report = vi.fn(async (_input: Parameters<BrowserDisplayDemandOptions["report"]>[0]) => ({
    state,
    accepted: true,
  }));
  report.mockImplementationOnce(() => held);
  const options: BrowserDisplayDemandOptions = {
    identity: "host/workspace/viewer",
    viewerToken: "viewer",
    expected: {
      sessionId: "session",
      runtimeId: "runtime",
      bridgeEpoch: 1,
      navigationGeneration: 1,
      viewportGeneration: 1,
    },
    display: { width: 1600, height: 1200 },
    active: true,
    report,
    onState,
  };
  const render = (next = options) => {
    runtime.index = 0;
    runtime.layouts = [];
    runtime.effects = [];
    useBrowserDisplayDemand(next);
  };
  render();
  for (const effect of [...runtime.layouts, ...runtime.effects]) {
    const cleanup = effect();
    if (cleanup) runtime.cleanup.push(cleanup);
  }
  return { options, report, onState, resolve, render };
}
beforeEach(() => {
  runtime.refs = [];
  runtime.index = 0;
  runtime.layouts = [];
  runtime.effects = [];
  runtime.cleanup = [];
  runtime.appState = null;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of runtime.cleanup) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("drops an old attachment reply even before the replacement's layout effects commit", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  f.render({ ...f.options, identity: "host/workspace/replacement", viewerToken: "replacement" });
  // Render updated the synchronous attachment ref, but no effect has retired the old reporter yet.
  f.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.onState).not.toHaveBeenCalled();
});

it("retracts demand on native background and does not accept a late in-flight state", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  runtime.appState!("background");
  f.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.onState).not.toHaveBeenCalled();
  expect(f.report.mock.calls[1]![0].display).toBeNull();
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.report).toHaveBeenCalledTimes(2);
});

it("drops a replaced source's late state during the render-to-layout gap under the same attachment", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  f.render({ ...f.options, expected: { ...f.options.expected!, runtimeId: "replacement" } });
  f.resolve({ state, accepted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.onState).not.toHaveBeenCalled();
});
