import { RuntimeProtocolError } from "./runtime-protocol";

/** The part of Paseo's plugin API used to confirm that a workspace is active. */
export interface WorkspaceLookup {
  workspaces: { ref(workspaceId: string): { refresh(): Promise<unknown> } };
}

/** How one workspace operation is retried after a stale archive. */
export interface RestoredWorkspaceRetry<Result> {
  workspaceId: string;
  /** The operation; it runs at most twice. */
  run(): Promise<Result>;
  /** Paseo's view of the workspace. Archived workspaces are not found. */
  paseo: WorkspaceLookup;
  /** Clears the supervisor's archive mark for the workspace. */
  restore(workspaceId: string): Promise<void>;
}

/** True when the supervisor refused a workspace because it was archived. */
export function isWorkspaceArchivedError(error: unknown): boolean {
  return error instanceof RuntimeProtocolError && error.code === "WORKSPACE_ARCHIVED";
}

/**
 * Run a workspace operation, recovering once from an archive that Paseo has since undone.
 *
 * Paseo++ can restore an archived workspace without notifying plugins, so the supervisor can
 * still hold the archive. Paseo is the authority: the archive mark is cleared and the operation
 * retried only when Paseo finds the workspace again. Any other failure, or a workspace Paseo
 * still treats as archived, is rethrown unchanged.
 */
export async function runWithRestoredWorkspace<Result>(
  retry: RestoredWorkspaceRetry<Result>,
): Promise<Result> {
  try {
    return await retry.run();
  } catch (error) {
    if (!isWorkspaceArchivedError(error)) throw error;

    const workspace = await retry.paseo.workspaces.ref(retry.workspaceId).refresh();
    if (!workspace) throw error;

    await retry.restore(retry.workspaceId);
    return retry.run();
  }
}
