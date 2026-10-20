import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createRuntimeGraphicsSettings,
  readBrowserGraphicsPreference,
} from "./runtime-graphics-settings";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-graphics-choice-"));
  homes.push(home);
  return {
    home,
    settings: createRuntimeGraphicsSettings(home),
    path: join(home, "plugin-data/shared-browser/graphics-choice.json"),
  };
}
it("persists ordered explicit choices privately without overwriting legacy WSL settings", async () => {
  const f = await fixture();
  expect(readBrowserGraphicsPreference(f.home)).toBe("host-default");
  await f.settings.update("vulkan");
  const legacy = join(f.home, "plugin-data/shared-browser/graphics.json");
  await writeFile(legacy, '{"mode":"wsl-d3d12"}');
  expect(readBrowserGraphicsPreference(f.home)).toBe("vulkan");
  await Promise.all([
    f.settings.update("host-default"),
    f.settings.update("vulkan"),
    f.settings.update("host-default"),
  ]);
  await f.settings.flush();
  expect(readBrowserGraphicsPreference(f.home)).toBe("host-default");
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({
    version: 1,
    preference: "host-default",
  });
  expect(await readFile(legacy, "utf8")).toBe('{"mode":"wsl-d3d12"}');
  if (process.platform !== "win32") expect((await stat(f.path)).mode & 0o777).toBe(0o600);
});
it("retains host behavior on malformed state and recovers a failed atomic write", async () => {
  const f = await fixture();
  await mkdir(f.path, { recursive: true });
  await expect(f.settings.update("vulkan")).rejects.toThrow();
  expect(readBrowserGraphicsPreference(f.home)).toBe("host-default");
  await rm(f.path, { recursive: true });
  await f.settings.update("vulkan");
  expect(readBrowserGraphicsPreference(f.home)).toBe("vulkan");
  for (const raw of [
    '{"version":2,"preference":"vulkan"}',
    '{"version":1,"preference":"bad"}',
    "invalid",
    " ".repeat(257),
  ]) {
    await writeFile(f.path, raw);
    expect(readBrowserGraphicsPreference(f.home)).toBe("host-default");
  }
});
