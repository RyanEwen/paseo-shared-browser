/** Stage qualified optional media without making compatible browser startup depend on it. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveDependencyRoot } from "./dependency-root.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nativeName = /^\.pyrowave-[a-f0-9-]{36}$/;
const safePath = (value) =>
  typeof value === "string" &&
  value.length <= 512 &&
  value
    .split("/")
    .every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9_@+.-]+$/.test(part));

/** One exact raw frame verifies GPU initialization, hardware-only selection, encode and
 * packetization using the same environment and source envelope as the running helper. */
export async function qualifyPyrowaveEncoder(binary, cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const pixels = 128 * 128,
    raw = Buffer.alloc((pixels * 3) / 2, 128),
    header = Buffer.alloc(32);
  raw.fill(32, 0, pixels);
  for (const [offset, value] of [
    [0, 0x31525750],
    [4, raw.length],
    [8, 1],
    [12, 1],
    [16, 1000],
    [24, 1],
    [28, 1],
  ])
    header.writeUInt32LE(value, offset);
  const result = spawnSync(binary, ["128", "128", "100000000", "30"], {
    input: Buffer.concat([header, raw]),
    timeout: 10000,
    killSignal: "SIGKILL",
    maxBuffer: 3 * 1024 * 1024,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: homedir(), XDG_CACHE_HOME: cacheDirectory },
  });
  const bytes = result.stdout;
  if (
    result.error ||
    result.status !== 0 ||
    !Buffer.isBuffer(bytes) ||
    bytes.length < 48 ||
    bytes.readUInt32LE(0) !== 0x31455750 ||
    bytes.readUInt32LE(8) !== 1 ||
    bytes.readUInt32LE(12) !== 1 ||
    bytes.readUInt32LE(16) !== 1000 ||
    bytes.readUInt32LE(20) !== 0 ||
    bytes.readUInt32LE(24) !== 1 ||
    bytes.readUInt32LE(28) !== 1
  )
    throw new Error("Native PyroWave qualification failed");
  const encodedBytes = bytes.readUInt32LE(4),
    sequence = bytes.readUInt32LE(32),
    info = bytes.readUInt32LE(36);
  if (
    encodedBytes > 2 * 1024 * 1024 ||
    bytes.length !== encodedBytes + 32 ||
    !(sequence & 0x80000000) ||
    (sequence & 16383) + 1 !== 128 ||
    ((sequence >>> 14) & 16383) + 1 !== 128 ||
    ((info >>> 24) & 7) !== 0
  )
    throw new Error("Invalid native PyroWave qualification output");
  return { encodedBytes, blocks: info & 0xffffff };
}

/** Copy packages with their original notices, excluding incidental nested install caches. */
async function stagePackage(name, root, stagingRoot) {
  const destination = join(stagingRoot, "node_modules", name);
  await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
  await cp(root, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => path === root || basename(path) !== "node_modules",
  });
}

/** Produce a complete bounded file inventory; every imported JS/native file is covered. */
async function inventory(root, relative, files) {
  const path = join(root, relative),
    info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Media assets contain a symlink");
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await inventory(root, `${relative}/${entry}`, files);
  } else if (info.isFile()) {
    if (
      files.length >= 256 ||
      info.size <= 0 ||
      info.size > 32 * 1024 * 1024 ||
      !safePath(relative)
    )
      throw new Error("Media assets exceed their bounds");
    const bytes = await readFile(path);
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
  } else throw new Error("Unexpected media asset type");
}

/** Stage only a locally qualified native cache matching this exact helper source.
 * Missing/unsupported native assets leave normal video available and advertise no LAN codec. */
export async function stageMediaRuntime({
  projectRoot,
  pluginDataRoot,
  stagingRoot,
  platform,
  arch,
}) {
  try {
    if (platform !== "linux") return false;
    const nativeRoot = join(pluginDataRoot, "native-media"),
      pointer = (await readFile(join(nativeRoot, "pyrowave-current"), "utf8")).trim();
    if (!nativeName.test(pointer)) return false;
    const cache = join(nativeRoot, pointer),
      indexPath = join(cache, "index.json"),
      indexInfo = await lstat(indexPath);
    if (!indexInfo.isFile() || indexInfo.isSymbolicLink() || indexInfo.size > 65536) return false;
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    if (
      index.version !== 1 ||
      index.platform !== platform ||
      index.arch !== arch ||
      index.encoderSourceSha256 !==
        digest(await readFile(join(projectRoot, "scripts/native/pyrowave-encoder.cpp"))) ||
      !Array.isArray(index.files) ||
      index.files.length > 64
    )
      return false;
    if (new Set(index.files.map((file) => file.path)).size !== index.files.length) return false;
    let cacheBytes = 0;
    for (const file of index.files) {
      if (!safePath(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
      const path = join(cache, file.path),
        info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 32 * 1024 * 1024 ||
        digest(await readFile(path)) !== file.sha256
      )
        return false;
      cacheBytes += info.size;
      if (cacheBytes > 64 * 1024 * 1024) return false;
      const destination = join(stagingRoot, "pyrowave", file.path);
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      await cp(path, destination);
    }
    if (
      !index.files.some((file) => file.path === "pyrowave-encoder") ||
      !index.files.some((file) => file.path === "libpyrowave-shared.so.1")
    )
      return false;
    await qualifyPyrowaveEncoder(
      join(stagingRoot, "pyrowave/pyrowave-encoder"),
      join(pluginDataRoot, "media-cache"),
    );
    const bindingRoot = resolveDependencyRoot(
      "node-datachannel",
      join(projectRoot, "package.json"),
    );
    const binding = JSON.parse(await readFile(join(bindingRoot, "package.json"), "utf8"));
    if (binding.version !== "0.33.4") return false;
    await stagePackage("node-datachannel", bindingRoot, stagingRoot);
    await stagePackage(
      "detect-libc",
      resolveDependencyRoot("detect-libc", join(bindingRoot, "package.json")),
      stagingRoot,
    );
    let nativePackages = 0;
    for (const name of Object.keys(binding.optionalDependencies ?? {})) {
      if (!name.startsWith("@node-datachannel/")) continue;
      let root;
      try {
        root = resolveDependencyRoot(name, join(bindingRoot, "package.json"));
      } catch {
        continue;
      }
      const meta = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (!meta.os?.includes(platform) || !meta.cpu?.includes(arch)) continue;
      await stagePackage(name, root, stagingRoot);
      nativePackages++;
    }
    if (!nativePackages) return false;
    const files = [];
    for (const relative of [
      "pyrowave",
      "browser-media-worker.cjs",
      "node_modules/node-datachannel",
      "node_modules/detect-libc",
      "node_modules/@node-datachannel",
    ])
      await inventory(stagingRoot, relative, files);
    if (files.reduce((sum, file) => sum + file.bytes, 0) > 128 * 1024 * 1024) return false;
    await writeFile(
      join(stagingRoot, "media-assets.json"),
      `${JSON.stringify({ version: 1, qualified: true, platform, arch, encoder: "pyrowave/pyrowave-encoder", worker: "browser-media-worker.cjs", datachannelDirectory: "node_modules/node-datachannel", files }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}
