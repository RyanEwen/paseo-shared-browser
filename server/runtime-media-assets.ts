/** Optional media assets are qualified and immutable; absence never blocks compatible video. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import type { BrowserMediaWorkerAssets } from "./browser-media-worker-client";
import type { NativePyrowaveAssets } from "./native-pyrowave-cohort";
import { resolveBrowserRuntimeRoot } from "./runtime-path";

const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    value
      .split("/")
      .every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9_@+.-]+$/.test(part)),
  );
const manifestSchema = z.object({
  version: z.literal(1),
  qualified: z.literal(true),
  platform: z.string().max(16),
  arch: z.string().max(16),
  encoder: relativePath,
  worker: relativePath,
  datachannelDirectory: relativePath,
  files: z
    .array(
      z.object({
        path: relativePath,
        bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(4)
    .max(256),
});
export interface RuntimeMediaAssets {
  worker: BrowserMediaWorkerAssets;
  pyrowave: NativePyrowaveAssets;
}

/** Validate every declared file before exposing a native executable/module to a runtime.
 * Paths stay inside this immutable runtime, regular files reject symlink substitution,
 * and a bounded streaming hash avoids reading all native binaries into memory together.
 * Missing/invalid assets return unavailable; H.264/JPEG keep working unchanged. */
export async function readRuntimeMediaAssets(home: string): Promise<RuntimeMediaAssets | null> {
  try {
    const runtimePath = resolveBrowserRuntimeRoot(home);
    const rootInfo = await lstat(runtimePath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
    const root = await realpath(runtimePath),
      manifestPath = join(root, "media-assets.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 65536)
      return null;
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (!parsed.success) return null;
    const manifest = parsed.data;
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) return null;
    if (
      manifest.encoder !== "pyrowave/pyrowave-encoder" ||
      manifest.worker !== "browser-media-worker.cjs" ||
      manifest.datachannelDirectory !== "node_modules/node-datachannel"
    )
      return null;
    const expected = new Map(manifest.files.map((file) => [file.path, file]));
    if (
      expected.size !== manifest.files.length ||
      !expected.has(manifest.encoder) ||
      !expected.has(manifest.worker) ||
      !expected.has(`${manifest.datachannelDirectory}/package.json`)
    )
      return null;
    if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 128 * 1024 * 1024) return null;
    // A hashed package.json alone does not cover the JS/native files its loader
    // imports. Require complete bounded trees, including native dependencies.
    let entries = 0;
    const verifyTree = async (relative: string): Promise<boolean> => {
      const directory = join(root, ...relative.split("/"));
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 1024 || entry.isSymbolicLink()) return false;
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!(await verifyTree(path))) return false;
        } else if (!entry.isFile() || !expected.has(path)) return false;
      }
      return true;
    };
    for (const directory of [
      "pyrowave",
      "node_modules/node-datachannel",
      "node_modules/detect-libc",
      "node_modules/@node-datachannel",
    ]) {
      if (!(await verifyTree(directory))) return null;
    }
    for (const file of manifest.files) {
      const path = join(root, ...file.path.split("/")),
        resolved = await realpath(path),
        info = await lstat(path);
      if (
        !resolved.startsWith(root + sep) ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== file.bytes
      )
        return null;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      if (hash.digest("hex") !== file.sha256) return null;
    }
    const data = join(home, "plugin-data", "shared-browser");
    return {
      worker: {
        workerPath: join(root, manifest.worker),
        datachannelDirectory: join(root, manifest.datachannelDirectory),
      },
      pyrowave: {
        binaryPath: join(root, manifest.encoder),
        cacheDirectory: join(data, "media-cache"),
        credentialDirectory: join(data, ".secrets", "media"),
      },
    };
  } catch {
    return null;
  }
}
