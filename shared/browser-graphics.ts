/** Saved graphics intent and bounded runtime observation; neither grants browser control. */
import { z } from "zod";

export const browserGraphicsPreferenceSchema = z.enum(["host-default", "vulkan", "wayland"]);
export type BrowserGraphicsPreference = z.infer<typeof browserGraphicsPreferenceSchema>;
/** Short setting summaries, shared by the selection and toolbar branch. */
export const BROWSER_GRAPHICS_LABELS: Record<BrowserGraphicsPreference, string> = {
  "host-default": "Host default",
  vulkan: "Vulkan GPU",
  wayland: "Wayland GPU",
};
export const browserGraphicsStateSchema = z.object({
  preference: browserGraphicsPreferenceSchema,
  mode: z.enum(["default", "wsl-d3d12", "vulkan", "wayland"]),
  platform: z.enum(["linux", "darwin", "win32", "other"]),
  renderer: z.string().max(512).nullable(),
  hardware: z.boolean().nullable(),
});
export type BrowserGraphicsState = z.infer<typeof browserGraphicsStateSchema>;
