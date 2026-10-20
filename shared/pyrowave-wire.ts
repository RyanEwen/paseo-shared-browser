/** Private native-helper framing. It carries source timing, never input authority. */
export const PYROWAVE_HEADER_BYTES = 32;
export const PYROWAVE_RAW_MAGIC = 0x31525750;
export const PYROWAVE_ENCODED_MAGIC = 0x31455750;
export const PYROWAVE_WIRE_VERSION = 1;
export const PYROWAVE_MAX_RAW_BYTES = (3840 * 3840 * 3) / 2;
export const PYROWAVE_MAX_ENCODED_BYTES = 2 * 1024 * 1024;

export interface PyrowaveFrameHeader {
  byteLength: number;
  sequence: number;
  timestampUs: number;
  generation: number;
  /** Native source layout: NV12 (0) or planar I420 (1). */
  format: 0 | 1;
}

/** Read one complete header before admitting its bounded payload or native work.
 * Payload availability is checked by the stream owner; this also accepts header-only input. */
export function readPyrowaveHeader(
  bytes: Uint8Array,
  kind: "raw" | "encoded",
): PyrowaveFrameHeader {
  if (bytes.byteLength < PYROWAVE_HEADER_BYTES) throw new Error("Truncated PyroWave header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, PYROWAVE_HEADER_BYTES);
  const expected = kind === "raw" ? PYROWAVE_RAW_MAGIC : PYROWAVE_ENCODED_MAGIC;
  const limit = kind === "raw" ? PYROWAVE_MAX_RAW_BYTES : PYROWAVE_MAX_ENCODED_BYTES;
  const byteLength = view.getUint32(4, true);
  const sequence = view.getUint32(8, true);
  const timestampUs = view.getUint32(16, true) + view.getUint32(20, true) * 2 ** 32;
  const generation = view.getUint32(24, true);
  const format = view.getUint32(28, true);
  if (
    view.getUint32(0, true) !== expected ||
    view.getUint32(12, true) !== PYROWAVE_WIRE_VERSION ||
    byteLength === 0 ||
    byteLength > limit ||
    sequence === 0 ||
    generation === 0 ||
    !Number.isSafeInteger(timestampUs) ||
    format > 1
  ) {
    throw new Error("Invalid PyroWave frame header");
  }
  return { byteLength, sequence, timestampUs, generation, format: format as 0 | 1 };
}

/** Serialize the fixed little-endian header and validate the exact resulting contract. */
export function writePyrowaveHeader(
  header: PyrowaveFrameHeader,
  kind: "raw" | "encoded",
): Uint8Array {
  const words = [header.byteLength, header.sequence, header.generation, header.format];
  if (
    words.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff) ||
    !Number.isSafeInteger(header.timestampUs) ||
    header.timestampUs < 0
  ) {
    throw new Error("Invalid PyroWave header values");
  }
  const bytes = new Uint8Array(PYROWAVE_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, kind === "raw" ? PYROWAVE_RAW_MAGIC : PYROWAVE_ENCODED_MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  view.setUint32(8, header.sequence, true);
  view.setUint32(12, PYROWAVE_WIRE_VERSION, true);
  view.setUint32(16, header.timestampUs % 2 ** 32, true);
  view.setUint32(20, Math.floor(header.timestampUs / 2 ** 32), true);
  view.setUint32(24, header.generation, true);
  view.setUint32(28, header.format, true);
  readPyrowaveHeader(bytes, kind);
  return bytes;
}
