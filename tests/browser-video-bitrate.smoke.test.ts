/** Opt-in proof that higher Standard budgets reach the real native encoder and decoder. */
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { CdpSession } from "../server/cdp";
import { createRuntimeVideoSettings } from "../server/runtime-video-settings";
import { type NativeVideoPacket, VIDEO_MAX_PACKET_BYTES } from "../shared/browser-video";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

it("decodes 48 and 96 Mbps cohorts at the desktop size without replacing its source", async () => {
  const server = createServer((_request, response) =>
    response.end(`<!doctype html><style>body{margin:0;background:white;font:16px Arial}</style>
      <h1>Owned moving text</h1><div id=text></div><script>
      text.innerHTML=Array.from({length:80},(_,i)=>'<p>Readable browser text 123456789. Item '+i+'</p>').join('');
      function tick(t){text.style.transform='translateY(-'+(t/20%20)+'px)';requestAnimationFrame(tick)}requestAnimationFrame(tick);
      </script>`),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await withIsolatedBrowser(async (owner, source) => {
      await createRuntimeVideoSettings(process.env.PASEO_HOME!).update(true);
      await source.runtime.navigate(origin);
      await owner.request(source, "emulate", {
        width: 1151,
        height: 1469,
        deviceScaleFactor: 2,
        captureScale: 2,
        mobile: false,
        touch: false,
      });
      // Commit restored emulation after navigation before opening a fenced track.
      await owner.request(source, "state", null);
      const page = (source.runtime as unknown as { page: CdpSession }).page;
      const targetId = page.targetId;
      for (const bitrate of [48_000_000, 96_000_000]) {
        let packet: NativeVideoPacket | undefined;
        const reads: unknown[] = [];
        // Other cohorts can wake a long-poll before this encoder produces its
        // first key. Bound elapsed acquisition time rather than counting reads.
        await vi.waitFor(
          async () => {
            const reply = (await owner.request(source, "video.read", {
              codec: "webcodecs",
              bitrate,
              fps: 60,
              requestKeyFrame: true,
              waitMs: 500,
            })) as { status: string; packets: NativeVideoPacket[] };
            reads.push({
              status: reply.status,
              packets: reply.packets.map((p) => ({ type: p.type, codec: p.codec })),
            });
            expect(reply.status, JSON.stringify(reply)).not.toBe("unsupported");
            expect(reply.status).not.toBe("reset");
            packet = reply.packets.find((entry) => entry.type === "key");
            expect(packet, JSON.stringify({ bitrate, reads: reads.slice(-5) })).toBeDefined();
          },
          { timeout: 10_000, interval: 100 },
        );
        expect(packet!.codec).toMatch(/^avc[13]/);
        expect([packet!.width, packet!.height]).toEqual([2302, 2938]);
        expect(Buffer.from(packet!.dataBase64, "base64").length).toBeLessThanOrEqual(
          VIDEO_MAX_PACKET_BYTES,
        );
        const decoded = await page.send<{
          result: { value: { width: number; height: number } };
          exceptionDetails?: unknown;
        }>("Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async()=>{
            const p=${JSON.stringify(packet)},bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
            return await new Promise((resolve,reject)=>{
              const decoder=new VideoDecoder({error:reject,output:f=>{
                const result={width:f.displayWidth,height:f.displayHeight};f.close();decoder.close();resolve(result);
              }});
              decoder.configure({codec:p.codec,codedWidth:p.width,codedHeight:p.height,...(p.descriptionBase64?{description:bytes(p.descriptionBase64)}:{})});
              decoder.decode(new EncodedVideoChunk({type:p.type,timestamp:p.timestampUs,data:bytes(p.dataBase64)}));
              decoder.flush().catch(reject);
            });
          })()`,
        });
        expect(decoded.exceptionDetails).toBeUndefined();
        expect(decoded.result.value).toEqual({ width: 2302, height: 2938 });
        expect(page.targetId).toBe(targetId);
      }
    }, "wayland");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);
