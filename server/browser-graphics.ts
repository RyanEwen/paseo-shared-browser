import { readFileSync } from "node:fs";
import { join } from "node:path";

export type BrowserGraphicsMode = "default" | "wsl-d3d12";

/** Explicit host graphics policy, separate from viewport and device emulation. */
export interface BrowserGraphicsConfiguration {
  mode: BrowserGraphicsMode;
  chromiumArguments: string[];
  environment: Record<string, string>;
}

/** Read the host's durable selection; an explicit environment override takes precedence. */
export function readBrowserGraphicsMode(
  paseoHome: string,
  override = process.env.PASEO_SHARED_BROWSER_GRAPHICS,
): BrowserGraphicsMode {
  if (override !== undefined) return resolveBrowserGraphics(override).mode;
  const path = join(paseoHome, "plugin-data", "shared-browser", "graphics.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "default";
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("mode" in value) ||
    typeof value.mode !== "string" ||
    Object.keys(value).some((key) => key !== "mode")
  ) {
    throw new Error("Shared Browser graphics.json must contain only a graphics mode");
  }
  return resolveBrowserGraphics(value.mode).mode;
}

/** Resolve the opt-in WSL hardware path without inheriting arbitrary loader or driver overrides. */
export function resolveBrowserGraphics(
  mode = process.env.PASEO_SHARED_BROWSER_GRAPHICS ?? "default",
  platform: NodeJS.Platform = process.platform,
): BrowserGraphicsConfiguration {
  if (mode === "default") {
    return { mode, chromiumArguments: [], environment: {} };
  }
  if (mode !== "wsl-d3d12") {
    throw new Error("PASEO_SHARED_BROWSER_GRAPHICS must be default or wsl-d3d12");
  }
  if (platform !== "linux") {
    throw new Error("Shared Browser wsl-d3d12 graphics requires a Linux WSL host");
  }
  return {
    mode,
    chromiumArguments: ["--use-gl=angle", "--use-angle=gl-egl"],
    environment: {
      GALLIUM_DRIVER: "d3d12",
      LD_LIBRARY_PATH: "/usr/lib/wsl/lib",
    },
  };
}

/** Refuse a software substitute when the host explicitly requested hardware rendering. */
export function assertWslHardwareRenderer(renderer: unknown): void {
  if (
    typeof renderer !== "string" ||
    !renderer.includes("D3D12 (") ||
    /llvmpipe|softpipe|swiftshader|software|basic render/i.test(renderer)
  ) {
    throw new Error(
      "Shared Browser wsl-d3d12 graphics did not select a hardware GPU. Check WSL GPU access, the Windows GPU driver, and Mesa's D3D12 driver, or use PASEO_SHARED_BROWSER_GRAPHICS=default.",
    );
  }
}
