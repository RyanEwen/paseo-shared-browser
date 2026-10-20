import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime } from "./agent-browser-runtime";
import {
  assertVulkanHardwareRenderer,
  assertWslHardwareRenderer,
  readBrowserGraphicsMode,
  resolveBrowserGraphics,
} from "./browser-graphics";

afterEach(() => vi.unstubAllEnvs());

describe("explicit browser graphics policy", () => {
  it("uses a private Wayland EGL surface without enabling remote desktop or changing other platforms", () => {
    const profile = resolveBrowserGraphics("wayland", "linux");
    expect(profile.mode).toBe("wayland");
    expect(profile.environment).toEqual({});
    expect(profile.chromiumArguments).toContain("--ozone-platform=wayland");
    expect(profile.chromiumArguments).toContain("--use-angle=gl-egl");
    expect(profile.chromiumArguments).not.toContain("--use-angle=vulkan");
    expect(() => resolveBrowserGraphics("wayland", "darwin")).toThrow("Linux host");
    expect(() => resolveBrowserGraphics("wayland", "win32")).toThrow("Linux host");
  });
  it("uses the qualified Linux Vulkan profile and refuses a software substitute", () => {
    const profile = resolveBrowserGraphics("vulkan", "linux");
    expect(profile.chromiumArguments).toEqual([
      "--enable-gpu",
      "--use-angle=vulkan",
      "--enable-features=Vulkan",
      "--disable-vulkan-surface",
      "--enable-unsafe-webgpu",
    ]);
    expect(profile.environment).toEqual({});
    expect(() => resolveBrowserGraphics("vulkan", "win32")).toThrow("Linux host");
    expect(() => resolveBrowserGraphics("vulkan", "darwin")).toThrow("Linux host");
    assertVulkanHardwareRenderer(
      "ANGLE (AMD, Vulkan 1.3.0 (AMD Radeon Graphics (RADV RENOIR)), Mesa)",
    );
    for (const renderer of [
      null,
      "",
      "ANGLE (Google, Vulkan SwiftShader)",
      "Vulkan llvmpipe",
      "Vulkan lavapipe",
      "ANGLE (D3D12 GPU)",
    ]) {
      expect(() => assertVulkanHardwareRenderer(renderer)).toThrow("did not select a hardware GPU");
    }
  });
  it.skipIf(process.platform !== "linux")(
    "loads the persistent host selection and honors explicit overrides",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "shared-browser-graphics-policy-"));
      vi.stubEnv("PASEO_SHARED_BROWSER_GRAPHICS", undefined);
      try {
        expect(readBrowserGraphicsMode(home)).toBe("default");
        const root = join(home, "plugin-data", "shared-browser");
        await mkdir(root, { recursive: true });
        const path = join(root, "graphics.json");
        await writeFile(path, JSON.stringify({ mode: "wsl-d3d12" }));
        expect(readBrowserGraphicsMode(home)).toBe("wsl-d3d12");
        expect(readBrowserGraphicsMode(home, "default")).toBe("default");
        await writeFile(path, JSON.stringify({ mode: "unknown" }));
        expect(() => readBrowserGraphicsMode(home)).toThrow("must be default or wsl-d3d12");
        await writeFile(path, JSON.stringify({ mode: "default", extra: true }));
        expect(() => readBrowserGraphicsMode(home)).toThrow("contain only");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
  it("keeps the default path and rejects unsupported or misspelled modes", () => {
    expect(resolveBrowserGraphics("default", "win32")).toEqual({
      mode: "default",
      chromiumArguments: [],
      environment: {},
    });
    expect(() => resolveBrowserGraphics("d3d12", "linux")).toThrow("must be");
    expect(() => resolveBrowserGraphics("wsl-d3d12", "win32")).toThrow("Linux WSL");
  });

  it.skipIf(process.platform !== "linux")(
    "passes only the selected driver settings to CLI children alongside private display authority",
    () => {
      vi.stubEnv("PASEO_SHARED_BROWSER_GRAPHICS", "wsl-d3d12");
      vi.stubEnv("LD_LIBRARY_PATH", "/tmp/untrusted-loader-path");
      const runtime = new AgentBrowserRuntime({
        binaryPath: "/tmp/unlaunched-browser",
        executablePath: "/tmp/unlaunched-chromium",
        profilePath: "/tmp/uncreated-profile",
        ipcDirectory: "/tmp/uncreated-ipc",
        session: "graphics-policy",
        launchEnvironment: { DISPLAY: ":24001", XAUTHORITY: "/tmp/private-auth" },
      });
      const native = runtime as unknown as { environment: NodeJS.ProcessEnv };
      expect(native.environment).toMatchObject({
        GALLIUM_DRIVER: "d3d12",
        LD_LIBRARY_PATH: "/usr/lib/wsl/lib",
        DISPLAY: ":24001",
        XAUTHORITY: "/tmp/private-auth",
        AGENT_BROWSER_SOCKET_DIR: "/tmp/uncreated-ipc",
      });
      expect(process.env.LD_LIBRARY_PATH).toBe("/tmp/untrusted-loader-path");
    },
  );

  it("rejects CPU rendering even if a software backend presents itself as D3D12", () => {
    assertWslHardwareRenderer("ANGLE (Microsoft Corporation, D3D12 (Qualcomm Adreno), OpenGL ES)");
    for (const renderer of [
      undefined,
      "ANGLE (Mesa, llvmpipe)",
      "ANGLE (Google, SwiftShader)",
      "ANGLE (Microsoft Corporation, D3D12 (Microsoft Basic Render Driver), OpenGL ES)",
    ]) {
      expect(() => assertWslHardwareRenderer(renderer)).toThrow("did not select a hardware GPU");
    }
  });
});
