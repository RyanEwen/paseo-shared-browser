/** Encoded video remains opt-in while the shared extension also owns invisible native windows. */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";

// The owned CLI is simulated at the process boundary, as in daemon-shutdown.test.ts: a
// POSIX-shebang script is not executable on Windows, so no executable file is required.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, result: { stdout: string }) => void,
  ) => callback(null, { stdout: "0.38.2\n" }),
}));

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(nativeVideo?: boolean, headed = false) {
  const directory = await mkdtemp(join(tmpdir(), "shared-browser-video-opt-in-"));
  temporary.push(directory);
  const binary = join(directory, "owned-cli");
  const ipcDirectory = join(directory, "ipc");
  const runtime = new AgentBrowserRuntime({
    binaryPath: binary,
    executablePath: join(directory, "unlaunched-chromium"),
    profilePath: join(directory, "profile"),
    ipcDirectory,
    session: "video-opt-in",
    headed,
    ...(nativeVideo === undefined ? {} : { nativeVideo }),
  });
  const internal = runtime as unknown as {
    invoke(args: string[]): Promise<unknown>;
    video: unknown;
  };
  const launches: string[][] = [];
  internal.invoke = async (args) => {
    launches.push(args);
    throw new Error("Owned fixture stops before a browser exists");
  };
  return { runtime, internal, launches, ipcDirectory };
}

describe("encoded video opt-in", () => {
  it("refuses foreground windows on an unowned real display before launching a process", async () => {
    const f = await fixture(false, true);
    await expect(f.runtime.launch()).rejects.toThrow("owned private display");
    expect(f.launches).toHaveLength(0);
  });
  it("loads window management for image-only sessions without enabling video or 2x rasterization", async () => {
    for (const option of [undefined, false]) {
      const f = await fixture(option);
      await expect(f.runtime.launch()).rejects.toThrow("stops before a browser");
      const [args] = f.launches;
      expect(args).toContain("--extension");
      expect(args?.join(" ")).toContain("allowlisted-extension-id");
      expect(args?.join(" ")).not.toContain("force-device-scale-factor");
      expect(await readdir(f.ipcDirectory)).toHaveLength(1);
      expect(f.internal.video).toBeNull();
    }
  });

  it("retains video's 2x raster policy only when video capability is enabled", async () => {
    const f = await fixture(true);
    await expect(f.runtime.launch()).rejects.toThrow("stops before a browser");
    const [args] = f.launches;
    expect(args).toContain("--extension");
    expect(args?.join(" ")).toContain("--allowlisted-extension-id=");
    expect(args?.join(" ")).toContain("--force-device-scale-factor=2");
  });

  it("reports a typed disabled reply without creating any capture source", async () => {
    const f = await fixture();
    const reply = await f.runtime.readVideo({ quality: "high" });
    expect(reply).toMatchObject({
      status: "unsupported",
      reasonCode: "video-disabled",
      streamId: null,
      packets: [],
    });
    expect(f.internal.video).toBeNull();
  });
});
