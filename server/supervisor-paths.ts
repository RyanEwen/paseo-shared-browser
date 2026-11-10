import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where one supervisor keeps its socket, credential, endpoint description and startup lock. */
export interface SupervisorPaths {
  root: string;
  socket: string;
  token: string;
  endpoint: string;
  lock: string;
}

/**
 * Resolve the supervisor's private paths under a Paseo home.
 *
 * @param paseoHome Paseo home directory; defaults to `$PASEO_HOME` or `~/.paseo`.
 * @returns Paths for the supervisor root, socket (a named pipe on Windows), token, endpoint
 *   file and startup lock.
 */
export function resolveSupervisorPaths(
  paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
): SupervisorPaths {
  const root = join(
    paseoHome,
    "plugin-data",
    "shared-browser",
    // Keep the existing lock/socket namespace across wire revisions. A version
    // mismatch must refuse connection, not launch a second supervisor alongside
    // the old one with the same workspace profiles and Chromium sessions.
    "supervisor-v2",
  );
  const socketId = createHash("sha256").update(root).digest("hex");
  const socket =
    process.platform === "win32"
      ? String.raw`\\.\pipe\paseo-shared-browser-${socketId}`
      : join(tmpdir(), `psb-${socketId.slice(0, 16)}.sock`);
  return {
    root,
    socket,
    token: join(root, "runtime.token"),
    endpoint: join(root, "runtime.json"),
    lock: join(root, "startup.lock"),
  };
}
