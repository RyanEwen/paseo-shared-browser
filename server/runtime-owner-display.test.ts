import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeGraphicsSettings } from "./runtime-graphics-settings";
import { createRuntimeOwner } from "./runtime-owner";
import { RuntimeLostError } from "./runtime-protocol";
import { createRuntimeVideoSettings } from "./runtime-video-settings";
import { PrivateDisplayError } from "./virtual-display";

const fake = vi.hoisted(() => ({
  display: vi.fn(),
  runtime: vi.fn(),
  launch: vi.fn(),
  shutdown: vi.fn(),
  assertAvailable: vi.fn(),
  stop: vi.fn(),
  wayland: vi.fn(),
  waylandAssets: vi.fn(),
  print: vi.fn(),
  targets: vi.fn(),
}));
vi.mock("./private-wayland-display", () => ({ createPrivateWaylandDisplay: fake.wayland }));
vi.mock("./wayland-assets", () => ({ readRuntimeWaylandAssets: fake.waylandAssets }));
vi.mock("./virtual-display", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./virtual-display")>()),
  createPrivateVirtualDisplay: fake.display,
}));
vi.mock("./runtime-path", () => ({
  resolveBrowserRuntimeRoot: () => "/tmp/owned-runtime-fixture",
}));
vi.mock("./agent-browser-runtime", () => ({
  AgentBrowserRuntime: class {
    launch = fake.launch;
    shutdown = fake.shutdown;
    identity = async () => ({ userAgent: "Fixture", targetId: "fixture-root" });
    print = fake.print;
    targets = fake.targets;
    constructor(options: unknown) {
      fake.runtime(options);
    }
  },
}));
let fixtureHome: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixtureHome, { recursive: true, force: true });
});

beforeEach(async () => {
  // Saved host graphics choices must never change an isolated protocol fixture.
  fixtureHome = await mkdtemp(join(tmpdir(), "shared-browser-owner-fixture-"));
  vi.stubEnv("PASEO_HOME", fixtureHome);
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", undefined);
  vi.clearAllMocks();
  fake.assertAvailable.mockReset();
  fake.launch.mockResolvedValue(undefined);
  fake.shutdown.mockResolvedValue(undefined);
  fake.stop.mockResolvedValue(undefined);
  fake.waylandAssets.mockResolvedValue(null);
  fake.wayland.mockResolvedValue({
    launchEnvironment: { WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/tmp/owned-wayland" },
    assertAvailable: fake.assertAvailable,
    stop: fake.stop,
  });
  fake.display.mockResolvedValue({
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
    assertAvailable: fake.assertAvailable,
    stop: fake.stop,
  });
  fake.targets.mockResolvedValue([
    { targetId: "fixture-root", url: "about:blank", title: "Source" },
  ]);
  fake.print.mockImplementation(async (_generation, assertPrivateDisplay) =>
    assertPrivateDisplay(),
  );
});

it("refuses controlled print on a real-user headed display despite display environment hints", async () => {
  const owner = await createRuntimeOwner({
    headed: true,
    virtualDisplay: false,
    nativeVideo: false,
  });
  const owned = await owner.create("unowned-display");
  owned.runtimeOptions.launchEnvironment = { DISPLAY: ":0" };
  expect(await owner.request(owned, "identity", null)).toMatchObject({ canPrint: false });
  await expect(owner.request(owned, "print", { targetId: "fixture-root" })).rejects.toThrow(
    "owned private desktop",
  );
  expect(fake.print).not.toHaveBeenCalled();
  await owner.stop(owned);
});

it.skipIf(process.platform !== "linux")(
  "authorizes an owned private source and refuses to print a preview",
  async () => {
    await createRuntimeGraphicsSettings(fixtureHome).update("private-desktop");
    const owner = await createRuntimeOwner({ nativeVideo: false });
    const owned = await owner.create("private-print");
    expect(await owner.request(owned, "identity", null)).toMatchObject({ canPrint: true });
    await owner.request(owned, "print", {
      targetId: "fixture-root",
      expectedInputGeneration: "1:1",
    });
    expect(fake.print).toHaveBeenCalledExactlyOnceWith("1:1", expect.any(Function));
    fake.targets.mockResolvedValueOnce([
      { targetId: "fixture-root", url: "chrome://print/", title: "Preview" },
    ]);
    await expect(owner.request(owned, "print", { targetId: "fixture-root" })).rejects.toThrow(
      "original page",
    );
    expect(fake.print).toHaveBeenCalledOnce();
    await owner.stop(owned);
  },
);

it.skipIf(process.platform !== "linux")(
  "requires an authenticated private display for the saved private desktop choice",
  async () => {
    await createRuntimeGraphicsSettings(fixtureHome).update("private-desktop");
    const owner = await createRuntimeOwner({ nativeVideo: false });
    const owned = await owner.create("private-desktop");
    expect(owned.runtimeOptions).toMatchObject({
      headed: true,
      graphicsMode: "default",
      launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
    });
    expect(owned.graphicsPreference).toBe("private-desktop");
    await owner.stop(owned);
    expect(fake.stop).toHaveBeenCalledOnce();

    fake.display.mockResolvedValueOnce(null);
    await expect(owner.create("missing-display")).rejects.toThrow("Xvfb was not found");
    expect(fake.runtime).toHaveBeenCalledTimes(1);
    fake.display.mockRejectedValueOnce(
      new PrivateDisplayError("Private browser display failed to start"),
    );
    await expect(owner.create("failed-display")).rejects.toThrow("failed to start");
    expect(fake.runtime).toHaveBeenCalledTimes(1);
  },
);

it("uses saved Wayland choice with owned native display and never silently falls back when assets are missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-owner-wayland-"));
  vi.stubEnv("PASEO_HOME", home);
  try {
    await createRuntimeGraphicsSettings(home).update("wayland");
    const owner = await createRuntimeOwner({ nativeVideo: false, virtualDisplay: false });
    await expect(owner.create("missing-native-assets")).rejects.toThrow("not prepared");
    expect(fake.launch).not.toHaveBeenCalled();
    expect(fake.display).not.toHaveBeenCalled();
    fake.waylandAssets.mockResolvedValue("/tmp/verified-native-assets");
    const owned = await owner.create("wayland-owned-runtime");
    expect(fake.wayland).toHaveBeenCalledWith("/tmp/verified-native-assets");
    expect(owned.runtimeOptions).toMatchObject({
      graphicsMode: "wayland",
      headed: true,
      launchEnvironment: { WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/tmp/owned-wayland" },
    });
    await owner.stop(owned);
    expect(fake.stop).toHaveBeenCalledOnce();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")(
  "applies saved graphics to new runtimes while preserving the running browser's startup choice",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "shared-browser-owner-graphics-"));
    vi.stubEnv("PASEO_HOME", home);
    vi.stubEnv("PASEO_SHARED_BROWSER_GRAPHICS", "wsl-d3d12");
    try {
      const settings = createRuntimeGraphicsSettings(home);
      const owner = await createRuntimeOwner({ nativeVideo: false, virtualDisplay: false });
      const original = await owner.create("original");
      expect(original.runtimeOptions.graphicsMode).toBe("wsl-d3d12");
      expect(original.graphicsPreference).toBe("host-default");
      await settings.update("vulkan");
      expect(original.runtimeOptions.graphicsMode).toBe("wsl-d3d12");
      expect(fake.shutdown).not.toHaveBeenCalled();
      expect(fake.runtime).toHaveBeenCalledTimes(1);
      const next = await owner.create("next");
      expect(next.runtimeOptions.graphicsMode).toBe("vulkan");
      expect(next.graphicsPreference).toBe("vulkan");
      await settings.update("host-default");
      const restored = await owner.create("restored");
      expect(restored.runtimeOptions.graphicsMode).toBe("wsl-d3d12");
      await Promise.all([owner.stop(original), owner.stop(next), owner.stop(restored)]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("supplies private display environment only to opted-in hidden runtime creation", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  const owner = await createRuntimeOwner({ nativeVideo: false });
  const runtime = await owner.create("workspace-fixture");
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({
    headed: true,
    launchEnvironment: { DISPLAY: ":23067", XAUTHORITY: "/tmp/private/authority" },
  });
  await owner.stop(runtime);
  expect(fake.shutdown).toHaveBeenCalledTimes(1);
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("prepares video while Off and applies the durable choice without creating another runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "shared-browser-owner-video-"));
  vi.stubEnv("PASEO_HOME", home);
  vi.stubEnv("PASEO_SHARED_BROWSER_VIDEO", "1");
  try {
    const policy = createRuntimeVideoSettings(home),
      owner = await createRuntimeOwner();
    await owner.create("off");
    expect(fake.runtime.mock.calls.at(-1)![0]).toMatchObject({ nativeVideo: true });
    const before = fake.runtime.mock.calls.at(-1)![0] as { nativeVideoAllowed(): boolean };
    expect(before.nativeVideoAllowed()).toBe(false);
    await policy.update(true);
    expect(fake.runtime.mock.calls.at(-1)![0]).toMatchObject({ nativeVideo: true });
    expect(fake.display).not.toHaveBeenCalled();
    expect(fake.runtime.mock.calls.at(-1)![0]).toMatchObject({ headed: false });
    expect(fake.runtime).toHaveBeenCalledTimes(1);
    const options = fake.runtime.mock.calls.at(-1)![0] as { nativeVideoAllowed(): boolean };
    expect(options.nativeVideoAllowed()).toBe(true);
    await policy.update(false);
    expect(options.nativeVideoAllowed()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("retains prepared headless capture when an optional private display is unavailable", async () => {
  if (process.platform !== "linux") return;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  fake.display.mockResolvedValueOnce(null);
  try {
    const owner = await createRuntimeOwner({ nativeVideo: true, virtualDisplay: true });
    const runtime = await owner.create("video-no-display");
    expect(fake.runtime.mock.calls.at(-1)![0]).toMatchObject({
      nativeVideo: true,
      headed: false,
    });
    expect(await owner.request(runtime, "identity", null)).toMatchObject({
      videoCaptureEnabled: true,
      displayNotice: "Private display unavailable: Xvfb was not found.",
    });
  } finally {
    warning.mockRestore();
  }
});

it("passes explicit headed intent to the runtime safety boundary and retains unavailable-display headless fallback", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  await (await createRuntimeOwner({ headed: true, nativeVideo: false })).create("headed-fixture");
  expect(fake.display).not.toHaveBeenCalled();
  expect(fake.runtime.mock.calls[0]![0]).toMatchObject({ headed: true });
  expect(fake.runtime.mock.calls[0]![0]).not.toHaveProperty("launchEnvironment");
  fake.display.mockResolvedValue(null);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const owner = await createRuntimeOwner({ nativeVideo: false });
    const absent = await owner.create("absent-fixture");
    expect(fake.runtime.mock.calls[1]![0]).toMatchObject({ headed: false });
    await expect(owner.request(absent, "identity", null)).resolves.toMatchObject({
      displayNotice: "Private display unavailable: Xvfb was not found.",
    });
  } finally {
    warning.mockRestore();
  }
});

it("falls back only before Chromium construction and reports a bounded secret-free notice", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [failure, notice] of [
      [
        new PrivateDisplayError("Private browser display ended before readiness"),
        "Private display unavailable: Private browser display ended before readiness.",
      ],
      [
        new Error("EACCES /home/user/.Xauthority-secret-cookie"),
        "Private display unavailable: unexpected startup failure.",
      ],
    ] as const) {
      fake.display.mockRejectedValueOnce(failure);
      const owner = await createRuntimeOwner({ nativeVideo: false });
      const runtime = await owner.create("startup-fallback-fixture");
      expect(fake.runtime.mock.calls.at(-1)![0]).toMatchObject({ headed: false });
      expect(fake.runtime.mock.calls.at(-1)![0]).not.toHaveProperty("launchEnvironment");
      const identity = await owner.request(runtime, "identity", null);
      expect(identity).toMatchObject({ displayNotice: notice });
      expect(JSON.stringify(identity)).not.toContain("secret");
      expect(warning).toHaveBeenLastCalledWith(`[shared-browser] ${notice} Using headless mode.`);
    }
  } finally {
    warning.mockRestore();
  }
});

it("cleans the private display after launch failure and even failing browser shutdown", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  fake.launch.mockRejectedValue(new Error("fixture launch failure"));
  fake.shutdown.mockRejectedValue(new Error("fixture shutdown failure"));
  await expect(
    (await createRuntimeOwner({ nativeVideo: false })).create("failure-fixture"),
  ).rejects.toThrow();
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("refuses runtime requests after private display loss", async () => {
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  const owner = await createRuntimeOwner({ nativeVideo: false });
  const runtime = await owner.create("loss-fixture");
  fake.assertAvailable.mockImplementation(() => {
    throw new RuntimeLostError("Private display ended");
  });
  await expect(owner.request(runtime, "state", null)).rejects.toBeInstanceOf(RuntimeLostError);
  await owner.stop(runtime);
  expect(fake.stop).toHaveBeenCalledTimes(1);
});

it("keeps explicit image-only runtimes headless unless desktop hover is requested", async () => {
  const owner = await createRuntimeOwner({ nativeVideo: false });
  for (const value of [undefined, "", "0", "true", "yes"]) {
    vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", value);
    await owner.create("default-fixture");
  }
  expect(fake.display).not.toHaveBeenCalled();
  for (const call of fake.runtime.mock.calls) {
    expect(call[0]).toMatchObject({ headed: false });
    expect(call[0]).not.toHaveProperty("launchEnvironment");
  }
});

it("reads the environment at each runtime creation and lets an explicit option override it", async () => {
  const owner = await createRuntimeOwner({ nativeVideo: false });
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", "1");
  await owner.create("env-opt-in");
  expect(fake.display).toHaveBeenCalledTimes(1);
  await (await createRuntimeOwner({ virtualDisplay: false })).create("option-false");
  expect(fake.display).toHaveBeenCalledTimes(1);
  vi.stubEnv("PASEO_SHARED_BROWSER_XVFB", undefined);
  await (await createRuntimeOwner({ virtualDisplay: true })).create("option-true");
  expect(fake.display).toHaveBeenCalledTimes(2);
});
