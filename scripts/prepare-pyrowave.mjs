/** Owner-operated native provisioning with existing tools, never a user-facing environment toggle. */
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
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { qualifyPyrowaveEncoder } from "./media-runtime.mjs";
import { verifyPinnedNativeSource } from "./native-source.mjs";

const execFileAsync = promisify(execFile);
const PYROWAVE_COMMIT = "21f099d24df0ab0e4c10c3288c924b6b1717e581";
const GRANITE_COMMIT = "53090429539bf3404250d18fe58db971f0907c04";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Preserve original source notices, including nested dependency notices. Symlinks and
 * Git metadata are skipped; independently pinned Granite is traversed as its own root. */
async function preserveLicenses(source, destination, prefix, budget) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    if (++budget.entries > 100000) throw new Error("Native source inventory exceeded its bound");
    const path = join(source, entry.name),
      relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await preserveLicenses(path, destination, relative, budget);
    else if (
      entry.isFile() &&
      /^(license|copying|notice|copyright)(?:[._-].*)?$/i.test(entry.name)
    ) {
      const info = await lstat(path);
      if (info.size > 1024 * 1024 || ++budget.files > 56)
        throw new Error("Native notices exceeded their bound");
      const target = join(destination, "licenses", relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(path, target);
    }
  }
}

/** Build one private hardware-qualified cache, preserving the previous pointer until
 * compilation, real GPU encode, license collection and checksums have all succeeded. */
export async function preparePyrowave({
  source,
  build,
  nativeRoot,
  projectRoot = dirname(dirname(fileURLToPath(import.meta.url))),
}) {
  if (process.platform !== "linux") throw new Error("Native PyroWave is qualified on Linux only");
  source = await realpath(resolve(source));
  build = await realpath(resolve(build));
  nativeRoot = resolve(nativeRoot);
  const granite = await realpath(join(source, "Granite"));
  await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(nativeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Invalid private native root");
  await chmod(nativeRoot, 0o700);
  await verifyPinnedNativeSource(source, nativeRoot);
  const name = `.pyrowave-${randomUUID()}`,
    cache = join(nativeRoot, name),
    binary = join(cache, "pyrowave-encoder");
  await mkdir(cache, { mode: 0o700 });
  await cp(join(build, "libpyrowave-shared.so.1.0.0"), join(cache, "libpyrowave-shared.so.1"));
  const helper = join(projectRoot, "scripts/native/pyrowave-encoder.cpp");
  await execFileAsync(
    "g++",
    [
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-I",
      source,
      "-I",
      join(granite, "third_party/khronos/vulkan-headers/include"),
      helper,
      "-L",
      build,
      "-lpyrowave-shared",
      "-ldl",
      "-Wl,-rpath,$ORIGIN",
      "-o",
      binary,
    ],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  );
  await chmod(binary, 0o700);
  const qualification = await qualifyPyrowaveEncoder(binary, join(nativeRoot, "cache"));
  const budget = { entries: 0, files: 0 };
  await preserveLicenses(source, cache, "pyrowave", budget);
  await preserveLicenses(granite, cache, "granite", budget);
  await writeFile(
    join(cache, "UPSTREAM-SOURCES.json"),
    `${JSON.stringify({ pyrowave: { repository: "https://github.com/Themaister/pyrowave", commit: PYROWAVE_COMMIT }, granite: { repository: "https://github.com/Themaister/Granite", commit: GRANITE_COMMIT }, helper: "scripts/native/pyrowave-encoder.cpp" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const files = [];
  const inventory = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
        path = join(directory, entry.name);
      if (entry.isDirectory()) await inventory(path, relative);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
        await chmod(path, entry.name === "pyrowave-encoder" ? 0o700 : 0o600);
      } else throw new Error("Unexpected native cache entry");
    }
  };
  await inventory(cache);
  if (files.length > 64) throw new Error("Native cache exceeded its file bound");
  await writeFile(
    join(cache, "index.json"),
    `${JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, builtAt: new Date().toISOString(), encoderSourceSha256: digest(await readFile(helper)), qualification, files }, null, 2)}\n`,
    { mode: 0o600, flush: true },
  );
  const pending = join(nativeRoot, `.pyrowave-current-${randomUUID()}`);
  await writeFile(pending, `${name}\n`, { mode: 0o600, flush: true });
  await rename(pending, join(nativeRoot, "pyrowave-current"));
  return { cache: name, files: files.length, qualification };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsByName = new Map();
  for (let index = 2; index < process.argv.length; index += 2)
    argumentsByName.set(process.argv[index], process.argv[index + 1]);
  const source = argumentsByName.get("--source"),
    build = argumentsByName.get("--build"),
    nativeRoot = argumentsByName.get("--native-root");
  if (!source || !build || !nativeRoot) {
    console.error(
      "Usage: node scripts/prepare-pyrowave.mjs --source PINNED_PYROWAVE --build QUALIFIED_BUILD --native-root PRIVATE_NATIVE_ROOT",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await preparePyrowave({ source, build, nativeRoot });
      console.log(
        `Prepared qualified native PyroWave cache (${result.files} files, GPU encode verified).`,
      );
    } catch {
      console.error(
        "Native PyroWave preparation failed. The previous native cache pointer is unchanged.",
      );
      process.exitCode = 1;
    }
  }
}
