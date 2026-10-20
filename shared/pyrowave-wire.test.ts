import { expect, it } from "vitest";
import { readPyrowaveHeader, writePyrowaveHeader } from "./pyrowave-wire";

const frame = {
  byteLength: 1536000,
  sequence: 2,
  timestampUs: 2 ** 42 + 13,
  generation: 4,
  format: 1 as const,
};

it("retains exact integer source timestamps and reads headers from offset views", () => {
  const header = writePyrowaveHeader(frame, "raw");
  const padded = new Uint8Array(64);
  padded.set(header, 7);
  expect(readPyrowaveHeader(padded.subarray(7, 39), "raw")).toEqual(frame);
  expect(() => readPyrowaveHeader(header, "encoded")).toThrow();
});

it("refuses oversized, incompatible and truncated framing before native allocation", () => {
  const header = writePyrowaveHeader(frame, "raw");
  for (const [offset, value] of [
    [0, 0],
    [4, 0xffffffff],
    [8, 0],
    [12, 2],
    [20, 0xffffffff],
    [24, 0],
    [28, 2],
  ]) {
    const corrupt = header.slice();
    new DataView(corrupt.buffer).setUint32(offset!, value!, true);
    expect(() => readPyrowaveHeader(corrupt, "raw")).toThrow();
  }
  expect(() => readPyrowaveHeader(header.subarray(0, 31), "raw")).toThrow();
  for (const timestampUs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => writePyrowaveHeader({ ...frame, timestampUs }, "raw")).toThrow();
  }
});
