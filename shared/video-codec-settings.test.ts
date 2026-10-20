import { expect, it } from "vitest";
import { readBrowserVideoRpc } from "./browser-video";
import { resolveVideoCodecSettings } from "./video-codec-settings";

it("preserves compatible defaults and separates experimental LAN budgets", () => {
  expect(resolveVideoCodecSettings({})).toEqual({
    codec: "webcodecs",
    bitrate: 12000000,
    fps: 30,
    key: "12000000:30",
  });
  expect(resolveVideoCodecSettings({ codec: "pyrowave" })).toEqual({
    codec: "pyrowave",
    bitrate: 100000000,
    fps: 30,
    key: "pyrowave:100000000:30",
  });
  for (const input of [
    { bitrate: 100000000 },
    { codec: "pyrowave" as const, bitrate: 12000000 },
    { codec: "pyrowave" as const, bitrate: 100000000, fps: 90 },
  ])
    expect(() => resolveVideoCodecSettings(input)).toThrow();
});
it("rejects incompatible codec/bitrate combinations at the authenticated RPC boundary", () => {
  const viewerToken = "v".repeat(32);
  expect(readBrowserVideoRpc.input.safeParse({ viewerToken, bitrate: 100000000 }).success).toBe(
    false,
  );
  expect(
    readBrowserVideoRpc.input.safeParse({ viewerToken, codec: "pyrowave", bitrate: 12000000 })
      .success,
  ).toBe(false);
  expect(
    readBrowserVideoRpc.input.safeParse({ viewerToken, codec: "pyrowave", bitrate: 250000000 })
      .success,
  ).toBe(true);
  expect(readBrowserVideoRpc.input.safeParse({ viewerToken }).success).toBe(true);
});
