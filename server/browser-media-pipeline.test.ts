import { expect, it, vi } from "vitest";
import { createBrowserMediaReceiver } from "../client/browser-media-receiver";
import {
  type BrowserVideoDecodeEnvironment,
  createBrowserVideoDecoder,
} from "../client/browser-video-decoder";
import { browserVideoTestMetadata } from "../tests/fixtures/browser-video";
import { createBrowserMediaSender } from "./browser-media-sender";

it("recovers both transport slots when the actual decoder skips an older paint", () => {
  vi.useFakeTimers();
  let paint: (() => void) | null = null;
  let callbacks: Parameters<BrowserVideoDecodeEnvironment["createDecoder"]>[0];
  const closed: number[] = [];
  const presented: number[] = [];
  const decoder = createBrowserVideoDecoder({
    environment: {
      createDecoder(value) {
        callbacks = value;
        return {
          decodeQueueSize: 0,
          configure() {},
          decode(chunk) {
            const { timestamp } = chunk as { timestamp: number };
            callbacks.output({
              timestamp,
              displayWidth: 1280,
              displayHeight: 800,
              close: () => closed.push(timestamp),
            });
          },
          close() {},
        };
      },
      createChunk: (chunk) => chunk,
      decodeBase64: () => new Uint8Array(),
      draw() {},
      scheduleDraw(draw) {
        paint = draw;
        return () => {
          paint = null;
        };
      },
    },
    isCurrent: () => true,
    onPresented(packet) {
      presented.push(packet.sequence);
      receiver.presented(packet);
    },
    onNeedKeyFrame: () => {
      throw new Error("Independent picture requested a keyframe");
    },
    onError: (error) => {
      throw error;
    },
  });
  const receiver = createBrowserMediaReceiver({
    now: () => 0,
    isCurrent: () => true,
    onPicture: (packet, epoch) => decoder.receive(packet, epoch),
    sendCredit: (bytes) => sender.credit(bytes),
  });
  const sender = createBrowserMediaSender(
    {
      isOpen: () => true,
      bufferedAmount: () => 0,
      maxMessageSize: () => 16384,
      sendMessageBinary(bytes) {
        receiver.receive(bytes);
        return true;
      },
    },
    () => true,
  );
  const send = (sequence: number) =>
    sender.send(
      { ...browserVideoTestMetadata(), sequence, timestampUs: sequence * 1000 },
      new Uint8Array([1]),
    );
  try {
    expect(send(1)).toBe(1);
    expect(send(2)).toBe(2);
    expect(send(3)).toBeNull();
    expect(closed).toEqual([1000]);
    expect(presented).toEqual([]);
    const draw = paint as (() => void) | null;
    expect(draw).not.toBeNull();
    draw?.();
    expect(presented).toEqual([2]);
    expect(vi.getTimerCount()).toBe(0);
    // No timeout or synthetic receipt for picture1 is needed to resume delivery.
    expect(send(3)).toBe(3);
    expect(send(4)).toBe(4);
  } finally {
    decoder.close();
    receiver.close();
    sender.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
