import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserGraphicsPreference,
  browserGraphicsPreferenceSchema,
} from "../shared/browser-graphics";

const filename = "graphics-choice.json";

/** Derived settings mirror. A missing/bad choice retains existing host behavior. */
export function readBrowserGraphicsPreference(home: string): BrowserGraphicsPreference {
  try {
    const raw = readFileSync(join(home, "plugin-data", "shared-browser", filename), "utf8");
    if (raw.length > 256) return "host-default";
    const value = JSON.parse(raw);
    if (value?.version !== 1) return "host-default";
    return browserGraphicsPreferenceSchema.parse(value.preference);
  } catch {
    return "host-default";
  }
}

/** Serialize atomic updates without restarting or mutating a running browser. */
export function createRuntimeGraphicsSettings(home: string) {
  let pending: Promise<void> = Promise.resolve();
  let applied: BrowserGraphicsPreference | undefined;
  return {
    update(preference: BrowserGraphicsPreference): Promise<void> {
      const choice = browserGraphicsPreferenceSchema.parse(preference);
      const operation = pending
        .catch(() => {})
        .then(async () => {
          if (applied === choice) return;
          const directory = join(home, "plugin-data", "shared-browser");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = join(directory, `.graphics-choice-${randomUUID()}`);
          try {
            await writeFile(temporary, JSON.stringify({ version: 1, preference: choice }), {
              mode: 0o600,
            });
            await rename(temporary, join(directory, filename));
            applied = choice;
          } finally {
            await rm(temporary, { force: true });
          }
        });
      pending = operation;
      pending.catch(() => {});
      return operation;
    },
    flush: () => pending,
  };
}
