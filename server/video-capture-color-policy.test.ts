import { expect, it } from "vitest";
import { needsSoftwareCaptureColorCorrection } from "./video-capture-color-policy";

it("restricts the software capture exception to its positively qualified browser configuration", () => {
  const qualified = {
    platform: "linux",
    graphicsMode: "vulkan",
    headless: true,
    product: "Chrome/155.0.8059.84",
    gpuCompositing: "disabled_software",
  };
  expect(needsSoftwareCaptureColorCorrection(qualified)).toBe(true);
  for (const different of [
    { platform: "win32" },
    { graphicsMode: "default" },
    { graphicsMode: "wsl-d3d12" },
    { headless: false },
    { product: "Chrome/155.0.8059.85" },
    { product: "Chrome/156.0.0.0" },
    { product: "" },
    { gpuCompositing: "enabled" },
    { gpuCompositing: undefined },
  ])
    expect(needsSoftwareCaptureColorCorrection({ ...qualified, ...different })).toBe(false);
});
