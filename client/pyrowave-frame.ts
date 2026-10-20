/** Strict CPU preflight before a WebGPU decoder can allocate from encoded metadata. */
import { VIDEO_MAX_PACKET_BYTES } from "../shared/browser-video";
import { pyrowaveDimensionsSchema } from "../shared/pyrowave-settings";

type Bitstream = Pick<
  typeof import("@trev.zip/pyrowave-webgpu"),
  "Layout" | "parseBlockHeader" | "parseSequenceHeader"
>;

/** Validate one complete independent I420 frame against authoritative packet geometry.
 * Input bytes, dimensions, block indices, payload extents, sequence and completeness
 * are bounded before any GPU work. The pinned parser is supplied only on web clients. */
export function validatePyrowaveFrame(
  bytes: Uint8Array,
  geometry: { width: number; height: number },
  parser: Bitstream,
): void {
  pyrowaveDimensionsSchema.parse(geometry);
  if (bytes.byteLength < 16 || bytes.byteLength > VIDEO_MAX_PACKET_BYTES || bytes.byteLength % 4) {
    throw new Error("Invalid PyroWave frame size");
  }
  const first = parser.parseBlockHeader(bytes, 0);
  const header = parser.parseSequenceHeader(bytes, 0);
  if (
    !first.extended ||
    header.code !== 0 ||
    header.chroma !== "420" ||
    header.width !== geometry.width ||
    header.height !== geometry.height
  ) {
    throw new Error("PyroWave frame does not match current view");
  }
  const layout = new parser.Layout(geometry.width, geometry.height, "420");
  if (header.totalBlocks < 1 || header.totalBlocks > layout.blockCount) {
    throw new Error("Invalid PyroWave block count");
  }
  const seen = new Set<number>();
  for (let offset = 8; offset < bytes.byteLength; ) {
    if (bytes.byteLength - offset < 8) throw new Error("Truncated PyroWave block");
    const block = parser.parseBlockHeader(bytes, offset);
    const size = block.payloadWords * 4;
    if (
      block.extended ||
      block.sequence !== header.sequence ||
      size < 8 ||
      size > bytes.byteLength - offset ||
      block.blockIndex >= layout.blockCount ||
      seen.has(block.blockIndex)
    ) {
      throw new Error("Invalid PyroWave block");
    }
    seen.add(block.blockIndex);
    if (seen.size > header.totalBlocks) throw new Error("Unexpected PyroWave blocks");
    offset += size;
  }
  if (seen.size !== header.totalBlocks) throw new Error("Incomplete PyroWave frame");
}
