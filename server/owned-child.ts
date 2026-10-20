/** Bounded termination only for a ChildProcess object created and retained by its owner. */
import type { ChildProcess } from "node:child_process";

/** Wait for exit without leaving a grace timer behind when exit wins the race. */
async function exitedWithin(exited: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Revoke admission separately before calling this helper. Request graceful shutdown,
 * then escalate only through the owned child handle. A kernel/driver that still refuses
 * exit after SIGKILL produces a bounded failure rather than hanging the owner forever. */
export async function stopOwnedChild(
  child: Pick<ChildProcess, "kill">,
  exited: Promise<void>,
  requestClose: () => void,
): Promise<void> {
  try {
    requestClose();
  } catch {
    /* A failed graceful write does not skip owned-process cleanup. */
  }
  if (await exitedWithin(exited, 1000)) return;
  child.kill("SIGTERM");
  if (await exitedWithin(exited, 1000)) return;
  child.kill("SIGKILL");
  if (await exitedWithin(exited, 1000)) return;
  throw new Error("Owned media process did not exit after termination");
}
