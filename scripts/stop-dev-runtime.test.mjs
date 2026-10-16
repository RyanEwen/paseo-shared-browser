import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./stop-dev-runtime.mjs", import.meta.url));

test("refuses a home outside the isolated helper's namespace", () => {
  const result = spawnSync(process.execPath, [script, join(tmpdir(), "ordinary-user-home")]);
  assert.notEqual(result.status, 0);
});

test("refuses an unrelated live process even when a private lock names its PID", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "shared-browser-teardown-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const home = join(temporary, "shared-browser-dev-000000000000", "home");
  const root = join(home, "plugin-data", "shared-browser");
  const lock = join(root, "supervisor-v2", "startup.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), String(process.pid));
  writeFileSync(join(root, "runtime-current"), ".runtime-00000000-0000-4000-8000-000000000000");
  const result = spawnSync(process.execPath, [script, home]);
  assert.notEqual(result.status, 0);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
