import type { BrowserVideoMetadata } from "../../shared/browser-video";
/** Fresh, non-secret authority metadata for transport/decoder policy regressions. */
export function browserVideoTestMetadata(): BrowserVideoMetadata {
  return {
    streamId: "s".repeat(32),
    captureGeneration: 1,
    sequence: 1,
    timestampUs: 1000,
    type: "key",
    codec: "pyrowave",
    width: 1280,
    height: 800,
    capturedAt: "2026-10-18T00:00:00.000Z",
    frame: {
      frameId: "f".repeat(32),
      sessionId: "a".repeat(32),
      runtimeId: "r".repeat(32),
      captureEpoch: 1,
      navigationGeneration: 1,
      viewportGeneration: 1,
      width: 1280,
      height: 800,
      capturedAt: "2026-10-18T00:00:00.000Z",
    },
  };
}

/** Complete ready source matching the transport metadata, with no live host identities. */
export function browserVideoTestState(): import("../../shared/browser").BrowserState {
  const metadata = browserVideoTestMetadata();
  return {
    sessionId: metadata.frame.sessionId,
    workspaceId: "owned-media",
    runtimeId: metadata.frame.runtimeId!,
    tabId: "owned-tab",
    bridgeEpoch: metadata.frame.captureEpoch!,
    status: "ready",
    url: "https://fixture.invalid/",
    title: "Owned media fixture",
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1280, height: 800 },
    captureScale: 1,
    navigationGeneration: 1,
    viewportGeneration: 1,
    devicePresetId: null,
    userAgent: "owned fixture",
    controller: "self",
    controllerLabel: "Fixture viewer",
    controllerExpiresAt: null,
    viewerCount: 1,
    error: null,
  };
}

/** Structurally valid SDP for policy tests; no real keys, endpoints or credentials. */
export function browserMediaTestOffer(): string {
  return `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}\r\n`;
}
