import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseRuntimeRequest, RUNTIME_PROTOCOL_VERSION } from "../server/runtime-protocol";
import { AgentBindingStore } from "../server/agent-binding-store";

it("stores hashed credentials, restores exact selection, and revokes archived workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-browser-authority-"));
  const path = join(root, "bindings.json");
  try {
    const first = new AgentBindingStore(path);
    first.set("private-ticket", { agentId: "one", workspaceId: "workspace", tabId: "second-tab" });
    first.set("another-ticket", { agentId: "two", workspaceId: "other", tabId: null });
    expect(readFileSync(path, "utf8")).not.toContain("private-ticket");
    const resumed = new AgentBindingStore(path);
    expect(resumed.get("private-ticket")?.tabId).toBe("second-tab");
    resumed.revokeWorkspace("workspace");
    expect(new AgentBindingStore(path).get("private-ticket")).toBeUndefined();
    expect(resumed.get("another-ticket")?.workspaceId).toBe("other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fails closed for corrupt or publicly readable authority files", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-browser-authority-"));
  const path = join(root, "bindings.json");
  try {
    const store = new AgentBindingStore(path);
    writeFileSync(path, "invalid json", { mode: 0o600 });
    expect(() => store.get("ticket")).toThrow();
    if (process.platform !== "win32") {
      writeFileSync(path, "{}");
      chmodSync(path, 0o644);
      expect(() => store.get("ticket")).toThrow("private, owned file");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


it("accepts every advertised recovery and tab operation over the wire", () => {
  for (const operation of ["reconnect", "open", "tabs.list", "tabs.create", "tabs.select", "tabs.close"]) {
    expect(parseRuntimeRequest({
      id: "correlated", version: RUNTIME_PROTOCOL_VERSION, method: "agent.request",
      ticket: "opaque", operation, input: {},
    })).toMatchObject({ id: "correlated", operation });
  }
});
