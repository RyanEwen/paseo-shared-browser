/** Exercise the actual trusted helper program's producer bounds without a fake duplicate policy. */
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { nativeVideoSynchronousTimers } from "../tests/fixtures/native-video-timers";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

it("bounds codec-active frames even when encodeQueueSize is zero and retains their generation until output", async () => {
  let deliver: (result: unknown) => void = () => {};
  const packets: { sequence: number; captureGeneration: number; timestampUs: number }[] = [];
  const submitted: number[] = [];
  let output: (chunk: unknown, metadata: unknown) => void = () => {};
  const reader = {
    read: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    cancel: async () => {
      deliver({ done: true });
    },
  };
  class SlowEncoder {
    // Native encodes leave the JS queue immediately but complete later.
    encodeQueueSize = 0;
    static async isConfigSupported() {
      return { supported: true };
    }
    constructor(callbacks: { output: typeof output }) {
      output = callbacks.output;
    }
    configure() {}
    close() {}
    reset() {}
    encode(frame: { timestamp: number }) {
      submitted.push(frame.timestamp);
    }
  }
  const context = createContext({
    ...nativeVideoSynchronousTimers,
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "exact-stream" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 800 }) }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    MediaStreamTrackProcessor: class {
      readable = { getReader: () => reader };
    },
    VideoEncoder: SlowEncoder,
    nativeVideoPacket: (json: string) => packets.push(JSON.parse(json)),
    performance: { now: () => 100 },
    btoa: (text: string) => Buffer.from(text, "binary").toString("base64"),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
  await runInContext('startCapture("exact",1280,800,1)', context);
  await runInContext('addEncoder("high","owned-stream")', context);
  const frame = async (timestamp: number) => {
    deliver({
      value: { timestamp, displayWidth: 1280, displayHeight: 800, close() {} },
      done: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const complete = (timestamp: number) =>
    output(
      {
        timestamp,
        type: "key",
        byteLength: 10,
        copyTo: (bytes: Uint8Array) => bytes.fill(1),
      },
      {},
    );
  try {
    for (let i = 0; i < 12; i++) await frame(100000 + i * 40000);
    expect(submitted).toEqual([100000, 140000]);
    complete(100000);
    expect(packets).toMatchObject([{ captureGeneration: 1, timestampUs: 100000 }]);
    await frame(600000);
    expect(submitted).toHaveLength(2); // One encode plus one unacknowledged output occupies both slots.
    runInContext('acknowledge("owned-stream",1)', context);
    await frame(640000);
    expect(submitted).toEqual([100000, 140000, 640000]);
    await runInContext("resetCapture(2,700000)", context);
    complete(140000);
    complete(640000);
    expect(packets).toHaveLength(1); // Late outputs remain fenced after document replacement.
    await frame(800000);
    complete(800000);
    expect(packets.at(-1)).toMatchObject({ captureGeneration: 2, timestampUs: 800000 });
  } finally {
    await runInContext("stopCapture()", context);
  }
});

it("oversize closes only that encoder, and repeated source frames cannot restart expensive keys", async () => {
  const packets: { error?: string; streamId?: string }[] = [];
  const encoders: { configuration: { bitrate: number }; calls: number; closed: boolean }[] = [];
  let deliver: (result: unknown) => void = () => {};
  let stopped = false;
  const scaledFrames: {
    timestamp: number;
    displayWidth: number;
    displayHeight: number;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const reader = {
    read: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    cancel: async () => {
      deliver({ done: true });
    },
  };
  class Encoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    configuration = { bitrate: 0 };
    calls = 0;
    closed = false;
    encodeQueueSize = 0;
    constructor(readonly callbacks: { output(chunk: unknown, metadata: unknown): void }) {
      encoders.push(this);
    }
    configure(value: { bitrate: number }) {
      this.configuration = value;
    }
    encode(frame: { timestamp: number }) {
      this.calls++;
      this.callbacks.output(
        {
          timestamp: frame.timestamp,
          type: "key",
          byteLength: this.configuration.bitrate > 5_000_000 ? 2_097_153 : 10,
          copyTo: (bytes: Uint8Array) => bytes.fill(1),
        },
        {},
      );
    }
    close() {
      if (this.closed) throw new Error("already closed");
      this.closed = true;
    }
    reset() {
      if (this.closed) throw new Error("already closed");
    }
  }
  const context = createContext({
    ...nativeVideoSynchronousTimers,
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "exact-stream" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 800 }) }],
          getTracks: () => [
            {
              stop: () => {
                stopped = true;
              },
            },
          ],
        }),
      },
    },
    MediaStreamTrackProcessor: class {
      readable = { getReader: () => reader };
    },
    VideoEncoder: Encoder,
    VideoFrame: class {
      timestamp: number;
      displayWidth: number;
      displayHeight: number;
      close = vi.fn();
      constructor(
        source: { timestamp: number },
        options: { displayWidth: number; displayHeight: number },
      ) {
        this.timestamp = source.timestamp;
        this.displayWidth = options.displayWidth;
        this.displayHeight = options.displayHeight;
        scaledFrames.push(this);
      }
    },
    nativeVideoPacket: (json: string) => packets.push(JSON.parse(json)),
    performance: { now: () => 100 },
    Uint8Array,
    Map,
    Set,
    Object,
    JSON,
    Number,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
  await runInContext('startCapture("exact",1280,800,1)', context);
  await runInContext('addEncoder("high","high-stream")', context);
  await runInContext('addEncoder("low","low-stream")', context);
  const frame = (timestamp: number) => ({
    timestamp,
    displayWidth: 1280,
    displayHeight: 800,
    close() {},
  });
  deliver({ value: frame(100000), done: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(encoders[0]?.closed).toBe(true);
  expect(packets).toContainEqual({
    error: "Native video quality exceeds its packet bound",
    streamId: "high-stream",
  });
  deliver({ value: frame(133333), done: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(encoders[0]?.calls).toBe(1);
  expect(encoders[1]?.calls).toBe(2);
  expect(packets.filter((packet) => packet.streamId === "low-stream")).toHaveLength(2);
  await runInContext("resetCapture(2,150000)", context);
  deliver({ value: { ...frame(200000), displayHeight: 799 }, done: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(packets).toContainEqual({
    error: "Native video dimensions changed",
    reasonCode: "source-dimensions",
  });
  await runInContext("stopCapture()", context);
  expect(stopped).toBe(true);
  await runInContext('startCapture("exact",412,839,3)', context);
  await runInContext('addEncoder("low","odd-stream")', context);
  const close = vi.fn();
  deliver({
    value: { timestamp: 300000, displayWidth: 412, displayHeight: 838, format: "I420", close },
    done: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(packets).toContainEqual(
    expect.objectContaining({
      streamId: "odd-stream",
      width: 412,
      height: 839,
      timestampUs: 300000,
    }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(scaledFrames[0]?.close).toHaveBeenCalledOnce();
  await runInContext("stopCapture()", context);
});

it.each([
  [412, 839, 412, 838],
  [393, 659, 392, 658],
  [413, 800, 412, 800],
])(
  "corrects only even-aligned YUV dimensions for %i by %i",
  (width, height, nativeWidth, nativeHeight) => {
    const frames: unknown[] = [];
    const context = createContext({
      ...nativeVideoSynchronousTimers,
      VideoFrame: class {
        constructor(
          readonly source: unknown,
          readonly options: unknown,
        ) {
          frames.push(this);
        }
      },
    });
    runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
    const native = {
      displayWidth: nativeWidth,
      displayHeight: nativeHeight,
      format: "I420",
      timestamp: 42,
    };
    context.frame = native;
    const result = runInContext(`frameForViewport(frame,${width},${height})`, context);
    expect(result.source).toBe(native);
    expect(result.options).toEqual({ displayWidth: width, displayHeight: height });
    expect(frames).toHaveLength(1);
    context.frame = { ...native, displayWidth: width, displayHeight: height };
    expect(runInContext(`frameForViewport(frame,${width},${height})`, context)).toBe(context.frame);
    for (const invalid of [
      { ...native, displayHeight: nativeHeight - 2 },
      { ...native, displayWidth: nativeWidth + 2 },
      { ...native, format: "RGBA" },
    ]) {
      context.frame = invalid;
      expect(runInContext(`frameForViewport(frame,${width},${height})`, context)).toBeNull();
    }
  },
);
