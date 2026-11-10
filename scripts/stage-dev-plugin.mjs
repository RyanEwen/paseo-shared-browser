/** Snapshot only development source, including when its private target is inside .dev. */
import { cp, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const excluded = new Set([
  ".git",
  "node_modules",
  ".secrets",
  "coverage",
  "dist",
  ".dev",
  ".local-history",
  "test-results",
  "playwright-report",
]);
const allowed = (path) => !excluded.has(basename(path)) && !basename(path).startsWith(".env");

/**
 * Resolve a possibly missing path through its nearest existing ancestor, so it compares with a
 * realpath'd source. Temporary directories are often reached through links (macOS /var) or
 * short names (Windows RUNNER~1), which a plain resolve() would leave unmatched.
 */
async function canonicalPath(path) {
  const missing = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);
      if (error?.code !== "ENOENT" || parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Copy allowed top-level entries individually: Node rejects a root-to-descendant
 * cp before applying its filter. Only an excluded subtree may contain the target,
 * preventing recursive copies while keeping archives and private credentials out. */
export async function stageDevelopmentPlugin(source, destination) {
  source = await realpath(source);
  destination = await canonicalPath(destination);
  const within = relative(source, destination);
  if (
    !within ||
    (!within.startsWith(`..${sep}`) &&
      within !== ".." &&
      !isAbsolute(within) &&
      !excluded.has(within.split(sep)[0]))
  )
    throw new Error("Development staging target overlaps included source");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source)) {
    const path = join(source, entry);
    if (!allowed(path)) continue;
    await cp(path, join(destination, entry), { recursive: true, filter: allowed });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error("Expected source and private staging target");
  await stageDevelopmentPlugin(process.argv[2], process.argv[3]);
}
