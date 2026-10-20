import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Explicit local-owner retrofit registrations, never inferred from page content or labels. */
export async function readAgentAdapterRegistration(
  paseoHome: string,
  agentId: string,
  workspaceId: string,
): Promise<string | undefined> {
  if (!/^[a-f0-9-]{36}$/i.test(agentId)) return undefined;
  const directory = join(paseoHome, "plugin-data", "shared-browser", ".secrets", "agents", agentId);
  try {
    const [info, ticketInfo, indexInfo] = await Promise.all([
      lstat(directory),
      lstat(join(directory, "ticket")),
      lstat(join(directory, "index.json")),
    ]);
    if (
      !info.isDirectory() ||
      !ticketInfo.isFile() ||
      !indexInfo.isFile() ||
      info.isSymbolicLink() ||
      ticketInfo.isSymbolicLink() ||
      indexInfo.isSymbolicLink()
    )
      throw new Error("Invalid adapter registration storage");
    if (
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 ||
        (ticketInfo.mode & 0o077) !== 0 ||
        (indexInfo.mode & 0o077) !== 0)
    )
      throw new Error("Adapter registration must be private");
    if (indexInfo.size > 16_384 || ticketInfo.size > 129)
      throw new Error("Invalid adapter registration size");
    const [text, value] = await Promise.all([
      readFile(join(directory, "index.json"), "utf8"),
      readFile(join(directory, "ticket"), "utf8"),
    ]);
    const metadata = JSON.parse(text) as { agentId?: string; workspaceId?: string };
    const ticket = value.trim();
    if (
      metadata.agentId !== agentId ||
      metadata.workspaceId !== workspaceId ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(ticket)
    )
      throw new Error("Adapter registration scope is invalid");
    return ticket;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    // No parser, file contents or ticket values may escape into host logs.
    throw new Error("Shared Browser adapter registration is invalid or not private");
  }
}
