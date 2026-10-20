import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

/** Native opt-in gate: uses only an explicitly prepared home and disposable browser profile. */
it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "keeps private Wayland GPU ownership, independent emulation and cleanup across launch-tab close",
  async () => {
    let directory: string | undefined;
    await withIsolatedBrowser(async (owner, owned) => {
      directory = owned.display?.launchEnvironment.XDG_RUNTIME_DIR;
      expect(directory).toMatch(/\/paseo-browser-wayland-/);
      const identity = await owner.request(owned, "identity", null);
      expect(identity).toMatchObject({ graphics: { mode: "wayland", hardware: true } });
      const root = owned.rootTargetId!;
      const second = (await owner.request(owned, "tabs.create", null)) as { targetId: string };
      const emulate = (targetId: string, width: number, height: number) =>
        owner.request(owned, "emulate", {
          targetId,
          width,
          height,
          deviceScaleFactor: 1,
          captureScale: 1,
          mobile: false,
          touch: false,
        });
      await emulate(second.targetId, 1280, 800);
      await emulate(root, 800, 600);
      await owner.request(owned, "tabs.close", { targetId: root });
      expect(owned.rootTargetId).toBeNull();
      expect(await owner.request(owned, "identity", null)).toMatchObject({
        targetId: second.targetId,
      });
      const controller = await owned.tabs.get(second.targetId)!;
      const page = (
        controller as unknown as { page: { send<T>(method: string, params: object): Promise<T> } }
      ).page;
      const metrics = await page.send<{ result: { value: object } }>("Runtime.evaluate", {
        expression: "({width:innerWidth,height:innerHeight})",
        returnByValue: true,
      });
      expect(metrics.result.value).toEqual({ width: 1280, height: 800 });
      const gpu = await page.send<{ result: { value: unknown } }>("Runtime.evaluate", {
        expression: `(() => ['webgl','webgl2'].map(kind => {
          const canvas=document.createElement('canvas'),gl=canvas.getContext(kind);
          if(!gl)return null;gl.clearColor(0,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
          const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];
        }))()`,
        returnByValue: true,
      });
      expect(gpu.result.value).toEqual([
        [0, 255, 255, 255],
        [0, 255, 255, 255],
      ]);
    }, "wayland");
    await expect(access(directory!)).rejects.toThrow();
  },
  60000,
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "invalidates only its browser after compositor loss and retires the owned shell children",
  async () => {
    await withIsolatedBrowser(async (owner, owned) => {
      const directory = owned.display!.launchEnvironment.XDG_RUNTIME_DIR!;
      const configArgument = `--config=${join(directory, "weston.ini")}`;
      const candidates: number[] = [];
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const args = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
          if (args.includes(configArgument) && args[0]?.endsWith("/runtime/wayland/bin/weston")) {
            candidates.push(Number(entry));
          }
        } catch {
          /* A different process exited during the read-only inventory. */
        }
      }
      expect(candidates).toHaveLength(1);
      const pid = candidates[0]!;
      const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        const args = (await readFile(`/proc/${child}/cmdline`, "utf8")).split("\0");
        expect(args[0]).toMatch(/\/runtime\/wayland\/libexec\/weston-(desktop-shell|keyboard)$/);
      }
      // The unique private config and exact package executable establish ownership.
      // Recheck immediately before fault injection; no name-based host process kill.
      expect((await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")).toContain(
        configArgument,
      );
      process.kill(pid, "SIGKILL");
      await vi.waitFor(() => expect(() => owned.display!.assertAvailable()).toThrow("ended"));
      await expect(owner.request(owned, "identity", null)).rejects.toThrow(
        "Private Wayland display ended",
      );
      await vi.waitFor(
        async () => {
          for (const child of children) {
            try {
              const status = await readFile(`/proc/${child}/status`, "utf8");
              const args = (await readFile(`/proc/${child}/cmdline`, "utf8")).split("\0");
              const stillOwned = args[0]?.includes("/runtime/wayland/libexec/");
              expect(stillOwned && !/^State:\s+Z/m.test(status)).toBe(false);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        },
        { timeout: 3000 },
      );
    }, "wayland");
  },
  60000,
);
