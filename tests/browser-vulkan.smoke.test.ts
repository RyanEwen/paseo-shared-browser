import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { CdpSession } from "../server/cdp";
import { withIsolatedBrowser } from "./isolated-browser-runtime";

/** Explicit opt-in native check on a Linux host with an accessible hardware Vulkan GPU. */
it("uses the saved Vulkan choice for hardware WebGL pixels and WebGPU compute", async () => {
  const server = createServer((_request, response) =>
    response.end("<!doctype html><title>Owned GPU fixture</title>"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Owned GPU fixture unavailable");
    await withIsolatedBrowser(async (owner, runtime) => {
      // WebGPU needs a trustworthy origin; an opaque about:blank document is insufficient.
      await owner.request(runtime, "navigate", { url: `http://127.0.0.1:${address.port}` });
      const identity = await owner.request(runtime, "identity", null);
      expect(identity).toMatchObject({
        graphics: { preference: "vulkan", mode: "vulkan", platform: "linux", hardware: true },
      });
      const page = await (
        runtime.runtime as unknown as { requirePage(): Promise<CdpSession> }
      ).requirePage();
      const gl = await page.send<{ result: { value: unknown } }>("Runtime.evaluate", {
        expression: `(() => ['webgl', 'webgl2'].map(kind => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const gl = canvas.getContext(kind, {preserveDrawingBuffer: true});
        if (!gl) return {kind, available: false};
        gl.clearColor(0,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel = new Uint8Array(4);
        gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        const extension = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        return {kind, available: true, pixel: Array.from(pixel), renderer};
      }))()`,
        returnByValue: true,
      });
      expect(gl.result.value).toMatchObject([
        {
          kind: "webgl",
          available: true,
          pixel: [0, 255, 255, 255],
          renderer: expect.stringContaining("Vulkan"),
        },
        {
          kind: "webgl2",
          available: true,
          pixel: [0, 255, 255, 255],
          renderer: expect.stringContaining("Vulkan"),
        },
      ]);
      const compute = await page.send<{ result: { value: unknown } }>("Runtime.evaluate", {
        expression: `(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter) return {available: false};
        const device = await adapter.requestDevice();
        let buffer, readback;
        try {
          buffer = device.createBuffer({size:128,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
          readback = device.createBuffer({size:128,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
          const module = device.createShaderModule({code:'@group(0) @binding(0) var<storage,read_write> values:array<u32>; @compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id:vec3<u32>){values[id.x]=id.x*3u+7u;}'});
          const pipeline = device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
          const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}}]});
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
          encoder.copyBufferToBuffer(buffer,0,readback,0,128);device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          return {available:true,values:Array.from(new Uint32Array(readback.getMappedRange()))};
        } finally {readback?.destroy();buffer?.destroy();device.destroy();}
      })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      expect(compute.result.value).toEqual({
        available: true,
        values: Array.from({ length: 32 }, (_, i) => i * 3 + 7),
      });
    }, "vulkan");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);
