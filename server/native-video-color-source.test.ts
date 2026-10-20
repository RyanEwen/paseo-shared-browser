import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { NATIVE_VIDEO_COLOR_SOURCE } from "./native-video-color-source";

/** Run the shipped helper; a buffer-only VideoFrame constructor catches the
 * unsupported alternative of assigning colour through a frame-clone initializer. */
function fixture() {
  const construct = vi.fn();
  const context = createContext({
    Uint8Array,
    Number,
    VideoFrame: class {
      constructor(bytes: Uint8Array, init: unknown) {
        if (!(bytes instanceof Uint8Array)) throw new Error("Expected copied planes");
        construct(bytes, init);
      }
    },
  });
  runInContext(NATIVE_VIDEO_COLOR_SOURCE, context);
  const color = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
  const layout = [
    { offset: 0, stride: 64 },
    { offset: 4096, stride: 32 },
    { offset: 5120, stride: 32 },
  ];
  const frame = {
    format: "I420",
    colorSpace: { toJSON: () => color },
    timestamp: 12345,
    visibleRect: { x: 0, y: 0, width: 64, height: 64 },
    displayWidth: 65,
    displayHeight: 64,
    allocationSize: vi.fn(() => 6144),
    copyTo: vi.fn(async (bytes: Uint8Array) => {
      bytes.fill(145);
      return layout;
    }),
  };
  context.frame = frame;
  const correct = (enabled: boolean) =>
    runInContext(`correctSoftwareCaptureColor(frame,${enabled})`, context);
  return { construct, color, frame, correct, layout };
}

it("copies unchanged planes with the measured601 matrix and preserves source time/display geometry", async () => {
  const f = fixture();
  await f.correct(true);
  expect(f.construct).toHaveBeenCalledOnce();
  const [bytes, init] = f.construct.mock.calls[0]!;
  expect(bytes.byteLength).toBe(6144);
  expect(bytes.every((value: number) => value === 145)).toBe(true);
  expect(init).toMatchObject({
    format: "I420",
    codedWidth: 64,
    codedHeight: 64,
    displayWidth: 65,
    displayHeight: 64,
    timestamp: 12345,
    layout: f.layout,
    colorSpace: { ...f.color, matrix: "smpte170m" },
    transfer: [bytes.buffer],
  });
  expect(f.color.matrix).toBe("bt709");
});

it("preserves all unqualified frames without copying or reinterpreting their colour", async () => {
  const f = fixture();
  expect(await f.correct(false)).toBe(f.frame);
  f.frame.format = "NV12";
  expect(await f.correct(true)).toBe(f.frame);
  f.frame.format = "I420";
  f.color.matrix = "smpte170m";
  expect(await f.correct(true)).toBe(f.frame);
  f.color.matrix = "bt709";
  f.color.fullRange = true;
  expect(await f.correct(true)).toBe(f.frame);
  expect(f.frame.copyTo).not.toHaveBeenCalled();
  expect(f.construct).not.toHaveBeenCalled();
});

it("bounds allocations and keeps copy failure terminal before reconstructing a frame", async () => {
  const f = fixture();
  f.frame.allocationSize.mockReturnValueOnce(3840 * 3840 * 4);
  await expect(f.correct(true)).rejects.toThrow("size");
  expect(f.frame.copyTo).not.toHaveBeenCalled();
  f.frame.copyTo.mockRejectedValueOnce(new Error("Readback failed"));
  await expect(f.correct(true)).rejects.toThrow("Readback failed");
  expect(f.construct).not.toHaveBeenCalled();
});

it("awaits one source copy before reconstructing or publishing its corrected frame", async () => {
  const f = fixture();
  const copy = Promise.withResolvers<typeof f.layout>();
  f.frame.copyTo.mockReturnValueOnce(copy.promise);
  const pending = f.correct(true);
  await Promise.resolve();
  expect(f.construct).not.toHaveBeenCalled();
  copy.resolve(f.layout);
  await pending;
  expect(f.construct).toHaveBeenCalledOnce();
});
