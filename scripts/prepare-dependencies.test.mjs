import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { prepareDependencies, resolveDependencyRoot } from "./prepare-dependencies.mjs";

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "shared-browser-dependencies-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

test("stages catalog dependencies for a Git checkout", (t) => {
  const root = temporaryRoot(t);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      catalog: { zod: "4.4.3" },
      dependencies: { zod: "catalog:" },
    }),
  );
  const calls = [];

  const installed = prepareDependencies(root, (...args) => calls.push(args));

  assert.equal(installed, true);
  assert.deepEqual(calls, [
    [
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--workspaces=false"],
      { cwd: root, stdio: "inherit" },
    ],
  ]);
});

test("resolves a dependency hoisted above the installed plugin", (t) => {
  const root = temporaryRoot(t);
  const packageRoot = join(root, "node_modules", "example-runtime");
  const pluginScript = join(
    root,
    "node_modules",
    "@omercnet",
    "paseo-shared-browser",
    "scripts",
    "prepare-runtime.mjs",
  );
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(dirname(pluginScript), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"example-runtime"}');

  assert.equal(
    resolveDependencyRoot("example-runtime", pathToFileURL(pluginScript).href),
    realpathSync(packageRoot),
  );
});

test("installs a standalone Git checkout without a parent catalog", (t) => {
  const root = temporaryRoot(t);
  const manifest = { dependencies: { zod: "4.4.3" }, devDependencies: { vitest: "5.0.1" } };
  const source = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(root, "package.json"), source);
  let calls = 0;
  assert.equal(
    prepareDependencies(root, (_command, args) => {
      calls += 1;
      assert.deepEqual(args, ["ci", "--omit=dev", "--ignore-scripts", "--workspaces=false"]);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), {
        dependencies: manifest.dependencies,
      });
    }),
    true,
  );
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), source);
});
