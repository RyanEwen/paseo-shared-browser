/** Display demand changes source detail, never page layout or browser control. */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { browserStateSchema, expectedStateSchema } from "./browser";
import { type CaptureDensity, canUseCaptureDensity } from "./capture-density";

export const DISPLAY_DEMAND_TTL_MS = 15_000;
export const DISPLAY_DEMAND_HEARTBEAT_MS = 5_000;
export const displayPixelSizeSchema = z.object({
  width: z.number().positive().max(32768),
  height: z.number().positive().max(32768),
});
export type DisplayPixelSize = z.infer<typeof displayPixelSizeSchema>;
export const browserDisplayDemandRpc = defineRpc({
  name: "shared-browser.display-demand",
  input: z.object({
    viewerToken: expectedStateSchema.shape.sessionId,
    expected: expectedStateSchema.required({ runtimeId: true, bridgeEpoch: true }),
    display: displayPixelSizeSchema.nullable(),
  }),
  output: z.object({ state: browserStateSchema, accepted: z.boolean() }),
});

/** Smallest supported source covering all physical display needs. A one-pixel
 * rounding tolerance matches existing Auto behavior; bounds always win over demand. */
export function densityForDisplayDemands(
  viewport: DisplayPixelSize,
  displays: Iterable<DisplayPixelSize>,
): CaptureDensity {
  const tolerance = 1 / Math.max(viewport.width, viewport.height);
  for (const display of displays) {
    const required = Math.max(display.width / viewport.width, display.height / viewport.height);
    if (required > 1 + tolerance && canUseCaptureDensity(viewport, 2)) return 2;
  }
  return 1;
}
