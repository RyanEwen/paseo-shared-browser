/** Route changes keep native resources while retiring old document output. */
import { expect, it } from "vitest";
import { createNativeVideoEncoderFixture } from "../tests/fixtures/native-video-encoder";

it("keeps the codec and outstanding native slots across a document boundary", async () => {
  const f = await createNativeVideoEncoderFixture();
  try {
    await f.frame(0);
    await f.frame(33333);
    f.reset(2, 100000);
    await f.frame(125000);
    expect(f.instances).toHaveLength(1);
    expect(f.encoded).toHaveLength(2);
    expect(f.instances[0]!.closed).toBe(false);
    f.output();
    f.output();
    expect(f.packets).toEqual([]);
    await f.frame(150000);
    expect(f.encoded.at(-1)?.keyFrame).toBe(true);
    f.output();
    expect(f.packets).toEqual([
      expect.objectContaining({ captureGeneration: 2, timestampUs: 150000, type: "key" }),
    ]);
  } finally {
    await f.stop();
  }
});

it("cannot let late old-document output revoke a new key or publish old pixels", async () => {
  const f = await createNativeVideoEncoderFixture();
  try {
    await f.frame(0);
    f.reset(2, 100000);
    await f.frame(125000);
    // Model a late old native callback after the new independent output.
    f.instances[0]!.pending.reverse();
    f.output();
    f.output();
    expect(f.packets).toHaveLength(1);
    expect(f.packets[0]).toMatchObject({ captureGeneration: 2, type: "key" });
    f.ack();
    await f.frame(175000);
    expect(f.encoded.at(-1)?.keyFrame).toBe(false);
    f.output();
    expect(f.packets.at(-1)).toMatchObject({ captureGeneration: 2, type: "delta" });
  } finally {
    await f.stop();
  }
});

it("coalesces repeated route boundaries into the latest generation's fresh key", async () => {
  const f = await createNativeVideoEncoderFixture();
  try {
    await f.frame(0);
    f.reset(2, 100000);
    f.reset(3, 200000);
    f.output();
    await f.frame(150000);
    expect(f.encoded).toHaveLength(1);
    await f.frame(225000);
    f.output();
    expect(f.instances).toHaveLength(1);
    expect(f.packets).toEqual([
      expect.objectContaining({ captureGeneration: 3, timestampUs: 225000, type: "key" }),
    ]);
  } finally {
    await f.stop();
  }
});

it("recovers silently dropped old-generation work without freeing a live codec slot", async () => {
  const f = await createNativeVideoEncoderFixture();
  try {
    await f.frame(0);
    f.drop();
    await f.frame(33333);
    f.drop();
    f.reset(2, 100000);
    await f.frame(125000);
    expect(f.instances).toHaveLength(1);
    expect(f.encoded).toHaveLength(2);
    f.advance(1001);
    f.touch();
    await f.frame(150000);
    expect(f.instances).toHaveLength(2);
    expect(f.instances[0]!.closed).toBe(true);
    f.output();
    expect(f.packets).toEqual([
      expect.objectContaining({ captureGeneration: 2, timestampUs: 150000, type: "key" }),
    ]);
  } finally {
    await f.stop();
  }
});

it("cannot let a late old receipt ACK release new-generation output pressure", async () => {
  const f = await createNativeVideoEncoderFixture();
  try {
    await f.frame(0);
    f.output();
    f.reset(2, 100000);
    await f.frame(125000);
    f.output();
    await f.frame(166667);
    f.output();
    f.acknowledge("stream", 1);
    await f.frame(210000);
    f.runTimers();
    expect(f.encoded).toHaveLength(3);
    f.acknowledge("stream", 2);
    f.runTimers();
    expect(f.encoded.at(-1)?.timestamp).toBe(210000);
    expect(f.encoded).toHaveLength(4);
  } finally {
    await f.stop();
  }
});
