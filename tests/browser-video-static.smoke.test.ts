/** Opt-in native proof: static text keeps refining without stale-frame replay. */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CdpSession } from "../server/cdp";
import type { NativeVideoRead } from "../server/native-video-capture";
import { createRuntimeOwner } from "../server/runtime-owner";
import { createRuntimeVideoSettings } from "../server/runtime-video-settings";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

type Owner = Awaited<ReturnType<typeof createRuntimeOwner>>;
type OwnedBrowser = Awaited<ReturnType<Owner["create"]>>;
interface TraceRow {
  receivedAt: number;
  timestampUs: number;
  capturedAt: string;
  type: "key" | "delta";
  bytes: number;
}
interface Evaluation<T> {
  result: { value: T };
  exceptionDetails?: unknown;
}

it("measures real static delta refinement against the JPEG-derived source reference", async () => {
  const server = createServer((q, r) =>
    r.end(
      q.url === "/decode"
        ? "<!doctype html><title>Owned decoder</title>"
        : `<!doctype html><style>body{margin:0;background:white;font:16px Arial}#text{padding:20px}</style><div id=text></div><script>
 text.innerHTML=Array.from({length:100},(_,i)=>'<p>Readable text123456789. The quick brown fox jumps over the lazy dog. Row '+i+'</p>').join('');
 const start=performance.now();function tick(){const elapsed=performance.now()-start;if(elapsed<2000){text.style.transform='translateY(-'+(elapsed/8%500)+'px)';requestAnimationFrame(tick)}else{text.style.transform='translateY(-250px)';window.motionStopped=Date.now()}}requestAnimationFrame(tick);
 </script>`,
    ),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rows: TraceRow[] = [];
  try {
    await withIsolatedBrowser(async (owner, b) => {
      const sourceHome = process.env.PASEO_HOME!,
        consumerHome = await mkdtemp(join(tmpdir(), "shared-browser-static-decoder-"));
      let co: Owner | undefined;
      let consumer: OwnedBrowser | undefined;
      try {
        await createRuntimeVideoSettings(sourceHome).update(true);
        await owner.request(b, "emulate", {
          width: 1151,
          height: 1469,
          deviceScaleFactor: 2,
          captureScale: 2,
          mobile: false,
          touch: false,
        });
        process.env.PASEO_HOME = consumerHome;
        co = await createRuntimeOwner({ nativeVideo: false, initialUrl: `${origin}/decode` });
        consumer = await co.create("owned-static-decoder");
        process.env.PASEO_HOME = sourceHome;
        const page = (consumer.runtime as unknown as { page: CdpSession }).page,
          sourcePage = (b.runtime as unknown as { page: CdpSession }).page;
        // Match production low-latency decoding and retain at most twelve cropped pictures.
        await page.send("Runtime.evaluate", {
          expression: `window.historyFrames=[];window.lastDecoded=-1;window.decodeError=null;window.decoder=null;window.stream=null;window.consume=(packets)=>{for(const p of packets){if(window.stream!==p.streamId){window.decoder?.close();window.stream=p.streamId;window.decoder=new VideoDecoder({error:e=>window.decodeError=String(e),output:f=>{const c=new OffscreenCanvas(1000,400);const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(f,200,300,1000,400,0,0,1000,400);window.historyFrames.push({t:f.timestamp,data:g.getImageData(0,0,1000,400).data});while(window.historyFrames.length>12)window.historyFrames.shift();window.lastDecoded=f.timestamp;f.close();}});window.decoder.configure({optimizeForLatency:true,codec:p.codec,codedWidth:p.width,codedHeight:p.height,...(p.descriptionBase64?{description:Uint8Array.from(atob(p.descriptionBase64),c=>c.charCodeAt(0))}:{})});}window.decoder.decode(new EncodedVideoChunk({type:p.type,timestamp:p.timestampUs,data:Uint8Array.from(atob(p.dataBase64),c=>c.charCodeAt(0))}));}};`,
        });
        await b.runtime.navigate(origin);
        await owner.request(b, "state", null);
        const start = Date.now();
        let streamId: string | null = null;
        let afterSequence = 0;
        let lastTimestamp = -1;
        while (Date.now() - start < 128000) {
          const reply = (await owner.request(b, "video.read", {
            codec: "webcodecs",
            bitrate: 12000000,
            fps: 60,
            streamId,
            afterSequence,
            waitMs: 500,
          })) as unknown as NativeVideoRead;
          expect(reply.status).not.toBe("unsupported");
          if (reply.streamId !== streamId) {
            streamId = reply.streamId;
            afterSequence = 0;
          }
          if (reply.packets.length) {
            // This fixture qualifies H.264 specifically; VP8 needs its own baseline.
            expect(reply.packets.every((p) => /^avc[13]/.test(p.codec))).toBe(true);
            for (const p of reply.packets) {
              rows.push({
                receivedAt: Date.now(),
                timestampUs: p.timestampUs,
                capturedAt: p.capturedAt,
                type: p.type,
                bytes: Buffer.from(p.dataBase64, "base64").length,
              });
              afterSequence = p.sequence;
              lastTimestamp = p.timestampUs;
            }
            await page.send("Runtime.evaluate", {
              expression: `window.consume(${JSON.stringify(reply.packets)})`,
            });
          }
        }
        const stopped = (
          await sourcePage.send<Evaluation<number>>("Runtime.evaluate", {
            expression: "window.motionStopped",
            returnByValue: true,
          })
        ).result.value;
        const decoderState = () =>
          page.send<Evaluation<{ last: number; error: string | null }>>("Runtime.evaluate", {
            expression:
              "({last:window.lastDecoded,error:window.decodeError,queued:window.decoder?.decodeQueueSize,frames:window.historyFrames.length})",
            returnByValue: true,
          });
        await vi.waitFor(async () => {
          const state = (await decoderState()).result.value;
          expect(state.error, JSON.stringify(state)).toBeNull();
          expect(state.last, JSON.stringify(state)).toBe(lastTimestamp);
        });
        // Capture a reference only after the trace so screenshots cannot generate
        // extra source refreshes during the static-cadence measurement.
        const screenshot = await b.runtime.frame(800_000, 100, 0);
        expect([screenshot.width, screenshot.height]).toEqual([2302, 2938]);
        const sourceJpeg = screenshot.dataBase64;
        const staticRows = rows.filter((r) => Date.parse(r.capturedAt) > stopped + 200);
        const measured = await page.send<Evaluation<Array<{ timestampUs: number; rmse: number }>>>(
          "Runtime.evaluate",
          {
            returnByValue: true,
            awaitPromise: true,
            expression: `(async()=>{if(window.decodeError)throw Error(window.decodeError);const img=new Image();img.src='data:image/jpeg;base64,${sourceJpeg}';await img.decode();const c=new OffscreenCanvas(1000,400);const g=c.getContext('2d',{willReadFrequently:true});if(img.width!==2302||img.height!==2938)throw Error('Reference size differs');g.drawImage(img,200,300,1000,400,0,0,1000,400);const ref=g.getImageData(0,0,1000,400).data;return window.historyFrames.filter(f=>${JSON.stringify(staticRows.map((r) => r.timestampUs))}.includes(f.t)).map(f=>{let sum=0,n=0;for(let i=0;i<ref.length;i+=4){if(ref[i]<240){for(let k=0;k<3;k++){sum+=(f.data[i+k]-ref[i+k])**2;n++;}}}return {timestampUs:f.t,rmse:Math.sqrt(sum/n)};});})()`,
          },
        );
        if (measured.exceptionDetails) throw Error(JSON.stringify(measured.exceptionDetails));
        const result = { motionStopped: stopped, staticRows, metrics: measured.result.value };
        expect(result.metrics.length).toBeGreaterThanOrEqual(3);
        expect(staticRows.filter((row) => row.type === "delta").length).toBeGreaterThanOrEqual(3);
        console.info("Static full-cycle quality", JSON.stringify(result));
        // Run beyond the two configured 60-picture GOP budgets. Idle cadence alone
        // must not replace settled text with another low-detail independent key.
        expect(staticRows.length).toBeGreaterThanOrEqual(120);
        expect(staticRows.some((row) => row.type === "key")).toBe(false);
        // The reproduced all-key baseline stayed at 17.30. Require meaningful
        // absolute improvement, not merely a non-worsening compressed image.
        expect(result.metrics.at(-1)!.rmse).toBeLessThan(14);
        expect(result.metrics.at(-1)!.rmse).toBeLessThanOrEqual(result.metrics[0]!.rmse + 1);
      } finally {
        if (co && consumer) await co.stop(consumer);
        process.env.PASEO_HOME = sourceHome;
        await rm(consumerHome, { recursive: true, force: true });
      }
    }, "wayland");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 155000);
