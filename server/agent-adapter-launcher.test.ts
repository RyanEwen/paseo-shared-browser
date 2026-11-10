import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ensureAgentAdapterLauncher, resolveAgentAdapterPath } from "./agent-adapter-launcher";
import { formatSupervisorEndpoint } from "./runtime-protocol";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A Paseo home with one runtime whose adapter prints the runtime directory it was loaded from. */
async function homeWithRuntime(runtimeId: string) {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-launcher-"));
  roots.push(home);
  const dataRoot = join(home, "plugin-data", "shared-browser");
  await installRuntime(dataRoot, runtimeId);
  return { home, dataRoot };
}

async function installRuntime(dataRoot: string, runtimeId: string) {
  const directory = `.runtime-${runtimeId}`;
  await mkdir(join(dataRoot, directory), { recursive: true });
  await writeFile(
    join(dataRoot, directory, "shared-browser-mcp.cjs"),
    "process.stdout.write(require('node:path').basename(__dirname));",
  );
  await writeFile(join(dataRoot, "runtime-current"), `${directory}\n`);
}

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

it("loads the adapter of whichever runtime is current when the agent starts", async () => {
  const { home, dataRoot } = await homeWithRuntime(FIRST);
  const launcher = await ensureAgentAdapterLauncher(home);
  expect(launcher).toBe(join(dataRoot, "shared-browser-mcp.cjs"));
  expect((await run(process.execPath, [launcher])).stdout).toBe(`.runtime-${FIRST}`);

  // A runtime replacement only moves the pointer; the saved launcher path keeps working.
  await installRuntime(dataRoot, SECOND);
  expect((await run(process.execPath, [launcher])).stdout).toBe(`.runtime-${SECOND}`);
});

it("refuses an invalid runtime pointer instead of loading an arbitrary path", async () => {
  const { home, dataRoot } = await homeWithRuntime(FIRST);
  const launcher = await ensureAgentAdapterLauncher(home);
  await writeFile(join(dataRoot, "runtime-current"), "../../elsewhere\n");
  await expect(run(process.execPath, [launcher])).rejects.toMatchObject({
    stderr: expect.stringContaining("Shared Browser runtime pointer is invalid"),
  });
});

it("rewrites a modified launcher and leaves an identical one untouched", async () => {
  const { home } = await homeWithRuntime(FIRST);
  const launcher = await ensureAgentAdapterLauncher(home);
  const source = await readFile(launcher, "utf8");
  await writeFile(launcher, "tampered");
  await ensureAgentAdapterLauncher(home);
  expect(await readFile(launcher, "utf8")).toBe(source);
});

it("falls back to the current runtime adapter when the launcher cannot be written", async () => {
  const { home, dataRoot } = await homeWithRuntime(FIRST);
  const failed = Promise.reject(new Error("read-only plugin data"));
  const originalError = console.error;
  console.error = () => {};
  try {
    expect(await resolveAgentAdapterPath(home, failed)).toBe(
      join(dataRoot, `.runtime-${FIRST}`, "shared-browser-mcp.cjs"),
    );
  } finally {
    console.error = originalError;
  }
});

/** Publish an endpoint file the way a running supervisor does. */
async function publishEndpoint(dataRoot: string, adapter: string) {
  await mkdir(join(dataRoot, "supervisor-v2"), { recursive: true });
  await writeFile(
    join(dataRoot, "supervisor-v2", "runtime.json"),
    formatSupervisorEndpoint("/unused.sock", adapter),
  );
}

it("prefers the running supervisor's adapter over a newer install's pointer", async () => {
  const { home, dataRoot } = await homeWithRuntime(FIRST);
  await publishEndpoint(dataRoot, join(dataRoot, `.runtime-${FIRST}`, "shared-browser-mcp.cjs"));
  // A later install moved the pointer, but its supervisor has not replaced the running one.
  await installRuntime(dataRoot, SECOND);
  const launcher = await ensureAgentAdapterLauncher(home);
  expect((await run(process.execPath, [launcher])).stdout).toBe(`.runtime-${FIRST}`);
});

it("ignores a published adapter outside this plugin's runtime directories", async () => {
  const { home, dataRoot } = await homeWithRuntime(FIRST);
  const elsewhere = await mkdtemp(join(tmpdir(), "shared-browser-elsewhere-"));
  roots.push(elsewhere);
  const foreign = join(elsewhere, `.runtime-${SECOND}`, "shared-browser-mcp.cjs");
  await mkdir(join(elsewhere, `.runtime-${SECOND}`), { recursive: true });
  await writeFile(foreign, "process.stdout.write('foreign');");
  await publishEndpoint(dataRoot, foreign);
  const launcher = await ensureAgentAdapterLauncher(home);
  expect((await run(process.execPath, [launcher])).stdout).toBe(`.runtime-${FIRST}`);
});

it("ignores the adapter published by a supervisor that is no longer running", async () => {
  const { home, dataRoot } = await homeWithRuntime(FIRST);
  await mkdir(join(dataRoot, "supervisor-v2"), { recursive: true });
  // A pid that cannot exist: the endpoint was left behind by a crashed supervisor.
  await writeFile(
    join(dataRoot, "supervisor-v2", "runtime.json"),
    formatSupervisorEndpoint(
      "/unused.sock",
      join(dataRoot, `.runtime-${FIRST}`, "shared-browser-mcp.cjs"),
      2_147_483_646,
    ),
  );
  await installRuntime(dataRoot, SECOND);
  const launcher = await ensureAgentAdapterLauncher(home);
  expect((await run(process.execPath, [launcher])).stdout).toBe(`.runtime-${SECOND}`);
});

it("matches the running supervisor's adapter through a symlinked Paseo home", async () => {
  const { dataRoot } = await homeWithRuntime(FIRST);
  const linkParent = await mkdtemp(join(tmpdir(), "shared-browser-link-"));
  roots.push(linkParent);
  const linkedHome = join(linkParent, "home");
  await symlink(join(dataRoot, "..", ".."), linkedHome);
  const linkedData = join(linkedHome, "plugin-data", "shared-browser");
  await publishEndpoint(dataRoot, join(linkedData, `.runtime-${FIRST}`, "shared-browser-mcp.cjs"));
  await installRuntime(dataRoot, SECOND);
  const launcher = await ensureAgentAdapterLauncher(linkedHome);
  expect((await run(process.execPath, [launcher])).stdout).toBe(`.runtime-${FIRST}`);
});
