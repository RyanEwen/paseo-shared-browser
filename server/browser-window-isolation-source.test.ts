/** Execute the shipped extension program, including asynchronous native tab identity arrival. */
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { BROWSER_WINDOW_ISOLATION_SOURCE } from "./browser-window-isolation-source";

function fixture() {
  const events = new Map<string, (...args: unknown[]) => void>();
  const tabs = new Map<number, { id: number; windowId: number }>();
  const targets: { id: string; tabId?: number; type: string; url: string }[] = [];
  let nextWindow = 100;
  const create = vi.fn(async ({ tabId }: { tabId: number; focused: boolean }) => {
    const id = nextWindow++;
    tabs.get(tabId)!.windowId = id;
    events.get("onAttached")?.(tabId, { newWindowId: id });
    return { id };
  });
  const context = createContext({
    URL,
    performance,
    setTimeout,
    sharedBrowserWindowDirty: vi.fn(),
    chrome: {
      runtime: { id: "trusted" },
      debugger: { getTargets: async () => targets },
      tabs: {
        ...Object.fromEntries(
          ["onCreated", "onAttached", "onRemoved", "onReplaced", "onUpdated"].map((name) => [
            name,
            { addListener: (fn: (...args: unknown[]) => void) => events.set(name, fn) },
          ]),
        ),
        query: async () => [...tabs.values()],
        get: async (tabId: number) => tabs.get(tabId),
      },
      windows: { create },
    },
  });
  runInContext(BROWSER_WINDOW_ISOLATION_SOURCE, context);
  const settle = (targetId?: string) =>
    runInContext(`sharedBrowserWindows.settle(${JSON.stringify(targetId ?? null)})`, context);
  const add = (id: string, tabId: number, windowId: number, url = "https://fixture.example/") => {
    targets.push({ id, tabId, type: "page", url });
    tabs.set(tabId, { id: tabId, windowId });
  };
  return { context, targets, tabs, events, create, settle, add };
}

it("isolates existing exact targets and attached popups while leaving preview/helper pages alone", async () => {
  const f = fixture();
  f.add("source", 1, 10);
  f.add("existing", 2, 10);
  f.add("preview", 3, 10, "chrome://print/");
  f.add("helper", 4, 10, "chrome-extension://trusted/recorder.html");
  await f.settle("existing");
  expect(f.create.mock.calls).toEqual([[{ tabId: 2, focused: false }]]);
  expect(f.tabs.get(1)!.windowId).toBe(10);
  expect(f.tabs.get(2)!.windowId).toBe(100);
  expect(f.tabs.get(3)!.windowId).toBe(10);
  expect(f.tabs.get(4)!.windowId).toBe(10);
  f.tabs.get(2)!.windowId = 10;
  f.events.get("onAttached")?.(2, { newWindowId: 10 });
  await f.settle("existing");
  expect(f.create).toHaveBeenCalledTimes(2);
});

it("waits for new target tabId metadata even when explicit settlement precedes the native event", async () => {
  const f = fixture();
  f.add("source", 1, 10);
  await f.settle();
  f.targets.push({ id: "popup", type: "page", url: "https://fixture.example/" });
  const pending = f.settle("popup");
  setTimeout(() => {
    f.targets[1]!.tabId = 2;
    f.tabs.set(2, { id: 2, windowId: 10 });
  }, 10);
  await expect(pending).resolves.toMatchObject({ targetId: "popup", tabId: 2 });
  expect(f.create).toHaveBeenCalledExactlyOnceWith({ tabId: 2, focused: false });
});

it("refuses failed moves and ambiguous target mappings without adopting another page", async () => {
  const f = fixture();
  f.add("source", 1, 10);
  f.add("second", 2, 10);
  f.create.mockRejectedValueOnce(new Error("Native move failed"));
  await expect(f.settle("second")).rejects.toThrow("Native move failed");
  expect(f.tabs.get(2)!.windowId).toBe(10);
  await expect(f.settle("second")).resolves.toMatchObject({ targetId: "second" });
  f.targets.push({ id: "ambiguous", tabId: 2, type: "page", url: "https://fixture.example/" });
  f.events.get("onCreated")?.();
  await f.settle();
  expect(runInContext("sharedBrowserWindows.identities.has('second')", f.context)).toBe(false);
});
