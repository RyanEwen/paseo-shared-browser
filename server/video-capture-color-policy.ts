/** Qualification for Chromium's software-bitmap I420 metadata defect.
 * SoftwareRenderer emits libyuv601 planes but FrameSinkVideoCapturer labels709.
 * Do not infer this from I420 or GPU status alone: GPU Skia capture really is709.
 * This exact build/headless/Vulkan combination was positively identified
 * by a Viz SoftwareRenderer trace and same-frame raw/RGB synthetic-patch checks.
 * Requalify on a browser upgrade instead of broadening this exception silently.
 */
export function needsSoftwareCaptureColorCorrection(input: {
  platform: string;
  graphicsMode: string;
  headless: boolean;
  product: string;
  gpuCompositing: unknown;
}): boolean {
  return (
    input.platform === "linux" &&
    input.graphicsMode === "vulkan" &&
    input.headless &&
    ["Chrome/155.0.8059.84", "HeadlessChrome/155.0.8059.84"].includes(input.product) &&
    input.gpuCompositing === "disabled_software"
  );
}
