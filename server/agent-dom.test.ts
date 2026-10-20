import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { type JsonValue, RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol";
import { RuntimeSupervisor } from "./supervisor";

const supervisors: RuntimeSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stopAll()));
});

async function fixture() {
  let now = 1000;
  let generation = "1:1";
  let replaceBeforeAction = false;
  const calls: string[] = [];
  const published: string[] = [];
  const channels = new Map<string, string>();
  let holdState: (() => Promise<void>) | null = null;
  const supervisor = new RuntimeSupervisor({
    now: () => now,
    bridgeTimeoutMs: 600_000,
    owner: {
      create: async () => ({ runtimeId: "r".repeat(40) }),
      stop: async () => {},
      request: async (_runtime, operation, input) => {
        const data = (input ?? {}) as Record<string, JsonValue>;
        calls.push(operation);
        if (operation === "identity") return { userAgent: "test", targetId: "A".repeat(32) };
        if (operation === "state") {
          if (holdState) {
            const hold = holdState;
            holdState = null;
            await hold();
          }
          return {
            url: "https://fixture.invalid/",
            title: "fixture",
            inputGeneration: generation,
            canGoBack: false,
            canGoForward: false,
          };
        }
        if (operation === "dom.snapshot")
          return { snapshotId: randomUUID(), entries: [], truncated: false };
        if (operation === "input.begin") {
          if (data.expectedInputGeneration !== generation) throw new Error("Document changed");
          channels.set(String(data.gestureId), generation);
        }
        if (operation === "input.end") channels.delete(String(data.gestureId));
        if (operation === "dom.action" || operation === "dom.evaluate") {
          if (replaceBeforeAction) {
            generation = "1:2";
            replaceBeforeAction = false;
          }
          if (channels.get(String(data.gestureId)) !== generation)
            throw new Error("Document changed before publication");
          published.push(operation);
          return { acknowledged: true };
        }
        return null;
      },
    },
  });
  supervisors.push(supervisor);
  const bridge = supervisor.claimBridge("dom-bridge");
  let id = 0;
  const dispatch = (method: string, rest: Record<string, unknown>) =>
    supervisor.dispatch({
      id: String(++id),
      version: RUNTIME_PROTOCOL_VERSION,
      token: "",
      method,
      ...rest,
    } as Parameters<typeof supervisor.dispatch>[0]);
  const ticket = `dom-test-ticket-${"t".repeat(40)}`;
  const admin = (method: string, rest: Record<string, unknown>) =>
    dispatch(method, { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ...rest });
  await admin("ticket.issue", { ticket });
  await admin("ticket.bind", { ticket, agentId: "dom-agent", workspaceId: "dom-workspace" });
  const request = (operation: string, input: JsonValue = {}) =>
    dispatch("agent.request", { ticket, operation, input });
  const snapshot = async () => (await request("dom.snapshot")) as unknown as { snapshotId: string };
  return {
    request,
    snapshot,
    admin,
    calls,
    channels,
    published,
    supervisor,
    bridge,
    advance: (ms: number) => {
      now += ms;
    },
    replace: () => {
      generation = "1:2";
    },
    replaceAtPublication: () => {
      replaceBeforeAction = true;
    },
    hold: () => {
      const pending = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      holdState = async () => {
        pending.resolve();
        await release.promise;
      };
      return { pending: pending.promise, release: release.resolve };
    },
  };
}
const fill = (snapshotId: string) => ({
  snapshotId,
  action: { kind: "fill", ref: "e1", text: "private value" },
});

it("supports repeated semantic actions with no frames, never echoes entered text, and cleans each channel", async () => {
  const f = await fixture();
  const s = await f.snapshot();
  await expect(f.request("dom.action", fill(s.snapshotId))).rejects.toThrow();
  await f.request("acquire-control");
  for (let i = 0; i < 2; i++) {
    const result = await f.request("dom.action", fill(s.snapshotId));
    expect(JSON.stringify(result)).not.toContain("private value");
  }
  expect(f.calls).not.toContain("frame");
  expect(f.published).toEqual(["dom.action", "dom.action"]);
  expect(f.channels.size).toBe(0);
  expect(f.calls.filter((c) => c === "input.end")).toHaveLength(2);
});

it.each(["dom.action", "dom.evaluate"])(
  "rejects %s with an expired, replaced, or foreign snapshot",
  async (operation) => {
    const f = await fixture();
    const s = await f.snapshot();
    await f.request("acquire-control");
    const input =
      operation === "dom.action"
        ? fill(s.snapshotId)
        : { snapshotId: s.snapshotId, expression: "document.title" };
    await expect(f.request(operation, { ...input, snapshotId: randomUUID() })).rejects.toThrow();
    f.advance(60_001);
    await expect(f.request(operation, input)).rejects.toThrow();
    const fresh = await f.snapshot();
    f.replace();
    await expect(
      f.request(operation, { ...input, snapshotId: fresh.snapshotId }),
    ).rejects.toThrow();
    expect(f.published).toEqual([]);
  },
);

it("rejects a document replaced after policy admission and ends its native channel", async () => {
  const f = await fixture();
  const s = await f.snapshot();
  await f.request("acquire-control");
  f.replaceAtPublication();
  await expect(f.request("dom.action", fill(s.snapshotId))).rejects.toThrow();
  expect(f.published).toEqual([]);
  expect(f.channels.size).toBe(0);
});

it("fences revoked queued semantic publication", async () => {
  const f = await fixture();
  const s = await f.snapshot();
  await f.request("acquire-control");
  const hold = f.hold();
  const reading = f.supervisor.requestWorkspace(
    f.bridge.bridgeId,
    f.bridge.epoch,
    "dom-workspace",
    "state",
    null,
  );
  await hold.pending;
  const action = f.request("dom.action", fill(s.snapshotId));
  const refused = expect(action).rejects.toThrow();
  const revoke = f.admin("agent.revoke", { agentId: "dom-agent" });
  hold.release();
  await reading;
  await refused;
  await revoke;
  expect(f.published).toEqual([]);
});

it("does not let another agent borrow a DOM snapshot", async () => {
  const f = await fixture();
  const s = await f.snapshot();
  const ticket = `second-dom-ticket-${"s".repeat(40)}`;
  await f.admin("ticket.issue", { ticket });
  await f.admin("ticket.bind", { ticket, agentId: "second-agent", workspaceId: "dom-workspace" });
  const request = (operation: string, input: JsonValue = {}) =>
    f.supervisor.dispatch({
      id: randomUUID(),
      version: RUNTIME_PROTOCOL_VERSION,
      method: "agent.request",
      ticket,
      operation,
      input,
    } as Parameters<typeof f.supervisor.dispatch>[0]);
  await request("acquire-control");
  await expect(request("dom.action", fill(s.snapshotId))).rejects.toThrow();
  expect(f.published).toEqual([]);
});
