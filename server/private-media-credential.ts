/** Durable capabilities for private media listeners, separate from browser/control authority. */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

/** Mint only into explicitly private persistent storage before opening a listener.
 * Revocation retains the original credential and its metadata for owner recovery;
 * listener closure, rather than an editable file, enforces capability revocation. */
export async function createPrivateMediaCredential(directory: string, resource: string) {
  if (
    !isAbsolute(directory) ||
    !directory.split(sep).includes(".secrets") ||
    directory === "/tmp" ||
    directory.startsWith("/tmp/") ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(resource)
  ) {
    throw new Error("Private media storage must be persistent and scoped");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.mode & 0o077)
  ) {
    throw new Error("Private media storage is not private");
  }
  const id = randomUUID();
  const location = join(directory, id);
  await mkdir(location, { mode: 0o700 });
  const credential = randomBytes(32).toString("base64url");
  const metadata = {
    purpose: "Single hidden-extension raw video capture listener",
    account: "local Shared Browser runtime",
    resource,
    credentialId: id,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    secretFilename: "ticket",
    destinations: ["runtime-owned loopback WebSocket", "trusted hidden capture extension"],
    backupStatus: "not copied; ephemeral listener capability retained in private owner storage",
    revokedAt: null as string | null,
  };
  await writeFile(join(location, "ticket"), `${credential}\n`, {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
  const index = join(location, "index.json");
  await writeFile(index, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
  let revocation: Promise<void> | null = null;
  return {
    credential,
    /** Persist audit state after the owner has synchronously revoked listener admission. */
    revoke(): Promise<void> {
      revocation ??= writeFile(
        index,
        `${JSON.stringify({ ...metadata, revokedAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600, flush: true },
      );
      return revocation;
    },
  };
}
