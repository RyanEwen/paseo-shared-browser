/** Exercise the actual trusted helper program's producer bounds without a fake duplicate policy. */
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

it("oversize closes only that encoder, and repeated source frames cannot restart expensive keys", async () => {
  const packets: { error?: string; streamId?: string }[] = [];
  const encoders: { configuration: { bitrate: number }; calls: number; closed: boolean }[] = [];
  let deliver: (result: unknown) => void = () => {};
  let stopped = false;
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
});
