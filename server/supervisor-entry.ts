import { dirname, join } from "node:path";
import { createLazyRuntimeOwner } from "./lazy-runtime-owner";
import { createRuntimeOwner } from "./runtime-owner";
import { runStandaloneSupervisor } from "./supervisor-server";

/** Empty workspace reservations run nothing; running browsers stay bounded by the lazy owner. */
const MAX_WORKSPACE_RESERVATIONS = 32;

/**
 * Detached supervisor entry. The process owner is created once, here, so this supervisor keeps
 * launching the agent-browser, Chromium and display binaries of the runtime it was started from,
 * even after a later install moves the runtime pointer. Creating it starts no processes.
 */
async function main(): Promise<void> {
  // This bundle lives in its runtime directory beside the binaries it must keep using.
  const runtimeRoot = dirname(process.argv[1]!);
  const owner = await createRuntimeOwner({ runtimeRoot });
  await runStandaloneSupervisor(
    createLazyRuntimeOwner(async (workspaceId, beforeLaunch) => ({
      owner,
      runtime: await owner.create(workspaceId, { beforeLaunch }),
    })),
    {
      maxWorkspaces: MAX_WORKSPACE_RESERVATIONS,
      // The adapter bundled beside this supervisor speaks exactly its protocol.
      adapterPath: join(runtimeRoot, "shared-browser-mcp.cjs"),
    },
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
