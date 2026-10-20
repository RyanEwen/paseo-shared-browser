/** Name a negotiated codec without inferring it from the saved transport choice.
 * Unknown or not-yet-negotiated values return null so callers can say Standard. */
export function describeActiveVideoCodec(codec: string | null | undefined): string | null {
  const value = codec?.toLowerCase();
  if (value === "pyrowave") return "PyroWave LAN";
  if (value?.startsWith("avc1") || value?.startsWith("avc3")) return "H.264";
  if (value?.startsWith("vp8")) return "VP8";
  return null;
}
