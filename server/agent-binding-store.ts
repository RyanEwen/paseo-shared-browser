import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SavedAgentBinding {
  agentId: string;
  workspaceId: string;
  tabId: string | null;
}

/** Private, durable authority written only by the authenticated plugin bridge.
 * Recovery never accepts a caller-supplied agent or workspace. Tokens are hashed
 * on disk; control leases, frames, and browser contents are never persisted.
 */
export class AgentBindingStore {
  constructor(private readonly path: string) {}

  get(ticket: string): SavedAgentBinding | undefined {
    return this.read()[this.key(ticket)];
  }

  set(ticket: string, binding: SavedAgentBinding): void {
    const records = this.read();
    records[this.key(ticket)] = binding;
    this.write(records);
  }

  revokeAgent(agentId: string): void {
    this.remove((binding) => binding.agentId === agentId);
  }

  revokeWorkspace(workspaceId: string): void {
    this.remove((binding) => binding.workspaceId === workspaceId);
  }

  private key(ticket: string): string {
    return createHash("sha256").update(ticket).digest("hex");
  }

  private remove(matches: (binding: SavedAgentBinding) => boolean): void {
    const records = this.read();
    for (const [key, binding] of Object.entries(records)) {
      if (matches(binding)) delete records[key];
    }
    this.write(records);
  }

  private read(): Record<string, SavedAgentBinding> {
    try {
      const info = lstatSync(this.path);
      if (
        !info.isFile() ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      ) {
        throw new Error("Agent binding store is not a private, owned file");
      }
      const records: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!records || typeof records !== "object" || Array.isArray(records)) {
        throw new Error("Invalid agent binding store");
      }
      for (const [key, binding] of Object.entries(records)) {
        if (
          !/^[a-f0-9]{64}$/.test(key) ||
          !binding ||
          typeof binding !== "object" ||
          typeof binding.agentId !== "string" ||
          !binding.agentId ||
          typeof binding.workspaceId !== "string" ||
          !binding.workspaceId ||
          !(binding.tabId === null || typeof binding.tabId === "string")
        ) {
          throw new Error("Invalid saved agent binding");
        }
      }
      return records as Record<string, SavedAgentBinding>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  /** Small synchronous transactions keep archive/revoke from racing recovery. */
  private write(records: Record<string, SavedAgentBinding>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify(records), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
