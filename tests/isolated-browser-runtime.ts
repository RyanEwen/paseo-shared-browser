import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { BrowserGraphicsMode } from "../server/browser-graphics";
import { createRuntimeOwner } from "../server/runtime-owner";

type Owner = Awaited<ReturnType<typeof createRuntimeOwner>>;
type Runtime = Awaited<ReturnType<Owner["create"]>>;

/** Run a native smoke with explicit binaries, a private display, and a disposable home/profile. */
export async function withIsolatedBrowser(
  run: (owner: Owner, runtime: Runtime) => Promise<void>,
  graphicsMode?: BrowserGraphicsMode,
): Promise<void> {
  if (
    !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE
  ) {
    throw new Error("Browser smoke requires explicit agent-browser and Chromium binary paths");
  }
  const home = await mkdtemp(join(tmpdir(), "shared-browser-smoke-"));
  vi.stubEnv("PASEO_HOME", home);
  let owner: Owner | null = null;
  let runtime: Runtime | null = null;
  try {
    if (graphicsMode) {
      const root = join(home, "plugin-data", "shared-browser");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "graphics.json"), JSON.stringify({ mode: graphicsMode }));
      // Verify the deployed file path independently of the shell environment.
      vi.stubEnv("PASEO_SHARED_BROWSER_GRAPHICS", undefined);
    }
    owner = await createRuntimeOwner({ initialUrl: "about:blank" });
    runtime = await owner.create("isolated-browser-smoke");
    await run(owner, runtime);
  } finally {
    try {
      if (owner && runtime) await owner.stop(runtime);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
