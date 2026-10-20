/** Trusted agent routing must extend observation/idle budgets without changing human admission. */
import { afterEach, expect, it } from "vitest";
import type { BrowserFrame, BrowserState } from "../shared/browser";
import { CdpUnknownOutcomeError } from "./cdp";
import { RUNTIME_PROTOCOL_VERSION } from "./runtime-protocol";
import { RuntimeSupervisor } from "./supervisor";

const supervisors: RuntimeSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
});

it("requires current control, document state and private-print capability before publication", async () => {
  const unsupported = await fixture();
  await expect(unsupported.agent("print")).rejects.toThrow("owned private desktop");
  expect(unsupported.calls).not.toContain("print");

  const f = await fixture(true);
  expect((await f.agent("status")).state.canPrint).toBe(true);
  f.replaceDocument();
  await expect(f.agent("print")).rejects.toThrow("stale");
  expect(f.calls).not.toContain("print");
  await f.agent("status");
  await f.agent("release-control");
  await expect(f.agent("print")).rejects.toThrow();
  expect(f.calls).not.toContain("print");
  await f.agent("acquire-control");
  await f.agent("print");
  expect(f.calls.filter((call) => call === "print")).toHaveLength(1);
});

it("surfaces an unknown print outcome without retry and discards the old agent frame", async () => {
  const f = await fixture(true);
  await f.agent("capture");
  f.makePrintUncertain();
  await expect(f.agent("print")).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
  expect(f.calls.filter((call) => call === "print")).toHaveLength(1);
  await expect(f.agent("input", { event: click })).rejects.toThrow();
  expect(f.calls).not.toContain("mouse.down");
});

/** Real supervisor/policy routing with a controllable host clock and one native document. */
async function fixture(canPrint = false) {
  let now = 1_000;
  let generation = "1:1";
  let ids = 0;
  let metadataDelay = 0;
  let printUncertain = false;
  const calls: string[] = [];
  const supervisor = new RuntimeSupervisor({
    now: () => now,
    bridgeTimeoutMs: 600_000,
    owner: {
      create: async () => ({ runtimeId: "r".repeat(40) }),
      stop: async () => {},
      request: async (_runtime, operation) => {
        calls.push(operation);
        if (operation === "identity") return { userAgent: "Policy fixture", canPrint };
        if (operation === "print" && printUncertain)
          throw new CdpUnknownOutcomeError("Print reply timed out");
        if (operation === "state") {
          now += metadataDelay;
          return { url: "about:blank", title: "Fixture", inputGeneration: generation };
        }
        if (operation === "frame") {
          return {
            dataBase64: "eA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date(now).toISOString(),
          };
        }
        if (operation === "video.read")
          return { inputGeneration: generation, status: "waiting", streamId: null, packets: [] };
        return null;
      },
    },
  });
  supervisors.push(supervisor);
  const bridge = supervisor.claimBridge("timing-fixture");
  const ticket = "t".repeat(40);
  const dispatch = (method: string, data: Record<string, unknown>) =>
    supervisor.dispatch({
      version: RUNTIME_PROTOCOL_VERSION,
      token: "",
      id: String(++ids),
      method,
      ...data,
    } as unknown as Parameters<typeof supervisor.dispatch>[0]);
  await dispatch("ticket.issue", { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ticket });
  await dispatch("ticket.bind", {
    bridgeId: bridge.bridgeId,
    epoch: bridge.epoch,
    ticket,
    agentId: "fixture-agent",
    workspaceId: "fixture-workspace",
  });
  const agent = (operation: string, input: Record<string, unknown> = {}) =>
    dispatch("agent.request", { ticket, operation, input }) as Promise<{
      state: BrowserState;
      frame: BrowserFrame | null;
      frameExpiresAt?: string;
      agentPolicy: { frameTtlMs: number; controlLeaseMs: number; viewerTtlMs: number };
      viewerToken: string;
      controlToken: string;
    }>;
  const human = (operation: string, input: Record<string, unknown> = {}) =>
    dispatch("browser.request", {
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      operation,
      input,
    }) as Promise<{
      state: BrowserState;
      frame: BrowserFrame | null;
      frameExpiresAt?: string;
      agentPolicy: { frameTtlMs: number; controlLeaseMs: number; viewerTtlMs: number };
      viewerToken: string;
      controlToken: string;
    }>;
  await agent("acquire-control");
  return {
    agent,
    human,
    calls,
    makePrintUncertain: () => {
      printUncertain = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
    replaceDocument: () => {
      generation = "1:2";
    },
    delayMetadata: (ms: number) => {
      metadataDelay = ms;
    },
  };
}

const click = {
  kind: "click",
  point: { x: 10, y: 20, width: 1280, height: 800 },
  button: "left",
  clickCount: 1,
};

it.each([6_000, 59_999])("admits a trusted agent screenshot after %ims", async (age) => {
  const f = await fixture();
  await f.agent("capture");
  f.advance(age);
  await f.agent("input", { event: click });
  expect(f.calls).toContain("mouse.down");
});

it("expires the agent screenshot at one minute with its real age in the diagnostic", async () => {
  const f = await fixture();
  await f.agent("capture");
  f.advance(60_000);
  await expect(f.agent("input", { event: click })).rejects.toThrow(/expired; ageMs=60000/);
  expect(f.calls).not.toContain("mouse.down");
});

it("keeps idle agent viewer and ownership alive until five minutes", async () => {
  const f = await fixture();
  f.advance(299_999);
  const state = await f.agent("status");
  expect(state.state.controller).toBe("self");
  expect(state.state.controllerExpiresAt).toBe(new Date(301_000).toISOString());
  // Status renews viewing, but does not silently extend idle control.
  f.advance(1);
  expect((await f.agent("status")).state.controller).toBe("none");
});

it("renews agent idle ownership for a full five minutes after admitted input", async () => {
  const f = await fixture();
  f.advance(250_000);
  await f.agent("capture");
  await f.agent("input", { event: click });
  expect((await f.agent("status")).state.controllerExpiresAt).toBe(new Date(551_000).toISOString());
  f.advance(299_999);
  expect((await f.agent("status")).state.controller).toBe("self");
  f.advance(1);
  expect((await f.agent("status")).state.controller).toBe("none");
});

it("renews the agent viewer heartbeat for five minutes, without an implicit lease renewal", async () => {
  const f = await fixture();
  for (let interval = 0; interval < 2; interval++) {
    f.advance(200_000);
    const before = f.calls.filter((operation) => operation === "state").length;
    await f.agent("status");
    // Reattachment adds its own state read, so this proves the original viewer survived.
    expect(f.calls.filter((operation) => operation === "state").length - before).toBe(1);
  }
  await f.agent("acquire-control");
  expect((await f.agent("status")).state.controller).toBe("self");
});

it("lets a human immediately take over and fences the old agent input", async () => {
  const f = await fixture();
  await f.agent("capture");
  const human = await f.human("attach", { workspaceId: "fixture-workspace", viewerLabel: "Human" });
  await f.human("acquire-control", { viewerToken: human.viewerToken, takeover: true });
  await expect(f.agent("input", { event: click })).rejects.toThrow(/control/i);
  expect(f.calls).not.toContain("mouse.down");
});

it("keeps a human label beginning with Agent on the five-second frame policy", async () => {
  const f = await fixture();
  const human = await f.human("attach", {
    workspaceId: "fixture-workspace",
    viewerLabel: "Agent fixture-agent",
  });
  const lease = await f.human("acquire-control", {
    viewerToken: human.viewerToken,
    takeover: true,
  });
  const capture = await f.human("capture", { viewerToken: human.viewerToken, quality: "medium" });
  f.advance(5_000);
  await expect(
    f.human("input", {
      viewerToken: human.viewerToken,
      controlToken: lease.controlToken,
      expected: {
        sessionId: capture.state.sessionId,
        runtimeId: capture.state.runtimeId,
        bridgeEpoch: capture.state.bridgeEpoch,
        navigationGeneration: capture.state.navigationGeneration,
        viewportGeneration: capture.state.viewportGeneration,
      },
      target: capture.frame,
      event: click,
    }),
  ).rejects.toThrow(/expired; ageMs=5000/);
});

it.each(["control", "viewer"])("retains the normal human %s expiry", async (which) => {
  const f = await fixture();
  const human = await f.human("attach", { workspaceId: "fixture-workspace", viewerLabel: "Human" });
  await f.human("acquire-control", { viewerToken: human.viewerToken, takeover: true });
  f.advance(which === "control" ? 30_000 : 45_000);
  if (which === "control") {
    expect((await f.human("status", { viewerToken: human.viewerToken })).state.controller).toBe(
      "none",
    );
  } else {
    await expect(f.human("status", { viewerToken: human.viewerToken })).rejects.toThrow(
      /Viewer token/,
    );
  }
});

it("still rejects a changed native document inside the agent screenshot lifetime", async () => {
  const f = await fixture();
  await f.agent("capture");
  f.advance(6_000);
  f.replaceDocument();
  await expect(f.agent("input", { event: click })).rejects.toThrow();
  expect(f.calls).not.toContain("mouse.down");
});

it("allows final metadata validation beyond five seconds for an agent capture", async () => {
  const f = await fixture();
  f.delayMetadata(6_000);
  await expect(f.agent("capture")).resolves.toHaveProperty("frame");
});

it("shares actual agent pointer activity and expires click and idle presence independently", async () => {
  const f = await fixture();
  expect((await f.agent("status")).state.agentPointer).toBeNull();
  await f.agent("capture");
  const clicked = await f.agent("input", { event: click });
  expect(clicked.state.agentPointer).toMatchObject({
    x: 10,
    y: 20,
    source: "native",
    clickRemainingMs: 900,
    remainingMs: 5000,
  });
  const human = await f.human("attach", {
    workspaceId: "fixture-workspace",
    viewerLabel: "Observer",
  });
  expect(human.state.agentPointer).toEqual(clicked.state.agentPointer);
  f.advance(250);
  const image = await f.human("capture", { viewerToken: human.viewerToken, quality: "medium" });
  expect(image.state.agentPointer?.clickRemainingMs).toBe(650);
  f.advance(500);
  const video = await f.human("video.read", { viewerToken: human.viewerToken, waitMs: 500 });
  expect(video.state.agentPointer?.clickRemainingMs).toBe(150);
  f.advance(150);
  expect((await f.agent("status")).state.agentPointer?.clickRemainingMs).toBe(0);
  f.advance(4100);
  expect((await f.agent("status")).state.agentPointer).toBeNull();
});

it("does not move the click pulse with the pointer or fabricate one for typing", async () => {
  const f = await fixture();
  await f.agent("capture");
  await f.agent("input", { event: click });
  await f.agent("capture");
  const moved = await f.agent("input", {
    event: { kind: "move", point: { x: 90, y: 80, width: 1280, height: 800 } },
  });
  expect(moved.state.agentPointer).toMatchObject({ x: 90, y: 80, clickRemainingMs: 0 });
  f.advance(5000);
  await f.agent("capture");
  expect(
    (await f.agent("input", { event: { kind: "type", text: "hello" } })).state.agentPointer,
  ).toBeNull();
});

it("clears pointer activity on document replacement and human takeover", async () => {
  const f = await fixture();
  await f.agent("capture");
  await f.agent("input", { event: click });
  f.replaceDocument();
  expect((await f.agent("status")).state.agentPointer).toBeNull();
  await f.agent("capture");
  await f.agent("input", { event: click });
  const human = await f.human("attach", {
    workspaceId: "fixture-workspace",
    viewerLabel: "Agent misleading label",
  });
  expect(
    (await f.human("acquire-control", { viewerToken: human.viewerToken, takeover: true })).state
      .agentPointer,
  ).toBeNull();
  expect((await f.agent("status")).state.agentPointer).toBeNull();
});

it("human re-observation cannot shorten the agent's receipt for identical cached pixels", async () => {
  const f = await fixture();
  const agent = await f.agent("capture");
  const human = await f.human("attach", { workspaceId: "fixture-workspace", viewerLabel: "Human" });
  f.advance(1);
  const viewed = await f.human("capture", { viewerToken: human.viewerToken, quality: "medium" });
  expect(viewed.frame!.frameId).toBe(agent.frame!.frameId);
  f.advance(59_998);
  await f.agent("input", { event: click });
  expect(f.calls).toContain("mouse.down");
});

it("agent re-observation cannot renew a human receipt for identical cached pixels", async () => {
  const f = await fixture();
  const human = await f.human("attach", { workspaceId: "fixture-workspace", viewerLabel: "Human" });
  const lease = await f.human("acquire-control", {
    viewerToken: human.viewerToken,
    takeover: true,
  });
  const capture = await f.human("capture", { viewerToken: human.viewerToken, quality: "medium" });
  f.advance(1);
  const agent = await f.agent("capture");
  expect(agent.frame!.frameId).toBe(capture.frame!.frameId);
  f.advance(4_999);
  await expect(
    f.human("input", {
      viewerToken: human.viewerToken,
      controlToken: lease.controlToken,
      expected: {
        sessionId: capture.state.sessionId,
        runtimeId: capture.state.runtimeId,
        bridgeEpoch: capture.state.bridgeEpoch,
        navigationGeneration: capture.state.navigationGeneration,
        viewportGeneration: capture.state.viewportGeneration,
      },
      target: capture.frame,
      event: click,
    }),
  ).rejects.toThrow(/expired; ageMs=5000/);
  expect(f.calls).not.toContain("mouse.down");
});

it("returns the effective runtime policy and the actual screenshot deadline", async () => {
  const f = await fixture();
  const capture = await f.agent("capture");
  expect(capture.agentPolicy).toMatchObject({
    frameTtlMs: 60_000,
    controlLeaseMs: 300_000,
    viewerTtlMs: 300_000,
  });
  expect(capture.frameExpiresAt).toBe(new Date(61_000).toISOString());
  // Older MCP adapters print state only; keep runtime policy authoritative there too.
  expect(capture.state).toMatchObject({
    agentPolicy: capture.agentPolicy,
    frameExpiresAt: capture.frameExpiresAt,
  });
});
