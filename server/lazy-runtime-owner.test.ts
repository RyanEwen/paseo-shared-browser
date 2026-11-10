import { afterEach, expect, it } from "vitest";
import type { BrowserState } from "../shared/browser";
import { isBrowserStateCurrent } from "../shared/browser";
import { createLazyRuntimeOwner } from "./lazy-runtime-owner";
import {
  type AgentBrowserOperation,
  type JsonValue,
  RUNTIME_PROTOCOL_VERSION,
} from "./runtime-protocol";
import { type RuntimeInstance, type RuntimeOwner, RuntimeSupervisor } from "./supervisor";

/** The production policy/supervisor chain with a counted, suspendable native launch boundary. */
function fixture() {
  let now = 0;
  let failure: Error | null = null;
  let navigationFailure: Error | null = null;
  let unconfirmedCleanup = false;
  let gate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  let preparation: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const preparing = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const pages = new Map<string, string>();
  const launches: string[] = [];
  const nativeOperations: string[] = [];
  const processOwner: RuntimeOwner<RuntimeInstance> = {
    async create() {
      return { runtimeId: "native-generation" };
    },
    async request(_runtime, operation, input, beforeMutation) {
      nativeOperations.push(operation);
      const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      if (operation === "tabs.list")
        return [...pages].map(([targetId, url]) => ({ targetId, url, title: targetId }));
      if (operation === "tabs.open" || operation === "tabs.create") {
        beforeMutation?.();
        const targetId = `page-${pages.size + 1}`;
        pages.set(targetId, operation === "tabs.open" ? String(data.url) : "about:blank");
        return { targetId };
      }
      const targetId = typeof data.targetId === "string" ? data.targetId : "page-1";
      if (!pages.has(targetId)) throw new Error("Browser tab is no longer available");
      if (operation === "identity") return { targetId, userAgent: "Fixture Chromium" };
      if (operation === "state")
        return {
          url: pages.get(targetId)!,
          title: targetId,
          inputGeneration: "0:0",
          canGoBack: false,
          canGoForward: false,
        };
      if (operation === "navigate") {
        beforeMutation?.();
        if (navigationFailure) throw navigationFailure;
        pages.set(targetId, String(data.url));
      }
      return null;
    },
    async stop() {
      pages.clear();
    },
  };
  // The native launch always opens a blank page; a requested URL is navigated afterwards.
  const owner = createLazyRuntimeOwner(async (_workspaceId, beforeLaunch) => {
    if (preparation) {
      preparing.resolve();
      await preparation.promise;
    }
    beforeLaunch();
    launches.push("about:blank");
    pages.set("page-1", "about:blank");
    entered.resolve();
    if (gate) await gate.promise;
    if (failure) throw failure;
    return { owner: processOwner, runtime: await processOwner.create("workspace") };
  });
  const supervisor = new RuntimeSupervisor({ owner, now: () => now, bridgeTimeoutMs: 1_000_000 });
  cleanups.push(async () => {
    try {
      await supervisor.stopAll();
    } catch (error) {
      if (!unconfirmedCleanup) throw error;
    }
  });
  let bridge = supervisor.claimBridge("lazy-bridge");
  let requestId = 0;
  const common = () => ({ id: `request-${++requestId}`, version: RUNTIME_PROTOCOL_VERSION });
  const browser = async <Result>(operation: string, input: JsonValue = {}) =>
    (await supervisor.dispatch({
      ...common(),
      method: "browser.request",
      token: "direct-test",
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      operation,
      input,
    })) as unknown as Result;
  const agent = async <Result>(
    ticket: string,
    operation: AgentBrowserOperation,
    input: JsonValue = {},
  ) =>
    (await supervisor.dispatch({
      ...common(),
      method: "agent.request",
      ticket,
      operation,
      input,
    })) as unknown as Result;
  const bind = async (label: string) => {
    const ticket = label + "x".repeat(40);
    await supervisor.dispatch({
      ...common(),
      method: "ticket.issue",
      token: "direct-test",
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      ticket,
    });
    await supervisor.dispatch({
      ...common(),
      method: "ticket.bind",
      token: "direct-test",
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      ticket,
      agentId: label,
      workspaceId: "workspace",
    });
    return ticket;
  };
  return {
    browser,
    agent,
    bind,
    launches,
    pages,
    nativeOperations,
    entered,
    preparing,
    holdPreparation() {
      preparation = Promise.withResolvers<void>();
      return preparation;
    },
    hold() {
      gate = Promise.withResolvers<void>();
      return gate;
    },
    expire() {
      now = 60_000;
    },
    failNavigation(error: Error) {
      navigationFailure = error;
    },
    fail(error = new Error("Native startup failed")) {
      failure = error;
    },
    expectUnconfirmedCleanup() {
      unconfirmedCleanup = true;
    },
    reconnectBridge() {
      supervisor.bridgeDisconnected(bridge.bridgeId, bridge.epoch);
      bridge = supervisor.claimBridge("replacement-bridge");
    },
    revoke(agentId: string) {
      return supervisor.dispatch({
        ...common(),
        method: "agent.revoke",
        token: "direct-test",
        bridgeId: bridge.bridgeId,
        epoch: bridge.epoch,
        agentId,
      });
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
type Attachment = { viewerToken: string; state: BrowserState };
type Control = { controlToken: string; state: BrowserState };

/** The transport's authority receipt contains generations, not optional display metadata. */
function expected(state: BrowserState) {
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
    ...(state.runtimeId ? { runtimeId: state.runtimeId } : {}),
    ...(state.bridgeEpoch === undefined ? {} : { bridgeEpoch: state.bridgeEpoch }),
  };
}

it("keeps human and agent observation truly empty, including screenshot and DOM requests", async () => {
  const f = fixture();
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Human",
  });
  expect(viewer.state.status).toBe("empty");
  expect(viewer.state.tabId).toBeUndefined();
  expect(await f.browser("tabs.list", { viewerToken: viewer.viewerToken })).toEqual({ tabs: [] });
  expect(
    await f.browser("capture", {
      viewerToken: viewer.viewerToken,
      quality: "medium",
      knownFrameId: null,
    }),
  ).toMatchObject({ state: { status: "empty" }, frame: null });
  const ticket = await f.bind("agent");
  expect(await f.agent(ticket, "tabs.list")).toMatchObject({ tabs: [] });
  expect(await f.agent(ticket, "status")).toMatchObject({ state: { status: "empty" } });
  expect(await f.agent(ticket, "acquire-control")).toMatchObject({ state: { status: "empty" } });
  await expect(f.agent(ticket, "dom.snapshot")).rejects.toThrow("No page is open");
  expect(f.launches).toEqual([]);
  expect(f.nativeOperations).toEqual([]);
});

it("opens one first destination, rejects a duplicate stale navigation and leaves other viewers empty", async () => {
  const f = fixture();
  const first = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "First",
  });
  const second = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Second",
  });
  const control = await f.browser<Control>("acquire-control", { viewerToken: first.viewerToken });
  const input = {
    viewerToken: first.viewerToken,
    controlToken: control.controlToken,
    expected: expected(control.state),
    action: { kind: "goto", url: "https://requested.example/" },
  };
  const opened = await Promise.allSettled([
    f.browser<{ state: BrowserState }>("navigate", input),
    f.browser("navigate", input),
  ]);
  expect(opened.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(f.launches).toEqual(["about:blank"]);
  expect([...f.pages.values()]).toEqual(["https://requested.example/"]);
  expect(await f.browser("status", { viewerToken: second.viewerToken })).toMatchObject({
    state: { status: "empty" },
  });
  expect(await f.browser("tabs.list", { viewerToken: second.viewerToken })).toMatchObject({
    tabs: [{ id: "page-1" }],
  });
  const emptyControl = await f.browser<Control>("acquire-control", {
    viewerToken: second.viewerToken,
  });
  await expect(
    f.browser("close", {
      viewerToken: second.viewerToken,
      controlToken: emptyControl.controlToken,
      sessionId: second.state.sessionId,
      runtimeId: second.state.runtimeId!,
    }),
  ).rejects.toThrow("Select a browser tab");
  expect([...f.pages.values()]).toEqual(["https://requested.example/"]);
  const selected = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Second",
    tabId: "page-1",
  });
  expect(selected.state.url).toBe("https://requested.example/");
  if (opened[0]!.status === "fulfilled")
    expect(isBrowserStateCurrent(opened[0]!.value.state, first.state)).toBe(false);
});

it("serializes concurrent explicit first tabs with one launch and one page per request", async () => {
  const f = fixture();
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Viewer",
  });
  const created = await Promise.all([
    f.browser("tabs.create", { viewerToken: viewer.viewerToken }),
    f.browser("tabs.create", { viewerToken: viewer.viewerToken }),
  ]);
  expect(created).toEqual([{ tabId: "page-1" }, { tabId: "page-2" }]);
  expect(f.launches).toEqual(["about:blank"]);
  expect([...f.pages.values()]).toEqual(["about:blank", "about:blank"]);
});

it("refuses expired human publication after startup without replay or adoption", async () => {
  const f = fixture();
  const gate = f.hold();
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Viewer",
  });
  const control = await f.browser<Control>("acquire-control", { viewerToken: viewer.viewerToken });
  const opening = f.browser("navigate", {
    viewerToken: viewer.viewerToken,
    controlToken: control.controlToken,
    expected: expected(control.state),
    action: { kind: "goto", url: "https://requested.example/" },
  });
  const refused = expect(opening).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
  await f.entered.promise;
  f.expire();
  gate.resolve();
  await refused;
  expect(f.launches).toHaveLength(1);
  // The launch page exists but authority expired before navigation: it stays blank, never replayed.
  expect([...f.pages.values()]).toEqual(["about:blank"]);
  expect(
    (await f.browser<Attachment>("attach", { workspaceId: "workspace", viewerLabel: "Recovered" }))
      .state.url,
  ).toBe("about:blank");
});

it("refuses expired preparation before native launch and reuses the still-empty reservation safely", async () => {
  const f = fixture();
  const gate = f.holdPreparation();
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Viewer",
  });
  const opening = f.browser("tabs.create", { viewerToken: viewer.viewerToken });
  const refused = expect(opening).rejects.toThrow("invalid or expired");
  await f.preparing.promise;
  f.expire();
  gate.resolve();
  await refused;
  expect(f.launches).toEqual([]);
  expect(f.pages.size).toBe(0);
  const reattached = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Fresh viewer",
  });
  expect(reattached.state.status).toBe("empty");
  expect(reattached.state.runtimeId).toBe(viewer.state.runtimeId);
  await f.browser("tabs.create", { viewerToken: reattached.viewerToken });
  expect(f.launches).toEqual(["about:blank"]);
});

it.each(["revocation", "selection"])(
  "fences agent %s during first launch without replay",
  async (change) => {
    const f = fixture();
    const gate = f.hold();
    const ticket = await f.bind("agent");
    await f.agent(ticket, "acquire-control");
    const opening = f.agent(ticket, "navigate", {
      action: { kind: "goto", url: "https://requested.example/" },
    });
    const refused = expect(opening).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    await f.entered.promise;
    const changing =
      change === "revocation"
        ? f.revoke("agent")
        : f.agent(ticket, "tabs.select", { tabId: "page-1" });
    gate.resolve();
    await refused;
    await changing;
    expect(f.launches).toHaveLength(1);
    expect([...f.pages.values()]).toEqual(["about:blank"]);
  },
);

it("reports failed startup as lost until explicit reattachment creates a fresh empty generation", async () => {
  const f = fixture();
  f.fail();
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Viewer",
  });
  await expect(f.browser("tabs.create", { viewerToken: viewer.viewerToken })).rejects.toMatchObject(
    { code: "RUNTIME_LOST" },
  );
  expect(await f.browser("status", { viewerToken: viewer.viewerToken })).toMatchObject({
    state: { status: "error" },
  });
  await expect(f.browser("tabs.create", { viewerToken: viewer.viewerToken })).rejects.toMatchObject(
    { code: "RUNTIME_LOST" },
  );
  expect(f.launches).toHaveLength(1);
  const replacement = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Explicit reconnect",
  });
  expect(replacement.state.status).toBe("empty");
  expect(replacement.state.runtimeId).not.toBe(viewer.state.runtimeId);
});

it("refuses replacement when failed startup could not confirm cleanup", async () => {
  const f = fixture();
  f.expectUnconfirmedCleanup();
  f.fail(
    new AggregateError([new Error("Owned daemon still running")], "Startup cleanup not confirmed"),
  );
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Viewer",
  });
  await expect(f.browser("tabs.create", { viewerToken: viewer.viewerToken })).rejects.toMatchObject(
    { code: "RUNTIME_LOST" },
  );
  await expect(
    f.browser("attach", { workspaceId: "workspace", viewerLabel: "Explicit reconnect" }),
  ).rejects.toThrow("cleanup");
  expect(f.launches).toHaveLength(1);
});

it("reconnects the bridge to existing content and selections instead of presenting empty state", async () => {
  const f = fixture();
  const ticket = await f.bind("agent");
  const created = await f.agent<{ state: BrowserState }>(ticket, "tabs.create");
  f.reconnectBridge();
  const observed = await f.agent<{ state: BrowserState }>(ticket, "status");
  expect(observed.state.runtimeId).toBe(created.state.runtimeId);
  expect(observed.state.tabId).toBe(created.state.tabId);
  expect(observed.state.status).toBe("ready");
  expect(f.launches).toHaveLength(1);
});

it("keeps an unreachable first destination as an ordinary page with a navigation error", async () => {
  const f = fixture();
  f.failNavigation(new Error("Navigation failed: net::ERR_CONNECTION_REFUSED"));
  const viewer = await f.browser<Attachment>("attach", {
    workspaceId: "workspace",
    viewerLabel: "Viewer",
  });
  const control = await f.browser<Control>("acquire-control", { viewerToken: viewer.viewerToken });
  await expect(
    f.browser("navigate", {
      viewerToken: viewer.viewerToken,
      controlToken: control.controlToken,
      expected: expected(control.state),
      action: { kind: "goto", url: "https://unreachable.example/" },
    }),
  ).rejects.toThrow("ERR_CONNECTION_REFUSED");

  // The workspace is not lost: the viewer moved to the launch page and can keep working.
  const status = await f.browser<{ state: BrowserState }>("status", {
    viewerToken: viewer.viewerToken,
  });
  expect(status.state.status).not.toBe("error");
  expect(status.state.tabId).toBe("page-1");
  expect(f.launches).toHaveLength(1);
});

it("moves an agent to its first page even when that page's navigation fails", async () => {
  const f = fixture();
  f.failNavigation(new Error("Navigation failed: net::ERR_NAME_NOT_RESOLVED"));
  const ticket = await f.bind("agent");
  await f.agent(ticket, "acquire-control");
  await expect(
    f.agent(ticket, "navigate", { action: { kind: "goto", url: "https://typo.example/" } }),
  ).rejects.toMatchObject({ code: "RUNTIME_FAILURE", message: expect.stringContaining("new tab") });

  // The agent's next request targets the opened page, not the empty session it started from.
  const status = await f.agent<{ state: BrowserState }>(ticket, "status");
  expect(status.state.tabId).toBe("page-1");
  expect(status.state.status).not.toBe("empty");
  expect(f.launches).toHaveLength(1);
});

it("never runs more browsers than its limit, even when workspaces open concurrently", async () => {
  const release = Promise.withResolvers<void>();
  let launches = 0;
  const processOwner: RuntimeOwner<RuntimeInstance> = {
    async create() {
      return { runtimeId: "native" };
    },
    async request(_runtime, operation) {
      return operation === "identity" ? { targetId: "page-1" } : null;
    },
    async stop() {},
  };
  const owner = createLazyRuntimeOwner(
    async () => {
      launches += 1;
      await release.promise;
      return { owner: processOwner, runtime: await processOwner.create("workspace") };
    },
    { maxStarted: 1 },
  );
  const first = await owner.create("first");
  const second = await owner.create("second");
  const opening = owner.request(first, "tabs.create", null);
  await expect(owner.request(second, "tabs.create", null)).rejects.toThrow(
    "Shared browser limit (1) reached",
  );
  release.resolve();
  await expect(opening).resolves.toEqual({ targetId: "page-1" });
  expect(launches).toBe(1);

  // A refused reservation stays usable once a slot frees up.
  await owner.stop(first);
  await expect(owner.request(second, "tabs.create", null)).resolves.toEqual({
    targetId: "page-1",
  });
});
