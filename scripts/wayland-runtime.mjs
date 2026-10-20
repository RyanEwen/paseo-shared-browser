/** Stage bounded private Weston assets; the host's default browser needs none of them. */
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/** Executable modules, dependent libraries and notices required by this Weston build. */
export const REQUIRED_WAYLAND_FILES = [
  "bin/weston",
  "lib/libweston-16.so.0",
  "lib/libdisplay-info.so.4",
  "lib/weston/libexec_weston.so.0",
  "lib/weston/desktop-shell.so",
  "lib/libweston-16/headless-backend.so",
  "lib/libweston-16/gl-renderer.so",
  "libexec/weston-desktop-shell",
  "libexec/weston-keyboard",
  "licenses/WESTON-COPYING",
  "licenses/LIBDISPLAY-INFO-LICENSE",
];

/** Validate a private prepared package before copying it into an immutable runtime. */
export async function verifyWaylandPackage(directory) {
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Invalid private Wayland root");
  const root = await realpath(directory),
    manifestPath = join(root, "manifest.json");
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536)
    throw new Error("Invalid private Wayland manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.westonVersion !== "16.0.1" ||
    manifest.platform !== "linux" ||
    manifest.arch !== "x64" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 11 ||
    manifest.files.length > 128
  )
    throw new Error("Unsupported private Wayland package");
  const names = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      file.path.length > 256 ||
      !file.path
        .split("/")
        .every((part) => /^[A-Za-z0-9_+.-]+$/.test(part) && part !== "." && part !== "..") ||
      names.has(file.path)
    )
      throw new Error("Invalid Wayland asset path");
    names.add(file.path);
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 32 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid Wayland asset checksum");
    bytes += file.bytes;
    if (bytes > 64 * 1024 * 1024) throw new Error("Private Wayland package exceeds bounds");
    const path = join(root, file.path),
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== file.bytes ||
      !(await realpath(path)).startsWith(root + sep)
    )
      throw new Error("Invalid Wayland asset");
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== file.sha256
    )
      throw new Error("Wayland asset checksum changed");
  }
  if (REQUIRED_WAYLAND_FILES.some((name) => !names.has(name)))
    throw new Error("Private Wayland package is incomplete");
  return manifest;
}

/** Missing assets remain optional. An existing but corrupt package fails preparation explicitly. */
export async function stageWaylandRuntime({ pluginDataRoot, stagingRoot, platform, arch }) {
  if (platform !== "linux" || arch !== "x64") return false;
  const native = join(pluginDataRoot, "native-wayland");
  let pointer;
  try {
    pointer = (await readFile(join(native, "current"), "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!/^\.wayland-[a-f0-9-]{36}$/.test(pointer))
    throw new Error("Invalid private Wayland pointer");
  const source = join(native, pointer),
    manifest = await verifyWaylandPackage(source);
  const destination = join(stagingRoot, "wayland");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const output = join(destination, file.path);
    await mkdir(join(output, ".."), { recursive: true, mode: 0o700 });
    await cp(join(source, file.path), output);
  }
  await cp(join(source, "manifest.json"), join(destination, "manifest.json"));
  await verifyWaylandPackage(destination);
  return true;
}
