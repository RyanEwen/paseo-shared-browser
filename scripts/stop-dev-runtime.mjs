// Gracefully tear down only the standalone helper's disposable supervisor.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const home = resolve(process.argv[2] ?? "");
assert.match(home, /[/\\]shared-browser-dev-[a-f0-9]{12}[/\\]home$/);
const root = join(home, "plugin-data", "shared-browser");
const lock = join(root, "supervisor-v2", "startup.lock");
if (existsSync(join(lock, "pid"))) {
  const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "Invalid isolated supervisor PID");
  let running = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    running = false;
  }
  if (running) {
    const pointer = readFileSync(join(root, "runtime-current"), "utf8").trim();
    assert.match(pointer, /^\.runtime-[a-f0-9-]{36}$/);
    const bundle = join(root, pointer, "supervisor.cjs");
    if (process.platform === "linux") {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      assert.equal(args[1], bundle, "Refusing to signal a different process");
    } else {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
      assert.ok(command.trim().endsWith(bundle), "Refusing to signal a different process");
    }
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; existsSync(lock); attempt++) {
      assert.ok(attempt < 300, "Isolated supervisor cleanup incomplete; no forced kill");
      await pause(100);
    }
    console.log("Stopped the verified isolated Shared Browser supervisor");
  }
}
