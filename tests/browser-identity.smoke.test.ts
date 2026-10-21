import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentBrowserRuntime } from "../server/agent-browser-runtime";
import { SessionManager } from "../server/browser";
import type { CdpSession } from "../server/cdp";
import { resolveBrowserRuntimeRoot } from "../server/runtime-path";
import type { JsonValue } from "../server/runtime-protocol";
import type { SupervisorClient } from "../server/supervisor-client";
import type { BrowserState } from "../shared/browser";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

interface PageIdentity {
  userAgent: string;
  platform: string;
  clientHints: { brands: { brand: string; version: string }[]; mobile: boolean; platform: string };
  webdriver: boolean;
  scriptExecuted: boolean;
  cookie: string;
}

/** Observe only the disposable fixture's public browser identity and synthetic cookie. */
async function inspectIdentity(runtime: AgentBrowserRuntime): Promise<PageIdentity> {
  const page = (runtime as unknown as { page: CdpSession }).page;
  const reply = await page.send<{ result: { value: PageIdentity } }>("Runtime.evaluate", {
    expression: `({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      clientHints: navigator.userAgentData.toJSON(),
      webdriver: navigator.webdriver,
      scriptExecuted: document.documentElement.dataset.scriptExecuted === "true",
      cookie: document.cookie
    })`,
    returnByValue: true,
  });
  return reply.result.value;
}

/** Keep policy mutations bound to the last observed session and viewport. */
function expected(state: BrowserState) {
  return {
    sessionId: state.sessionId,
    navigationGeneration: state.navigationGeneration,
    viewportGeneration: state.viewportGeneration,
  };
}

it("retains native desktop identity and client hints through device switches and reconnect", async () => {
  const requests = new Map<string, IncomingHttpHeaders>();
  const fixture = createServer((request, response) => {
    requests.set(request.url ?? "/", request.headers);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/native") {
      response.setHeader(
        "Set-Cookie",
        "identity-fixture=retained; Path=/; Max-Age=3600; SameSite=Lax",
      );
    }
    response.end(
      '<!doctype html><title>Identity fixture</title><script>document.documentElement.dataset.scriptExecuted="true"</script>',
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  try {
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const preparedHome = process.env.PASEO_HOME;
    if (!preparedHome) throw new Error("Identity smoke requires an explicit isolated PASEO_HOME");
    // CI prepares this isolated home; resolve its binaries before the helper creates a fresh profile.
    const runtimeRoot = resolveBrowserRuntimeRoot(preparedHome);
    vi.stubEnv(
      "PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY",
      process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ??
        join(
          runtimeRoot,
          "node_modules",
          ".bin",
          process.platform === "win32" ? "agent-browser.exe" : "agent-browser",
        ),
    );
    vi.stubEnv(
      "PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE",
      process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ??
        join(runtimeRoot, "chromium", process.platform === "win32" ? "chrome.exe" : "chrome"),
    );
    await withIsolatedBrowser(async (owner, owned) => {
      const runtime = owned.runtime;
      await runtime.navigate(`${origin}/native`);
      const native = await inspectIdentity(runtime);
      expect(native.clientHints.brands.length).toBeGreaterThan(0);
      expect(native.webdriver).toBe(true);
      expect(native.scriptExecuted).toBe(true);
      expect(native.cookie).toBe("identity-fixture=retained");

      // Replace only the supervisor transport; policy, owner and Chromium remain real.
      const client = {
        connect: async () => ({
          bridgeId: "identity-fixture",
          epoch: 1,
          expiresAt: 60_000,
          heartbeatIntervalMs: 10_000,
        }),
        ensureWorkspace: async () => ({ runtimeId: owned.runtimeId, createdAt: 1 }),
        requestWorkspace: async (_workspaceId: string, operation: string, input: JsonValue) =>
          owner.request(owned, operation, input),
        disconnect: () => {},
      };
      const manager = new SessionManager({
        client: client as unknown as SupervisorClient,
        validateWorkspace: async () => true,
      });
      /** Assert browser-reported identity and network headers agree with the original native tab. */
      const expectNative = async (path: string) => {
        await runtime.navigate(`${origin}/${path}`);
        expect(await inspectIdentity(runtime)).toEqual(native);
        const headers = requests.get(`/${path}`);
        expect(headers?.["user-agent"]).toBe(native.userAgent);
        expect(headers?.["sec-ch-ua"]).toBe(requests.get("/native")?.["sec-ch-ua"]);
        expect(headers?.["sec-ch-ua-platform"]).toBe(JSON.stringify(native.clientHints.platform));
        expect(headers?.cookie).toBe("identity-fixture=retained");
      };
      try {
        await manager.connect();
        const viewer = await manager.attach("identity-workspace", "Synthetic viewer");
        const control = await manager.acquireControl(viewer.viewerToken);
        let state = control.state;
        await expectNative("attached");

        for (const presetId of ["desktop-chrome", "desktop-1920x1200"] as const) {
          const mobile = await manager.applyDevicePreset({
            viewerToken: viewer.viewerToken,
            controlToken: control.controlToken,
            expected: expected(state),
            presetId: "pixel-7",
          });
          await runtime.navigate(`${origin}/mobile`);
          const emulated = await inspectIdentity(runtime);
          expect(emulated.userAgent).toContain("Pixel 7");
          expect(emulated.platform).toBe("Linux armv81");
          expect(emulated.webdriver).toBe(native.webdriver);

          const desktop = await manager.applyDevicePreset({
            viewerToken: viewer.viewerToken,
            controlToken: control.controlToken,
            expected: expected(mobile.state),
            presetId,
          });
          state = desktop.state;
          expect(state.userAgent).toBe(native.userAgent);
          await expectNative(presetId);
        }

        const resized = await manager.resize({
          viewerToken: viewer.viewerToken,
          controlToken: control.controlToken,
          expected: expected(state),
          viewport: { width: 1440, height: 900 },
          preserveEmulation: true,
        });
        expect(resized.state.userAgent).toBe(native.userAgent);
        await expectNative("resized");

        const mobile = await manager.applyDevicePreset({
          viewerToken: viewer.viewerToken,
          controlToken: control.controlToken,
          expected: expected(resized.state),
          presetId: "pixel-7",
        });
        await manager.resize({
          viewerToken: viewer.viewerToken,
          controlToken: control.controlToken,
          expected: expected(mobile.state),
          viewport: { width: 1280, height: 800 },
        });
        await expectNative("custom-desktop");
        await runtime.reconnect();
        await expectNative("reconnected");
      } finally {
        manager.disconnect();
      }
    });
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
