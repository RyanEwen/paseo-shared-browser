import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readAgentAdapterRegistration } from "./agent-adapter-registration";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-adapter-"));
  roots.push(home);
  const agentId = "11111111-1111-4111-8111-111111111111",
    workspaceId = "wks_fixture";
  const directory = join(home, "plugin-data/shared-browser/.secrets/agents", agentId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "index.json"), JSON.stringify({ agentId, workspaceId }), {
    mode: 0o600,
  });
  await writeFile(join(directory, "ticket"), "t".repeat(40), { mode: 0o600 });
  return { home, agentId, workspaceId, directory };
}
it("loads only an explicit registration for the exact agent and workspace", async () => {
  const f = await fixture();
  expect(await readAgentAdapterRegistration(f.home, f.agentId, f.workspaceId)).toBe("t".repeat(40));
  await expect(readAgentAdapterRegistration(f.home, f.agentId, "other_workspace")).rejects.toThrow(
    "invalid or not private",
  );
});
it("leaves agents without an explicit registration unchanged", async () => {
  const f = await fixture();
  expect(await readAgentAdapterRegistration(f.home, "../../unsafe", f.workspaceId)).toBeUndefined();
  expect(
    await readAgentAdapterRegistration(
      f.home,
      "22222222-2222-4222-8222-222222222222",
      f.workspaceId,
    ),
  ).toBeUndefined();
});
it.skipIf(process.platform === "win32")(
  "rejects exposed secrets without echoing their contents",
  async () => {
    const f = await fixture();
    await chmod(join(f.directory, "ticket"), 0o644);
    await expect(readAgentAdapterRegistration(f.home, f.agentId, f.workspaceId)).rejects.toThrow(
      "invalid or not private",
    );
  },
);
it.skipIf(process.platform === "win32")("rejects a symlinked ticket", async () => {
  const f = await fixture();
  await rm(join(f.directory, "ticket"));
  await writeFile(join(f.home, "other-ticket"), "t".repeat(40));
  await symlink(join(f.home, "other-ticket"), join(f.directory, "ticket"));
  await expect(readAgentAdapterRegistration(f.home, f.agentId, f.workspaceId)).rejects.toThrow(
    "invalid or not private",
  );
});
