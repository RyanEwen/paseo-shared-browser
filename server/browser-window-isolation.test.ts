/** Exercise host readiness caching and helper lifecycle at the actual CDP adapter seam. */
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { BrowserWindowIsolation } from "./browser-window-isolation";
import type { CdpConnection } from "./cdp";

function fixture() {
  const connection = Object.assign(new EventEmitter(), {
    isOpen: true,
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === "Target.getTargets") return { targetInfos: [] };
      if (method === "Target.createTarget") return { targetId: "manager" };
      if (method === "Target.attachToTarget") return { sessionId: "manager-session" };
      if (method === "Runtime.evaluate") {
        if (String(params.expression).startsWith("document.readyState"))
          return { result: { value: true } };
        const targetId = String(params.expression).includes('"new-target"')
          ? "new-target"
          : "source";
        return { result: { value: { targetId, targetIds: ["source", targetId] } } };
      }
      return {};
    }),
  });
  const event = (method: string, params: object = {}) =>
    connection.emit("event", { method, params, sessionId: "manager-session" });
  const dirty = () =>
    event("Runtime.bindingCalled", { name: "sharedBrowserWindowDirty", payload: "changed" });
  const connect = () =>
    BrowserWindowIsolation.connect(connection as unknown as CdpConnection, true);
  const evaluations = () =>
    connection.send.mock.calls.filter(([method]) => method === "Runtime.evaluate").length;
  return { connection, event, dirty, connect, evaluations };
}

it("keeps stable frame/pointer readiness off CDP and isolates hidden helper creation", async () => {
  const f = fixture();
  const manager = await f.connect();
  const before = f.evaluations();
  for (let index = 0; index < 100; index++) await manager.settle("source");
  expect(f.evaluations()).toBe(before);
  expect(
    f.connection.send.mock.calls.find(([method]) => method === "Target.createTarget")?.[1],
  ).toMatchObject({ hidden: true, background: true });
  expect(
    f.connection.send.mock.calls.find(([method]) => method === "Target.createTarget")?.[1],
  ).not.toHaveProperty("newWindow");
  // Exact new targets force a readiness query even before Chrome delivers a tab event.
  await manager.settle("new-target");
  expect(f.evaluations()).toBe(before + 1);
});

it("retains a newer dirty binding that arrives during an older settlement reply", async () => {
  const f = fixture();
  const manager = await f.connect();
  const original = f.connection.send.getMockImplementation()!;
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<unknown>();
  let hold = true;
  f.connection.send.mockImplementation(async (method, params) => {
    if (method === "Runtime.evaluate" && hold) {
      hold = false;
      entered.resolve();
      return response.promise;
    }
    return original(method, params);
  });
  f.dirty();
  const before = f.evaluations();
  const pending = manager.settle("source");
  await entered.promise;
  f.dirty();
  response.resolve({ result: { value: { targetId: "source", targetIds: ["source"] } } });
  await pending;
  expect(f.evaluations()).toBe(before + 2);
});

it.each(["detach", "reload"] as const)(
  "refuses cached and pending readiness after helper %s",
  async (kind) => {
    const f = fixture();
    const manager = await f.connect();
    const original = f.connection.send.getMockImplementation()!;
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    f.connection.send.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate") {
        entered.resolve();
        return response.promise;
      }
      return original(method, params);
    });
    f.dirty();
    const pending = manager.settle("source");
    const refused = expect(pending).rejects.toThrow("unavailable");
    await entered.promise;
    if (kind === "detach")
      f.connection.emit("Target.detachedFromTarget", { sessionId: "manager-session" });
    else f.event("Runtime.executionContextsCleared");
    response.resolve({ result: { value: { targetId: "source", targetIds: ["source"] } } });
    await refused;
    await expect(manager.settle("source")).rejects.toThrow("unavailable");
  },
);
