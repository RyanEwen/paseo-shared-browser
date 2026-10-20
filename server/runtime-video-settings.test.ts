import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntimeVideoSettings, readLiveVideoEnabled } from "./runtime-video-settings";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-video-choice-"));
  homes.push(home);
  return {
    home,
    policy: createRuntimeVideoSettings(home),
    path: join(home, "plugin-data/shared-browser/video-policy.json"),
  };
}
it("starts off and persists ordered explicit choices across runtime recreation", async () => {
  const f = await fixture();
  expect(readLiveVideoEnabled(f.home)).toBe(false);
  await f.policy.update(true);
  expect(readLiveVideoEnabled(f.home)).toBe(true);
  await Promise.all([f.policy.update(false), f.policy.update(true), f.policy.update(false)]);
  await f.policy.flush();
  expect(readLiveVideoEnabled(f.home)).toBe(false);
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ version: 1, enabled: false });
  if (process.platform !== "win32") expect((await stat(f.path)).mode & 0o777).toBe(0o600);
});
it("fails closed on invalid state and recovers after a failed atomic write", async () => {
  const f = await fixture();
  await mkdir(f.path, { recursive: true });
  await expect(f.policy.update(true)).rejects.toThrow();
  expect(readLiveVideoEnabled(f.home)).toBe(false);
  await rm(f.path, { recursive: true });
  await f.policy.update(true);
  expect(readLiveVideoEnabled(f.home)).toBe(true);
  await writeFile(f.path, '{"version":1,"enabled":"true"}');
  expect(readLiveVideoEnabled(f.home)).toBe(false);
  await writeFile(f.path, "invalid");
  expect(readLiveVideoEnabled(f.home)).toBe(false);
});
