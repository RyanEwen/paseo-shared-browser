/** Verify copy ownership through the shipped capture loop, including mixed codec viewers. */
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "./native-video-extension-source";

it.each([
  { compatible: false, boundary: null },
  { compatible: true, boundary: null },
  { compatible: true, boundary: "reset" },
  { compatible: true, boundary: "replace" },
  { compatible: true, boundary: "expired" },
])(
  "owns colour-copy frames with $compatible standard viewer and $boundary boundary",
  async ({ compatible, boundary }) => {
    let deliver: (value: unknown) => void = () => {};
    const copy = vi.fn();
    let clockNow = 1;
    let releaseCopy = () => {};
    const copying = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const reconstructed = vi.fn();
    const encoded = vi.fn();
    const sentColors: unknown[] = [];
    const errors: unknown[] = [];
    const frames: Frame[] = [];
    const originalColor = {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false,
    };
    class Frame {
      format = "I420";
      timestamp = 100000;
      visibleRect = { x: 0, y: 0, width: 64, height: 64 };
      displayWidth = 64;
      displayHeight = 64;
      colorSpace = { toJSON: () => originalColor };
      close = vi.fn();
      constructor(source?: Frame | Uint8Array, init?: { colorSpace: typeof originalColor }) {
        if (source instanceof Uint8Array) {
          reconstructed();
          this.colorSpace = { toJSON: () => init!.colorSpace };
        } else if (source) this.colorSpace = source.colorSpace;
        frames.push(this);
      }
      allocationSize() {
        return 6144;
      }
      async copyTo(bytes: Uint8Array) {
        copy(this);
        if (boundary) await copying;
        bytes.fill(145);
        return [
          { offset: 0, stride: 64 },
          { offset: 4096, stride: 32 },
          { offset: 5120, stride: 32 },
        ];
      }
    }
    class Socket {
      static OPEN = 1;
      readyState = 1;
      addEventListener(name: string, callback: () => void) {
        if (name === "open") queueMicrotask(callback);
      }
      close() {}
      send(bytes: string | ArrayBuffer) {
        if (typeof bytes === "string") sentColors.push(JSON.parse(bytes));
      }
    }
    class Encoder {
      static async isConfigSupported() {
        return { supported: true };
      }
      encodeQueueSize = 0;
      configure() {}
      close() {}
      encode(frame: Frame) {
        encoded(frame);
      }
    }
    const reader = {
      read: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
      cancel: async () => {
        deliver({ done: true });
      },
    };
    const context = createContext({
      chrome: {
        debugger: { getTargets: async () => [{ id: "owned", type: "page", tabId: 1 }] },
        tabCapture: { getMediaStreamId: async () => "owned-stream" },
      },
      navigator: {
        mediaDevices: {
          getUserMedia: async () => ({
            getVideoTracks: () => [{ getSettings: () => ({ width: 64, height: 64 }) }],
            getTracks: () => [{ stop() {} }],
          }),
        },
      },
      MediaStreamTrackProcessor: class {
        readable = { getReader: () => reader };
      },
      VideoFrame: Frame,
      VideoEncoder: Encoder,
      WebSocket: Socket,
      Uint8Array,
      ArrayBuffer,
      DataView,
      setTimeout,
      clearTimeout,
      performance: { now: () => clockNow },
      nativeVideoPacket: (value: string) => errors.push(JSON.parse(value)),
    });
    runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
    await runInContext('startCapture("owned",64,64,1,true)', context);
    try {
      if (boundary !== "expired")
        await runInContext(
          `addRawEncoder("raw","stream",100000000,30,"ws://127.0.0.1:1234/capture","${"s".repeat(43)}")`,
          context,
        );
      if (compatible) await runInContext('addEncoder("low","compatible")', context);
      const frame = new Frame();
      deliver({ value: frame, done: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(copy).toHaveBeenCalledTimes(compatible && boundary !== "expired" ? 2 : 1);
      if (boundary) {
        // A reset with a permissive timestamp still cannot relabel an in-progress
        // old-generation plane copy. Replacement revokes the whole source instead.
        if (boundary === "expired") clockNow += 251;
        const reset =
          boundary === "expired"
            ? undefined
            : runInContext(
                boundary === "reset" ? "resetCapture(2,0)" : 'startCapture("owned",64,64,2,true)',
                context,
              );
        releaseCopy();
        await reset;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(encoded).not.toHaveBeenCalled();
        expect(
          runInContext("capture.latestFrame === null && capture.frameTimer === null", context),
        ).toBe(true);
        expect(sentColors).toEqual([]);
        expect(frames.every((owned) => owned.close.mock.calls.length === 1)).toBe(true);
        expect(errors).toEqual([]);
        return;
      }
      expect(reconstructed).toHaveBeenCalledTimes(compatible ? 1 : 0);
      expect(sentColors).toEqual([{ ...originalColor, matrix: "smpte170m" }]);
      expect(originalColor.matrix).toBe("bt709");
      expect(encoded).toHaveBeenCalledTimes(compatible ? 1 : 0);
      if (compatible) expect(encoded.mock.calls[0]![0].colorSpace.toJSON()).toEqual(sentColors[0]);
      expect(frames.every((owned) => owned.close.mock.calls.length === 1)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await runInContext("stopCapture()", context);
    }
  },
);
