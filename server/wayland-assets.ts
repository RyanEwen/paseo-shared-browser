/** Verified private Weston assets live with the immutable browser runtime. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { resolveBrowserRuntimeRoot } from "./runtime-path";

export const WAYLAND_REQUIRED_FILES = [
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
] as const;

const manifestSchema = z.object({
  version: z.literal(1),
  westonVersion: z.literal("16.0.1"),
  platform: z.literal("linux"),
  arch: z.literal("x64"),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(256)
          .refine((path) =>
            path
              .split("/")
              .every((part) => /^[A-Za-z0-9_+.-]+$/.test(part) && part !== "." && part !== ".."),
          ),
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(WAYLAND_REQUIRED_FILES.length)
    .max(128),
});

/** Missing or corrupt optional assets are unavailable, never an executable fallback. */
export async function readRuntimeWaylandAssets(home: string): Promise<string | null> {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  try {
    const directory = join(resolveBrowserRuntimeRoot(home), "wayland");
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    const root = await realpath(directory);
    const manifestPath = join(root, "manifest.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 65536)
      return null;
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const names = new Set(manifest.files.map((file) => file.path));
    if (
      names.size !== manifest.files.length ||
      WAYLAND_REQUIRED_FILES.some((name) => !names.has(name))
    )
      return null;
    // An unlisted library could shadow a host dependency through the private loader path.
    let entries = 0;
    async function listedOnly(relative = ""): Promise<boolean> {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        if (++entries > 256 || entry.isSymbolicLink()) return false;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!(await listedOnly(path))) return false;
        } else if (!entry.isFile() || (path !== "manifest.json" && !names.has(path))) return false;
      }
      return true;
    }
    if (!(await listedOnly())) return null;
    let total = 0;
    for (const file of manifest.files) {
      const path = join(root, file.path),
        metadata = await lstat(path);
      total += file.bytes;
      if (
        total > 64 * 1024 * 1024 ||
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== file.bytes
      )
        return null;
      if (!(await realpath(path)).startsWith(root + sep)) return null;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      if (hash.digest("hex") !== file.sha256) return null;
    }
    return root;
  } catch {
    return null;
  }
}
