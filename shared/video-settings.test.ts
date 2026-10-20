import { expect, it } from "vitest";
import { captureBrowserRpc } from "./browser";
import {
  browserDisplayPreferences,
  browserDisplayPreferencesSchema,
} from "./browser-display-preferences";
import { readBrowserVideoRpc } from "./browser-video";
import { JPEG_QUALITY } from "./capture-settings";
import { resolveVideoEncoderSettings, videoEncoderKey } from "./video-settings";

it("retains current defaults and migrates the old coupled quality without losing favorites", () => {
  expect(resolveVideoEncoderSettings({})).toEqual({ bitrate: 12_000_000, fps: 30 });
  const migrated = browserDisplayPreferences.migrate?.(
    { captureQuality: "low", favoritePresetIds: ["pixel-7-sharp"] },
    1,
  );
  expect(browserDisplayPreferencesSchema.parse(migrated)).toEqual({
    videoCodec: "webcodecs",
    pyrowaveBitrate: 100_000_000,
    graphicsPreference: "host-default",
    liveVideoEnabled: false,
    captureQuality: "low",
    favoritePresetIds: ["pixel-7-sharp"],
    videoBitrate: 2_000_000,
    videoFps: 30,
  });
});
it("accepts explicit JPEG100 and video24Mbps60fps, and refuses arbitrary settings", () => {
  const viewerToken = "v".repeat(32);
  expect(captureBrowserRpc.input.parse({ viewerToken, quality: "maximum" }).quality).toBe(
    "maximum",
  );
  expect(JPEG_QUALITY.maximum).toBe(100);
  expect(
    readBrowserVideoRpc.input.parse({ viewerToken, bitrate: 24_000_000, fps: 60 }),
  ).toMatchObject({ bitrate: 24_000_000, fps: 60 });
  for (const invalid of [{ bitrate: 25_000_000 }, { fps: 120 }, { fps: NaN }, { bitrate: 0 }])
    expect(readBrowserVideoRpc.input.safeParse({ viewerToken, ...invalid }).success).toBe(false);
  expect(videoEncoderKey(resolveVideoEncoderSettings({ bitrate: 24_000_000, fps: 15 }))).toBe(
    "24000000:15",
  );
});

it.each([48_000_000, 96_000_000])(
  "admits optional %s Standard video without migrating saved choices",
  (bitrate) => {
    const viewerToken = "v".repeat(32);
    expect(readBrowserVideoRpc.input.parse({ viewerToken, bitrate, fps: 60 })).toMatchObject({
      bitrate,
      fps: 60,
    });
    expect(browserDisplayPreferencesSchema.parse({ videoBitrate: bitrate }).videoBitrate).toBe(
      bitrate,
    );
    expect(resolveVideoEncoderSettings({}).bitrate).toBe(12_000_000);
    expect(browserDisplayPreferencesSchema.parse({ videoBitrate: 24_000_000 }).videoBitrate).toBe(
      24_000_000,
    );
    expect(
      readBrowserVideoRpc.input.safeParse({ viewerToken, codec: "pyrowave", bitrate }).success,
    ).toBe(false);
  },
);

it("migrates old host settings to an explicit off choice and preserves a saved on choice", () => {
  const old = {
    captureQuality: "maximum",
    videoBitrate: 24_000_000,
    videoFps: 60,
    favoritePresetIds: ["pixel-7-sharp"],
  };
  const migrated = browserDisplayPreferencesSchema.parse(
    browserDisplayPreferences.migrate?.(old, 2),
  );
  expect(migrated).toEqual({
    ...old,
    liveVideoEnabled: false,
    graphicsPreference: "host-default",
    videoCodec: "webcodecs",
    pyrowaveBitrate: 100_000_000,
  });
  expect(
    browserDisplayPreferencesSchema.parse({ ...old, liveVideoEnabled: true }).liveVideoEnabled,
  ).toBe(true);
  expect(browserDisplayPreferencesSchema.safeParse({ liveVideoEnabled: "true" }).success).toBe(
    false,
  );
});

it("migrates version3 graphics without changing saved video or favorites and validates an explicit choice", () => {
  const previous = {
    liveVideoEnabled: true,
    captureQuality: "maximum",
    videoBitrate: 24_000_000,
    videoFps: 60,
    favoritePresetIds: ["pixel-7-sharp"],
  };
  expect(
    browserDisplayPreferencesSchema.parse(browserDisplayPreferences.migrate?.(previous, 3)),
  ).toEqual({
    ...previous,
    graphicsPreference: "host-default",
    videoCodec: "webcodecs",
    pyrowaveBitrate: 100_000_000,
  });
  expect(
    browserDisplayPreferencesSchema.parse({ ...previous, graphicsPreference: "vulkan" })
      .graphicsPreference,
  ).toBe("vulkan");
  expect(
    browserDisplayPreferencesSchema.safeParse({ graphicsPreference: "automatic" }).success,
  ).toBe(false);
});

it("migrates version4 without changing graphics, video rates or favorites and adds an explicit compatible codec default", () => {
  const previous = {
    graphicsPreference: "vulkan",
    liveVideoEnabled: true,
    captureQuality: "maximum",
    videoBitrate: 24000000,
    videoFps: 60,
    favoritePresetIds: ["pixel-7-sharp"],
  };
  expect(
    browserDisplayPreferencesSchema.parse(browserDisplayPreferences.migrate?.(previous, 4)),
  ).toEqual({ ...previous, videoCodec: "webcodecs", pyrowaveBitrate: 100000000 });
  expect(
    browserDisplayPreferencesSchema.parse({
      ...previous,
      videoCodec: "pyrowave",
      pyrowaveBitrate: 250000000,
    }).videoBitrate,
  ).toBe(24000000);
  expect(
    browserDisplayPreferencesSchema.safeParse({
      ...previous,
      videoCodec: "pyrowave",
      pyrowaveBitrate: 24000000,
    }).success,
  ).toBe(false);
});
