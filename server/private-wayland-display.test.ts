import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPrivateWaylandDisplay } from "./private-wayland-display";

/** A real owned Unix-socket child exercises startup/teardown without a GPU dependency. */
async function fixture(software = false) {
  const root = await mkdtemp(join(tmpdir(), "wayland-child-test-"));
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin/weston"),
    `#!/usr/bin/env node
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const directory=process.env.XDG_RUNTIME_DIR;
fs.writeFileSync(${JSON.stringify(join(root, "context.json"))},JSON.stringify({directory,display:process.env.DISPLAY,wayland:process.env.WAYLAND_DISPLAY}));
console.error('GL renderer: ${software ? "llvmpipe software" : "AMD owned fixture"}');
const server=net.createServer(socket=>socket.once('data',()=>{const reply=Buffer.alloc(12);reply.writeUInt32LE(2,0);reply.writeUInt32LE(12<<16,4);socket.end(reply)}));
server.listen(path.join(directory,'wayland-1'));
`,
    { mode: 0o700 },
  );
  return root;
}

it.skipIf(process.platform !== "linux")(
  "owns its private listener and removes it on idempotent stop",
  async () => {
    const assets = await fixture();
    let display: Awaited<ReturnType<typeof createPrivateWaylandDisplay>> | undefined;
    try {
      display = await createPrivateWaylandDisplay(assets);
      const context = JSON.parse(await readFile(join(assets, "context.json"), "utf8"));
      expect(context.display).toBeUndefined();
      expect(context.wayland).toBeUndefined();
      expect(display.launchEnvironment).toEqual({
        WAYLAND_DISPLAY: "wayland-1",
        XDG_RUNTIME_DIR: context.directory,
      });
      display.assertAvailable();
      await Promise.all([display.stop(), display.stop()]);
      expect(() => display!.assertAvailable()).toThrow("Private Wayland display ended");
      await expect(access(context.directory)).rejects.toThrow();
    } finally {
      await display?.stop();
      await rm(assets, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses software rendering and removes partial startup state",
  async () => {
    const assets = await fixture(true);
    try {
      await expect(createPrivateWaylandDisplay(assets)).rejects.toThrow("software rendering");
      const context = JSON.parse(await readFile(join(assets, "context.json"), "utf8"));
      await expect(access(context.directory)).rejects.toThrow();
    } finally {
      await rm(assets, { recursive: true, force: true });
    }
  },
);
