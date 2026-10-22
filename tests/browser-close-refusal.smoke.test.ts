import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CdpSession } from "../server/cdp";
import { createRuntimeOwner } from "../server/runtime-owner";
import { FRAME_MAX_BYTES } from "../shared/capture-settings";

/** A close refused after cleanup must keep both the launch and attached pages usable. */
it("reattaches the same surviving target after close authority expires during cleanup", async () => {
  if (
    !process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY ||
    !process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE ||
    !process.env.PASEO_HOST
  ) {
    throw new Error("Close refusal smoke requires explicit isolated binaries and host");
  }
  const home = await mkdtemp(join(tmpdir(), "sb-close-refusal-"));
  vi.stubEnv("PASEO_HOME", home);
  const owner = await createRuntimeOwner({
    initialUrl: "about:blank",
    nativeVideo: false,
    virtualDisplay: false,
  });
  let owned: Awaited<ReturnType<typeof owner.create>> | undefined;
  try {
    owned = await owner.create("close-refusal");
    const original = owned.rootTargetId!;
    const created = (await owner.request(owned, "tabs.create", null)) as { targetId: string };
    await owner.request(owned, "identity", { targetId: created.targetId });
    for (const targetId of [original, created.targetId]) {
      const controller = targetId === original ? owned.runtime : await owned.tabs.get(targetId)!;
      await controller.emulate({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
      });
      const page = (controller as unknown as { page: CdpSession }).page;
      await page.send("Runtime.evaluate", {
        expression: "document.body.innerHTML='<input value=retained>';",
      });
      const released = vi.spyOn(controller, "releaseTarget");
      let checks = 0;
      await expect(
        owner.request(owned, "tabs.close", { targetId }, () => {
          if (++checks === 2) throw new Error("Viewer expired");
        }),
      ).rejects.toThrow("Viewer expired");
      expect(released).toHaveBeenCalledOnce();
      released.mockRestore();
      expect(owned.rootTargetId).toBe(original);
      expect(
        ((await owner.request(owned, "identity", { targetId })) as { targetId: string }).targetId,
      ).toBe(targetId);
      // Identity reattaches through the production owner route. Capture and native input
      // then prove that a closed controller was not left cached under this target.
      const live = (controller as unknown as { page: CdpSession }).page;
      const draft = await live.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.querySelector('input').value",
        returnByValue: true,
      });
      expect(draft.result.value).toBe("retained");
      await controller.mouseMove(20, 20);
      const frame = await controller.frame(FRAME_MAX_BYTES);
      expect(frame.byteLength).toBeGreaterThan(0);
    }
    expect((await owned.runtime.targets()).map((target) => target.targetId)).toEqual(
      expect.arrayContaining([original, created.targetId]),
    );
  } finally {
    if (owned) await owner.stop(owned);
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
