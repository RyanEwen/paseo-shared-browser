import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readRuntimeWaylandAssets, WAYLAND_REQUIRED_FILES } from "./wayland-assets";

/** Only checksums are exercised; no fixture binary is executed. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "wayland-assets-test-"));
  const root = join(home, "plugin-data/shared-browser/runtime/wayland");
  const files = WAYLAND_REQUIRED_FILES.map((path) => ({
    path,
    bytes: 7,
    sha256: createHash("sha256").update("fixture").digest("hex"),
  }));
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), "fixture");
  }
  const manifest = { version: 1, westonVersion: "16.0.1", platform: "linux", arch: "x64", files };
  const save = () => writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await save();
  return { home, root, manifest, save, close: () => rm(home, { recursive: true, force: true }) };
}

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "accepts complete assets and refuses corruption or an unlisted loader dependency",
  async () => {
    const f = await fixture();
    try {
      expect(await readRuntimeWaylandAssets(f.home)).toBe(f.root);
      const extra = join(f.root, "lib/libinput.so.10");
      await writeFile(extra, "unlisted");
      expect(await readRuntimeWaylandAssets(f.home)).toBeNull();
      await rm(extra);
      await writeFile(join(f.root, "bin/weston"), "changed");
      expect(await readRuntimeWaylandAssets(f.home)).toBeNull();
    } finally {
      await f.close();
    }
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "refuses escape paths, duplicate entries and substituted native symlinks",
  async () => {
    const f = await fixture();
    try {
      f.manifest.files[0]!.path = "../escape" as never;
      await f.save();
      expect(await readRuntimeWaylandAssets(f.home)).toBeNull();
      f.manifest.files[0]!.path = "bin/weston";
      f.manifest.files.push(f.manifest.files[0]!);
      await f.save();
      expect(await readRuntimeWaylandAssets(f.home)).toBeNull();
      f.manifest.files.pop();
      await f.save();
      await rm(join(f.root, "bin/weston"));
      await symlink(join(f.root, "lib/libdisplay-info.so.4"), join(f.root, "bin/weston"));
      expect(await readRuntimeWaylandAssets(f.home)).toBeNull();
    } finally {
      await f.close();
    }
  },
);
