/** Codec-specific admission keeps LAN budgets distinct from compatible video defaults. */
import { z } from "zod";
import { pyrowaveBitrateSchema } from "./pyrowave-settings";
import {
  resolveVideoEncoderSettings,
  videoBitrateSchema,
  videoEncoderKey,
  videoFrameRateSchema,
} from "./video-settings";

export const videoCodecSchema = z.enum(["webcodecs", "pyrowave"]);
export const videoRequestBitrateSchema = z.union([videoBitrateSchema, pyrowaveBitrateSchema]);
export interface VideoCodecSettings {
  codec: z.infer<typeof videoCodecSchema>;
  key: string;
  bitrate: number;
  fps: z.infer<typeof videoFrameRateSchema>;
}
/** Reject mismatched codec/bandwidth before source allocation. Existing callers retain
 * their legacy profile, default bitrate/FPS and exact compatible cohort key. */
export function resolveVideoCodecSettings(input: {
  codec?: z.infer<typeof videoCodecSchema>;
  quality?: "low" | "medium" | "high";
  bitrate?: number;
  fps?: number;
}): VideoCodecSettings {
  const codec = videoCodecSchema.parse(input.codec ?? "webcodecs");
  if (codec === "pyrowave") {
    const bitrate = pyrowaveBitrateSchema.parse(input.bitrate ?? 100_000_000);
    const fps = videoFrameRateSchema.parse(input.fps ?? 30);
    return { codec, bitrate, fps, key: `pyrowave:${bitrate}:${fps}` };
  }
  const settings = resolveVideoEncoderSettings(input);
  return { ...settings, codec, key: videoEncoderKey(settings) };
}
