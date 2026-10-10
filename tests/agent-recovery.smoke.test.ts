import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRuntimeOwner } from "../server/runtime-owner";
import { resolveSupervisorPaths, startSupervisorServer } from "../server/supervisor";
import { AgentSupervisorClient, SupervisorClient } from "../server/supervisor-client";
import type { BrowserState } from "../shared/browser";

it("preserves a real two-tab browser draft and human lease across agent reconnect", async () => {
  let submitted = "";
  const fixture = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/submitted") {
      submitted = url.searchParams.get("draft") ?? "";
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Recovery fixture</title>
      <form action="/submitted"><input name="draft" style="position:absolute;left:40px;top:40px;width:200px;height:30px">
      <button style="position:absolute;left:280px;top:40px;width:120px;height:30px">Check draft</button></form>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  const origin = `http://127.0.0.1:${address.port}`;
  const home = await mkdtemp(join(tmpdir(), "shared-browser-recovery-smoke-"));
  vi.stubEnv("PASEO_HOME", home);
  const paths = resolveSupervisorPaths(home);
  const running = await startSupervisorServer(await createRuntimeOwner({ initialUrl: origin }), paths);
  const admin = new SupervisorClient({ bridgeId: "isolated-recovery-smoke", paths });
  const ticket = "synthetic-recovery-ticket-" + "x".repeat(40);
  const agent = new AgentSupervisorClient({ ticket, paths });
  try {
    await admin.connect();
    await admin.issueAgentTicket(ticket);
    await admin.bindAgentTicket(ticket, "synthetic-agent", "synthetic-workspace");
    await agent.open();
    const first = await agent.request("status", {}) as unknown as { state: BrowserState };
    if (!first.state.tabId) throw new Error("Initial browser tab missing");
    const human = await admin.requestBrowser<{ viewerToken: string }>("attach", {
      workspaceId: "synthetic-workspace", viewerLabel: "Synthetic human", tabId: first.state.tabId,
    });
    const humanControl = await admin.requestBrowser<{ controlToken: string }>("acquire-control", {
      viewerToken: human.viewerToken, takeover: false,
    });
    const second = await agent.request("tabs.create", {}) as unknown as { tabId: string };
    await agent.request("acquire-control", {});
    await agent.request("navigate", { action: { kind: "goto", url: origin + "/second" } });
    await agent.request("capture", {});
    await agent.request("input", { event: { kind: "click", point: { x: 80, y: 55, width: 1280, height: 800 } } });
    await agent.request("capture", {});
    await agent.request("input", { event: { kind: "type", text: "unsaved synthetic draft" } });
    const before = await agent.request("status", {}) as unknown as { state: BrowserState };
    agent.disconnect();
    const recovered = await agent.reconnect() as unknown as { state: BrowserState };
    expect(recovered.state.runtimeId).toBe(before.state.runtimeId);
    expect(recovered.state.tabId).toBe(second.tabId);
    expect(recovered.state.navigationGeneration).toBe(before.state.navigationGeneration);
    expect(recovered.state.controller).toBe("none");
    const tabs = await agent.request("tabs.list", {}) as unknown as { tabs: unknown[] };
    expect(tabs.tabs).toHaveLength(2);
    // A successful release proves recovery did not steal the other tab's lease.
    await admin.requestBrowser("release-control", {
      viewerToken: human.viewerToken, controlToken: humanControl.controlToken,
    });
    await agent.request("acquire-control", {});
    await agent.request("capture", {});
    await agent.request("input", { event: { kind: "click", point: { x: 330, y: 55, width: 1280, height: 800 } } });
    await vi.waitFor(() => expect(submitted).toBe("unsaved synthetic draft"));
  } finally {
    agent.disconnect();
    admin.disconnect();
    await running.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);
