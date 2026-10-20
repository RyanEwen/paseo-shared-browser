import * as parser from "@trev.zip/pyrowave-webgpu";
import { expect, it } from "vitest";
import { validatePyrowaveFrame } from "./pyrowave-frame";

/** Two bounded block headers with empty coefficient ballots, preceded by a sequence header. */
function frameBytes() {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x80000000 | (63 << 14) | 63, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 2 << 16, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, 2 << 16, true);
  view.setUint32(20, 1 << 8, true);
  return bytes;
}
const geometry = { width: 64, height: 64 };
it("accepts a complete bounded frame without requiring any GPU globals", () => {
  expect(() => validatePyrowaveFrame(frameBytes(), geometry, parser)).not.toThrow();
});
it.each([
  ["wrong dimensions", (view: DataView) => view.setUint32(0, 0x80000000 | (63 << 14) | 65, true)],
  ["wrong chroma", (view: DataView) => view.setUint32(4, (1 << 26) | 2, true)],
  ["unknown header", (view: DataView) => view.setUint32(4, (1 << 24) | 2, true)],
  ["duplicate block", (view: DataView) => view.setUint32(20, 0, true)],
  ["mixed sequence", (view: DataView) => view.setUint32(16, (1 << 28) | (2 << 16), true)],
  ["escaped extent", (view: DataView) => view.setUint32(16, 4095 << 16, true)],
  ["short payload", (view: DataView) => view.setUint32(16, 1 << 16, true)],
  ["extra sequence", (view: DataView) => view.setUint32(16, 0x80000000, true)],
  ["block bounds", (view: DataView) => view.setUint32(20, 0xffffff00, true)],
  ["incomplete frame", (view: DataView) => view.setUint32(4, 3, true)],
] as const)("refuses %s before GPU allocation", (_label, change) => {
  const bytes = frameBytes();
  change(new DataView(bytes.buffer));
  expect(() => validatePyrowaveFrame(bytes, geometry, parser)).toThrow();
});
it("rejects truncated, oversized and unbounded geometry before parsing", () => {
  for (const bytes of [new Uint8Array(12), new Uint8Array(25), new Uint8Array(2097156)]) {
    expect(() => validatePyrowaveFrame(bytes, geometry, parser)).toThrow();
  }
  expect(() =>
    validatePyrowaveFrame(frameBytes(), { width: 16384, height: 16384 }, parser),
  ).toThrow();
});
