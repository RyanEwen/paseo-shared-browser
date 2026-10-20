import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import { createRuntimeOwner } from "./runtime-owner";

type Owner = Awaited<ReturnType<typeof createRuntimeOwner>>;
type Owned = Parameters<Owner["request"]>[0];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(lingerSnapshots: number | null) {
  const owner = await createRuntimeOwner({ virtualDisplay: false, nativeVideo: false });
  const state = { ids: ["root", "closing"], closing: false, polls: 0, next: 0 };
  const native = {
    targets: vi.fn(async () => {
      if (state.closing && lingerSnapshots !== null && state.polls++ >= lingerSnapshots) {
        state.ids = state.ids.filter((id) => id !== "closing");
      } else if (state.closing && lingerSnapshots === null) {
        state.polls++;
      }
      return state.ids.map((targetId) => ({ targetId, title: targetId, url: "about:blank" }));
    }),
    closeTarget: vi.fn(async () => {
      state.closing = true;
    }),
    createTarget: vi.fn(async () => {
      const id = `new-${++state.next}`;
      state.ids.unshift(id);
      return id;
    }),
    selectTarget: vi.fn(async () => {}),
    releaseTarget: vi.fn(async () => {}),
  };
  const owned = {
    runtimeId: "review-runtime",
    runtime: native,
    rootTargetId: "root",
    runtimeOptions: {},
    tabs: new Map(),
    tabOrder: ["root", "closing"],
    display: null,
    displayNotice: null,
  } as unknown as Owned;
  return { owner, owned, native, state };
}

it("confirms an acknowledged close only after the target disappears without replay", async () => {
  const f = await fixture(2);
  const pending = f.owner.request(f.owned, "tabs.close", { targetId: "closing" });
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBeNull();
  expect(f.native.closeTarget).toHaveBeenCalledTimes(1);
  expect(f.state.polls).toBe(3);
  expect(
    ((await f.owner.request(f.owned, "tabs.list", null)) as { targetId: string }[]).map(
      (x) => x.targetId,
    ),
  ).toEqual(["root"]);
});

it("fails explicitly, without replaying close or reordering, when the target never disappears", async () => {
  const f = await fixture(null);
  const outcome = f.owner.request(f.owned, "tabs.close", { targetId: "closing" }).then(
    () => "ok",
    (error) => String(error),
  );
  await vi.runAllTimersAsync();
  expect(await outcome).toContain(
    "CdpUnknownOutcomeError: Browser tab close could not be confirmed",
  );
  expect(f.native.closeTarget).toHaveBeenCalledTimes(1);
  expect(f.state.polls).toBe(20);
  const ids = (await f.owner.request(f.owned, "tabs.list", null)) as { targetId: string }[];
  expect(ids.map((tab) => tab.targetId)).toEqual(["root", "closing"]);
});

it("retains known ordering across unordered snapshots and appends explicit creations", async () => {
  const f = await fixture(null);
  f.state.ids = ["third", "closing", "root"];
  const ids = async () =>
    ((await f.owner.request(f.owned, "tabs.list", null)) as { targetId: string }[]).map(
      (x) => x.targetId,
    );
  expect(await ids()).toEqual(["root", "closing", "third"]);
  f.state.ids = ["closing", "root", "third"];
  expect(await ids()).toEqual(["root", "closing", "third"]);
  await f.owner.request(f.owned, "tabs.create", null);
  await f.owner.request(f.owned, "tabs.create", null);
  expect(await ids()).toEqual(["root", "closing", "third", "new-1", "new-2"]);
});

it("preserves the existing last-tab refusal", async () => {
  const f = await fixture(null);
  f.state.ids = ["root"];
  await expect(f.owner.request(f.owned, "tabs.close", { targetId: "root" })).rejects.toThrow(
    "last browser tab",
  );
  expect(f.native.closeTarget).not.toHaveBeenCalled();
});

it("preserves source and preview when a tab-only close would remove the sole content page", async () => {
  const f = await fixture(null);
  const targets = f.native.targets.getMockImplementation()!;
  f.native.targets.mockImplementation(async () =>
    (await targets()).map((target) => ({
      ...target,
      url: target.targetId === "closing" ? "chrome://print/" : target.url,
    })),
  );
  await expect(f.owner.request(f.owned, "tabs.close", { targetId: "root" })).rejects.toThrow(
    "Close Print preview first, then confirm closing the final tab and browser",
  );
  expect(f.native.closeTarget).not.toHaveBeenCalled();
  expect(f.native.releaseTarget).not.toHaveBeenCalled();
  expect(f.state.ids).toEqual(["root", "closing"]);
  expect(f.owned.rootTargetId).toBe("root");
});

it("retires the launch-page controller without selecting or reconfiguring its survivor", async () => {
  const f = await fixture(0);
  f.owned.rootTargetId = "closing";
  const survivor = {
    identity: vi.fn(async () => ({ targetId: "root", width: 1280, height: 800 })),
    shutdown: vi.fn(async () => {}),
  };
  f.owned.tabs.set("root", Promise.resolve(survivor) as never);
  await f.owner.request(f.owned, "tabs.close", { targetId: "closing" });
  expect(f.native.releaseTarget).toHaveBeenCalledTimes(1);
  expect(f.native.selectTarget).not.toHaveBeenCalled();
  expect(survivor.shutdown).not.toHaveBeenCalled();
  expect(f.owned.rootTargetId).toBeNull();
  // Untargeted compatibility requests and explicit viewer requests reuse the same controller.
  for (const input of [null, { targetId: "root" }]) {
    await expect(f.owner.request(f.owned, "identity", input)).resolves.toMatchObject({
      targetId: "root",
      width: 1280,
      height: 800,
    });
  }
  expect(survivor.identity).toHaveBeenCalledTimes(2);
});

it("keeps an unconfirmed launch-page close pinned to its original target", async () => {
  const f = await fixture(null);
  f.owned.rootTargetId = "closing";
  const outcome = f.owner
    .request(f.owned, "tabs.close", { targetId: "closing" })
    .catch((error) => String(error));
  await vi.runAllTimersAsync();
  expect(await outcome).toContain("Browser tab close could not be confirmed");
  expect(f.owned.rootTargetId).toBe("closing");
  expect(f.native.releaseTarget).toHaveBeenCalledTimes(1);
  expect(f.native.closeTarget).toHaveBeenCalledTimes(1);
  expect(f.native.selectTarget).not.toHaveBeenCalled();
});

it("releases a previously unattached preview controller only after confirmed cancellation", async () => {
  const f = await fixture(2);
  f.owned.runtimeOptions = {
    binaryPath: "/unused/agent-browser",
    executablePath: "/unused/chrome",
    profilePath: "/unused/profile",
    ipcDirectory: "/unused/ipc",
    session: "preview-close-fixture",
  };
  const targets = f.native.targets.getMockImplementation()!;
  f.native.targets.mockImplementation(async () =>
    (await targets()).map((target) => ({
      ...target,
      url: target.targetId === "closing" ? "chrome://print/" : target.url,
    })),
  );
  const attach = vi.spyOn(AgentBrowserRuntime.prototype, "attachTarget").mockResolvedValue();
  const cancel = vi
    .spyOn(AgentBrowserRuntime.prototype, "cancelPrintPreview")
    .mockImplementation(async () => {
      f.state.closing = true;
    });
  const shutdown = vi
    .spyOn(AgentBrowserRuntime.prototype, "shutdown")
    .mockImplementation(async () => {
      expect(f.state.ids).toEqual(["root"]);
    });

  expect(f.owned.tabs.size).toBe(0);
  const pending = f.owner.request(f.owned, "tabs.close", { targetId: "closing" });
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBeNull();

  expect(attach).toHaveBeenCalledExactlyOnceWith("closing");
  expect(cancel).toHaveBeenCalledOnce();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(shutdown.mock.instances[0]).toBe(cancel.mock.instances[0]);
  expect(f.owned.tabs.size).toBe(0);
  expect(f.owned.rootTargetId).toBe("root");
  expect(f.native.closeTarget).not.toHaveBeenCalled();
  expect(f.native.releaseTarget).not.toHaveBeenCalled();
  expect(f.native.selectTarget).not.toHaveBeenCalled();
});
