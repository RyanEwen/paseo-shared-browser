/** Trusted helper correction for the positively qualified software-bitmap path.
 * No colour conversion or range expansion occurs here. Raw encoders can carry the
 * metadata override alongside unchanged planes. WebCodecs requires one bounded
 * copy to reconstruct a VideoFrame with the actual 601 matrix and original geometry.
 */
export const NATIVE_VIDEO_COLOR_SOURCE = `
/** Return only the qualified metadata override; never modify or copy source pixels. */
function softwareCaptureColorOverride(frame, enabled) {
  const color = frame.colorSpace?.toJSON();
  if (!enabled || frame.format !== "I420" || color?.matrix !== "bt709" ||
      color.fullRange !== false || color.primaries !== "bt709" || color.transfer !== "bt709")
    return null;
  const rect = frame.visibleRect;
  if (!rect || rect.x || rect.y || rect.width < 1 || rect.height < 1 ||
      rect.width > 3840 || rect.height > 3840)
    throw new Error("Unexpected software capture geometry");
  return { ...color, matrix: "smpte170m" };
}

async function correctSoftwareCaptureColor(frame, enabled) {
  const color = softwareCaptureColorOverride(frame, enabled);
  if (!color) return frame;
  const rect = frame.visibleRect;
  const length = frame.allocationSize({ rect });
  if (!Number.isInteger(length) || length < 1 || length > 3840 * 3840 * 3 / 2)
    throw new Error("Unexpected software capture size");
  const bytes = new Uint8Array(length);
  const layout = await frame.copyTo(bytes, { rect });
  return new VideoFrame(bytes, {
    format: "I420", codedWidth: rect.width, codedHeight: rect.height,
    displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
    timestamp: frame.timestamp, layout,
    colorSpace: color, transfer: [bytes.buffer],
  });
}
`;
