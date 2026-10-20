/** Resolve package roots even when package.json is hidden by package exports. */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Resolve from the owning package, not an assumed hoisted node_modules layout. */
export function resolveDependencyRoot(name, from = import.meta.url) {
  const require = createRequire(from);
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let directory = dirname(require.resolve(name));
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === name)
          return directory;
      } catch {
        /* Keep walking from the resolved entry through its bounded parent chain. */
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error(`Cannot resolve installed dependency ${name}`);
  }
}
