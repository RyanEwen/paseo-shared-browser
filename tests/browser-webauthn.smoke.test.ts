import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentBrowserRuntime } from "../server/agent-browser-runtime";
import type { CdpSession } from "../server/cdp";
import { createPrivateWaylandDisplay } from "../server/private-wayland-display";
import { createPrivateVirtualDisplay } from "../server/virtual-display";
import { readRuntimeWaylandAssets } from "../server/wayland-assets";

/** Exercise real WebAuthn admission, without a real authenticator or private account. */
it.each(["headless", "xvfb", "wayland"] as const)(
  "admits WebAuthn on independent windows with %s",
  async (mode) => {
    const binaryPath = process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY;
    const executablePath = process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE;
    if (!binaryPath || !executablePath || !process.env.PASEO_HOME || !process.env.PASEO_HOST)
      throw new Error("WebAuthn smoke requires explicit isolated binaries, home and host");
    const fixture = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>WebAuthn fixture</title><input value='retained draft'>");
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Fixture has no port");
    const root = await mkdtemp(join(tmpdir(), "sb-auth-"));
    const assets =
      mode === "wayland"
        ? await readRuntimeWaylandAssets(process.env.PASEO_SHARED_BROWSER_TEST_ASSETS_HOME!)
        : null;
    if (mode === "wayland" && !assets) throw new Error("Wayland assets unavailable");
    const display =
      mode === "wayland"
        ? await createPrivateWaylandDisplay(assets!)
        : mode === "xvfb"
          ? await createPrivateVirtualDisplay(
              process.env.PASEO_SHARED_BROWSER_TEST_XVFB
                ? {
                    executablePath: process.env.PASEO_SHARED_BROWSER_TEST_XVFB,
                  }
                : {},
            )
          : null;
    const runtime = new AgentBrowserRuntime({
      binaryPath,
      executablePath,
      profilePath: join(root, "profile"),
      ipcDirectory: join(root, "ipc"),
      session: "webauthn-focus",
      headed: !!display,
      graphicsMode: mode === "wayland" ? "wayland" : "default",
      ...(display ? { launchEnvironment: display.launchEnvironment } : {}),
      initialUrl: `http://localhost:${address.port}/`,
    });
    let attached: AgentBrowserRuntime | undefined;
    try {
      await runtime.launch();
      await runtime.emulate({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
      });
      const page = (runtime as unknown as { page: CdpSession }).page;
      const inspect = async (expression: string, session = page) => {
        const result = await session.send<{ result: { value: unknown } }>("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        return result.result.value;
      };
      const identity = await runtime.identity();
      console.log(
        `webauthn-smoke: ${identity.browserProduct}, revision ${identity.browserRevision}`,
      );
      const original = identity.targetId;
      const other = await runtime.createTarget(`http://localhost:${address.port}/`);
      attached = new AgentBrowserRuntime({
        binaryPath,
        executablePath,
        profilePath: runtime.profilePath,
        ipcDirectory: runtime.ipcDirectory,
        session: runtime.session,
        headed: !!display,
        graphicsMode: mode === "wayland" ? "wayland" : "default",
        ...(display ? { launchEnvironment: display.launchEnvironment } : {}),
      });
      await attached.attachTarget(other, runtime);
      await attached.emulate({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
        touch: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect((await runtime.identity()).targetId).toBe(original);
      expect(
        await inspect(
          "({focused:document.hasFocus(),visibility:document.visibilityState,secure:isSecureContext})",
        ),
      ).toEqual({ focused: true, visibility: "visible", secure: true });
      // A bounded abort distinguishes admission from Chromium's immediate focus rejection.
      // No virtual authenticator is enabled, since its testing override can skip focus checks.
      const admission = `(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        await navigator.credentials.create({signal:controller.signal,publicKey:{
          challenge:new Uint8Array([1,2,3,4]),rp:{name:'Synthetic fixture',id:'localhost'},
          user:{id:new Uint8Array([1]),name:'synthetic',displayName:'Synthetic'},
          pubKeyCredParams:[{type:'public-key',alg:-7}],timeout:10000
        }});
        return {name:'success'};
      } catch (error) { return {name:error.name,message:error.message}; }
      finally {clearTimeout(timer);}
    })()`;
      const secondPage = (attached as unknown as { page: CdpSession }).page;
      for (const session of [page, secondPage]) {
        const result = await inspect(admission, session);
        expect(result, JSON.stringify({ mode, ...(result as object) })).toMatchObject({
          name: "AbortError",
        });
      }
      expect((await runtime.identity()).targetId).toBe(original);
      expect((await runtime.targets()).map((target) => target.targetId)).toEqual(
        expect.arrayContaining([original, other]),
      );
      expect(await inspect("document.querySelector('input').value")).toBe("retained draft");
    } finally {
      await attached?.shutdown();
      await runtime.shutdown();
      await display?.stop();
      await new Promise<void>((resolve, reject) =>
        fixture.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
