/** Prepare a locally built Weston package without installing packages or changing a live browser. */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyWaylandPackage } from "./wayland-runtime.mjs";

/** Flatten only in-tree library symlinks, retain notices, and atomically publish a private pointer. */
export async function prepareWayland(source, nativeRoot) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Private Weston is qualified on Linux x64 only");
  source = await realpath(source);
  const { stdout } = await promisify(execFile)(join(source, "bin/weston"), ["--version"], {
    timeout: 5000,
    maxBuffer: 4096,
    env: {
      PATH: process.env.PATH,
      LD_LIBRARY_PATH: `${join(source, "lib")}:${join(source, "lib/weston")}`,
    },
  });
  if (stdout.trim() !== "weston 16.0.1") throw new Error("Expected Weston 16.0.1 built package");
  nativeRoot = resolve(nativeRoot);
  await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(nativeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Invalid private Wayland root");
  const name = `.wayland-${randomUUID()}`,
    target = join(nativeRoot, name),
    files = [];
  await mkdir(target, { mode: 0o700 });
  let entries = 0,
    total = 0;
  async function copy(relative) {
    if (++entries > 256) throw new Error("Wayland package entry bound exceeded");
    const input = join(source, relative),
      output = join(target, relative),
      info = await lstat(input);
    if (info.isDirectory()) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      for (const child of await readdir(input)) await copy(`${relative}/${child}`);
      return;
    }
    const canonical = await realpath(input),
      actual = await lstat(canonical);
    if (
      !canonical.startsWith(source + sep) ||
      !actual.isFile() ||
      actual.size < 1 ||
      actual.size > 32 * 1024 * 1024
    )
      throw new Error("Invalid built Wayland file");
    total += actual.size;
    if (total > 64 * 1024 * 1024) throw new Error("Wayland package byte bound exceeded");
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await cp(canonical, output);
    await chmod(output, actual.mode & 0o111 ? 0o700 : 0o600);
    files.push({
      path: relative,
      bytes: actual.size,
      sha256: createHash("sha256")
        .update(await readFile(output))
        .digest("hex"),
    });
  }
  const temporary = join(nativeRoot, `.current-${randomUUID()}`);
  try {
    for (const path of ["bin", "lib", "libexec", "share/weston", "licenses"]) await copy(path);
    const manifest = {
      version: 1,
      westonVersion: "16.0.1",
      platform: process.platform,
      arch: process.arch,
      files,
    };
    await writeFile(join(target, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await verifyWaylandPackage(target);
    await writeFile(temporary, name, { mode: 0o600, flag: "wx", flush: true });
    await rename(temporary, join(nativeRoot, "current"));
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, nativeRoot] = process.argv.slice(2);
  if (!source || !nativeRoot)
    throw new Error("Usage: prepare-wayland.mjs BUILT_PACKAGE PRIVATE_NATIVE_ROOT");
  await prepareWayland(source, nativeRoot);
  console.log("Prepared private Weston assets; existing browsers are unchanged");
}
