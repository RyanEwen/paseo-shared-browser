/** Verify clean pinned source exports without accidentally resolving a surrounding Git repository. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snapshots = [
  {
    repo: "Themaister/pyrowave",
    commit: "21f099d24df0ab0e4c10c3288c924b6b1717e581",
    sha256: "b90fa45d97566ed7e74df9cd1d4d7fb98c47d1b12d9c73edefc07469c59277c3",
    prefix: "",
  },
  {
    repo: "Themaister/Granite",
    commit: "53090429539bf3404250d18fe58db971f0907c04",
    sha256: "51765130fa3a476e1a7c82d1656d9d5f58a53a2e7642483df9b09d0d7dd8d7a8",
    prefix: "Granite",
  },
  {
    repo: "zeux/volk",
    commit: "47cddf7ed97b94118a08aacb548a411188e016cc",
    sha256: "ed771f9132ea077af0abc74d29f415a81f181f83c3ac5e0f67b2f2149976fe2d",
    prefix: "Granite/third_party/volk",
  },
  {
    repo: "KhronosGroup/Vulkan-Headers",
    commit: "6802bb4733b63ed5efd3adb308a6c885ef180ea1",
    sha256: "9044fbb356160e43201dc2094acb44c8a906722a63a35f48fc0f051579db9bb6",
    prefix: "Granite/third_party/khronos/vulkan-headers",
  },
];

/** Stream each public pinned archive into a bounded buffer, and verify before extraction. */
async function archive(snapshot, cache) {
  const path = join(cache, `${snapshot.commit}.tar.gz`);
  try {
    const info = await lstat(path);
    if (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.size <= 64 * 1024 * 1024 &&
      hash(await readFile(path)) === snapshot.sha256
    )
      return path;
  } catch {
    /* Download a missing or invalid cache entry. */
  }
  const response = await fetch(
    `https://codeload.github.com/${snapshot.repo}/tar.gz/${snapshot.commit}`,
  );
  if (!response.ok || !response.body) throw new Error("Pinned source download failed");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 64 * 1024 * 1024) throw new Error("Pinned source archive exceeds its bound");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== snapshot.sha256) throw new Error("Pinned source archive checksum changed");
  await writeFile(path, bytes, { mode: 0o600, flush: true });
  return path;
}

/** Hash complete file/symlink inventories, excluding only Git's own bookkeeping. */
async function inventory(root, prefix, files, budget) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    if (++budget.entries > 100000) throw new Error("Source inventory exceeds its bound");
    const path = join(root, entry.name),
      relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventory(path, relative, files, budget);
    else if (entry.isSymbolicLink()) files.set(relative, `symlink:${await readlink(path)}`);
    else if (entry.isFile()) {
      const info = await lstat(path);
      if (info.size > 32 * 1024 * 1024) throw new Error("Source file exceeds its bound");
      files.set(relative, hash(await readFile(path)));
    } else throw new Error("Unexpected native source entry");
  }
}

/** Compare the supplied source, including exact dependency exports, with four verified
 * upstream archives. A tarball export has no .git; git -C alone could report this plugin's
 * unrelated parent commit and must never stand in for source provenance. */
export async function verifyPinnedNativeSource(source, nativeRoot) {
  const cache = join(nativeRoot, "source-archives");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(nativeRoot, ".source-verify-"));
  try {
    const expected = new Map();
    for (const [index, snapshot] of snapshots.entries()) {
      const path = await archive(snapshot, cache),
        directory = join(temporary, String(index));
      await mkdir(directory, { mode: 0o700 });
      await execFileAsync(
        "tar",
        [
          "-xzf",
          path,
          "-C",
          directory,
          "--strip-components=1",
          "--no-same-owner",
          "--no-same-permissions",
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      await inventory(directory, snapshot.prefix, expected, { entries: 0 });
    }
    const actual = new Map();
    await inventory(source, "", actual, { entries: 0 });
    if (actual.size !== expected.size) throw new Error("Native source file inventory changed");
    for (const [path, digest] of expected)
      if (actual.get(path) !== digest)
        throw new Error("Native source bytes differ from the pinned export");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
