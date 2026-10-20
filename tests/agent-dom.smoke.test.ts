import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { createRuntimeOwner } from "../server/runtime-owner";
import { resolveSupervisorPaths, startSupervisorServer } from "../server/supervisor";
import { SupervisorClient } from "../server/supervisor-client";
import type { BrowserState } from "../shared/browser";

it("uses actual MCP tools for a screenshot-free form and fences replaced documents/tabs", async () => {
  if (
    !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE
  )
    throw new Error("DOM smoke requires explicit isolated browser binaries");
  let submitted: string | null = null;
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "text/html");
    if (url.pathname === "/done") {
      submitted = `${url.searchParams.get("name")}:${url.searchParams.get("plan")}`;
      res.end("<title>Done</title><h1>Submitted</h1>");
    } else if (url.pathname === "/large") {
      res.end(
        `<title>Large DOM</title>${Array.from({ length: 1000 }, (_, i) => `<button>Button ${i}</button>`).join("")}`,
      );
    } else
      res.end(`<!doctype html><title>DOM form fixture</title>
      <form action="/done"><label>Name<input id="name" name="name" value="private-initial-value"></label>
      <label>Password<input type="password" value="password-must-not-leak"></label>
      <label>Plan<select name="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
      <button>Submit</button></form>
      <button type="button" onclick="document.getElementById('name').outerHTML='<input id=name value=replacement>'">Replace field</button>
      <button type="button" onclick="document.open();document.write('<h1>Replacement document</h1>');document.close()">Replace document</button>
      <button type="button" onclick="document.querySelector('form').insertAdjacentHTML('beforeend','<input aria-label=Added>')">Add field</button>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const home = await mkdtemp(join(tmpdir(), "shared-browser-dom-smoke-"));
  vi.stubEnv("PASEO_HOME", home);
  const owner = await createRuntimeOwner({ initialUrl: origin });
  let frames = 0;
  const running = await startSupervisorServer(
    {
      ...owner,
      request: async (runtime, op, input) => {
        if (op === "frame") frames++;
        return owner.request(runtime, op, input);
      },
    },
    resolveSupervisorPaths(home),
  );
  const admin = new SupervisorClient({
    bridgeId: "dom-smoke",
    paths: resolveSupervisorPaths(home),
  });
  const ticket = `synthetic-dom-ticket-${"x".repeat(40)}`;
  const bundle = join(home, "mcp.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../server/mcp-entry.ts", import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mcp = new Client({ name: "dom-form-test", version: "1.0.0" });
  try {
    await admin.connect();
    await admin.issueAgentTicket(ticket);
    await admin.bindAgentTicket(ticket, "dom-agent", "dom-workspace");
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle],
        env: { PASEO_HOME: home, PASEO_SHARED_BROWSER_TICKET: ticket },
        stderr: "pipe",
      }),
    );
    const call = async (name: string, args = {}) => {
      const reply = await mcp.callTool({ name: `shared_browser_${name}`, arguments: args });
      if (reply.isError) throw new Error(JSON.stringify(reply.content));
      return JSON.parse((reply.content as { text: string }[])[0]!.text);
    };
    const snapshot = await call("snapshot");
    expect(JSON.stringify(snapshot)).not.toContain("private-initial-value");
    expect(JSON.stringify(snapshot)).not.toContain("password-must-not-leak");
    const ref = (snap: typeof snapshot, name: string) =>
      snap.entries.find(
        (entry: { name: string; role: string }) => entry.name === name && entry.role !== "label",
      ).ref;
    await expect(
      call("fill", { snapshotId: snapshot.snapshotId, ref: ref(snapshot, "Name"), text: "Ada" }),
    ).rejects.toThrow();
    await call("acquire_control");
    const fill = await call("fill", {
      snapshotId: snapshot.snapshotId,
      ref: ref(snapshot, "Name"),
      text: "Ada",
    });
    expect(fill.state.agentPointer).toBeNull();
    expect(JSON.stringify(fill)).not.toContain("Ada");
    const hover = await call("hover", {
      snapshotId: snapshot.snapshotId,
      ref: ref(snapshot, "Submit"),
    });
    expect(hover.state.agentPointer).toMatchObject({ source: "semantic", clickRemainingMs: 0 });
    expect(hover.state.agentPointer.x).toBeGreaterThan(0);
    expect(hover.state.agentPointer.y).toBeGreaterThan(0);
    await call("select", {
      snapshotId: snapshot.snapshotId,
      ref: ref(snapshot, "Plan"),
      values: ["pro"],
    });
    const inspection = await call("evaluate", {
      snapshotId: snapshot.snapshotId,
      expression: "document.querySelector('input[name=name]').value",
    });
    expect(inspection.result.json).toBe('"Ada"');
    await expect(
      call("evaluate", {
        snapshotId: snapshot.snapshotId,
        expression: "document.body.setAttribute('data-bad','yes')",
      }),
    ).rejects.toThrow();
    await expect(
      call("evaluate", {
        snapshotId: snapshot.snapshotId,
        expression: "setTimeout(()=>document.body.remove(),0)",
      }),
    ).rejects.toThrow();
    const large = await call("evaluate", {
      snapshotId: snapshot.snapshotId,
      expression: "'x'.repeat(30000)",
    });
    expect(large.result.truncated).toBe(true);
    expect(large.result.json).toHaveLength(16000);
    const object = await call("evaluate", {
      snapshotId: snapshot.snapshotId,
      expression: "({title:document.title, list:[1,2,3]}) // trailing comment",
    });
    expect(JSON.parse(object.result.json)).toEqual({ title: "DOM form fixture", list: [1, 2, 3] });
    await expect(
      call("evaluate", {
        snapshotId: snapshot.snapshotId,
        expression: "({get value(){document.body.setAttribute('data-bad','yes');return 1}})",
      }),
    ).rejects.toThrow();
    await expect(
      call("evaluate", {
        snapshotId: snapshot.snapshotId,
        expression: "({toJSON(){document.body.remove();return 1}})",
      }),
    ).rejects.toThrow();
    await expect(
      call("evaluate", { snapshotId: snapshot.snapshotId, expression: "(()=>{while(true){} })()" }),
    ).rejects.toThrow();
    await call("click", { snapshotId: snapshot.snapshotId, ref: ref(snapshot, "Submit") });
    await vi.waitFor(() => expect(submitted).toBe("Ada:pro"));
    expect((await call("status")).state.agentPointer).toBeNull();
    await expect(
      call("fill", {
        snapshotId: snapshot.snapshotId,
        ref: ref(snapshot, "Name"),
        text: "wrong document",
      }),
    ).rejects.toThrow();
    // Form submission commits navigation independently of its click ACK. After
    // proving the old reference is stale, observe the new document before issuing
    // another mutation with the agent's source receipt.
    await call("status");
    await call("navigate", { action: { kind: "goto", url: origin } });
    const another = await call("snapshot");
    const clicked = await call("click", {
      snapshotId: another.snapshotId,
      ref: ref(another, "Replace field"),
    });
    expect(clicked.state.agentPointer).toMatchObject({ source: "semantic" });
    expect(clicked.state.agentPointer.clickRemainingMs).toBeGreaterThan(0);
    await expect(
      call("fill", {
        snapshotId: another.snapshotId,
        ref: ref(another, "Name"),
        text: "must not retarget",
      }),
    ).rejects.toThrow();
    const replacement = await call("snapshot");
    await call("click", {
      snapshotId: replacement.snapshotId,
      ref: ref(replacement, "Replace document"),
    });
    await expect(
      call("evaluate", { snapshotId: replacement.snapshotId, expression: "document.title" }),
    ).rejects.toThrow();
    await call("navigate", { action: { kind: "goto", url: origin } });
    const first = await call("snapshot");
    await call("tab_open");
    await call("acquire_control");
    await expect(
      call("click", { snapshotId: first.snapshotId, ref: ref(first, "Submit") }),
    ).rejects.toThrow();
    await call("tab_select", { tabId: first.state.tabId });
    await call("acquire_control");
    await expect(
      call("click", { snapshotId: first.snapshotId, ref: ref(first, "Submit") }),
    ).rejects.toThrow();
    await call("navigate", { action: { kind: "goto", url: `${origin}/large` } });
    const bounded = await call("snapshot");
    expect(bounded.entries.length).toBeLessThanOrEqual(200);
    expect(bounded.truncated).toBe(true);
    expect(
      JSON.stringify({
        snapshotId: bounded.snapshotId,
        entries: bounded.entries,
        truncated: bounded.truncated,
      }).length,
    ).toBeLessThan(24000);
    await call("navigate", { action: { kind: "goto", url: origin } });
    const current = await call("snapshot");
    const human = await admin.requestBrowser<{ viewerToken: string }>("attach", {
      workspaceId: "dom-workspace",
      viewerLabel: "Human",
      tabId: current.state.tabId,
    });
    const humanControl = await admin.requestBrowser<{ controlToken: string }>("acquire-control", {
      viewerToken: human.viewerToken,
      takeover: true,
    });
    await expect(
      call("fill", {
        snapshotId: current.snapshotId,
        ref: ref(current, "Name"),
        text: "not authorized",
      }),
    ).rejects.toThrow();
    await admin.requestBrowser("close", {
      viewerToken: human.viewerToken,
      controlToken: humanControl.controlToken,
      sessionId: current.state.sessionId,
      runtimeId: current.state.runtimeId,
    });
    const reopened = await call("open");
    expect(reopened.state.runtimeId).not.toBe(current.state.runtimeId);
    await call("acquire_control");
    await expect(
      call("fill", {
        snapshotId: current.snapshotId,
        ref: ref(current, "Name"),
        text: "wrong runtime",
      }),
    ).rejects.toThrow();
    const reopenedSnapshot = await call("snapshot");
    expect(reopenedSnapshot.state.runtimeId).toBe(reopened.state.runtimeId);
    expect(frames).toBe(0);
    expect((current.state as BrowserState).workspaceId).toBe("dom-workspace");
  } finally {
    await mcp.close();
    admin.disconnect();
    await running.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 60_000);
