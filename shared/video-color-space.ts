/** Bounded SDR source colour metadata. Unsupported/HDR capture keeps compatible-video fallback. */
import { z } from "zod";

export const videoColorSpaceSchema = z.object({
  primaries: z.enum(["bt709", "bt470bg", "smpte170m"]),
  transfer: z.enum(["bt709", "iec61966-2-1"]),
  matrix: z.enum(["bt709", "bt470bg", "smpte170m"]),
  fullRange: z.boolean(),
});
export type BrowserVideoColorSpace = z.infer<typeof videoColorSpaceSchema>;
