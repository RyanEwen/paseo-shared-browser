/** Execute the shipped extension program so rate admission is not a duplicate policy test. */
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { nativeVideoSynchronousTimers } from "../tests/fixtures/native-video-timers";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

it("owns bitrate/FPS per encoder, actually rate-limits frames, and closes only the removed cohort", async () => {
  const encoders: Encoder[] = [];
  const constraints: unknown[] = [];
  let clockNow = 0;
  let deliver: (value: unknown) => void = () => {};
  let context: ReturnType<typeof createContext>;
  class Encoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    configuration = { bitrate: 0, framerate: 0 };
    calls = 0;
    encoded: { timestamp: number; keyFrame: boolean }[] = [];
    closed = false;
    encodeQueueSize = 0;
    constructor(readonly callbacks: { output(chunk: unknown, metadata: unknown): void }) {
      encoders.push(this);
    }
    configure(value: typeof this.configuration) {
      this.configuration = value;
    }
    close() {
      this.closed = true;
    }
    reset() {}
    encode(frame: { timestamp: number }, options: { keyFrame: boolean }) {
      this.calls++;
      this.encoded.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame });
      this.callbacks.output(
        {
          timestamp: frame.timestamp,
          type: "key",
          byteLength: 1,
          copyTo: (bytes: Uint8Array) => bytes.fill(1),
        },
        {},
      );
    }
  }
  const reader = {
    read: () =>
      new Promise((resolve) => {
        deliver = (result) => {
          const frame = (result as { value?: { timestamp: number } }).value;
          if (frame) {
            clockNow = Math.max(clockNow, frame.timestamp / 1000);
            // Streaming readers renew active cohort demand during this long synthetic run.
            runInContext("for (const key of encoders.keys()) touchEncoder(key)", context);
          }
          resolve(result);
        };
      }),
    cancel: async () => {
      deliver({ done: true });
    },
  };
  context = createContext({
    ...nativeVideoSynchronousTimers,
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "source" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async (value: unknown) => {
          constraints.push(value);
          return {
            getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 800 }) }],
            getTracks: () => [{ stop() {} }],
          };
        },
      },
    },
    MediaStreamTrackProcessor: class {
      readable = { getReader: () => reader };
    },
    VideoEncoder: Encoder,
    nativeVideoPacket(json: string) {
      const packet = JSON.parse(json);
      runInContext(`acknowledge(${JSON.stringify(packet.streamId)},${packet.sequence})`, context);
    },
    performance: { now: () => clockNow },
    Uint8Array,
    Map,
    Set,
    Object,
    JSON,
    Number,
    Math,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
  await runInContext('startCapture("exact",1280,800,1)', context);
  await runInContext('addEncoder("24000000:15","slow",24000000,15)', context);
  await runInContext('addEncoder("5000000:30","medium",5000000,30)', context);
  await runInContext('addEncoder("12000000:60","fast",12000000,60)', context);
  expect(
    encoders.map((value) => [value.configuration.bitrate, value.configuration.framerate]),
  ).toEqual([
    [24_000_000, 15],
    [5_000_000, 30],
    [12_000_000, 60],
  ]);
  expect(constraints[0]).toMatchObject({ video: { mandatory: { maxFrameRate: 60 } } });
  await expect(
    runInContext('addEncoder("2000000:30","fourth",2000000,30)', context),
  ).rejects.toThrow("limit");
  for (let i = 0; i < 60; i++) {
    deliver({
      value: {
        timestamp: 1_000_000 + Math.ceil((i * 1_000_000) / 60),
        displayWidth: 1280,
        displayHeight: 800,
        close() {},
      },
      done: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(encoders.map((value) => value.calls)).toEqual([15, 30, 60]);
  // A forced recovery key bypasses FPS thinning, while backlog remains a hard gate.
  runInContext('requestKeyFrame("24000000:15")', context);
  encoders[0]!.encodeQueueSize = 2;
  const push = async (timestamp: number) => {
    deliver({
      value: { timestamp, displayWidth: 1280, displayHeight: 800, close() {} },
      done: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await push(1_985_000);
  expect(encoders.map((value) => value.calls)).toEqual([15, 30, 60]);
  encoders[0]!.encodeQueueSize = 0;
  await push(1_990_000);
  expect(encoders.map((value) => value.calls)).toEqual([16, 30, 60]);
  expect(encoders[0]!.encoded.at(-1)).toEqual({ timestamp: 1_990_000, keyFrame: true });
  await push(1_991_000);
  expect(encoders.map((value) => value.calls)).toEqual([16, 30, 60]);

  // The real native track drops to 1fps when the page stops changing. Those
  // refreshes must refine the prior image rather than restart every GOP.
  for (const timestamp of [3_000_000, 4_000_000, 5_000_000]) await push(timestamp);
  expect(encoders[0]!.encoded.slice(-3).map((frame) => frame.keyFrame)).toEqual([
    false,
    false,
    false,
  ]);
  for (const encoder of encoders.slice(1))
    expect(encoder.encoded.slice(-3).map((frame) => frame.keyFrame)).toEqual([false, false, false]);

  // Exceed every configured GOP while idle, then resume active capture. Idle
  // alone must not restart settled quality; active periodic keys remain intact.
  for (let second = 6; second <= 70; second++) await push(second * 1_000_000);
  for (const encoder of encoders)
    expect(encoder.encoded.slice(-65).every((frame) => !frame.keyFrame)).toBe(true);
  // One close pair after idle is not sustained motion.
  await push(70_080_000);
  expect(encoders.map((encoder) => encoder.encoded.at(-1)?.keyFrame)).toEqual([
    false,
    false,
    false,
  ]);
  await push(71_000_000);
  for (let sample = 1; sample <= 15; sample++) await push(71_000_000 + sample * 80_000);
  for (const encoder of encoders)
    expect(encoder.encoded.slice(-15).filter((frame) => frame.keyFrame)).toHaveLength(1);
  runInContext('requestKeyFrame("24000000:15")', context);
  await push(73_300_000);
  expect(encoders.map((encoder) => encoder.encoded.at(-1)?.keyFrame)).toEqual([true, false, false]);

  runInContext('removeEncoder("5000000:30")', context);
  expect(encoders.map((value) => value.closed)).toEqual([false, true, false]);
  await runInContext('addEncoder("2000000:30","new",2000000,30)', context);
  expect(encoders).toHaveLength(4);
  runInContext('removeEncoder("2000000:30")', context);
  for (const bitrate of [48_000_000, 96_000_000]) {
    const key = `${bitrate}:60`;
    await runInContext(`addEncoder("${key}","high-budget",${bitrate},60)`, context);
    expect(encoders.at(-1)?.configuration).toMatchObject({ bitrate, framerate: 60 });
    runInContext(`removeEncoder("${key}")`, context);
    expect(encoders.at(-1)?.closed).toBe(true);
  }
  await expect(
    runInContext('addEncoder("100000000:60","wrong-codec-budget",100000000,60)', context),
  ).rejects.toThrow("Unknown video settings");
  await runInContext("stopCapture()", context);
  expect(encoders.every((value) => value.closed)).toBe(true);
});

/** Codec probes deliberately remain pending, as a timed-out CDP evaluation does. */
function allocationFixture() {
  const support: ((value: { supported: boolean }) => void)[] = [];
  const created: { closed: boolean; configure(value: unknown): void }[] = [];
  let deliver: (result: unknown) => void = () => {};
  const context = createContext({
    ...nativeVideoSynchronousTimers,
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "source" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ getSettings: () => ({}) }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    MediaStreamTrackProcessor: class {
      readable = {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              deliver = resolve;
            }),
          cancel: async () => {
            deliver({ done: true });
          },
        }),
      };
    },
    VideoEncoder: class {
      static isConfigSupported() {
        return new Promise((resolve) => support.push(resolve));
      }
      closed = false;
      constructor() {
        created.push(this);
      }
      configure(_value: unknown) {}
      close() {
        this.closed = true;
      }
      reset() {}
    },
    nativeVideoPacket() {},
    performance: { now: () => 0 },
    btoa() {},
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
  const evaluate = (expression: string) => runInContext(expression, context);
  return { support, created, evaluate };
}
it("helper reserves its three pending slots before asynchronous codec probes", async () => {
  const f = allocationFixture();
  await f.evaluate('startCapture("exact",1280,800,1)');
  const pending = [2_000_000, 5_000_000, 12_000_000].map((value) =>
    f.evaluate(`addEncoder("${value}:30","${value}",${value},30)`),
  );
  await expect(f.evaluate('addEncoder("24000000:30","fourth",24000000,30)')).rejects.toThrow(
    "limit",
  );
  expect(f.support).toHaveLength(3);
  for (const resolve of f.support) resolve({ supported: true });
  await Promise.all(pending);
  expect(f.created).toHaveLength(3);
  await f.evaluate("stopCapture()");
});
it("same-key allocation cannot replace or orphan an encoder with a different stream identity", async () => {
  const f = allocationFixture();
  await f.evaluate('startCapture("exact",1280,800,1)');
  const first = f.evaluate('addEncoder("12000000:30","original",12000000,30)');
  const same = f.evaluate('addEncoder("12000000:30","original",12000000,30)');
  await expect(f.evaluate('addEncoder("12000000:30","replacement",12000000,30)')).rejects.toThrow(
    "identity",
  );
  expect(f.support).toHaveLength(1);
  f.support[0]!({ supported: true });
  await Promise.all([first, same]);
  expect(f.created).toHaveLength(1);
  await expect(f.evaluate('addEncoder("12000000:30","replacement",12000000,30)')).rejects.toThrow(
    "identity",
  );
  await f.evaluate("stopCapture()");
});
it("cancelled pending allocation cannot publish after a replacement or capture restart", async () => {
  const f = allocationFixture();
  await f.evaluate('startCapture("exact",1280,800,1)');
  const old = f.evaluate('addEncoder("12000000:30","old",12000000,30)');
  const oldRejected = expect(old).rejects.toThrow("changed");
  f.evaluate('removeEncoder("12000000:30")');
  const newOne = f.evaluate('addEncoder("12000000:30","new",12000000,30)');
  f.support[0]!({ supported: true });
  await oldRejected;
  expect(f.created).toHaveLength(0);
  await f.evaluate("stopCapture()");
  await f.evaluate('startCapture("exact",1280,800,2)');
  const newRejected = expect(newOne).rejects.toThrow("changed");
  f.support[1]!({ supported: true });
  await newRejected;
  expect(f.created).toHaveLength(0);
  await f.evaluate("stopCapture()");
});
