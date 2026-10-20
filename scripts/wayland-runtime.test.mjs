import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { REQUIRED_WAYLAND_FILES, stageWaylandRuntime } from "./wayland-runtime.mjs";

test("stages only an intact prepared package; absence stays optional and corruption fails explicitly", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "wayland-stage-test-"));
  const data = join(temporary, "data"),
    staging = join(temporary, "runtime");
  const options = { pluginDataRoot: data, stagingRoot: staging, platform: "linux", arch: "x64" };
  try {
    assert.equal(await stageWaylandRuntime(options), false);
    const name = `.wayland-${randomUUID()}`,
      source = join(data, "native-wayland", name);
    const files = REQUIRED_WAYLAND_FILES.map((path) => ({
      path,
      bytes: 7,
      sha256: createHash("sha256").update("fixture").digest("hex"),
    }));
    for (const file of files) {
      await mkdir(dirname(join(source, file.path)), { recursive: true });
      await writeFile(join(source, file.path), "fixture");
    }
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({
        version: 1,
        westonVersion: "16.0.1",
        platform: "linux",
        arch: "x64",
        files,
      }),
    );
    await writeFile(join(data, "native-wayland/current"), name);
    assert.equal(await stageWaylandRuntime(options), true);
    assert.equal(await readFile(join(staging, "wayland/bin/weston"), "utf8"), "fixture");
    await writeFile(join(source, "bin/weston"), "changed");
    await assert.rejects(stageWaylandRuntime(options), /checksum changed/);
    assert.equal(await stageWaylandRuntime({ ...options, platform: "win32" }), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
