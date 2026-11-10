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
import { SupervisorClient } from "../server/supervisor-client";
import { resolveSupervisorPaths } from "../server/supervisor-paths";
import { startSupervisorServer } from "../server/supervisor-server";

// React-like controlled numeric fields: a dirty local draft stays visible until blur,
// while input updates model history. Undo only synchronizes fields whose draft is clean.
const fixtureHtml = `<!doctype html><title>Focus and draft fixture</title>
<label>X<input id=x type=number value=120></label><label>Y<input id=y type=number value=7></label>
<button id=undo>Undo</button><button id=parent><span role=button aria-label="Nested">Nested</span></button>
<div role=button id=plain>Plain</div><label>Notes<textarea id=notes></textarea></label>
<div contenteditable=true aria-label="Editable" id=editable></div>
<label>Plan<select id=plan><option value=basic>Basic</option><option value=pro>Pro</option></select></label>
<label>Remove target on blur<input id=remove></label><button id=victim>Victim</button>
<label>Replace on focus<input id=replace value=original></label>
<label>Disable on focus<input id=disable value=original></label>
<label>Redirect on focus<input id=redirect value=original></label>
<label>Replace document on focus<input id=document></label>
<label>Keyboard anchor<input id=keyboard-anchor></label>
<button id=keyboard-enabled type=button>Keyboard action</button>
<button id=keyboard-disabled type=button disabled>Disabled keyboard action</button>
<label>After disabled action<input id=keyboard-after></label>
<output id=keyboard-clicks>[]</output><output id=keyboard-events>[]</output>
<div id=shadow></div><output id=model></output><output id=events></output>
<script>
const fields=[document.getElementById('x'),document.getElementById('y')];
let model={x:120,y:7},history=[],dirty=new Set(),events=[];
function render(){for(const field of fields)if(!dirty.has(field.id))field.value=String(model[field.id]);document.getElementById('model').textContent=JSON.stringify(model);document.getElementById('undo').disabled=history.length===0;}
for(const field of fields){field.addEventListener('input',()=>{dirty.add(field.id);history.push({...model});model={...model,[field.id]:Number(field.value)};render()});field.addEventListener('blur',()=>{dirty.delete(field.id);render()});}
for(const type of ['focus','blur','input','change','click'])document.addEventListener(type,event=>{document.body.dataset.active=document.activeElement.id;if(type==='focus')document.body.dataset.deepActive=event.composedPath()[0].id;events.push(type+':'+event.target.id);document.getElementById('events').textContent=JSON.stringify(events.slice(-60))},true);
document.getElementById('undo').onclick=()=>{if(history.length)model=history.pop();render()};
document.getElementById('parent').onclick=()=>document.body.dataset.parentClicked='yes';
document.getElementById('plain').onclick=()=>document.body.dataset.plainClicked='yes';
document.getElementById('victim').onclick=()=>document.body.dataset.victimClicked='yes';
document.getElementById('remove').onblur=()=>document.getElementById('victim')?.remove();
document.getElementById('replace').onfocus=event=>{event.target.outerHTML='<input id=replacement value=untouched>'};
document.getElementById('disable').onfocus=event=>{event.target.disabled=true};
document.getElementById('redirect').onfocus=()=>document.getElementById('notes').focus();
document.getElementById('document').onfocus=()=>{document.open();document.write('<title>Replaced</title><h1>Replacement</h1>');document.close()};
document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow<input id=shadow-input></label>';
const keyboardClicks=[],keyboardEvents=[];
for(const id of ['keyboard-enabled','keyboard-disabled'])document.getElementById(id).onclick=event=>{keyboardClicks.push({id,active:document.activeElement.id,trusted:event.isTrusted});document.getElementById('keyboard-clicks').textContent=JSON.stringify(keyboardClicks)};
for(const type of ['keydown','keyup'])document.getElementById('keyboard-enabled').addEventListener(type,event=>{keyboardEvents.push({type,key:event.key,code:event.code,trusted:event.isTrusted});document.getElementById('keyboard-events').textContent=JSON.stringify(keyboardEvents)});
render();
</script>`;

/** Own a disposable real MCP/supervisor/browser fixture for DOM focus or one native activation key. */
async function runFocusSmoke(activationKey: "Enter" | "Space" | null = null) {
  if (
    !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE
  )
    throw new Error("Focus smoke requires explicit isolated browser binaries");
  const fixture = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  const home = await mkdtemp(join(tmpdir(), "shared-browser-focus-smoke-"));
  vi.stubEnv("PASEO_HOME", home);
  const owner = await createRuntimeOwner({ initialUrl: `http://127.0.0.1:${address.port}` });
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
    bridgeId: "focus-smoke",
    paths: resolveSupervisorPaths(home),
  });
  const ticket = `synthetic-focus-ticket-${"x".repeat(40)}`;
  const bundle = join(home, "mcp.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../server/mcp-entry.ts", import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mcp = new Client({ name: "focus-draft-test", version: "1.0.0" });
  try {
    await admin.connect();
    await admin.issueAgentTicket(ticket);
    await admin.bindAgentTicket(ticket, "focus-agent", "focus-workspace");
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle],
        env: {
          PASEO_HOME: home,
          PASEO_SHARED_BROWSER_TICKET: ticket,
          ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
        },
        stderr: "pipe",
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await mcp.callTool({ name: `shared_browser_${name}`, arguments: args });
      if (r.isError) throw new Error(JSON.stringify(r.content));
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    let snapshot = await call("snapshot");
    const ref = (name: string) =>
      snapshot.entries.find(
        (e: { name: string; role: string }) => e.name === name && e.role !== "label",
      ).ref;
    const action = (kind: string, name: string, args = {}) =>
      call(kind, { snapshotId: snapshot.snapshotId, ref: ref(name), ...args });
    const inspect = async (expression: string) =>
      JSON.parse(
        (await call("evaluate", { snapshotId: snapshot.snapshotId, expression })).result.json,
      );
    const state = async () => ({
      active: await inspect("document.body.getAttribute('data-active') || ''"),
      x: await inspect("document.querySelector('#x').value"),
      y: await inspect("document.querySelector('#y').value"),
      model: await inspect("document.querySelector('#model').textContent"),
      events: JSON.parse(await inspect("document.querySelector('#events').textContent")),
    });
    if (activationKey) {
      await call("acquire_control");
      snapshot = await call("snapshot");
      await action("click", "Keyboard anchor");
      await call("capture");
      await call("input", { event: { kind: "key", key: "Tab" } });
      expect(await inspect("document.activeElement.id")).toBe("keyboard-enabled");
      expect(await inspect("document.querySelector('#keyboard-enabled').disabled")).toBe(false);
      await call("capture");
      await call("input", { event: { kind: "key", key: activationKey } });
      expect(await inspect("document.activeElement.id")).toBe("keyboard-enabled");
      expect(
        JSON.parse(await inspect("document.querySelector('#keyboard-clicks').textContent")),
      ).toEqual([{ id: "keyboard-enabled", active: "keyboard-enabled", trusted: true }]);
      const key = activationKey === "Space" ? " " : "Enter";
      const edges = JSON.parse(
        await inspect("document.querySelector('#keyboard-events').textContent"),
      );
      expect(edges.filter((event: { code: string }) => event.code !== "Tab")).toEqual([
        { type: "keydown", key, code: activationKey, trusted: true },
        { type: "keyup", key, code: activationKey, trusted: true },
      ]);
      // Native focus traversal skips disabled buttons; the same key cannot activate one.
      await call("capture");
      await call("input", { event: { kind: "key", key: "Tab" } });
      expect(await inspect("document.activeElement.id")).toBe("keyboard-after");
      expect(await inspect("document.querySelector('#keyboard-disabled').disabled")).toBe(true);
      await call("capture");
      await call("input", { event: { kind: "key", key: activationKey } });
      expect(
        JSON.parse(await inspect("document.querySelector('#keyboard-clicks').textContent")),
      ).toEqual([{ id: "keyboard-enabled", active: "keyboard-enabled", trusted: true }]);
      return;
    }
    await expect(action("fill", "X", { text: "160" })).rejects.toThrow();
    await call("acquire_control");
    snapshot = await call("snapshot");
    await action("fill", "X", { text: "160" });
    expect((await state()).active).toBe("x");
    await action("click", "Y");
    expect((await state()).active).toBe("y");
    await action("click", "Undo");
    const undone = await state();
    expect(undone.x).toBe("120");
    expect(JSON.parse(undone.model).x).toBe(120);
    expect(undone.events.indexOf("focus:x")).toBeLessThan(undone.events.indexOf("input:x"));
    expect(undone.events.indexOf("blur:x")).toBeLessThan(undone.events.indexOf("focus:y"));
    await action("click", "X");
    expect((await state()).active).toBe("x");
    await action("click", "Y");
    await action("type", "X", { text: "0" });
    expect((await state()).active).toBe("x");
    await action("click", "Y");
    await action("click", "Undo");
    expect((await state()).x).toBe("120");
    await action("fill", "X", { text: "190" });
    await action("fill", "Y", { text: "8" });
    await action("click", "Undo");
    await action("click", "Undo");
    expect((await state()).x).toBe("120");
    expect((await state()).y).toBe("7");
    await action("fill", "Notes", { text: "memo" });
    expect((await state()).active).toBe("notes");
    await action("fill", "Editable", { text: "draft" });
    expect((await state()).active).toBe("editable");
    await action("select", "Plan", { values: ["pro"] });
    expect((await state()).active).toBe("plan");
    await action("click", "Nested");
    expect((await state()).active).toBe("parent");
    expect(await inspect("document.body.dataset.parentClicked")).toBe("yes");
    await action("fill", "X", { text: "160" });
    await action("click", "Plain");
    expect((await state()).active).toBe("");
    await action("click", "Undo");
    expect((await state()).x).toBe("120");
    await action("fill", "Shadow", { text: "shadow draft" });
    expect(await inspect("document.body.getAttribute('data-deep-active')")).toBe("shadow-input");
    await action("fill", "Remove target on blur", { text: "remove" });
    await expect(action("click", "Victim")).rejects.toThrow();
    snapshot = await call("snapshot");
    expect(await inspect("document.body.dataset.victimClicked === undefined")).toBe(true);
    await expect(action("fill", "Replace on focus", { text: "wrong" })).rejects.toThrow();
    snapshot = await call("snapshot");
    expect(await inspect("document.querySelector('#replacement').value")).toBe("untouched");
    await expect(action("fill", "Disable on focus", { text: "wrong" })).rejects.toThrow();
    snapshot = await call("snapshot");
    expect(await inspect("document.querySelector('#disable').value")).toBe("original");
    await expect(action("fill", "Redirect on focus", { text: "wrong" })).rejects.toThrow();
    snapshot = await call("snapshot");
    expect(await inspect("document.querySelector('#redirect').value")).toBe("original");
    await expect(action("fill", "Replace document on focus", { text: "wrong" })).rejects.toThrow();
    snapshot = await call("snapshot");
    expect(await inspect("document.title")).toBe("Replaced");
    expect(frames).toBe(0);
  } finally {
    await mcp.close();
    admin.disconnect();
    await running.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}

it(
  "focuses DOM edits and clicks, commits blur drafts before undo, and rejects focus-time replacement",
  () => runFocusSmoke(),
  60_000,
);

it.each(["Enter", "Space"] as const)(
  "discrete activation %s activates one enabled native button",
  (key) => runFocusSmoke(key),
  60_000,
);
