import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const filename = "video-policy.json";

/** Derived runtime policy; the revisioned Paseo settings document remains authoritative. */
export function readLiveVideoEnabled(home: string): boolean {
  try {
    const raw = readFileSync(join(home, "plugin-data", "shared-browser", filename), "utf8");
    if (raw.length > 256) return false;
    const value = JSON.parse(raw);
    return value?.version === 1 && value.enabled === true;
  } catch {
    // Missing, unreadable or invalid policy must never enable capture implicitly.
    return false;
  }
}

export function createRuntimeVideoSettings(home: string) {
  let pending: Promise<void> = Promise.resolve();
  let applied: boolean | undefined;
  return {
    update(enabled: boolean): Promise<void> {
      const operation = pending
        .catch(() => {})
        .then(async () => {
          if (applied === enabled) return;
          const directory = join(home, "plugin-data", "shared-browser");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = join(directory, `.video-policy-${randomUUID()}`);
          try {
            await writeFile(temporary, JSON.stringify({ version: 1, enabled }), { mode: 0o600 });
            await rename(temporary, join(directory, filename));
            applied = enabled;
          } finally {
            await rm(temporary, { force: true });
          }
        });
      pending = operation;
      // Keep failures visible to handlers, while allowing the next explicit update to recover.
      pending.catch(() => {});
      return operation;
    },
    flush: () => pending,
  };
}
