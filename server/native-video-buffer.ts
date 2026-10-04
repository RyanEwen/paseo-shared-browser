/** Bounded per-encoder packet history. Gaps return a fresh keyframe, never a broken delta chain. */
import {
  type NativeVideoPacket,
  VIDEO_MAX_BATCH_BYTES,
  VIDEO_MAX_BATCH_PACKETS,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../shared/browser-video";
export const NATIVE_VIDEO_MAX_AGE_MS = 1000;
const MAX_RING_BYTES = 8 * 1024 * 1024;
export interface VideoSourceClock {
  sourceMs: number;
  monotonicMs: number;
  wallMs: number;
}
/** Chromium VideoFrame timestamps and CDP Performance.Timestamp share TimeTicks, not JS time origin. */
export function videoSourceTime(
  timestampUs: number,
  clock: VideoSourceClock,
  nowMonotonicMs: number,
): string | null {
  const elapsedMs = timestampUs / 1000 - clock.sourceMs;
  const ageMs = nowMonotonicMs - (clock.monotonicMs + elapsedMs);
  if (
    !Number.isFinite(ageMs) ||
    ageMs < -VIDEO_SOURCE_CLOCK_TOLERANCE_MS ||
    ageMs > NATIVE_VIDEO_MAX_AGE_MS
  )
    return null;
  return new Date(clock.wallMs + elapsedMs).toISOString();
}
export function createNativeVideoBuffer() {
  let packets: NativeVideoPacket[] = [];
  let bytes = 0;
  let lastSequence = 0;
  let needsKey = true;
  const size = (packet: NativeVideoPacket) => Buffer.byteLength(packet.dataBase64, "base64");
  return {
    /** Caller already validated identity/source age. A missing sequence suppresses dependent deltas. */
    add(packet: NativeVideoPacket): boolean {
      if (packet.sequence <= lastSequence) return false;
      if (lastSequence && packet.sequence !== lastSequence + 1) needsKey = true;
      lastSequence = packet.sequence;
      if (needsKey && packet.type !== "key") return false;
      if (packet.type === "key") needsKey = false;
      packets.push(packet);
      bytes += size(packet);
      while (packets.length > VIDEO_MAX_BATCH_PACKETS || bytes > MAX_RING_BYTES) {
        const removed = packets.shift();
        if (removed) bytes -= size(removed);
      }
      return true;
    },
    clear(): void {
      packets = [];
      bytes = 0;
      needsKey = true;
    },
    /** Ask for a fresh key only when this reader cannot recover its retained chain.
     * No observed packet yet and an up-to-date decoder waiting for its next delta
     * are ordinary waiting, not reasons to generate repeated recovery keys. */
    needsKeyFrame(afterSequence: number, nowMs: number): boolean {
      if (!lastSequence) return false;
      if (needsKey) return true;
      const fresh = packets.filter(
        (packet) => nowMs - Date.parse(packet.capturedAt) <= NATIVE_VIDEO_MAX_AGE_MS,
      );
      const first = fresh[0];
      if (!first) return afterSequence < lastSequence;
      if (afterSequence === 0 || afterSequence < first.sequence - 1) {
        return !fresh.some((packet) => packet.type === "key");
      }
      return false;
    },
    /** Returning no packet is honest when all retained source receipts are older than one second. */
    read(afterSequence: number, nowMs: number): NativeVideoPacket[] {
      let candidates = packets.filter(
        (packet) => nowMs - Date.parse(packet.capturedAt) <= NATIVE_VIDEO_MAX_AGE_MS,
      );
      const first = candidates[0];
      if (!first) return [];
      candidates = candidates.filter((packet) => packet.sequence > afterSequence);
      // An independently decodable newer key supersedes all earlier pictures.
      // Catch up before serialization/transport instead of sending a stale GOP.
      // Never skip an arbitrary delta: its successor can depend on that picture.
      const keyIndex = candidates.findLastIndex((packet) => packet.type === "key");
      if (keyIndex >= 0) {
        candidates = candidates.slice(keyIndex);
      } else if (afterSequence < first.sequence - 1 || afterSequence === 0) {
        return [];
      }
      let batchBytes = 0;
      const batch: NativeVideoPacket[] = [];
      for (const packet of candidates) {
        const packetBytes = size(packet);
        if (batchBytes + packetBytes > VIDEO_MAX_BATCH_BYTES) break;
        batchBytes += packetBytes;
        batch.push(packet);
      }
      return batch;
    },
  };
}
