import { expect, it } from "vitest";
import { browserVideoPlaybackStatus, describeBrowserVideoTransport } from "./browser-video-status";

it("names actual playback separately from a requested PyroWave choice", () => {
  const input = { status: "playing" as const, updating: false, requestedPyrowave: true };
  expect(
    describeBrowserVideoTransport({ ...input, activeCodec: "pyrowave", fallback: false }),
  ).toBe("PyroWave LAN");
  expect(
    describeBrowserVideoTransport({ ...input, activeCodec: "avc1.42002a", fallback: true }),
  ).toBe("H.264 · PyroWave unavailable");
  expect(
    describeBrowserVideoTransport({
      ...input,
      status: "starting",
      activeCodec: null,
      fallback: true,
    }),
  ).toBe("Starting standard video…");
  expect(
    describeBrowserVideoTransport({
      ...input,
      status: "unavailable",
      activeCodec: null,
      fallback: true,
    }),
  ).toBe("Video unavailable · screenshots");
});
it("an On preference cannot claim live playback before an actual presented frame", () => {
  const input = {
    enabled: true,
    updating: false,
    supported: true,
    hostCaptureEnabled: true,
    failed: false,
  };
  expect(browserVideoPlaybackStatus({ ...input, hasFrame: false })).toBe("starting");
  expect(browserVideoPlaybackStatus({ ...input, hasFrame: true })).toBe("playing");
  expect(browserVideoPlaybackStatus({ ...input, hasFrame: false, failed: true })).toBe(
    "unavailable",
  );
});

it.each([
  ["avc1.420033", "H.264"],
  ["avc3.640028", "H.264"],
  ["vp8", "VP8"],
  ["vp8.0", "VP8"],
  ["pyrowave", "PyroWave LAN"],
  [null, "Standard"],
  ["unknown", "Standard"],
])("names the presented %s codec in the browser bar", (activeCodec, label) => {
  const input = {
    status: "playing" as const,
    updating: false,
    activeCodec,
    requestedPyrowave: false,
    fallback: false,
  };
  expect(describeBrowserVideoTransport(input)).toBe(label);
  // A retained front must not claim the old codec while replacement is pending.
  expect(describeBrowserVideoTransport({ ...input, updating: true })).toBe("Updating video");
  expect(describeBrowserVideoTransport({ ...input, status: "off" })).toBe("Screenshots");
});
