/** Final source updates survive FPS/ACK pressure without another source picture. */
import { expect, it } from "vitest";
import { createNativeVideoEncoderFixture as fixture } from "../tests/fixtures/native-video-encoder";
import { NATIVE_VIDEO_FRAME_RETENTION_MS } from "./native-video-frame-source";

it("submits the last changed picture 13.3ms after its predecessor when its deadline arrives", async () => {
  const f = await fixture(false, 60);
  try {
    await f.frame(0);
    f.output();
    f.ack();
    f.advance(13.3);
    const final = await f.frame(13300);
    expect(f.encoded).toHaveLength(1);
    expect(final.closes).toBe(0);
    f.advance(4);
    f.runTimers();
    expect(f.encoded.at(-1)).toEqual({ timestamp: 13300, keyFrame: false });
    expect(final.closes).toBe(1);
    f.output();
    expect(f.packets.at(-1)).toMatchObject({ timestampUs: 13300, captureGeneration: 1 });
    f.advance(100);
    f.runTimers();
    expect(f.encoded).toHaveLength(2);
    expect(f.timerCount()).toBe(0);
  } finally {
    await f.stop();
  }
});

it("keeps the two-slot bound until output and its ACK actually release capacity", async () => {
  const f = await fixture(false, 60);
  try {
    await f.frame(0);
    f.advance(17);
    await f.frame(17000);
    f.advance(13);
    const final = await f.frame(30000);
    f.output();
    f.runTimers();
    expect(f.encoded).toHaveLength(2);
    f.ack();
    f.runTimers();
    expect(f.encoded).toHaveLength(2);
    f.advance(4);
    f.runTimers();
    expect(f.encoded.map((x) => x.timestamp)).toEqual([0, 17000, 30000]);
    expect(f.instances[0]!.pending).toHaveLength(2);
    expect(final.closes).toBe(1);
  } finally {
    await f.stop();
  }
});

it("serves different-rate cohorts independently and cannot repeat a frame for forced keys", async () => {
  const f = await fixture(false, 60);
  try {
    await f.addEncoder("slow", "slow-stream", 2000000, 15);
    await f.frame(0);
    f.output(0);
    f.output(1);
    f.ack();
    f.advance(20);
    const final = await f.frame(20000);
    expect(f.instances[0]!.submitted.map((x) => x.timestamp)).toEqual([0, 20000]);
    expect(f.instances[1]!.submitted.map((x) => x.timestamp)).toEqual([0]);
    f.request();
    f.runTimers();
    expect(f.instances[0]!.submitted).toHaveLength(2);
    f.advance(47);
    f.runTimers();
    expect(f.instances[1]!.submitted.map((x) => x.timestamp)).toEqual([0, 20000]);
    expect(f.instances[0]!.submitted).toHaveLength(2);
    expect(final.closes).toBe(1);
  } finally {
    await f.stop();
  }
});

it("replaces pending pixels with newer pixels and prevents a post-defer catch-up burst", async () => {
  const f = await fixture(false, 60);
  try {
    await f.frame(0);
    f.output();
    f.ack();
    f.advance(13.3);
    const superseded = await f.frame(13300);
    f.advance(1.7);
    const newest = await f.frame(15000);
    expect(superseded.closes).toBe(1);
    f.advance(2);
    f.runTimers();
    expect(f.encoded.map((x) => x.timestamp)).toEqual([0, 15000]);
    expect(newest.closes).toBe(1);
    f.output();
    f.ack();
    // Its source timestamp has advanced enough, but the actual last submission
    // just occurred. The deferred pacing barrier prevents immediate catch-up.
    await f.frame(40000);
    expect(f.encoded).toHaveLength(2);
    f.advance(17);
    f.runTimers();
    expect(f.encoded.map((x) => x.timestamp)).toEqual([0, 15000, 40000]);
  } finally {
    await f.stop();
  }
});

it("retires retained generation pixels and their timer on reset", async () => {
  const f = await fixture(false, 60);
  try {
    await f.frame(0);
    f.output();
    f.ack();
    f.advance(13);
    const old = await f.frame(13000);
    f.reset(2, 100000);
    expect(old.closes).toBe(1);
    expect(f.timerCount()).toBe(0);
    f.advance(100);
    f.runTimers();
    expect(f.encoded).toHaveLength(1);
    await f.frame(120000);
    f.output();
    expect(f.packets.at(-1)).toMatchObject({ timestampUs: 120000, captureGeneration: 2 });
  } finally {
    await f.stop();
  }
});

it("expires a blocked last picture without future input, output or ACKs", async () => {
  const f = await fixture(false, 60);
  try {
    await f.frame(0);
    await f.frame(17000);
    const final = await f.frame(34000);
    f.advance(NATIVE_VIDEO_FRAME_RETENTION_MS);
    f.runTimers();
    expect(final.closes).toBe(1);
    expect(f.timerCount()).toBe(0);
    f.output();
    f.ack();
    f.runTimers();
    expect(f.encoded).toHaveLength(2);
  } finally {
    await f.stop();
  }
});

it("stop releases retained pixels once and cancels every pending wake", async () => {
  const f = await fixture(false, 60);
  await f.frame(0);
  const final = await f.frame(13000);
  await f.stop();
  f.advance(1000);
  f.runTimers();
  expect(final.closes).toBe(1);
  expect(f.timerCount()).toBe(0);
  expect(f.encoded).toHaveLength(1);
});

it.each(["done", "rejection"])("retires the mailbox on terminal reader %s", async (kind) => {
  const f = await fixture(false, 60);
  try {
    await f.frame(0);
    f.advance(13);
    const final = await f.frame(13000);
    if (kind === "done") await f.endReader();
    else await f.failReader();
    expect(final.closes).toBe(1);
    expect(f.timerCount()).toBe(0);
    f.advance(100);
    f.output();
    f.ack();
    f.runTimers();
    expect(f.encoded).toHaveLength(1);
    expect(f.packets.filter((p) => p.sequence !== undefined)).toEqual([]);
    expect(final.closes).toBe(1);
    await expect(f.addEncoder("new", "new-stream")).rejects.toThrow("not running");
  } finally {
    await f.stop();
  }
});
