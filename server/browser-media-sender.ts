/** Credit-paced binary delivery. No queue can grow behind a slow decoder or link. */
import {
  BROWSER_MEDIA_MESSAGE_BYTES,
  encodeBrowserMediaFrame,
  fragmentBrowserMediaFrame,
} from "../shared/browser-media-wire";
import type { BrowserVideoMetadata } from "../shared/browser-video";

export const BROWSER_MEDIA_CREDIT_TTL_MS = 150;
export const BROWSER_MEDIA_MAX_IN_FLIGHT_FRAMES = 2;
export interface BrowserMediaChannel {
  isOpen(): boolean;
  bufferedAmount(): number;
  maxMessageSize(): number;
  /** Native send may report buffering rather than failure. Never retry a fragment on false. */
  sendMessageBinary(bytes: Uint8Array): boolean;
}

/** Overlap delivery and presentation of at most two independent pictures, without a queue.
 * A receiver credits only actual presentation. Lost frames expire; native buffering must
 * drain before admitting another picture. The authenticated peer fences every send. */
export function createBrowserMediaSender(channel: BrowserMediaChannel, isCurrent: () => boolean) {
  let closed = false,
    lastId = 0;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  /** Release transport capacity only; this never grants frame or input authority. */
  const release = (id: number) => {
    const timer = pending.get(id);
    if (timer !== undefined) clearTimeout(timer);
    pending.delete(id);
  };
  const clear = () => {
    for (const id of pending.keys()) release(id);
  };
  return {
    send(metadata: BrowserVideoMetadata, data: Uint8Array, observationEpoch = 0): number | null {
      if (
        closed ||
        pending.size >= BROWSER_MEDIA_MAX_IN_FLIGHT_FRAMES ||
        !isCurrent() ||
        !channel.isOpen() ||
        channel.bufferedAmount() > 0
      )
        return null;
      if (channel.maxMessageSize() < BROWSER_MEDIA_MESSAGE_BYTES || lastId === 0xffffffff)
        throw new Error("Media transport bounds changed");
      const frame = encodeBrowserMediaFrame(metadata, data, observationEpoch),
        id = ++lastId;
      const messages = fragmentBrowserMediaFrame(frame, id);
      pending.set(
        id,
        setTimeout(() => release(id), BROWSER_MEDIA_CREDIT_TTL_MS),
      );
      for (const message of messages) {
        if (closed || !isCurrent() || !channel.isOpen()) {
          clear();
          return null;
        }
        // send(false) can mean accepted but buffered; duplicate publication is unsafe.
        channel.sendMessageBinary(message);
      }
      return id;
    },
    /** A presented newer picture retires superseded transport slots as well as its own.
     * The decoder can discard an older decoded picture before paint, so waiting for that
     * picture's exact credit would stall until expiry. Old credits cannot release newer
     * transfers; future IDs are malformed. Observation/input receipts remain separate. */
    credit(bytes: Uint8Array): boolean {
      if (closed) return false;
      if (bytes.byteLength !== 4) throw new Error("Invalid media credit");
      const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
      if (!id || id > lastId) throw new Error("Unknown media credit");
      if (!pending.has(id)) return false;
      for (const transferId of pending.keys()) {
        if (transferId <= id) release(transferId);
      }
      return true;
    },
    close() {
      closed = true;
      clear();
    },
  };
}
