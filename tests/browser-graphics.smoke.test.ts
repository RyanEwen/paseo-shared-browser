import { expect, it } from "vitest";
import type { DeviceEmulation } from "../server/agent-browser-runtime";
import type { CdpSession } from "../server/cdp";
import { DEFAULT_VIEWPORT, FRAME_MAX_BYTES } from "../shared/browser";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

/** Prove both WebGL versions render actual pixels using the selected hardware backend. */
it("renders WebGL 1 and 2 on the WSL GPU and captures the page", async () => {
  if (process.env.PASEO_SHARED_BROWSER_GRAPHICS !== "wsl-d3d12") {
    throw new Error("Hardware smoke requires PASEO_SHARED_BROWSER_GRAPHICS=wsl-d3d12");
  }
  await withIsolatedBrowser(async (owner, runtime) => {
    const viewport = {
      ...DEFAULT_VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
      touch: false,
    } satisfies DeviceEmulation;
    await owner.request(runtime, "emulate", viewport);
    const native = runtime.runtime as unknown as { requirePage(): Promise<CdpSession> };
    const page = await native.requirePage();
    const graphics = await page.send<{ result: { value: unknown } }>("Runtime.evaluate", {
      expression: `(() => {
        return ['webgl', 'webgl2'].map((kind, index) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 64;
          canvas.style.cssText = 'position:absolute;left:8px;top:' + (8 + index * 80) + 'px';
          document.body.appendChild(canvas);
          const gl = canvas.getContext(kind, { preserveDrawingBuffer: true });
          if (!gl) return { kind, available: false };
          gl.clearColor(1, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const pixel = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          return { kind, available: true, pixel: [...pixel], renderer };
        });
      })()`,
      returnByValue: true,
    });
    expect(graphics.result.value).toMatchObject([
      {
        kind: "webgl",
        available: true,
        pixel: [255, 0, 0, 255],
        renderer: expect.stringContaining("D3D12 ("),
      },
      {
        kind: "webgl2",
        available: true,
        pixel: [255, 0, 0, 255],
        renderer: expect.stringContaining("D3D12 ("),
      },
    ]);
    console.log("browser-graphics-smoke:", JSON.stringify(graphics.result.value));
    const frame = (await owner.request(runtime, "frame", {
      quality: 80,
      maxBytes: FRAME_MAX_BYTES,
      waitMs: 0,
    })) as { byteLength: number; dataBase64: string };
    expect(frame.byteLength).toBeGreaterThan(0);
    expect(frame.dataBase64.length).toBeGreaterThan(0);
    // Check the captured image itself, not just the WebGL framebuffer readback.
    const captured = await page.send<{ result: { value: number[][] } }>("Runtime.evaluate", {
      expression: `(async () => {
        const image = new Image();
        const loaded = new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
        });
        image.src = ${JSON.stringify(`data:image/jpeg;base64,${frame.dataBase64}`)};
        await loaded;
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return [16, 96].map((y) => [...context.getImageData(16, y, 1, 1).data]);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    expect(captured.result.value).toHaveLength(2);
    for (const pixel of captured.result.value) {
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(30);
      expect(pixel[2]).toBeLessThan(30);
      expect(pixel[3]).toBe(255);
    }
  }, "wsl-d3d12");
}, 30_000);
