/** Experimental LAN codec limits, separate from compatible H.264 bitrate choices. */
import { z } from "zod";
import { videoFrameRateSchema } from "./video-settings";

export const PYROWAVE_BITRATES = [100_000_000, 200_000_000, 250_000_000] as const;
export const pyrowaveBitrateSchema = z.union(PYROWAVE_BITRATES.map((value) => z.literal(value)));
export const pyrowaveDimensionsSchema = z.object({
  width: z.number().int().min(64).max(3840).multipleOf(2),
  height: z.number().int().min(64).max(3840).multipleOf(2),
});
export const pyrowaveConfigurationSchema = pyrowaveDimensionsSchema.extend({
  bitrate: pyrowaveBitrateSchema,
  fps: videoFrameRateSchema,
});
export type PyrowaveConfiguration = z.infer<typeof pyrowaveConfigurationSchema>;
