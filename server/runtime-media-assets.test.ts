import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readRuntimeMediaAssets } from "./runtime-media-assets";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "owned-media-assets-")),
    data = join(home, "plugin-data/shared-browser"),
    name = `.runtime-${randomUUID()}`,
    root = join(data, name);
  const files = [
    ["pyrowave/pyrowave-encoder", "fixture encoder"],
    ["pyrowave/libpyrowave-shared.so.1", "fixture native library"],
    ["browser-media-worker.cjs", "fixture worker"],
    [
      "node_modules/node-datachannel/package.json",
      '{"name":"node-datachannel","version":"0.33.4"}',
    ],
    ["node_modules/node-datachannel/dist/index.cjs", "fixture binding loader"],
    ["node_modules/detect-libc/index.js", "fixture libc resolver"],
    ["node_modules/@node-datachannel/test/node_datachannel.node", "fixture addon"],
  ].map(([path, text]) => ({
    path: path!,
    text: text!,
    bytes: Buffer.byteLength(text!),
    sha256: createHash("sha256").update(text!).digest("hex"),
  }));
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.text);
  }
  await writeFile(join(data, "runtime-current"), `${name}\n`);
  const manifest = {
    version: 1,
    qualified: true,
    platform: process.platform,
    arch: process.arch,
    encoder: "pyrowave/pyrowave-encoder",
    worker: "browser-media-worker.cjs",
    datachannelDirectory: "node_modules/node-datachannel",
    files: files.map(({ text: _text, ...file }) => file),
  };
  const save = () => writeFile(join(root, "media-assets.json"), JSON.stringify(manifest));
  await save();
  return { home, root, manifest, save, close: () => rm(home, { recursive: true, force: true }) };
}
it("accepts a complete qualified immutable asset set and derives private storage outside the runtime", async () => {
  const f = await fixture();
  try {
    const result = await readRuntimeMediaAssets(f.home);
    expect(result?.worker.workerPath).toBe(join(f.root, "browser-media-worker.cjs"));
    expect(result?.pyrowave.credentialDirectory).toBe(
      join(f.home, "plugin-data/shared-browser/.secrets/media"),
    );
  } finally {
    await f.close();
  }
});
it("refuses unlisted imported code and same-size native corruption without executing either", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "node_modules/node-datachannel/unlisted.cjs"), "never execute");
    expect(await readRuntimeMediaAssets(f.home)).toBeNull();
    await rm(join(f.root, "node_modules/node-datachannel/unlisted.cjs"));
    await writeFile(join(f.root, "pyrowave/pyrowave-encoder"), "changed encoder");
    expect(await readRuntimeMediaAssets(f.home)).toBeNull();
  } finally {
    await f.close();
  }
});
it("refuses path escapes, duplicate manifest paths and native-file symlinks", async () => {
  const f = await fixture();
  try {
    f.manifest.encoder = "../outside";
    await f.save();
    expect(await readRuntimeMediaAssets(f.home)).toBeNull();
    f.manifest.encoder = "pyrowave/pyrowave-encoder";
    f.manifest.files.push(f.manifest.files[0]!);
    await f.save();
    expect(await readRuntimeMediaAssets(f.home)).toBeNull();
    f.manifest.files.pop();
    await f.save();
    const path = join(f.root, "node_modules/node-datachannel/dist/index.cjs");
    await rm(path);
    await symlink(join(f.root, "pyrowave/pyrowave-encoder"), path);
    expect(await readRuntimeMediaAssets(f.home)).toBeNull();
  } finally {
    await f.close();
  }
});
