import { afterEach, expect, it } from "vitest";
import type { BrowserState } from "../shared/browser";
import { type JsonValue, RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol";
import { type RuntimeOwner, RuntimeSupervisor } from "./supervisor";

interface Runtime {
  runtimeId: string;
  workspaceId: string;
  pages: Map<string, { title: string; url: string }>;
}

/** A real supervisor/policy boundary with controllable native target discovery. */
class Owner implements RuntimeOwner<Runtime> {
  runtimes: Runtime[] = [];
  stopped: Runtime[] = [];
  nativeCloses: string[] = [];
  beforeList: (() => Promise<void>) | null = null;

  async create(workspaceId: string) {
    const runtime = {
      runtimeId: `runtime_${String(this.runtimes.length).padStart(32, "0")}`,
      workspaceId,
      pages: new Map([["root", { title: "Draft", url: "https://example.com/" }]]),
    };
    this.runtimes.push(runtime);
    return runtime;
  }

  async request(runtime: Runtime, operation: string, input: JsonValue): Promise<JsonValue> {
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (operation === "tabs.list") {
      await this.beforeList?.();
      return [...runtime.pages].map(([targetId, page]) => ({ targetId, ...page }));
    }
    if (operation === "tabs.create") {
      const targetId = `page-${runtime.pages.size}`;
      runtime.pages.set(targetId, { title: "New tab", url: "about:blank" });
      return { targetId };
    }
    if (operation === "tabs.close") {
      if (runtime.pages.size === 1) throw new Error("The last browser tab requires confirmation");
      const targetId = String(data.targetId);
      if (!runtime.pages.has(targetId)) throw new Error("Browser tab is no longer available");
      this.nativeCloses.push(targetId);
      runtime.pages.delete(targetId);
      return null;
    }
    const targetId = typeof data.targetId === "string" ? data.targetId : "root";
    const page = runtime.pages.get(targetId);
    if (!page) throw new Error("Browser tab is no longer available");
    if (operation === "identity") return { targetId, userAgent: "Fake Chromium" };
    if (operation === "state")
      return { ...page, canGoBack: false, canGoForward: false, inputGeneration: "0:0" };
    if (["emulate", "screencast.stop", "video.stop", "input.end"].includes(operation)) return null;
    throw new Error(`Unexpected native operation: ${operation}`);
  }

  async stop(runtime: Runtime) {
    this.stopped.push(runtime);
  }
}

const supervisors: RuntimeSupervisor<Runtime>[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
});

/** Use the same authenticated browser and agent dispatch routes as the shipped bridge. */
function fixture() {
  const owner = new Owner();
  const clock = { now: Date.now() };
  const supervisor = new RuntimeSupervisor({
    owner,
    now: () => clock.now,
    bridgeTimeoutMs: 120_000,
  });
  supervisors.push(supervisor);
  const bridge = supervisor.claimBridge("close-fixture");
  let id = 0;
  const dispatch = <T>(method: string, input: object) =>
    supervisor.dispatch({
      version: RUNTIME_PROTOCOL_VERSION,
      id: String(++id),
      method,
      ...input,
    } as never) as Promise<T>;
  const admin = <T>(method: string, input: object) =>
    dispatch<T>(method, { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ...input });
  const human = <T>(operation: string, input: object) =>
    admin<T>("browser.request", { operation, input });
  const attach = (workspaceId = "workspace-one", label = "Viewer", tabId?: string) =>
    human<{ viewerToken: string; state: BrowserState }>("attach", {
      workspaceId,
      viewerLabel: label,
      ...(tabId ? { tabId } : {}),
    });
  const control = (viewerToken: string) =>
    human<{ controlToken: string; state: BrowserState }>("acquire-control", { viewerToken });
  const ticket = `close-ticket-${"t".repeat(40)}`;
  const agent = <T = JsonValue>(operation: string, input = {}) =>
    dispatch<T>("agent.request", { ticket, operation, input });
  const bindAgent = async () => {
    await admin("ticket.issue", { ticket });
    await admin("ticket.bind", { ticket, agentId: "agent-one", workspaceId: "workspace-one" });
    await agent("status");
  };
  return { owner, clock, supervisor, human, admin, attach, control, agent, bindAgent };
}

/** Pin the exact observed selection, runtime and user-approved close effect. */
function closeInput(
  viewer: { viewerToken: string; state: BrowserState },
  controlToken: string,
  scope: "tab" | "last-tab" = "last-tab",
) {
  return {
    viewerToken: viewer.viewerToken,
    controlToken,
    tabId: viewer.state.tabId!,
    sessionId: viewer.state.sessionId,
    runtimeId: viewer.state.runtimeId!,
    scope,
  };
}

it("closes exactly the final workspace browser for every viewer and requires explicit reopen", async () => {
  const f = fixture();
  const first = await f.attach();
  const second = await f.attach("workspace-one", "Observer");
  const other = await f.attach("workspace-two");
  const { controlToken } = await f.control(first.viewerToken);
  await expect(f.human("tabs.close", closeInput(first, controlToken))).resolves.toEqual({
    closed: true,
    browserClosed: true,
  });
  expect(f.owner.stopped.map((runtime) => runtime.workspaceId)).toEqual(["workspace-one"]);
  for (const viewer of [first, second])
    await expect(f.human("status", { viewerToken: viewer.viewerToken })).rejects.toThrow(
      "Browser is closed",
    );
  await expect(f.attach()).rejects.toThrow("Browser is closed");
  expect(
    (await f.human<{ state: BrowserState }>("status", { viewerToken: other.viewerToken })).state
      .runtimeId,
  ).toBe(other.state.runtimeId);
  await f.human("reopen", { workspaceId: "workspace-one" });
  expect((await f.attach()).state.runtimeId).not.toBe(first.state.runtimeId);
  expect(f.owner.nativeCloses).toEqual([]);
});

it("does not upgrade tab-only confirmation when its other page disappears", async () => {
  const f = fixture();
  const viewer = await f.attach();
  const { controlToken } = await f.control(viewer.viewerToken);
  await expect(f.human("tabs.close", closeInput(viewer, controlToken, "tab"))).rejects.toThrow(
    "last browser tab",
  );
  expect(f.owner.stopped).toEqual([]);
  expect(
    (await f.human<{ state: BrowserState }>("status", { viewerToken: viewer.viewerToken })).state
      .controller,
  ).toBe("self");
});

it.each(["about:blank", "chrome://print/"])(
  "refuses final-close confirmation after another target appears (%s)",
  async (url) => {
    const f = fixture();
    const viewer = await f.attach();
    const { controlToken } = await f.control(viewer.viewerToken);
    f.owner.runtimes[0]!.pages.set("new-page", { title: "New", url });
    await expect(f.human("tabs.close", closeInput(viewer, controlToken))).rejects.toThrow(
      "Browser tabs changed",
    );
    expect(f.owner.stopped).toEqual([]);
    expect(
      (await f.human<{ state: BrowserState }>("status", { viewerToken: viewer.viewerToken })).state
        .controller,
    ).toBe("self");
    expect(f.owner.runtimes[0]!.pages.size).toBe(2);
  },
);

it("removes only the controlled tab when multiple targets remain", async () => {
  const f = fixture();
  const viewer = await f.attach();
  const { controlToken } = await f.control(viewer.viewerToken);
  f.owner.runtimes[0]!.pages.set("survivor", { title: "Keep", url: "https://keep.example/" });
  const other = await f.attach("workspace-one", "Other", "survivor");
  await expect(f.human("tabs.close", closeInput(viewer, controlToken, "tab"))).resolves.toEqual({
    closed: true,
    browserClosed: false,
  });
  expect(f.owner.stopped).toEqual([]);
  expect(
    (await f.human<{ state: BrowserState }>("status", { viewerToken: other.viewerToken })).state
      .tabId,
  ).toBe("survivor");
});

it.each(["tabId", "sessionId", "runtimeId", "controlToken"])(
  "refuses stale or unauthorized %s before stop",
  async (field) => {
    const f = fixture();
    const viewer = await f.attach();
    const { controlToken } = await f.control(viewer.viewerToken);
    await expect(
      f.human("tabs.close", {
        ...closeInput(viewer, controlToken),
        [field]: `stale_${"s".repeat(32)}`,
      }),
    ).rejects.toThrow();
    expect(f.owner.stopped).toEqual([]);
    expect(
      (await f.human<{ state: BrowserState }>("status", { viewerToken: viewer.viewerToken })).state
        .controller,
    ).toBe("self");
  },
);

it("rechecks control expiry after an awaited native target read", async () => {
  const f = fixture();
  const viewer = await f.attach();
  const { controlToken } = await f.control(viewer.viewerToken);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.owner.beforeList = async () => {
    entered.resolve();
    await release.promise;
  };
  const closing = f.human("tabs.close", closeInput(viewer, controlToken));
  await entered.promise;
  f.clock.now += 31_000;
  release.resolve();
  await expect(closing).rejects.toThrow("control lease");
  expect(f.owner.stopped).toEqual([]);
  expect(
    (await f.human<{ state: BrowserState }>("status", { viewerToken: viewer.viewerToken })).state
      .controller,
  ).toBe("none");
});

it("keeps creation and final-stop in one workspace queue so a queued new page cannot be swallowed", async () => {
  const f = fixture();
  const viewer = await f.attach();
  const { controlToken } = await f.control(viewer.viewerToken);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.owner.beforeList = async () => {
    entered.resolve();
    await release.promise;
  };
  const closing = f.human("tabs.close", closeInput(viewer, controlToken));
  await entered.promise;
  const creating = f
    .human("tabs.create", { viewerToken: viewer.viewerToken })
    .catch((error) => error);
  release.resolve();
  await expect(closing).resolves.toMatchObject({ browserClosed: true });
  expect(String(await creating)).toMatch(/not found|closed|changed/);
  expect(f.owner.runtimes[0]!.pages.size).toBe(1);
  expect(f.owner.stopped).toHaveLength(1);
});

it("requires explicit agent final scope and leaves the browser closed until human reopen", async () => {
  const f = fixture();
  await f.bindAgent();
  await f.agent("acquire-control");
  await expect(f.agent("tabs.close")).rejects.toThrow("last browser tab");
  await expect(f.agent("tabs.close", { scope: "last-tab" })).resolves.toMatchObject({
    closed: true,
    browserClosed: true,
  });
  await expect(f.agent("status")).rejects.toThrow("Browser is closed");
  expect(f.owner.stopped).toHaveLength(1);
});

it("fences a revoked agent during final-target discovery before invalidating human viewers", async () => {
  const f = fixture();
  const viewer = await f.attach();
  await f.bindAgent();
  await f.agent("acquire-control");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.owner.beforeList = async () => {
    entered.resolve();
    await release.promise;
  };
  const closing = f.agent("tabs.close", { scope: "last-tab" });
  await entered.promise;
  const revoked = f.admin("agent.revoke", { agentId: "agent-one" });
  release.resolve();
  await expect(closing).rejects.toThrow(/revoked|invalid|changed/);
  await revoked;
  expect(f.owner.stopped).toEqual([]);
  expect(
    (await f.human<{ state: BrowserState }>("status", { viewerToken: viewer.viewerToken })).state
      .tabId,
  ).toBe("root");
});

it("does not let a late stale-tab attachment create a replacement browser behind final close", async () => {
  const f = fixture();
  const viewer = await f.attach();
  const { controlToken } = await f.control(viewer.viewerToken);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.owner.beforeList = async () => {
    entered.resolve();
    await release.promise;
  };
  const closing = f.human("tabs.close", closeInput(viewer, controlToken));
  await entered.promise;
  const attachment = f
    .attach("workspace-one", "Stale viewer", "already-closed-tab")
    .catch((error) => error);
  release.resolve();
  await closing;
  expect(String(await attachment)).toMatch(/closed|available/);
  expect(f.owner.runtimes).toHaveLength(1);
  expect(f.owner.stopped).toHaveLength(1);
});
