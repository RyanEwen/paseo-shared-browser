/** User-facing playback status is based on actual presentation, separate from saved choices. */
import { describeActiveVideoCodec } from "./browser-video-codec-label";

export type BrowserVideoStatus = "off" | "starting" | "playing" | "unavailable";
/** Keep screenshots/starting/failure distinct from a saved On choice. */
export function browserVideoPlaybackStatus(input: {
  enabled: boolean;
  hasFrame: boolean;
  updating: boolean;
  supported: boolean;
  hostCaptureEnabled: boolean | undefined;
  failed: boolean;
}): BrowserVideoStatus {
  if (!input.enabled) return "off";
  if (input.hasFrame && !input.updating) return "playing";
  if (!input.supported || input.hostCaptureEnabled === false || input.failed) return "unavailable";
  return "starting";
}
/** Generic status for reusable settings pages without a concrete active codec. */
export function describeBrowserVideoStatus(status: BrowserVideoStatus): string {
  switch (status) {
    case "off":
      return "Screenshots active";
    case "playing":
      return "Live video active";
    case "starting":
      return "Starting live video…";
    case "unavailable":
      return "Live video unavailable, screenshots active";
  }
}
/** Name the actual path prominently, including a requested codec that fell back. */
export function describeBrowserVideoTransport(input: {
  status: BrowserVideoStatus;
  updating: boolean;
  activeCodec: string | null;
  requestedPyrowave: boolean;
  fallback: boolean;
}): string {
  if (input.updating) return "Updating video";
  if (input.status === "playing") {
    const codec = describeActiveVideoCodec(input.activeCodec) ?? "Standard";
    if (input.fallback && input.activeCodec !== "pyrowave")
      return `${codec} · PyroWave unavailable`;
    return codec;
  }
  if (input.status === "starting") {
    if (input.requestedPyrowave && !input.fallback) return "Starting PyroWave…";
    if (input.fallback) return "Starting standard video…";
    return "Starting video…";
  }
  if (input.status === "unavailable") return "Video unavailable · screenshots";
  return "Screenshots";
}
