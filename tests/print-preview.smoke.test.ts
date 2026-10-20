import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import type { CdpSession } from "../server/cdp";
import { createRuntimeGraphicsSettings } from "../server/runtime-graphics-settings";
import { createRuntimeOwner } from "../server/runtime-owner";
import { RUNTIME_PROTOCOL_VERSION } from "../server/runtime-protocol";
import { resolveSupervisorPaths, startSupervisorServer } from "../server/supervisor";
import {
  type BrowserFrame,
  type BrowserState,
  type BrowserTab,
  listBrowserTabsRpc,
  printBrowserRpc,
} from "../shared/browser";

/** Real private headed Chromium through policy routes, with no system dialogs or physical printing. */
it.each(["human", "agent"] as const)(
  "opens controlled %s print from a hidden source among eight tabs and preserves it",
  async (trigger) => {
    if (
      !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
      !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ||
      !process.env.PASEO_HOST
    )
      throw new Error(
        "Print smoke requires explicit isolated runtime binaries and host, plus Xvfb",
      );
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Print lifecycle fixture</title>
      <input aria-label="Unsaved draft" style="position:absolute;left:40px;top:20px" value="initial">
      <button style="position:absolute;left:40px;top:80px;width:160px;height:40px" onclick="print()">Print page</button><h1 style="margin-top:160px">Printable document</h1><script>
      addEventListener("beforeprint",()=>document.body.dataset.prints=String(Number(document.body.dataset.prints||0)+1));
      window.print=()=>{document.body.dataset.replacedPrint="yes"};
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Print fixture has no port");
    const home = await mkdtemp(join(tmpdir(), "shared-browser-print-"));
    vi.stubEnv("PASEO_HOME", home);
    await createRuntimeGraphicsSettings(home).update("private-desktop");
    const owner = await createRuntimeOwner({
      initialUrl: `http://127.0.0.1:${address.port}/`,
      nativeVideo: false,
    });
    let sourcePage: CdpSession | null = null;
    const running = await startSupervisorServer(
      {
        ...owner,
        create: async (workspaceId) => {
          const owned = await owner.create(workspaceId);
          sourcePage = (owned.runtime as unknown as { page: CdpSession }).page;
          return owned;
        },
        request: async (runtime, operation, input) => {
          try {
            return await owner.request(runtime, operation, input);
          } catch (error) {
            console.error("print-smoke: native failure", operation, String(error));
            throw error;
          }
        },
      },
      resolveSupervisorPaths(home),
    );
    const supervisor = running.supervisor;
    const bridge = supervisor.claimBridge("print-smoke");
    const ticket = `synthetic-print-ticket-${"x".repeat(40)}`;
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
      frame: BrowserFrame;
      result: { json: string };
      snapshotId: string;
      tabs: BrowserTab[];
      entries: {
        ref: string;
        name: string;
        role: string;
        options: { value: string; label: string }[];
      }[];
    };
    const mcp = new Client({ name: "print-smoke-client", version: "1.0.0" });
    /** Exercise the shipped stdio tools, retaining the policy operation names in the lifecycle. */
    const agent = async (
      operation: string,
      input: Record<string, unknown> = {},
    ): Promise<Reply> => {
      const names: Record<string, string> = {
        "acquire-control": "acquire_control",
        "release-control": "release_control",
        "dom.snapshot": "snapshot",
        "dom.evaluate": "evaluate",
        "tabs.list": "tabs",
        "tabs.select": "tab_select",
        capture: "capture",
        print: "print",
      };
      let name = names[operation];
      let args = input;
      if (operation === "dom.action") {
        const { kind, ...action } = input.action as Record<string, unknown>;
        name = String(kind);
        args = { snapshotId: input.snapshotId, ...action };
      }
      if (!name) throw new Error(`Unmapped smoke operation: ${operation}`);
      const reply = await mcp.callTool({ name: `shared_browser_${name}`, arguments: args });
      if (reply.isError) throw new Error(JSON.stringify(reply.content));
      const value = JSON.parse((reply.content as { text: string }[])[0]!.text);
      return operation === "capture" ? ({ state: value } as Reply) : value;
    };
    const human = <T>(operation: string, input: Record<string, unknown>) =>
      dispatch<T>("browser.request", {
        bridgeId: bridge.bridgeId,
        epoch: bridge.epoch,
        operation,
        input,
      });
    const tabs = () => agent("tabs.list");
    const bundle = join(home, "mcp.cjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../server/mcp-entry.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
    });
    try {
      await dispatch("ticket.issue", { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ticket });
      await dispatch("ticket.bind", {
        bridgeId: bridge.bridgeId,
        epoch: bridge.epoch,
        ticket,
        agentId: "print-agent",
        workspaceId: "print-workspace",
      });
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [bundle],
          env: { PASEO_HOME: home, PASEO_SHARED_BROWSER_TICKET: ticket },
          stderr: "pipe",
        }),
      );
      const initial = await agent("acquire-control");
      const originalId = initial.state.tabId!;
      expect(initial.state.graphics?.preference).toBe("private-desktop");
      expect(initial.state.canPrint).toBe(true);
      const source = await agent("dom.snapshot");
      await agent("dom.action", {
        snapshotId: source.snapshotId,
        action: {
          kind: "fill",
          ref: source.entries.find((entry) => entry.name === "Unsaved draft")!.ref,
          text: "retain my unsaved work",
        },
      });
      await agent("release-control");

      const originalViewer = await human<{ viewerToken: string }>("attach", {
        workspaceId: "print-workspace",
        viewerLabel: "Print tester",
        tabId: originalId,
      });
      // A transient preview must remain discoverable even with all eight page slots occupied.
      for (let index = 0; index < 7; index++)
        await human("tabs.create", { viewerToken: originalViewer.viewerToken });
      await agent("acquire-control");
      const hiddenSource = await agent("dom.snapshot");
      // Production focus emulation reports visible even for background tabs.
      // Temporarily remove only that override on the exact fixture source to
      // measure its native visibility, then restore the normal product setting.
      await sourcePage!.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      try {
        const visibility = await agent("dom.evaluate", {
          snapshotId: hiddenSource.snapshotId,
          expression: "document.visibilityState",
        });
        expect(visibility.result.json).toBe('"hidden"');
      } finally {
        await sourcePage!.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      }
      const originalTabs = (await tabs()).tabs.map((tab) => tab.id);
      console.log(`print-smoke: ${trigger} controlled print on hidden source`);
      if (trigger === "human") {
        await agent("release-control");
        const originalControl = await human<{ controlToken: string }>("acquire-control", {
          viewerToken: originalViewer.viewerToken,
        });
        const sourceFrame = await human<Reply>("capture", {
          viewerToken: originalViewer.viewerToken,
          quality: "medium",
        });
        try {
          await human(
            "print",
            printBrowserRpc.input.parse({
              viewerToken: originalViewer.viewerToken,
              controlToken: originalControl.controlToken,
              expected: sourceFrame.state,
            }),
          );
        } catch (error) {
          expect(error).toMatchObject({ code: "UNKNOWN_OUTCOME" });
          expect(String(error)).toContain("Do not repeat the print action");
        }
        await human("release-control", {
          viewerToken: originalViewer.viewerToken,
          controlToken: originalControl.controlToken,
        });
      } else {
        try {
          await agent("print");
        } catch (error) {
          expect(String(error)).toContain("Do not repeat the print action");
        }
      }
      let preview: BrowserTab | undefined;
      await vi.waitFor(
        async () => {
          preview = (await tabs()).tabs.find((tab) => tab.url === "chrome://print/");
          expect(preview).toBeDefined();
        },
        { timeout: 5000 },
      );
      expect(preview!.title).toMatch(/^Print preview/);
      const listed = await human<{ tabs: BrowserTab[] }>("tabs.list", {
        viewerToken: originalViewer.viewerToken,
      });
      expect(listBrowserTabsRpc.output.parse(listed).tabs).toHaveLength(9);
      await expect(
        human("tabs.create", { viewerToken: originalViewer.viewerToken }),
      ).rejects.toThrow("tab limit");
      expect((await tabs()).tabs.some((tab) => tab.id === originalId)).toBe(true);
      const previewViewer = await human<{ viewerToken: string; state: BrowserState }>("attach", {
        workspaceId: "print-workspace",
        viewerLabel: "Print tester",
        tabId: preview!.id,
      });
      expect(previewViewer.state.url).toBe("chrome://print/");
      const image = await human<Reply>("capture", {
        viewerToken: previewViewer.viewerToken,
        quality: "high",
      });
      expect(image.frame.byteLength).toBeGreaterThan(5000);
      if (process.env.PRINT_PREVIEW_ARTIFACT)
        await writeFile(
          process.env.PRINT_PREVIEW_ARTIFACT,
          Buffer.from(image.frame.dataBase64, "base64"),
        );

      console.log("print-smoke: select preview and change layout");
      await agent("tabs.select", { tabId: preview!.id });
      await agent("acquire-control");
      const settings = await agent("dom.snapshot");
      const layout = settings.entries.find((entry) =>
        entry.options.some((option) => option.label === "Landscape"),
      );
      expect(layout).toBeDefined();
      await agent("dom.action", {
        snapshotId: settings.snapshotId,
        action: {
          kind: "select",
          ref: layout!.ref,
          values: [layout!.options.find((option) => option.label === "Landscape")!.value],
        },
      });
      const current = await agent("dom.snapshot");
      const selectedLayout = await agent("dom.evaluate", {
        snapshotId: current.snapshotId,
        expression:
          "document.querySelector('print-preview-app').shadowRoot.querySelector('print-preview-sidebar').shadowRoot.querySelector('print-preview-layout-settings').shadowRoot.querySelector('select').value",
      });
      expect(selectedLayout.result.json).toBe('"landscape"');
      const cancel = current.entries.find(
        (entry) => entry.name === "Cancel" && entry.role === "button",
      );
      expect(cancel).toBeDefined();
      if (trigger === "human") {
        console.log("print-smoke: cancel preview");
        try {
          await agent("dom.action", {
            snapshotId: current.snapshotId,
            action: { kind: "click", ref: cancel!.ref },
          });
        } catch (error) {
          // Cancel may destroy its target before Runtime.evaluate can acknowledge.
          // Accept only that uncertain outcome and observe removal below, never replay.
          expect(String(error)).toContain("outcome is unknown");
        }
      } else {
        await agent("release-control");
        const closer = await human<{ controlToken: string }>("acquire-control", {
          viewerToken: previewViewer.viewerToken,
        });
        await human("tabs.close", {
          viewerToken: previewViewer.viewerToken,
          controlToken: closer.controlToken,
          tabId: preview!.id,
        });
      }
      await vi.waitFor(
        async () => expect((await tabs()).tabs.some((tab) => tab.id === preview!.id)).toBe(false),
        { timeout: 5000 },
      );
      console.log("print-smoke: explicitly return to source");
      await agent("tabs.select", { tabId: originalId });
      await agent("acquire-control");
      const restored = await agent("dom.snapshot");
      const draft = await agent("dom.evaluate", {
        snapshotId: restored.snapshotId,
        expression: "document.querySelector('input').value",
      });
      expect(draft.result.json).toBe('"retain my unsaved work"');
      expect((await agent("capture")).state.tabId).toBe(originalId);
      await human("detach", { viewerToken: previewViewer.viewerToken });

      const final = await agent("dom.snapshot");
      const retained = await agent("dom.evaluate", {
        snapshotId: final.snapshotId,
        expression:
          "({draft:document.querySelector('input').value,prints:document.body.dataset.prints,replaced:document.body.dataset.replacedPrint||null})",
      });
      expect(JSON.parse(retained.result.json)).toEqual({
        draft: "retain my unsaved work",
        prints: "1",
        replaced: null,
      });
      expect((await tabs()).tabs.map((tab) => tab.id)).toEqual(originalTabs);
    } catch (error) {
      console.error("print-smoke: operation failed", error);
      throw error;
    } finally {
      await mcp.close();
      await running.close();
      server.close();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
