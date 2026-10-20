import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageDevelopmentPlugin } from "./stage-dev-plugin.mjs";

test("private in-checkout staging excludes credentials and recovery archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-stage-"));
  try {
    await mkdir(join(root, "client"));
    await writeFile(join(root, "client", "browser.ts"), "source");
    for (const name of [".dev", ".secrets", ".local-history", "node_modules", ".git"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "private"), "never stage");
    }
    await mkdir(join(root, "client", ".secrets"));
    await writeFile(join(root, "client", ".secrets", "nested"), "never stage");
    await writeFile(join(root, ".env.local"), "never stage");
    const destination = join(root, ".dev", "staged");
    await stageDevelopmentPlugin(root, destination);
    assert.deepEqual(await readdir(destination), ["client"]);
    assert.deepEqual(await readdir(join(destination, "client")), ["browser.ts"]);
    assert.equal(await readFile(join(destination, "client", "browser.ts"), "utf8"), "source");
    await assert.rejects(stageDevelopmentPlugin(root, join(root, "client", "staged")), /overlaps/);
    await assert.rejects(stageDevelopmentPlugin(root, root), /overlaps/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
