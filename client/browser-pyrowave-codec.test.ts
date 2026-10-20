import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeBrowserMediaFrame, fragmentBrowserMediaFrame } from "../shared/browser-media-wire";
import { browserVideoTestMetadata } from "../tests/fixtures/browser-video";
import { createBrowserMediaReceiver } from "./browser-media-receiver";
import { createBrowserPyrowaveCodec } from "./browser-pyrowave-codec";
import { createBrowserVideoDecoder, type DecodedBrowserVideoFrame } from "./browser-video-decoder";

const state = vi.hoisted(() => ({
  constructors: 0,
  closes: 0,
  decodes: 0,
  callbacks: null as null | { output(frame: { close(): void }): void },
  flush: Promise.resolve(),
  destroyDevice: vi.fn(),
  configure: vi.fn(),
  loseDevice: () => {},
}));
vi.mock("@trev.zip/pyrowave-webgpu", async () => {
  const actual = await vi.importActual<typeof import("@trev.zip/pyrowave-webgpu")>(
    "@trev.zip/pyrowave-webgpu",
  );
  return {
    ...actual,
    PyroWaveDecoder: class {
      constructor(callbacks: typeof state.callbacks) {
        state.constructors++;
        state.callbacks = callbacks;
      }
      configure(config: unknown) {
        state.configure(config);
      }
      decode() {
        state.decodes++;
      }
      flush() {
        return state.flush;
      }
      close() {
        state.closes++;
      }
    },
  };
});
beforeEach(() => {
  state.constructors = state.closes = state.decodes = 0;
  state.callbacks = null;
  state.flush = Promise.resolve();
  state.destroyDevice.mockReset();
  state.configure.mockReset();
  const lost = Promise.withResolvers<void>();
  state.loseDevice = () => lost.resolve();
  vi.stubGlobal("navigator", {
    gpu: {
      requestAdapter: async () => ({
        requestDevice: async () => ({ lost: lost.promise, destroy: state.destroyDevice }),
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
function chunk(complete = true) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x80000000 | (63 << 14) | 63, true);
  view.setUint32(4, complete ? 1 : 2, true);
  view.setUint32(8, 2 << 16, true);
  return {
    timestamp: 100,
    byteLength: bytes.byteLength,
    copyTo: (target: Uint8Array) => target.set(bytes),
  };
}
function fixture() {
  const callbacks = { output: vi.fn(), error: vi.fn(), dequeue: vi.fn() };
  const codec = createBrowserPyrowaveCodec(callbacks);
  codec.configure({
    codec: "pyrowave",
    codedWidth: 64,
    codedHeight: 64,
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    optimizeForLatency: true,
  });
  return { codec, callbacks };
}
it("refuses incomplete frames before constructing any GPU decoder", async () => {
  const { codec, callbacks } = fixture();
  try {
    expect(state.constructors).toBe(0);
    codec.decode(chunk(false));
    await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledOnce());
    expect(state.constructors).toBe(0);
    expect(state.decodes).toBe(0);
  } finally {
    codec.close();
  }
});
it("bounds pending chunks and fences delayed work and late output after closure", async () => {
  const { codec, callbacks } = fixture();
  const pending = Promise.withResolvers<void>();
  state.flush = pending.promise;
  codec.decode(chunk());
  await vi.waitFor(() => expect(state.decodes).toBe(1));
  for (let i = 0; i < 3; i++) codec.decode(chunk());
  expect(codec.decodeQueueSize).toBe(4);
  expect(() => codec.decode(chunk())).toThrow();
  codec.close();
  const frame = { close: vi.fn() };
  state.callbacks!.output(frame);
  expect(frame.close).toHaveBeenCalledOnce();
  pending.resolve();
  await vi.waitFor(() => expect(codec.decodeQueueSize).toBe(0));
  expect(state.decodes).toBe(1);
  expect(state.closes).toBe(1);
  expect(state.destroyDevice).toHaveBeenCalledOnce();
  expect(callbacks.output).not.toHaveBeenCalled();
  expect(callbacks.dequeue).not.toHaveBeenCalled();
});
it("revokes pending presentation and releases the owned device on actual loss notification", async () => {
  const { codec, callbacks } = fixture();
  codec.decode(chunk());
  await vi.waitFor(() => expect(state.decodes).toBe(1));
  state.loseDevice();
  await vi.waitFor(() => expect(callbacks.error).toHaveBeenCalledOnce());
  const frame = { close: vi.fn() };
  state.callbacks!.output(frame);
  expect(frame.close).toHaveBeenCalledOnce();
  expect(callbacks.output).not.toHaveBeenCalled();
  expect(state.destroyDevice).toHaveBeenCalledOnce();
  expect(() => codec.decode(chunk())).toThrow();
  codec.close();
  expect(state.destroyDevice).toHaveBeenCalledOnce();
});
it("does not load or allocate the GPU codec when closed before queued initialization", async () => {
  const { codec, callbacks } = fixture();
  codec.decode(chunk());
  codec.close();
  await vi.waitFor(() => expect(codec.decodeQueueSize).toBe(0));
  expect(state.constructors).toBe(0);
  expect(callbacks.error).not.toHaveBeenCalled();
});

for (const fullRange of [false, true]) {
  it(`preserves explicit ${fullRange ? "full" : "limited"} source range and BT.601 matrix`, async () => {
    const callbacks = { output: vi.fn(), error: vi.fn(), dequeue: vi.fn() };
    const codec = createBrowserPyrowaveCodec(callbacks);
    const colorSpace = {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "smpte170m",
      fullRange,
    } as const;
    codec.configure({
      codec: "pyrowave",
      codedWidth: 64,
      codedHeight: 64,
      colorSpace,
      optimizeForLatency: true,
    });
    try {
      codec.decode(chunk());
      await vi.waitFor(() => expect(state.decodes).toBe(1));
      expect(state.configure).toHaveBeenCalledWith(expect.objectContaining({ colorSpace }));
      expect(callbacks.error).not.toHaveBeenCalled();
    } finally {
      codec.close();
    }
  });
}

it("refuses unspecified colour instead of silently interpreting limited-range capture as full range", () => {
  const codec = createBrowserPyrowaveCodec({ output: vi.fn(), error: vi.fn(), dequeue: vi.fn() });
  expect(() =>
    codec.configure({
      codec: "pyrowave",
      codedWidth: 64,
      codedHeight: 64,
      optimizeForLatency: true,
    }),
  ).toThrow();
  expect(state.constructors).toBe(0);
  codec.close();
});

it("keeps one GPU device across independent sequence gaps and credits only the newest painted picture", async () => {
  let scheduled: (() => void) | null = null;
  const sendCredit = vi.fn();
  const errors = vi.fn();
  const receiver = createBrowserMediaReceiver({
    now: () => 0,
    isCurrent: () => true,
    onPicture: (picture, epoch) => decoder.receive(picture, epoch),
    sendCredit,
  });
  const decoder = createBrowserVideoDecoder({
    environment: {
      createDecoder: createBrowserPyrowaveCodec,
      createChunk: ({ timestamp, data }) => ({
        timestamp,
        byteLength: data.length,
        copyTo: (target: Uint8Array) => target.set(data),
      }),
      decodeBase64: () => {
        throw Error("Expected binary media");
      },
      scheduleDraw(draw) {
        scheduled = draw;
        return () => {
          scheduled = null;
        };
      },
      draw: () => {},
    },
    isCurrent: () => true,
    onPresented: (picture) => receiver.presented(picture),
    onNeedKeyFrame: () => {
      throw Error("Independent picture requested a recovery key");
    },
    onError: errors,
  });
  try {
    for (const sequence of [1, 3, 7]) {
      const payload = new Uint8Array(16);
      chunk().copyTo(payload);
      const metadata = {
        ...browserVideoTestMetadata(),
        sequence,
        timestampUs: sequence * 1000,
        width: 64,
        height: 64,
        colorSpace: {
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          fullRange: false,
        } as const,
      };
      for (const fragment of fragmentBrowserMediaFrame(
        encodeBrowserMediaFrame(metadata, payload),
        sequence,
      )) {
        receiver.receive(fragment);
      }
      await vi.waitFor(() => expect(state.decodes).toBe([1, 3, 7].indexOf(sequence) + 1));
      const frame: DecodedBrowserVideoFrame = {
        timestamp: sequence * 1000,
        displayWidth: 64,
        displayHeight: 64,
        close: vi.fn(),
      };
      state.callbacks!.output(frame);
    }
    expect(state.constructors).toBe(1);
    expect(state.destroyDevice).not.toHaveBeenCalled();
    expect(sendCredit).not.toHaveBeenCalled();
    const paint = scheduled as (() => void) | null;
    paint?.();
    expect(sendCredit).toHaveBeenCalledOnce();
    expect(new DataView(sendCredit.mock.calls[0]![0].buffer).getUint32(0, true)).toBe(7);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    receiver.close();
    decoder.close();
  }
  expect(state.destroyDevice).toHaveBeenCalledOnce();
});
