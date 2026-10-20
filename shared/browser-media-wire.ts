/** Bounded fragmentation for authenticated unordered binary media, never input authority. */
import { z } from "zod";
import {
  type BrowserBinaryVideoPacket,
  type BrowserVideoMetadata,
  browserVideoMetadataSchema,
  VIDEO_MAX_PACKET_BYTES,
} from "./browser-video";

export const BROWSER_MEDIA_PROTOCOL = "paseo-shared-browser-media-v1";
export const BROWSER_MEDIA_MESSAGE_BYTES = 16_384;
export const BROWSER_MEDIA_HEADER_BYTES = 24;
export const BROWSER_MEDIA_PAYLOAD_BYTES = BROWSER_MEDIA_MESSAGE_BYTES - BROWSER_MEDIA_HEADER_BYTES;
export const BROWSER_MEDIA_METADATA_BYTES = 32_768;
export const BROWSER_MEDIA_MAX_FRAME_BYTES =
  VIDEO_MAX_PACKET_BYTES + BROWSER_MEDIA_METADATA_BYTES + 4;
export const BROWSER_MEDIA_FRAME_TTL_MS = 100;
export interface AssembledBrowserMediaFrame {
  transferId: number;
  observationEpoch: number;
  packet: BrowserBinaryVideoPacket;
}
const MAGIC = 0x314d4250;
const VERSION = 1;
const OBSERVATION_MAGIC = 0x31455042;
export const browserMediaObservationEpochSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const envelopeSchema = z.object({
  observationEpoch: browserMediaObservationEpochSchema,
  packet: browserVideoMetadataSchema,
});

/** A viewing-only epoch marker preserves the existing local input-settlement gate.
 * It cannot grant control or change server source timestamps/receipt authority. */
export function writeBrowserMediaObservationEpoch(epoch: number): Uint8Array {
  browserMediaObservationEpochSchema.parse(epoch);
  const bytes = new Uint8Array(12),
    header = new DataView(bytes.buffer);
  header.setUint32(0, OBSERVATION_MAGIC, true);
  header.setUint32(4, epoch % 4294967296, true);
  header.setUint32(8, Math.floor(epoch / 4294967296), true);
  return bytes;
}
/** Parse a fixed-size observation marker, never an input command. */
export function readBrowserMediaObservationEpoch(bytes: Uint8Array): number {
  if (bytes.byteLength !== 12) throw new Error("Invalid media observation marker");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== OBSERVATION_MAGIC)
    throw new Error("Invalid media observation marker");
  return browserMediaObservationEpochSchema.parse(
    header.getUint32(4, true) + header.getUint32(8, true) * 4294967296,
  );
}

/** Serialize only schema-bounded metadata plus encoded bytes. Source timestamps and
 * receipts remain unchanged. Callers must authenticate signaling before any delivery. */
export function encodeBrowserMediaFrame(
  metadata: BrowserVideoMetadata,
  data: Uint8Array,
  observationEpoch = 0,
): Uint8Array {
  if (!data.byteLength || data.byteLength > VIDEO_MAX_PACKET_BYTES)
    throw new Error("Invalid binary video size");
  const validated = envelopeSchema.parse({ packet: metadata, observationEpoch });
  const text = new TextEncoder().encode(JSON.stringify(validated));
  if (!text.byteLength || text.byteLength > BROWSER_MEDIA_METADATA_BYTES)
    throw new Error("Video metadata exceeds its bound");
  const bytes = new Uint8Array(4 + text.byteLength + data.byteLength);
  new DataView(bytes.buffer).setUint32(0, text.byteLength, true);
  bytes.set(text, 4);
  bytes.set(data, 4 + text.byteLength);
  return bytes;
}

/** Each fragment fits the negotiated 16 KiB SCTP message bound. Fresh independent
 * frames can supersede missing work without waiting for a retransmission chain. */
export function fragmentBrowserMediaFrame(frame: Uint8Array, transferId: number): Uint8Array[] {
  if (
    !Number.isInteger(transferId) ||
    transferId < 1 ||
    transferId > 0xffffffff ||
    frame.byteLength < 5 ||
    frame.byteLength > BROWSER_MEDIA_MAX_FRAME_BYTES
  )
    throw new Error("Invalid media transfer");
  const messages: Uint8Array[] = [];
  for (let offset = 0; offset < frame.byteLength; offset += BROWSER_MEDIA_PAYLOAD_BYTES) {
    const length = Math.min(BROWSER_MEDIA_PAYLOAD_BYTES, frame.byteLength - offset);
    const message = new Uint8Array(BROWSER_MEDIA_HEADER_BYTES + length),
      header = new DataView(message.buffer);
    header.setUint32(0, MAGIC, true);
    header.setUint32(4, VERSION, true);
    header.setUint32(8, transferId, true);
    header.setUint32(12, frame.byteLength, true);
    header.setUint32(16, offset, true);
    header.setUint32(20, 0, true);
    message.set(frame.subarray(offset, offset + length), BROWSER_MEDIA_HEADER_BYTES);
    messages.push(message);
  }
  return messages;
}

/** Reassemble at most one bounded newest frame. Older fragments, expired work and
 * duplicates cannot renew its deadline. Malformed headers fail before allocation.
 * The owner must still fence runtime/tab/navigation and observation policy. */
export function createBrowserMediaAssembler(now: () => number) {
  let newest = 0;
  let pending: {
    id: number;
    started: number;
    bytes: Uint8Array;
    received: Uint8Array;
    count: number;
  } | null = null;
  let closed = false;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (expiry !== null) clearTimeout(expiry);
    expiry = null;
    pending = null;
  };
  return {
    receive(message: Uint8Array): AssembledBrowserMediaFrame | null {
      if (closed) return null;
      if (
        message.byteLength <= BROWSER_MEDIA_HEADER_BYTES ||
        message.byteLength > BROWSER_MEDIA_MESSAGE_BYTES
      )
        throw new Error("Invalid media fragment size");
      const header = new DataView(message.buffer, message.byteOffset, BROWSER_MEDIA_HEADER_BYTES);
      const id = header.getUint32(8, true),
        size = header.getUint32(12, true),
        offset = header.getUint32(16, true),
        length = message.byteLength - BROWSER_MEDIA_HEADER_BYTES;
      if (
        header.getUint32(0, true) !== MAGIC ||
        header.getUint32(4, true) !== VERSION ||
        header.getUint32(20, true) !== 0 ||
        !id ||
        size < 5 ||
        size > BROWSER_MEDIA_MAX_FRAME_BYTES ||
        offset % BROWSER_MEDIA_PAYLOAD_BYTES ||
        offset >= size ||
        length !== Math.min(BROWSER_MEDIA_PAYLOAD_BYTES, size - offset)
      )
        throw new Error("Invalid media fragment header");
      if (id < newest) return null;
      if (pending && now() - pending.started > BROWSER_MEDIA_FRAME_TTL_MS) release();
      if (id === newest && !pending) return null;
      if (id > newest) {
        release();
        newest = id;
        pending = {
          id,
          started: now(),
          bytes: new Uint8Array(size),
          received: new Uint8Array(Math.ceil(size / BROWSER_MEDIA_PAYLOAD_BYTES)),
          count: 0,
        };
        expiry = setTimeout(release, BROWSER_MEDIA_FRAME_TTL_MS);
      }
      if (!pending || size !== pending.bytes.byteLength)
        throw new Error("Media frame identity changed");
      const index = offset / BROWSER_MEDIA_PAYLOAD_BYTES;
      if (pending.received[index]) return null;
      pending.bytes.set(message.subarray(BROWSER_MEDIA_HEADER_BYTES), offset);
      pending.received[index] = 1;
      pending.count++;
      if (pending.count !== pending.received.length) return null;
      const bytes = pending.bytes;
      release();
      const metadataLength = new DataView(bytes.buffer).getUint32(0, true);
      if (
        !metadataLength ||
        metadataLength > BROWSER_MEDIA_METADATA_BYTES ||
        metadataLength >= bytes.length - 4 ||
        bytes.length - 4 - metadataLength > VIDEO_MAX_PACKET_BYTES
      )
        throw new Error("Invalid binary media envelope");
      const envelope = envelopeSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + metadataLength)),
        ),
      );
      return {
        transferId: id,
        observationEpoch: envelope.observationEpoch,
        packet: { ...envelope.packet, data: bytes.subarray(4 + metadataLength) },
      };
    },
    /** Revoke late fragments and release the only retained frame buffer. */
    close() {
      closed = true;
      release();
    },
  };
}
