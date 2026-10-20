/** Binary media feeds the existing decoder; only actual current presentation earns credit. */
import { createBrowserMediaAssembler } from "../shared/browser-media-wire";
import type { BrowserBinaryVideoPacket, BrowserVideoMetadata } from "../shared/browser-video";

export interface BrowserMediaReceiverOptions {
  now(): number;
  isCurrent(packet: BrowserVideoMetadata): boolean;
  onPicture(packet: BrowserBinaryVideoPacket, observationEpoch: number): void;
  sendCredit(bytes: Uint8Array): void;
}

/** Retain no independent authority or byte queue. The decoder owns its bounded pictures;
 * weak transfer associations disappear with those pictures, and close revokes late paints. */
export function createBrowserMediaReceiver(options: BrowserMediaReceiverOptions) {
  const assembler = createBrowserMediaAssembler(options.now);
  let transfers = new WeakMap<BrowserVideoMetadata, number>(),
    closed = false;
  return {
    receive(bytes: Uint8Array): void {
      if (closed) return;
      const frame = assembler.receive(bytes);
      if (!frame || !options.isCurrent(frame.packet)) return;
      transfers.set(frame.packet, frame.transferId);
      options.onPicture(frame.packet, frame.observationEpoch);
    },
    /** A decoded frame can remain visually current without granting any control lease. */
    presented(packet: BrowserVideoMetadata): void {
      if (closed || !options.isCurrent(packet)) return;
      const id = transfers.get(packet);
      if (id === undefined) return;
      transfers.delete(packet);
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, id, true);
      options.sendCredit(bytes);
    },
    close() {
      closed = true;
      assembler.close();
      transfers = new WeakMap();
    },
  };
}
