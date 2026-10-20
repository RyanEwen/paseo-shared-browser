/** Silent native drops and delayed callbacks exercise the shipped program's bounded recovery. */
import { expect, it } from "vitest";
import { createNativeVideoEncoderFixture as fixture } from "../tests/fixtures/native-video-encoder";
import {
  NATIVE_ENCODER_MAX_STALL_RECOVERIES,
  NATIVE_ENCODER_OUTPUT_DEADLINE_MS,
} from "./native-video-encoder-source";

it("recovers two silent drops with a fresh independent picture after the deadline", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.output();
    f.ack();
    await f.frame(33333);
    f.drop();
    await f.frame(66666);
    f.drop();
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS - 1);
    f.touch();
    await f.frame(99999);
    expect(f.instances).toHaveLength(1);
    expect(f.encoded).toHaveLength(3);
    f.advance(2);
    f.touch();
    await f.frame(133332);
    expect(f.instances).toHaveLength(2);
    expect(f.instances[0]!.closed).toBe(true);
    expect(f.instances[1]!.submitted).toEqual([{ timestamp: 133332, keyFrame: true }]);
    f.output();
    f.ack();
    await f.frame(166665);
    f.output();
    expect(f.packets.map((p) => [p.sequence, p.type])).toEqual([
      [1, "key"],
      [2, "key"],
      [3, "delta"],
    ]);
  } finally {
    await f.stop();
  }
});

it("preserves delayed output that arrives within the monotonic deadline", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    await f.frame(33333);
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS - 1);
    f.touch();
    await f.frame(66666);
    f.output();
    f.output();
    expect(f.instances).toHaveLength(1);
    expect(f.instances[0]!.closed).toBe(false);
    expect(f.packets.map((p) => p.timestampUs)).toEqual([0, 33333]);
  } finally {
    await f.stop();
  }
});

it("fences late output and errors from a retired codec incarnation", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    await f.frame(33333);
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS + 1);
    f.touch();
    await f.frame(66666);
    f.output(0);
    f.instances[0]!.callbacks.error?.(new Error("Late retired codec error"));
    expect(f.packets).toEqual([]);
    f.output(1);
    f.output(0);
    expect(f.packets.map((p) => [p.type, p.timestampUs])).toEqual([["key", 66666]]);
  } finally {
    await f.stop();
  }
});

it("bounds dropped recovery keys even when unusable deltas still produce output", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.drop();
    for (let attempt = 0; attempt < NATIVE_ENCODER_MAX_STALL_RECOVERIES; attempt++) {
      f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS + 1);
      f.touch();
      const timestamp = (attempt + 1) * 1_100_000;
      await f.frame(timestamp);
      f.drop();
      await f.frame(timestamp + 33333);
      f.output();
      expect(f.packets).toEqual([]);
    }
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS + 1);
    f.touch();
    await f.frame(5_000_000);
    expect(f.instances).toHaveLength(NATIVE_ENCODER_MAX_STALL_RECOVERIES + 1);
    expect(f.instances.every((codec) => codec.closed)).toBe(true);
    expect(f.packets).toEqual([
      { error: "Native video encoder recovery exhausted", streamId: "stream" },
    ]);
    await f.frame(6_000_000);
    expect(f.instances).toHaveLength(NATIVE_ENCODER_MAX_STALL_RECOVERIES + 1);
  } finally {
    await f.stop();
  }
});

it("keeps a healthy sibling cohort running through another codec's recovery", async () => {
  const f = await fixture();
  try {
    await f.addEncoder("low", "healthy");
    await f.frame(0);
    f.output(0);
    f.output(1);
    f.ack();
    for (const timestamp of [33333, 66666]) {
      await f.frame(timestamp);
      f.drop(0);
      f.output(1);
      f.ack();
    }
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS + 1);
    f.touch("high");
    f.touch("low");
    await f.frame(1_100_000);
    f.output(1);
    f.output(2);
    expect(f.instances[1]!.closed).toBe(false);
    expect(f.instances[1]!.submitted.at(-1)?.keyFrame).toBe(false);
    expect(f.packets.filter((p) => p.streamId === "healthy").map((p) => p.type)).toEqual([
      "key",
      "delta",
      "delta",
      "delta",
    ]);
  } finally {
    await f.stop();
  }
});

it("fences recovered work when a new source generation arrives", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    await f.frame(33333);
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS + 1);
    f.touch();
    await f.frame(1_100_000);
    f.reset(2, 1_200_000);
    f.output(0);
    f.output(1);
    expect(f.packets).toEqual([]);
    await f.frame(1_150_000);
    expect(f.instances[1]!.submitted).toHaveLength(1);
    await f.frame(1_250_000);
    f.output(1);
    expect(f.packets).toContainEqual(
      expect.objectContaining({
        captureGeneration: 2,
        timestampUs: 1_250_000,
        type: "key",
      }),
    );
  } finally {
    await f.stop();
  }
});

it("retains ACK pressure without resetting a healthy stalled consumer", async () => {
  const f = await fixture();
  try {
    await f.frame(0);
    f.output();
    await f.frame(33333);
    f.output();
    f.advance(NATIVE_ENCODER_OUTPUT_DEADLINE_MS + 1);
    f.touch();
    await f.frame(1_100_000);
    expect(f.instances).toHaveLength(1);
    expect(f.encoded).toHaveLength(2);
    f.ack();
    await f.frame(1_133_333);
    f.output();
    expect(f.packets.map((p) => p.type)).toEqual(["key", "delta", "delta"]);
  } finally {
    await f.stop();
  }
});
