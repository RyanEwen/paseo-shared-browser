import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentBrowserRuntime } from "../server/agent-browser-runtime";
import { resolveBrowserRuntimeRoot } from "../server/runtime-path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Real Chromium regression for pointer acknowledgements after opening another page.
 * The old shared native window could hold mouseMoved for ~5 s on its hidden tab.
 * Independent inactive windows and renderer focus emulation must retain prompt input
 * without activating another participant's target.
 */
it.skipIf(process.platform !== "linux")(
  "acknowledges pointer input after opening another independent window",
  async () => {
    const runtimeRoot = resolveBrowserRuntimeRoot(
      process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
    );
    const binaryPath =
      process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ??
      join(runtimeRoot, "node_modules", ".bin", "agent-browser");
    const executablePath =
      process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ??
      join(runtimeRoot, "chromium", "chrome");
    const root = await mkdtemp(join(tmpdir(), "sbb-"));
    roots.push(root);
    const runtime = new AgentBrowserRuntime({
      binaryPath,
      executablePath,
      profilePath: join(root, "profile"),
      ipcDirectory: join(root, "ipc"),
      session: "background-tab",
      initialUrl: "about:blank",
    });
    try {
      await runtime.launch();
      await runtime.emulate({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
      });
      const evaluate = (expression: string) =>
        (
          runtime as unknown as {
            page: {
              send(method: string, params: object): Promise<{ result: { value: string } }>;
            };
          }
        ).page.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });
      // Opening another independent window must leave this attachment usable.
      await runtime.createTarget("about:blank");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await evaluate("document.visibilityState")).result.value).toBe("visible");

      const started = Date.now();
      await runtime.mouseMove(20, 30);
      await runtime.mouseDown(20, 30, "left", 1);
      await runtime.mouseUp(20, 30, "left", 1);
      // Unmitigated, the first move alone takes ~5000 ms.
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await runtime.shutdown();
    }
  },
  60_000,
);
