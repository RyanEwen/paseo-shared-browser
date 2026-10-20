import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserDisplayDemandRpc,
  densityForDisplayDemands,
} from "../shared/browser-display-demand";
import { type BrowserRuntimeClient, SessionManager } from "./browser-policy";
import type { JsonValue } from "./runtime-protocol";

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.disconnect();
  vi.useRealTimers();
});

/** Minimal runtime boundary records real policy commands without starting Chromium. */
async function fixture() {
  vi.useFakeTimers();
  const operations: { operation: string; input: JsonValue }[] = [];
  const runtime: BrowserRuntimeClient = {
    connect: async () => ({ epoch: 1 }),
    ensureWorkspace: async (workspaceId) => ({
      workspaceId,
      runtimeId: "owned-runtime-".padEnd(40, "r"),
      createdAt: 1,
    }),
    requestWorkspace: async (_workspace, operation, input) => {
      operations.push({ operation, input });
      if (operation === "identity") return { userAgent: "Test Chromium" };
      if (operation === "state")
        return {
          url: "https://example.test/",
          title: "Test",
          canGoBack: false,
          canGoForward: false,
          inputGeneration: "0:0",
        };
      if (["emulate", "capture.density", "screencast.stop", "video.stop"].includes(operation))
        return null;
      throw new Error(`Unexpected runtime operation ${operation}`);
    },
    archiveWorkspace: async () => {},
    closeWorkspace: async () => {},
    disconnect: () => {},
  };
  let id = 0;
  const manager = new SessionManager({
    client: runtime,
    controlLeaseMs: 1000,
    now: () => Date.now(),
    validateWorkspace: async () => true,
    issueToken: () => `token_${String(++id).padStart(40, "0")}`,
  });
  managers.push(manager);
  const first = await manager.attach("owned-workspace", "Controller");
  const second = await manager.attach("owned-workspace", "Observer");
  return { manager, operations, first, second };
}

describe("display demand source and control policy", () => {
  it("allows an observer to improve source detail without changing control or page layout", async () => {
    const f = await fixture();
    const control = await f.manager.acquireControl(f.first.viewerToken);
    const report = await f.manager.reportDisplayDemand({
      viewerToken: f.second.viewerToken,
      expected: browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
      display: { width: 2560, height: 1600 },
    });
    expect(report.accepted).toBe(true);
    expect(report.state.controller).toBe("other");
    await vi.advanceTimersByTimeAsync(250);
    const state = (await f.manager.status(f.first.viewerToken)).state;
    expect(state.controller).toBe("self");
    expect(state.viewport).toEqual(control.state.viewport);
    expect(state.captureScale).toBe(2);
    expect(state.viewportGeneration).toBe(control.state.viewportGeneration + 1);
    expect(f.operations.filter(({ operation }) => operation === "capture.density")).toHaveLength(1);
    // Previous observations lose authority after the source transition.
    const stale = await f.manager.reportDisplayDemand({
      viewerToken: f.second.viewerToken,
      expected: browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
      display: { width: 1280, height: 800 },
    });
    expect(stale.accepted).toBe(false);
  });

  it("does not renew a controller lease through observer demand or accept conflicting manual detail", async () => {
    const f = await fixture();
    const control = await f.manager.acquireControl(f.first.viewerToken);
    await f.manager.reportDisplayDemand({
      viewerToken: f.second.viewerToken,
      expected: browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
      display: { width: 2560, height: 1600 },
    });
    await vi.advanceTimersByTimeAsync(250);
    const current = (await f.manager.status(f.second.viewerToken)).state;
    await expect(
      f.manager.setCaptureDensity({
        viewerToken: f.first.viewerToken,
        controlToken: control.controlToken!,
        expected: current,
        density: 1,
      }),
    ).rejects.toThrow("follows the active viewers");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.manager.status(f.second.viewerToken)).state.controller).toBe("none");
  });

  it("rejects cross-runtime/tab/source reports without creating automatic ownership", async () => {
    const f = await fixture();
    for (const changed of [
      { runtimeId: "other" },
      { sessionId: "other-tab" },
      { bridgeEpoch: 99 },
      { navigationGeneration: 99 },
      { viewportGeneration: 99 },
    ]) {
      const reply = await f.manager.reportDisplayDemand({
        viewerToken: f.second.viewerToken,
        expected: {
          ...browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
          ...changed,
        },
        display: { width: 2560, height: 1600 },
      });
      expect(reply.accepted).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.operations.some(({ operation }) => operation === "capture.density")).toBe(false);
    await f.manager.detach(f.second.viewerToken);
    await expect(
      f.manager.reportDisplayDemand({
        viewerToken: f.second.viewerToken,
        expected: browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
        display: null,
      }),
    ).rejects.toThrow("invalid or expired");
  });

  it("re-evaluates automatic detail before accepting a larger CSS viewport", async () => {
    const f = await fixture();
    await f.manager.reportDisplayDemand({
      viewerToken: f.second.viewerToken,
      expected: browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
      display: { width: 2560, height: 1600 },
    });
    await vi.advanceTimersByTimeAsync(250);
    const control = await f.manager.acquireControl(f.first.viewerToken);
    const resized = await f.manager.resize({
      viewerToken: f.first.viewerToken,
      controlToken: control.controlToken!,
      expected: control.state,
      viewport: { width: 2400, height: 1600 },
      preserveEmulation: true,
    });
    expect(resized.state.viewport).toEqual({ width: 2400, height: 1600 });
    expect(resized.state.captureScale).toBe(1);
    expect(resized.state.controller).toBe("self");
  });

  it("cancels queued source changes when the manager is torn down", async () => {
    const f = await fixture();
    await f.manager.reportDisplayDemand({
      viewerToken: f.second.viewerToken,
      expected: browserDisplayDemandRpc.input.shape.expected.parse(f.second.state),
      display: { width: 2560, height: 1600 },
    });
    f.manager.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.operations.some(({ operation }) => operation === "capture.density")).toBe(false);
  });
});

it("bounds reports, requires complete source identity and tolerates one physical pixel", () => {
  const expected = {
    sessionId: "s".repeat(40),
    runtimeId: "r".repeat(40),
    bridgeEpoch: 1,
    navigationGeneration: 0,
    viewportGeneration: 0,
  };
  const input = { viewerToken: "a".repeat(40), expected, display: { width: 1280, height: 800 } };
  expect(browserDisplayDemandRpc.input.safeParse(input).success).toBe(true);
  for (const width of [0, -1, Infinity, NaN, 32769])
    expect(
      browserDisplayDemandRpc.input.safeParse({ ...input, display: { width, height: 800 } })
        .success,
    ).toBe(false);
  expect(
    browserDisplayDemandRpc.input.safeParse({
      ...input,
      expected: { ...expected, runtimeId: undefined },
    }).success,
  ).toBe(false);
  expect(densityForDisplayDemands(input.display, [{ width: 1281, height: 800 }])).toBe(1);
  expect(densityForDisplayDemands(input.display, [{ width: 1282, height: 800 }])).toBe(2);
});
