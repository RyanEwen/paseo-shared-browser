/** A real rendering compositor, owned by one hidden Linux browser runtime. */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isHardwareRenderer } from "./browser-graphics";
import { stopOwnedChild } from "./owned-child";
import { RuntimeLostError } from "./runtime-protocol";
import { PrivateDisplayError, type PrivateVirtualDisplay } from "./virtual-display";

/** Test the exact private listener with wl_display.sync, without touching a host display. */
async function synchronizeDisplay(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    let received = Buffer.alloc(0),
      settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => {
      // Object1 is wl_display, opcode0 is sync, new callback object2.
      const request = Buffer.alloc(12);
      request.writeUInt32LE(1, 0);
      request.writeUInt32LE(12 << 16, 4);
      request.writeUInt32LE(2, 8);
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 65536) return finish(false);
      while (received.length >= 8) {
        const header = received.readUInt32LE(4),
          size = header >>> 16;
        if (size < 8 || size > 65536) return finish(false);
        if (received.length < size) return;
        if (received.readUInt32LE(0) === 2 && (header & 0xffff) === 0) return finish(true);
        received = received.subarray(size);
      }
    });
  });
}

/** Remove even partially configured private state when filesystem setup fails. */
async function createDisplayDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-browser-wayland-"));
  try {
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, "weston.ini"),
      "[core]\nxwayland=false\n[shell]\nlocking=false\npanel-position=none\nbackground-color=0xff000000\n",
      { mode: 0o600 },
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Launch verified Weston 16 assets using host Mesa, with a private 0700 Unix socket.
 * No container, seat, physical screen, Xwayland, network service or host configuration.
 * Startup requires both a working listener and a hardware GL renderer. Failure closes
 * only this child and its directory; later compositor loss invalidates the browser.
 */
export async function createPrivateWaylandDisplay(assets: string): Promise<PrivateVirtualDisplay> {
  const directory = await createDisplayDirectory();
  const config = join(directory, "weston.ini"),
    socket = "wayland-1";
  const modules = {
    "headless-backend.so": "lib/libweston-16/headless-backend.so",
    "gl-renderer.so": "lib/libweston-16/gl-renderer.so",
    "desktop-shell.so": "lib/weston/desktop-shell.so",
    "weston-desktop-shell": "libexec/weston-desktop-shell",
    "weston-keyboard": "libexec/weston-keyboard",
  };
  const child = spawn(
    join(assets, "bin/weston"),
    [
      "--backend=headless",
      "--renderer=gl",
      "--shell=desktop",
      `--socket=${socket}`,
      "--width=1920",
      "--height=1920",
      "--scale=2",
      "--idle-time=0",
      `--config=${config}`,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: homedir(),
        LANG: "C.UTF-8",
        XDG_RUNTIME_DIR: directory,
        XDG_CACHE_HOME: join(directory, "cache"),
        LD_LIBRARY_PATH: `${join(assets, "lib")}:${join(assets, "lib/weston")}`,
        WESTON_DATA_DIR: join(assets, "share/weston"),
        WESTON_MODULE_MAP: Object.entries(modules)
          .map(([name, path]) => `${name}=${join(assets, path)}`)
          .join(";"),
      },
    },
  );
  let ended = false,
    log = "",
    closing: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => {
    const finish = () => {
      ended = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  // Drain continuously while bounding retained diagnostic bytes. Never log page data.
  child.stderr.on("data", (bytes: Buffer) => {
    log = (log + bytes.toString()).slice(-65536);
  });
  const stop = () =>
    (closing ??= (async () => {
      ended = true;
      await stopOwnedChild(child, exited, () => {
        child.kill("SIGTERM");
      });
      await rm(directory, { recursive: true, force: true });
    })());
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !ended) {
      const renderer = log.match(/GL renderer: ([^\r\n]+)/)?.[1];
      if (renderer && !isHardwareRenderer(renderer))
        throw new PrivateDisplayError("Wayland GPU selected software rendering");
      if (renderer && (await synchronizeDisplay(join(directory, socket)))) {
        if (ended) break;
        return {
          launchEnvironment: Object.freeze({ WAYLAND_DISPLAY: socket, XDG_RUNTIME_DIR: directory }),
          assertAvailable() {
            if (ended) throw new RuntimeLostError("Private Wayland display ended");
          },
          stop,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new PrivateDisplayError("Wayland GPU display did not become ready");
  } catch (error) {
    await stop();
    throw error;
  }
}
