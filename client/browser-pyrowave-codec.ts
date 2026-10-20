/** Web-only GPU codec adapter, lazily loaded so native clients retain their current decoder. */

import { pyrowaveDimensionsSchema } from "../shared/pyrowave-settings";
import { videoColorSpaceSchema } from "../shared/video-color-space";
import type { BrowserVideoCodec, BrowserVideoDecodeEnvironment } from "./browser-video-decoder";
import { validatePyrowaveFrame } from "./pyrowave-frame";

type Callbacks = Parameters<BrowserVideoDecodeEnvironment["createDecoder"]>[0];
type Config = Parameters<BrowserVideoCodec["configure"]>[0];
interface Chunk {
  timestamp: number;
  byteLength: number;
  copyTo(destination: Uint8Array): void;
}
interface OwnedGpuDevice {
  readonly lost: Promise<unknown>;
  destroy(): void;
}
declare const navigator: {
  gpu?: { requestAdapter(): Promise<{ requestDevice(): Promise<OwnedGpuDevice> } | null> };
};

/** Keep at most four pending chunks during asynchronous GPU setup. All validation
 * happens before configure() creates a GPU device; close() fences delayed imports
 * and output. The surrounding decoder still owns source/receipt and paint policy. */
export function createBrowserPyrowaveCodec(callbacks: Callbacks): BrowserVideoCodec {
  let closed = false;
  let config: Config | null = null;
  let pending = 0;
  let decoder: import("@trev.zip/pyrowave-webgpu").PyroWaveDecoder | null = null;
  let device: OwnedGpuDevice | null = null;
  let work = Promise.resolve();
  /** Fence delayed outputs before releasing either codec or the GPU device we own. */
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      decoder?.close();
    } finally {
      decoder = null;
      device?.destroy();
      device = null;
    }
  };
  const fail = (error: unknown) => {
    if (closed) return;
    close();
    callbacks.error(error);
  };
  return {
    get decodeQueueSize() {
      return pending;
    },
    configure(value) {
      if (closed || config || value.codec !== "pyrowave" || value.description)
        throw new Error("Invalid PyroWave decoder configuration");
      pyrowaveDimensionsSchema.parse({ width: value.codedWidth, height: value.codedHeight });
      config = { ...value, colorSpace: videoColorSpaceSchema.parse(value.colorSpace) };
    },
    decode(value) {
      if (closed || !config || pending >= 4 || !value || typeof value !== "object")
        throw new Error("PyroWave decoder is unavailable");
      const chunk = value as Partial<Chunk>;
      if (
        !Number.isSafeInteger(chunk.timestamp) ||
        chunk.timestamp! < 0 ||
        !Number.isInteger(chunk.byteLength) ||
        chunk.byteLength! < 16 ||
        chunk.byteLength! > 2 * 1024 * 1024 ||
        typeof chunk.copyTo !== "function"
      )
        throw new Error("Invalid PyroWave chunk");
      const bytes = new Uint8Array(chunk.byteLength!);
      chunk.copyTo(bytes);
      const timestamp = chunk.timestamp!;
      const current = config;
      pending += 1;
      work = work
        .then(async () => {
          if (closed) return;
          const module = await import("@trev.zip/pyrowave-webgpu");
          if (closed) return;
          validatePyrowaveFrame(
            bytes,
            { width: current.codedWidth, height: current.codedHeight },
            module,
          );
          if (!decoder) {
            const adapter = await navigator.gpu?.requestAdapter();
            if (closed) return;
            if (!adapter) throw new Error("WebGPU video is unavailable");
            const allocated = await adapter.requestDevice();
            if (closed) {
              allocated.destroy();
              return;
            }
            device = allocated;
            void allocated.lost.then(() => {
              fail(new Error("WebGPU video device was lost"));
            });
            decoder = new module.PyroWaveDecoder({
              output(frame) {
                if (closed) frame.close();
                else callbacks.output(frame);
              },
              error(error) {
                fail(error);
              },
            });
            decoder.configure({
              codec: "pyrowave",
              codedWidth: current.codedWidth,
              codedHeight: current.codedHeight,
              device: allocated,
              colorSpace: videoColorSpaceSchema.parse(current.colorSpace),
            });
          }
          decoder.decode({ timestamp, data: bytes });
          await decoder.flush();
        })
        .catch((error: unknown) => {
          fail(error);
        })
        .finally(() => {
          pending -= 1;
          if (!closed) callbacks.dequeue();
        });
    },
    close,
  };
}
