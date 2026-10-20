/** Loss, reordering and malformed envelopes cannot create unbounded media work. */
import { afterEach, expect, it, vi } from "vitest";
import { browserVideoTestMetadata } from "../tests/fixtures/browser-video";
import {
  BROWSER_MEDIA_FRAME_TTL_MS,
  BROWSER_MEDIA_MAX_FRAME_BYTES,
  BROWSER_MEDIA_PAYLOAD_BYTES,
  createBrowserMediaAssembler,
  encodeBrowserMediaFrame,
  fragmentBrowserMediaFrame,
} from "./browser-media-wire";

const metadata = browserVideoTestMetadata();
const body = () =>
  encodeBrowserMediaFrame(metadata, new Uint8Array(BROWSER_MEDIA_PAYLOAD_BYTES * 3).fill(7));
afterEach(() => vi.useRealTimers());
it("reassembles reordered fragments without base64 or changing receipt metadata", () => {
  const assembler = createBrowserMediaAssembler(() => 0);
  try {
    const parts = fragmentBrowserMediaFrame(body(), 1).reverse();
    expect(assembler.receive(parts[0]!)).toBeNull();
    expect(assembler.receive(parts[0]!)).toBeNull();
    for (const part of parts.slice(1, -1)) expect(assembler.receive(part)).toBeNull();
    const result = assembler.receive(parts.at(-1)!)!;
    const { data, ...receipt } = result.packet;
    expect(result.transferId).toBe(1);
    expect(receipt).toEqual(metadata);
    expect(data).toEqual(new Uint8Array(BROWSER_MEDIA_PAYLOAD_BYTES * 3).fill(7));
    expect(assembler.receive(parts[0]!)).toBeNull();
  } finally {
    assembler.close();
  }
});
it("supersedes lost frames and expires incomplete storage without accepting late reconstruction", () => {
  vi.useFakeTimers();
  let now = 0;
  const assembler = createBrowserMediaAssembler(() => now);
  const first = fragmentBrowserMediaFrame(body(), 1),
    next = fragmentBrowserMediaFrame(body(), 2);
  assembler.receive(first[0]!);
  assembler.receive(next[0]!);
  expect(assembler.receive(first[1]!)).toBeNull();
  now = BROWSER_MEDIA_FRAME_TTL_MS + 1;
  vi.advanceTimersByTime(now);
  for (const part of next) expect(assembler.receive(part)).toBeNull();
  const fresh = fragmentBrowserMediaFrame(body(), 3);
  let result: ReturnType<typeof assembler.receive> = null;
  for (const part of fresh) result = assembler.receive(part);
  expect(result?.packet.sequence).toBe(1);
  assembler.close();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([0, 4, 12, 16, 20])(
  "refuses corrupt header word at %i before allocating from it",
  (offset) => {
    const assembler = createBrowserMediaAssembler(() => 0),
      part = fragmentBrowserMediaFrame(body(), 1)[0]!;
    new DataView(part.buffer).setUint32(
      offset,
      offset === 12 ? BROWSER_MEDIA_MAX_FRAME_BYTES + 1 : 0xffffffff,
      true,
    );
    try {
      expect(() => assembler.receive(part)).toThrow();
    } finally {
      assembler.close();
    }
  },
);
it("refuses conflicting transfer extents, invalid metadata and all output after close", () => {
  const assembler = createBrowserMediaAssembler(() => 0),
    parts = fragmentBrowserMediaFrame(body(), 1);
  assembler.receive(parts[0]!);
  new DataView(parts[1]!.buffer).setUint32(12, body().length - 1, true);
  expect(() => assembler.receive(parts[1]!)).toThrow();
  assembler.close();
  expect(assembler.receive(parts[0]!)).toBeNull();
  const invalid = new Uint8Array([1, 0, 0, 0, 123, 1]);
  const other = createBrowserMediaAssembler(() => 0);
  try {
    expect(() => other.receive(fragmentBrowserMediaFrame(invalid, 1)[0]!)).toThrow();
  } finally {
    other.close();
  }
});

it("keeps the newest complete picture when two in-flight transfers interleave", () => {
  const assembler = createBrowserMediaAssembler(() => 0);
  const first = fragmentBrowserMediaFrame(body(), 1);
  const next = fragmentBrowserMediaFrame(body(), 2);
  const completed: number[] = [];
  try {
    for (let index = 0; index < next.length; index++) {
      for (const fragment of [first[index]!, next[index]!]) {
        const result = assembler.receive(fragment);
        if (result) completed.push(result.transferId);
      }
    }
    expect(completed).toEqual([2]);
    for (const fragment of first) expect(assembler.receive(fragment)).toBeNull();
  } finally {
    assembler.close();
  }
});
