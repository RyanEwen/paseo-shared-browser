import { describe, expect, it, vi } from "vitest";
import { RuntimeProtocolError } from "./runtime-protocol";
import { runWithRestoredWorkspace, type WorkspaceLookup } from "./workspace-restore";

/** A Paseo lookup that finds the workspace only when `active` is true. */
function paseoWith(active: boolean): WorkspaceLookup & { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(async () => (active ? { id: "workspace-one" } : null));
  return { refresh, workspaces: { ref: () => ({ refresh }) } };
}

const archived = () => new RuntimeProtocolError("WORKSPACE_ARCHIVED", "Workspace is archived");

describe("runWithRestoredWorkspace", () => {
  it("returns a first success without asking Paseo or restoring", async () => {
    const paseo = paseoWith(true);
    const restore = vi.fn(async () => {});
    await expect(
      runWithRestoredWorkspace({
        workspaceId: "workspace-one",
        paseo,
        restore,
        run: async () => 1,
      }),
    ).resolves.toBe(1);
    expect(paseo.refresh).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores and retries once when Paseo finds the archived workspace active", async () => {
    const paseo = paseoWith(true);
    const restore = vi.fn(async () => {});
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(archived())
      .mockResolvedValue("ok");
    await expect(
      runWithRestoredWorkspace({ workspaceId: "workspace-one", paseo, restore, run }),
    ).resolves.toBe("ok");
    expect(restore).toHaveBeenCalledWith("workspace-one");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps the archive when Paseo still treats the workspace as archived", async () => {
    const restore = vi.fn(async () => {});
    const failure = archived();
    await expect(
      runWithRestoredWorkspace({
        workspaceId: "workspace-one",
        paseo: paseoWith(false),
        restore,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(restore).not.toHaveBeenCalled();
  });

  it("rethrows other failures unchanged without asking Paseo", async () => {
    const paseo = paseoWith(true);
    const restore = vi.fn(async () => {});
    const failure = new RuntimeProtocolError("RUNTIME_FAILURE", "Workspace not found");
    await expect(
      runWithRestoredWorkspace({
        workspaceId: "workspace-one",
        paseo,
        restore,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(paseo.refresh).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not retry a second time when the retried operation also fails", async () => {
    const restore = vi.fn(async () => {});
    const run = vi.fn(async () => {
      throw archived();
    });
    await expect(
      runWithRestoredWorkspace({
        workspaceId: "workspace-one",
        paseo: paseoWith(true),
        restore,
        run,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
