import { mkdtemp, rm } from "node:fs/promises";
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
import type { BrowserState, BrowserTab } from "../shared/browser";
import { isPrintPreviewUrl } from "../shared/browser-page";

/** Real Chromium policy routes and shipped stdio close tool, without touching a user's browser. */
it.each(["human", "agent"] as const)(
  "closes the final tab via %s, keeps other workspaces and reopens saved data",
  async (actor) => {
    if (
      !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
      !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ||
      !process.env.PASEO_HOST
    )
      throw new Error("Close smoke requires explicit isolated native binaries and host");
    const web = createServer((_req, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><title>Close lifecycle</title><input value="initial"><script>localStorage.setItem('saved','retained');</script>`,
      );
    });
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    const address = web.address();
    if (!address || typeof address === "string") throw new Error("Fixture has no port");
    const home = await mkdtemp(join(tmpdir(), "shared-browser-close-"));
    vi.stubEnv("PASEO_HOME", home);
    if (actor === "human") await createRuntimeGraphicsSettings(home).update("private-desktop");
    const owner = await createRuntimeOwner({
      initialUrl: `http://127.0.0.1:${address.port}/`,
      nativeVideo: false,
      virtualDisplay: false,
      ...(process.env.PASEO_SHARED_BROWSER_TEST_XVFB
        ? { virtualDisplayExecutablePath: process.env.PASEO_SHARED_BROWSER_TEST_XVFB }
        : {}),
    });
    const pages = new Map<string, CdpSession>();
    const stopped: string[] = [];
    const running = await startSupervisorServer(
      {
        ...owner,
        create: async (workspaceId) => {
          const runtime = await owner.create(workspaceId);
          pages.set(workspaceId, (runtime.runtime as unknown as { page: CdpSession }).page);
          return runtime;
        },
        stop: async (runtime) => {
          stopped.push(runtime.runtimeId);
          await owner.stop(runtime);
        },
      },
      resolveSupervisorPaths(home),
    );
    const supervisor = running.supervisor;
    const bridge = supervisor.claimBridge("close-smoke");
    const heartbeat = setInterval(() => supervisor.heartbeat(bridge.bridgeId, bridge.epoch), 5_000);
    heartbeat.unref();
    let id = 0;
    const dispatch = <T>(method: string, input: object) =>
      supervisor.dispatch({
        version: RUNTIME_PROTOCOL_VERSION,
        id: String(++id),
        method,
        ...input,
      } as never) as Promise<T>;
    const human = <T>(operation: string, input: object) =>
      dispatch<T>("browser.request", {
        bridgeId: bridge.bridgeId,
        epoch: bridge.epoch,
        operation,
        input,
      });
    type Viewer = { viewerToken: string; state: BrowserState };
    type Control = { controlToken: string; state: BrowserState };
    const attach = (workspaceId: string, viewerLabel: string, tabId?: string) =>
      human<Viewer>("attach", { workspaceId, viewerLabel, ...(tabId ? { tabId } : {}) });
    const acquire = (viewerToken: string) => human<Control>("acquire-control", { viewerToken });
    const input = (viewer: Viewer, controlToken: string, scope: "tab" | "last-tab") => ({
      viewerToken: viewer.viewerToken,
      controlToken,
      tabId: viewer.state.tabId!,
      sessionId: viewer.state.sessionId,
      runtimeId: viewer.state.runtimeId!,
      scope,
    });
    const mcp = new Client({ name: "close-lifecycle", version: "1.0.0" });
    const tool = async <T>(name: string, args = {}, allowError = false) => {
      const result = await mcp.callTool({ name: `shared_browser_${name}`, arguments: args });
      if (allowError) return result as T;
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
    };
    const evaluate = async (workspaceId: string, expression: string) => {
      const result = await pages
        .get(workspaceId)!
        .send<{ result: { value: unknown } }>("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });
      return result.result.value;
    };
    try {
      const first = await attach("closing-workspace", "Human controller");
      const observer = await attach("closing-workspace", "Second viewer");
      const other = await attach("retained-workspace", "Unrelated viewer");
      const control = await acquire(first.viewerToken);
      await evaluate(
        "closing-workspace",
        "document.querySelector('input').value='unsaved draft';document.cookie='saved=retained;max-age=3600';localStorage.setItem('persist-once','retained')",
      );
      await evaluate(
        "retained-workspace",
        "document.querySelector('input').value='keep other workspace'",
      );
      const originalId = first.state.tabId!;

      // A fresh target between dialog and confirmation must leave both pages intact.
      const extra = await human<{ tabId: string }>("tabs.create", {
        viewerToken: first.viewerToken,
      });
      await expect(
        human("tabs.close", input(first, control.controlToken, "last-tab")),
      ).rejects.toThrow("Browser tabs changed");
      expect(stopped).toEqual([]);
      const extraViewer = await attach("closing-workspace", "Extra page", extra.tabId);
      const extraController = await attach("closing-workspace", "Extra controller", extra.tabId);
      await acquire(extraController.viewerToken);
      await expect(
        human("tabs.close", {
          viewerToken: extraViewer.viewerToken,
          tabId: extra.tabId,
          sessionId: extraViewer.state.sessionId,
          runtimeId: extraViewer.state.runtimeId!,
          scope: "tab",
        }),
      ).resolves.toMatchObject({ browserClosed: false });
      expect(
        (await human<{ state: BrowserState }>("status", { viewerToken: first.viewerToken })).state
          .controller,
      ).toBe("self");
      expect(
        (await human<{ state: BrowserState }>("status", { viewerToken: observer.viewerToken }))
          .state.tabId,
      ).toBe(originalId);
      expect(await evaluate("closing-workspace", "document.querySelector('input').value")).toBe(
        "unsaved draft",
      );
      expect(stopped).toEqual([]);

      if (actor === "human") {
        const current = await human<{ state: BrowserState }>("status", {
          viewerToken: first.viewerToken,
        });
        try {
          await human("print", {
            viewerToken: first.viewerToken,
            controlToken: control.controlToken,
            expected: current.state,
          });
        } catch (error) {
          expect(error).toMatchObject({ code: "UNKNOWN_OUTCOME" });
          expect(String(error)).toContain("Do not repeat the print action");
        }
        let preview: BrowserTab | undefined;
        await vi.waitFor(async () => {
          const result = await human<{ tabs: BrowserTab[] }>("tabs.list", {
            viewerToken: first.viewerToken,
          });
          preview = result.tabs.find((tab) => isPrintPreviewUrl(tab.url));
          expect(preview).toBeDefined();
        });
        await expect(
          human("tabs.close", input(first, control.controlToken, "tab")),
        ).rejects.toThrow("Close Print preview first");
        await expect(
          human("tabs.close", input(first, control.controlToken, "last-tab")),
        ).rejects.toThrow("Browser tabs changed");
        expect(
          (await human<{ state: BrowserState }>("status", { viewerToken: observer.viewerToken }))
            .state.tabId,
        ).toBe(originalId);
        const previewViewer = await attach("closing-workspace", "Preview viewer", preview!.id);
        const previewControl = await acquire(previewViewer.viewerToken);
        await human("tabs.close", input(previewViewer, previewControl.controlToken, "tab"));
        expect(
          (
            await human<{ tabs: BrowserTab[] }>("tabs.list", { viewerToken: first.viewerToken })
          ).tabs.map((tab) => tab.id),
        ).toEqual([originalId]);
        expect(await evaluate("closing-workspace", "document.querySelector('input').value")).toBe(
          "unsaved draft",
        );
        expect(stopped).toEqual([]);
      }

      if (actor === "agent") {
        await human("release-control", {
          viewerToken: first.viewerToken,
          controlToken: control.controlToken,
        });
        const ticket = `synthetic-close-ticket-${"x".repeat(40)}`;
        await dispatch("ticket.issue", { bridgeId: bridge.bridgeId, epoch: bridge.epoch, ticket });
        await dispatch("ticket.bind", {
          bridgeId: bridge.bridgeId,
          epoch: bridge.epoch,
          ticket,
          agentId: "close-agent",
          workspaceId: "closing-workspace",
        });
        const bundle = join(home, "mcp.cjs");
        await build({
          entryPoints: [fileURLToPath(new URL("../server/mcp-entry.ts", import.meta.url))],
          outfile: bundle,
          bundle: true,
          platform: "node",
          format: "cjs",
          logLevel: "silent",
        });
        await mcp.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [bundle],
            env: { PASEO_HOME: home, PASEO_SHARED_BROWSER_TICKET: ticket },
            stderr: "pipe",
          }),
        );
        // The shipped tool can close an observed page while a human owns its input lease.
        const agentExtra = await tool<{ tabId: string }>("tab_open");
        const humanExtra = await attach(
          "closing-workspace",
          "Human on agent page",
          agentExtra.tabId,
        );
        await acquire(humanExtra.viewerToken);
        await expect(tool("tab_close")).resolves.toMatchObject({
          state: { tabId: originalId, controller: "none" },
        });
        await expect(human("status", { viewerToken: humanExtra.viewerToken })).rejects.toThrow(
          "Browser tab is closed",
        );
        expect(
          (await tool<{ isError: boolean }>("tab_close", { scope: "last-tab" }, true)).isError,
        ).toBe(true);
        await tool("acquire_control");
        expect((await tool<{ isError: boolean }>("tab_close", {}, true)).isError).toBe(true);
        expect(stopped).toEqual([]);
        await expect(tool("tab_close", { scope: "last-tab" })).resolves.toMatchObject({
          closed: true,
          browserClosed: true,
        });
        expect((await tool<{ isError: boolean }>("status", {}, true)).isError).toBe(true);
      } else {
        await expect(
          human("tabs.close", input(first, control.controlToken, "last-tab")),
        ).resolves.toEqual({ closed: true, browserClosed: true });
      }
      expect(stopped).toEqual([first.state.runtimeId]);
      for (const viewer of [first, observer])
        await expect(human("status", { viewerToken: viewer.viewerToken })).rejects.toThrow(
          "Browser is closed",
        );
      await expect(attach("closing-workspace", "Background attach")).rejects.toThrow(
        "Browser is closed",
      );
      expect(
        (await human<{ state: BrowserState }>("status", { viewerToken: other.viewerToken })).state
          .runtimeId,
      ).toBe(other.state.runtimeId);
      expect(await evaluate("retained-workspace", "document.querySelector('input').value")).toBe(
        "keep other workspace",
      );

      await human("reopen", { workspaceId: "closing-workspace" });
      const reopened = await attach("closing-workspace", "Explicit reopen");
      expect(reopened.state.runtimeId).not.toBe(first.state.runtimeId);
      expect(
        await evaluate(
          "closing-workspace",
          "({draft:document.querySelector('input').value,saved:localStorage.getItem('persist-once'),cookie:document.cookie})",
        ),
      ).toEqual({ draft: "initial", saved: "retained", cookie: "saved=retained" });
      expect(
        (await human<{ tabs: BrowserTab[] }>("tabs.list", { viewerToken: reopened.viewerToken }))
          .tabs,
      ).toHaveLength(1);
      console.log(
        `close-smoke: ${actor} final close stopped exactly one workspace; both observers closed, other draft preserved; explicit reopen retained saved site data`,
      );
    } finally {
      clearInterval(heartbeat);
      await mcp.close();
      await running.close();
      web.close();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  60_000,
);
