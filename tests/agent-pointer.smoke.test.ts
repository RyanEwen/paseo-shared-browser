import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRuntimeOwner } from "../server/runtime-owner";
import { RUNTIME_PROTOCOL_VERSION } from "../server/runtime-protocol";
import { RuntimeSupervisor } from "../server/supervisor";
import type { BrowserState } from "../shared/browser";

it("shows real native and semantic agent activity to image and video observers", async () => {
  if (
    !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ||
    !process.env.PASEO_HOST
  )
    throw new Error("Pointer smoke requires explicit isolated runtime binaries and host");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Pointer fixture</title><style>
      #target{position:absolute;left:100px;top:120px;width:180px;height:40px}
      #clip{position:absolute;left:100px;top:220px;width:80px;height:40px;overflow:hidden}
      #clipped{width:200px;height:40px} #outside{position:absolute;top:2000px}
      </style><button id=target>Record click</button><div id=clip><button id=clipped>Clipped target</button></div><button id=outside>Outside viewport</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pointer fixture has no port");
  const home = await mkdtemp(join(tmpdir(), "shared-browser-pointer-"));
  vi.stubEnv("PASEO_HOME", home);
  const supervisor = new RuntimeSupervisor({
    owner: await createRuntimeOwner({
      initialUrl: `http://127.0.0.1:${address.port}/`,
      nativeVideo: true,
    }),
  });
  const bridge = supervisor.claimBridge("pointer-smoke");
  const ticket = `synthetic-pointer-ticket-${"x".repeat(40)}`;
  let id = 0;
  const dispatch = <T>(method: string, data: Record<string, unknown>) =>
    supervisor.dispatch({
      version: RUNTIME_PROTOCOL_VERSION,
      token: "",
      id: String(++id),
      method,
      ...data,
    } as Parameters<typeof supervisor.dispatch>[0]) as Promise<T>;
  type Reply = {
    state: BrowserState;
    result?: { pointer?: { x: number; y: number } };
    snapshotId: string;
    entries: { ref: string; name: string }[];
  };
  const agent = (operation: string, input: Record<string, unknown> = {}) =>
    dispatch<Reply>("agent.request", { ticket, operation, input });
  const human = <T>(operation: string, input: Record<string, unknown>) =>
    dispatch<T>("browser.request", {
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      operation,
      input,
    });
  try {
    await dispatch("ticket.issue", { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ticket });
    await dispatch("ticket.bind", {
      bridgeId: bridge.bridgeId,
      epoch: bridge.epoch,
      ticket,
      agentId: "pointer-agent",
      workspaceId: "pointer-workspace",
    });
    const acquired = await agent("acquire-control");
    const observer = await human<{ viewerToken: string }>("attach", {
      workspaceId: "pointer-workspace",
      viewerLabel: "Observer",
      tabId: acquired.state.tabId,
    });
    expect((await agent("status")).state.agentPointer).toBeNull();
    await agent("capture");
    const native = await agent("input", {
      event: {
        kind: "click",
        point: { x: 140, y: 140, width: 1280, height: 800 },
        button: "left",
        clickCount: 1,
      },
    });
    expect(native.state.agentPointer).toMatchObject({ x: 140, y: 140, source: "native" });
    const image = await human<{ state: BrowserState }>("capture", {
      viewerToken: observer.viewerToken,
      quality: "medium",
    });
    expect(image.state.agentPointer).toMatchObject({ x: 140, y: 140, source: "native" });
    expect(image.state.agentPointer?.clickRemainingMs).toBeGreaterThan(0);

    const snapshot = await agent("dom.snapshot");
    const ref = (name: string) => snapshot.entries.find((entry) => entry.name === name)!.ref;
    const action = (kind: "click" | "hover", name: string) =>
      agent("dom.action", { snapshotId: snapshot.snapshotId, action: { kind, ref: ref(name) } });
    const clipped = await action("hover", "Clipped target");
    expect(clipped.state.agentPointer).toMatchObject({
      x: 140,
      y: 240,
      source: "semantic",
      clickRemainingMs: 0,
    });
    const offscreen = await action("hover", "Outside viewport");
    expect(offscreen.result?.pointer).toBeUndefined();
    const clicked = await action("click", "Record click");
    expect(clicked.state.agentPointer).toMatchObject({ x: 190, y: 140, source: "semantic" });
    const video = await human<{ state: BrowserState }>("video.read", {
      viewerToken: observer.viewerToken,
      waitMs: 100,
    });
    expect(video.state.agentPointer).toMatchObject({ x: 190, y: 140, source: "semantic" });
    expect(video.state.agentPointer?.clickRemainingMs).toBeGreaterThan(0);
    await agent("navigate", { action: { kind: "reload" } });
    expect((await agent("status")).state.agentPointer).toBeNull();
  } finally {
    await supervisor.stopAll();
    server.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
