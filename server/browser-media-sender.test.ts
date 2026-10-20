import { afterEach, expect, it, vi } from "vitest";
import { browserVideoTestMetadata } from "../tests/fixtures/browser-video";
import { BROWSER_MEDIA_CREDIT_TTL_MS, createBrowserMediaSender } from "./browser-media-sender";

const credit = (id: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, id, true);
  return bytes;
};
afterEach(() => vi.useRealTimers());
it("bounds the pipeline at two frames and never retries a buffered native fragment", () => {
  const sent: Uint8Array[] = [];
  const sender = createBrowserMediaSender(
    {
      isOpen: () => true,
      bufferedAmount: () => 0,
      maxMessageSize: () => 16384,
      sendMessageBinary: (bytes) => {
        sent.push(bytes);
        return false;
      },
    },
    () => true,
  );
  try {
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBe(1);
    expect(sent).toHaveLength(4);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBe(2);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBeNull();
    expect(sent).toHaveLength(8);
    expect(sender.credit(credit(1))).toBe(true);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBe(3);
    expect(sender.credit(credit(1))).toBe(false);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBeNull();
    expect(() => sender.credit(credit(4))).toThrow();
    expect(() => sender.credit(new Uint8Array(5))).toThrow();
  } finally {
    sender.close();
  }
});

it("retires skipped older pictures on a newer presentation without releasing newer work", () => {
  vi.useFakeTimers();
  const sender = createBrowserMediaSender(
    {
      isOpen: () => true,
      bufferedAmount: () => 0,
      maxMessageSize: () => 16384,
      sendMessageBinary: () => true,
    },
    () => true,
  );
  try {
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBe(1);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBe(2);
    // The decoder may supersede picture1 before RAF and present only picture2.
    expect(sender.credit(credit(2))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBe(3);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBe(4);
    expect(sender.credit(credit(1))).toBe(false);
    expect(sender.credit(credit(2))).toBe(false);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBeNull();
    expect(sender.credit(credit(3))).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(BROWSER_MEDIA_CREDIT_TTL_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBe(5);
  } finally {
    sender.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("expires lost credits, refuses buffered links and revokes partial publication on source replacement", () => {
  vi.useFakeTimers();
  let current = true,
    buffered = 0,
    sends = 0;
  const sender = createBrowserMediaSender(
    {
      isOpen: () => true,
      bufferedAmount: () => buffered,
      maxMessageSize: () => 16384,
      sendMessageBinary: () => {
        sends++;
        if (sends === 6) current = false;
        return true;
      },
    },
    () => current,
  );
  sender.send(browserVideoTestMetadata(), new Uint8Array(60000));
  vi.advanceTimersByTime(BROWSER_MEDIA_CREDIT_TTL_MS);
  buffered = 1;
  expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBeNull();
  buffered = 0;
  expect(sender.send(browserVideoTestMetadata(), new Uint8Array(60000))).toBeNull();
  expect(sends).toBe(6);
  sender.close();
  expect(vi.getTimerCount()).toBe(0);
  current = true;
  expect(sender.send(browserVideoTestMetadata(), new Uint8Array(1))).toBeNull();
});
