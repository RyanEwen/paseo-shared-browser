/** Real native windows, popup identity, dual capture and helper recovery on owned displays only. */

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { CdpConnection, type CdpSession } from "../server/cdp";
import type { NativeVideoRead } from "../server/native-video-capture";
import { NATIVE_VIDEO_EXTENSION_ID } from "../server/native-video-extension";
import { FRAME_MAX_BYTES } from "../shared/capture-settings";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

afterEach(() => vi.restoreAllMocks());

it.each(["headless", "xvfb", "wayland"] as const)(
  "retains popup identity, independent capture and existing tabs with %s",
  async (mode) => {
    if (!process.env.PASEO_HOST)
      throw new Error("Window lifecycle smoke requires an isolated host");
    const web = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><title>Window fixture</title><body style='margin:0;background:red'><input style='position:absolute;left:30px;top:30px' value='initial'><div style='position:absolute;top:300px;left:300px;width:20px;height:20px;background:white;animation:move .2s infinite alternate'></div><style>@keyframes move{to{transform:translateX(40px)}}</style>",
      );
    });
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    const address = web.address();
    if (!address || typeof address === "string") throw new Error("Fixture unavailable");
    const url = `http://localhost:${address.port}/`;
    try {
      await withIsolatedBrowser(
        async (owner, owned) => {
          const rootId = owned.rootTargetId!;
          const page = () => (owned.runtime as unknown as { page: CdpSession }).page;
          const inspect = async <T>(session: CdpSession, expression: string): Promise<T> => {
            const result = await session.send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true, userGesture: true },
            );
            if (result.exceptionDetails) throw new Error("Synthetic page evaluation failed");
            return result.result.value;
          };
          const emulate = (targetId: string) =>
            owner.request(owned, "emulate", {
              targetId,
              width: 800,
              height: 600,
              deviceScaleFactor: 1,
              mobile: false,
              touch: false,
            });
          const list = async () =>
            (await owner.request(owned, "tabs.list", null)) as { targetId: string }[];
          await owned.runtime.navigate(url);
          await emulate(rootId);
          await inspect(
            page(),
            "window.name='original-window';document.querySelector('input').value='root draft';localStorage.setItem('shared','same profile');document.cookie='window-test=retained;max-age=60';true",
          );
          const created = (await owner.request(owned, "tabs.create", null)) as { targetId: string };
          await owner.request(owned, "navigate", { targetId: created.targetId, url });
          await emulate(created.targetId);
          const second = await owned.tabs.get(created.targetId)!;
          const secondPage = (second as unknown as { page: CdpSession }).page;
          expect(
            await inspect(
              secondPage,
              "({saved:localStorage.getItem('shared'),cookie:document.cookie})",
            ),
          ).toEqual({ saved: "same profile", cookie: "window-test=retained" });
          await inspect(
            secondPage,
            "document.body.style.background='blue';document.querySelector('input').value='second draft';true",
          );

          // This is the site's actual Window.open API. Draft/name/opener witnesses are
          // set synchronously before asynchronous native relocation can complete.
          expect(
            await inspect(
              page(),
              `(() => {window.fixturePopup=window.open('', 'retained-popup');if(!fixturePopup)return false;fixturePopup.document.write('<title>Named popup</title><input value="popup draft">');fixturePopup.document.close();fixturePopup.retainedWitness='same document';return true})()`,
            ),
          ).toBe(true);
          let popupId = "";
          await vi.waitFor(async () => {
            const tabs = await list();
            expect(tabs).toHaveLength(3);
            popupId = tabs.find(
              (tab) => tab.targetId !== rootId && tab.targetId !== created.targetId,
            )!.targetId;
          });
          await owner.request(owned, "identity", { targetId: popupId });
          const popup = await owned.tabs.get(popupId)!;
          const popupPage = (popup as unknown as { page: CdpSession }).page;
          expect(
            await inspect(
              popupPage,
              "({name:window.name,opener:opener.name,witness:retainedWitness,draft:document.querySelector('input').value})",
            ),
          ).toEqual({
            name: "retained-popup",
            opener: "original-window",
            witness: "same document",
            draft: "popup draft",
          });
          expect(
            await inspect(
              page(),
              "fixturePopup.opener===window && fixturePopup.name==='retained-popup'",
            ),
          ).toBe(true);
          const windows = await Promise.all(
            (await list()).map((tab) =>
              page().connection.send<{ windowId: number }>("Browser.getWindowForTarget", {
                targetId: tab.targetId,
              }),
            ),
          );
          expect(new Set(windows.map((window) => window.windowId)).size).toBe(3);
          expect((await owned.runtime.identity()).targetId).toBe(rootId);

          // Separate source pixels prove screenshots and native video do not follow
          // another participant's native window, even while both sources are active.
          const observedColors: number[][] = [];
          for (const [targetId, controller, session, expected] of [
            [rootId, owned.runtime, page(), [255, 0, 0]],
            [created.targetId, second, secondPage, [0, 0, 255]],
          ] as const) {
            const frame = await controller.frame(FRAME_MAX_BYTES);
            const color = await inspect<number[]>(
              session,
              `(async()=>{const b=await createImageBitmap(await(await fetch('data:image/jpeg;base64,${frame.dataBase64}')).blob());const c=new OffscreenCanvas(1,1);c.getContext('2d').drawImage(b,0,0,1,1,0,0,1,1);b.close();return [...c.getContext('2d').getImageData(0,0,1,1).data].slice(0,3)})()`,
            );
            color.forEach((value, index) => {
              expect(Math.abs(value - expected[index]!)).toBeLessThan(15);
            });
            let video: NativeVideoRead | undefined;
            await vi.waitFor(
              async () => {
                video = (await owner.request(owned, "video.read", {
                  targetId,
                  quality: "high",
                  codec: "webcodecs",
                  fps: 30,
                  bitrate: 5000000,
                  waitMs: 500,
                })) as unknown as NativeVideoRead;
                expect(video.status).not.toBe("unsupported");
                expect(video.packets.some((packet) => packet.type === "key")).toBe(true);
              },
              { timeout: 12000, interval: 100 },
            );
            const videoColor = await inspect<number[]>(
              session,
              `new Promise((resolve,reject)=>{const packets=${JSON.stringify(video!.packets)};const decoder=new VideoDecoder({error:reject,output:frame=>{const c=new OffscreenCanvas(1,1);c.getContext('2d').drawImage(frame,0,0,1,1,0,0,1,1);frame.close();resolve([...c.getContext('2d').getImageData(0,0,1,1).data].slice(0,3));decoder.close()}});const p=packets[0];decoder.configure({optimizeForLatency:true,codec:p.codec,codedWidth:p.width,codedHeight:p.height,...(p.colorSpace?{colorSpace:p.colorSpace}:{}),...(p.descriptionBase64?{description:Uint8Array.from(atob(p.descriptionBase64),c=>c.charCodeAt(0))}:{})});for(const p of packets)decoder.decode(new EncodedVideoChunk({type:p.type,timestamp:p.timestampUs,data:Uint8Array.from(atob(p.dataBase64),c=>c.charCodeAt(0))}));decoder.flush().catch(reject);})`,
            );
            observedColors.push(videoColor);
            // This qualifies exact source identity, not colour fidelity. Separate
            // HEAD/current synthetic measurements retain any backend colour drift.
            videoColor.forEach((value, index) => {
              if (expected[index] === 255) expect(value).toBeGreaterThan(200);
              else expect(value).toBeLessThan(60);
            });
          }
          await writeFile(
            `/tmp/shared-browser-window-colour-current-${mode}.json`,
            JSON.stringify({ mode, colors: { red: observedColors[0], blue: observedColors[1] } }),
          );
          const started = performance.now();
          for (let index = 0; index < 20; index++) await owned.runtime.mouseMove(50 + index, 100);
          const elapsed = performance.now() - started;
          expect(elapsed).toBeLessThan(2000);
          console.log(
            `window-smoke ${mode}: 20 native pointer packets ${Math.round(elapsed)} ms; distinct JPEG/video source colors`,
          );
          await owned.runtime.stopVideo();
          await second.stopVideo();

          // Loss fails closed even with cached readiness. Reconnect recreates only
          // the hidden helper, and reconciles legacy tabs already present at startup.
          const connection = page().connection;
          const all = await connection.send<{ targetInfos: { targetId: string; url: string }[] }>(
            "Target.getTargets",
          );
          const helper = all.targetInfos.find(
            (target) =>
              target.url === `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/windows.html`,
          )!;
          await connection.send("Target.closeTarget", { targetId: helper.targetId });
          await vi.waitFor(async () => {
            await expect(owned.runtime.mouseMove(1, 1)).rejects.toThrow("window manager");
          });
          const legacy = await connection.send<{ targetId: string }>("Target.createTarget", {
            url,
            background: true,
          });
          await owned.runtime.reconnect();
          const after = await list();
          expect(after.map((tab) => tab.targetId)).toEqual([
            rootId,
            created.targetId,
            popupId,
            legacy.targetId,
          ]);
          const existingWindows = await Promise.all(
            after.map((tab) =>
              page().connection.send<{ windowId: number }>("Browser.getWindowForTarget", {
                targetId: tab.targetId,
              }),
            ),
          );
          expect(new Set(existingWindows.map((window) => window.windowId)).size).toBe(4);
          expect(await inspect(page(), "document.querySelector('input').value")).toBe("root draft");
          expect(await inspect(secondPage, "document.querySelector('input').value")).toBe(
            "second draft",
          );
          expect(await inspect(popupPage, "window.name+'|'+retainedWitness+'|'+opener.name")).toBe(
            "retained-popup|same document|original-window",
          );
          expect((await list()).some((tab) => tab.targetId === helper.targetId)).toBe(false);
          // A real viewer reattach requests identity/state through the owner. It must
          // recover management after the pinned launch page has already been closed.
          await owner.request(owned, "tabs.close", { targetId: rootId });
          expect(owned.rootTargetId).toBeNull();
          const management = (owned.runtime as unknown as { connection: { close(): void } })
            .connection;
          management.close();
          const transport = vi.spyOn(CdpConnection.prototype, "send");
          await expect(
            owner.request(owned, "identity", { targetId: created.targetId }),
          ).resolves.toMatchObject({ targetId: created.targetId });
          await expect(
            owner.request(owned, "state", { targetId: created.targetId }),
          ).resolves.toMatchObject({ url });
          expect((owned.runtime as unknown as { page: CdpSession | null }).page).toBeNull();
          expect((owned.runtime as unknown as { targetId: string }).targetId).toBe(rootId);
          expect(
            transport.mock.calls.some(
              ([method]) => method === "Target.activateTarget" || method === "Page.navigate",
            ),
          ).toBe(false);
          expect(await inspect(secondPage, "document.querySelector('input').value")).toBe(
            "second draft",
          );
          expect(await inspect(popupPage, "window.name+'|'+(opener===null||opener.closed)")).toBe(
            "retained-popup|true",
          );
          await second.mouseMove(50, 100);
          expect((await second.frame(FRAME_MAX_BYTES)).byteLength).toBeGreaterThan(0);
          expect((await list()).map((tab) => tab.targetId)).toEqual([
            created.targetId,
            popupId,
            legacy.targetId,
          ]);
        },
        mode === "wayland" ? "wayland" : undefined,
        { nativeVideo: true, privateDesktop: mode === "xvfb" },
      );
    } finally {
      await new Promise<void>((resolve) => web.close(() => resolve()));
    }
  },
  120_000,
);
