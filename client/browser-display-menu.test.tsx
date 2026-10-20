import { beforeEach, expect, it, vi } from "vitest";
import { DEVICE_PRESETS } from "../shared/device-presets";

// The same small hook runtime used by sibling control tests keeps the menu's path across renders.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.index++;
    hooks.slots[index] ??= initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = value;
      },
    ];
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("./browser-toolbar-menu", () => ({
  BrowserToolbarMenu: "ToolbarMenu",
  BrowserMenuItem: "MenuItem",
  BrowserMenuHeading: "Heading",
  BrowserMenuSeparator: "Separator",
}));

import { BrowserDisplayMenu, type BrowserDisplayMenuProps } from "./browser-display-menu";

type Element = {
  type?: string | ((props: Record<string, unknown>) => unknown);
  props?: Record<string, unknown>;
};
function expand(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!node || typeof node !== "object") return [];
  const element = node as Element;
  if (typeof element.type === "function") return expand(element.type(element.props ?? {}));
  return [element, ...expand(element.props?.children)];
}
function fixture(compact = false) {
  const props: BrowserDisplayMenuProps = {
    theme: {
      colors: { foreground: "#111", foregroundMuted: "#666", accent: "#26f" },
    } as BrowserDisplayMenuProps["theme"],
    compact,
    paneRef: { current: null },
    anchorRef: { current: null },
    paneSize: { width: 900, height: 600 },
    onClose: vi.fn(),
    shouldRestoreFocus: () => true,
    scaleMode: "fit",
    viewport: { width: 1280, height: 720 },
    onScaleModeChange: vi.fn(),
    resolution: {
      selectedPresetId: null,
      favoritePresetIds: [],
      selectDisabled: false,
      favoriteDisabled: false,
      onSelect: vi.fn(),
      onToggleFavorite: vi.fn(),
    },
    quality: {
      disabled: false,
      captureQuality: "medium",
      liveVideoEnabled: true,
      videoStatus: "unavailable",
      videoBitrate: 12_000_000,
      videoFps: 30,
      onQualityChange: vi.fn(),
      onLiveVideoChange: vi.fn(),
      onVideoBitrateChange: vi.fn(),
      onVideoFpsChange: vi.fn(),
    },
    graphics: {
      preference: "host-default",
      graphics: null,
      disabled: false,
      applyDisabled: false,
      onChange: vi.fn(),
      onApply: vi.fn(),
    },
    fillViewportSelected: false,
    fillViewportDetail: "1280 × 720",
    fillViewportDisabled: false,
    onFillViewport: vi.fn(),
    customViewport: "Custom size fields",
    error: null,
  };
  const render = () => {
    hooks.index = 0;
    return BrowserDisplayMenu(props);
  };
  const menu = () => {
    const root = render();
    return { root, rows: expand(root.props.submenu?.children ?? root.props.children) };
  };
  const press = (label: string) => {
    const row = menu().rows.find((item) => item.props?.label === label);
    expect(row, label).toBeDefined();
    (row!.props!.onPress as () => void)();
  };
  return { props, render, menu, press };
}
beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
});

it("summarizes every root settings group from current values", () => {
  const f = fixture();
  f.props.resolution.selectedPresetId = "desktop-chrome";
  const detail = (label: string) =>
    expand(f.render().props.children).find((item) => item.props?.label === label)?.props?.detail;
  expect(detail("Display Size")).toBe("720p · 1280 × 720");
  expect(detail("Quality and mode")).toBe("Standard · 12 Mbps · 30 FPS");
  expect(detail("Graphics")).toBe("Host default");

  f.props.quality.liveVideoEnabled = false;
  f.props.quality.captureQuality = "maximum";
  expect(detail("Quality and mode")).toBe("Screenshots · JPEG 100%");
});

it.each(["webcodecs", "pyrowave"] as const)(
  "summarizes the selected %s budget for video and JPEG quality for screenshots",
  (codec) => {
    const f = fixture();
    f.props.quality.codec = {
      value: codec,
      bitrate: 100_000_000,
      available: true,
      unavailableReason: null,
      activeCodec: null,
      fallbackReason: null,
      onChange: vi.fn(),
      onBitrateChange: vi.fn(),
      onRetry: vi.fn(),
    };
    const detail = () =>
      expand(f.render().props.children).find((item) => item.props?.label === "Quality and mode")
        ?.props?.detail;
    expect(detail()).toBe(
      codec === "pyrowave" ? "PyroWave · 100 Mbps · 30 FPS" : "Standard · 12 Mbps · 30 FPS",
    );

    // Selected PyroWave keeps its label even while the previous compatible front is retained.
    for (const [activeCodec, compatibleLabel] of [
      ["avc1.42002a", "H.264"],
      ["avc3.640028", "H.264"],
      ["vp8", "VP8"],
      ["vp8.0", "VP8"],
      ["unknown", "Standard"],
      ["pyrowave", "Standard"],
      [null, "Standard"],
    ] as const) {
      f.props.quality.codec.activeCodec = activeCodec;
      expect(detail()).toBe(
        codec === "pyrowave"
          ? "PyroWave · 100 Mbps · 30 FPS"
          : `${compatibleLabel} · 12 Mbps · 30 FPS`,
      );
    }

    // Committed changes update the root and nested setting, including while playback starts.
    f.props.quality.codec.bitrate = 250_000_000;
    f.props.quality.videoBitrate = 24_000_000;
    const budget = codec === "pyrowave" ? "250 Mbps" : "24 Mbps";
    const codecLabel = codec === "pyrowave" ? "PyroWave" : "Standard";
    expect(detail()).toBe(`${codecLabel} · ${budget} · 30 FPS`);
    f.props.quality.videoFps = 60;
    expect(detail()).toBe(`${codecLabel} · ${budget} · 60 FPS`);
    f.press("Quality and mode");
    expect(f.menu().rows.find((item) => item.props?.label === "Video bitrate")?.props?.detail).toBe(
      budget,
    );
    f.props.quality.liveVideoEnabled = false;
    expect(detail()).toBe("Screenshots · JPEG 65%");
    f.props.quality.captureQuality = "high";
    expect(detail()).toBe("Screenshots · JPEG 85%");
    f.props.quality.liveVideoEnabled = true;
    expect(detail()).toBe(`${codecLabel} · ${budget} · 60 FPS`);
  },
);

it("shows the current graphics mode without a Saved prefix", () => {
  const f = fixture();
  const detail = () =>
    expand(f.render().props.children).find((item) => item.props?.label === "Graphics")?.props
      ?.detail;
  expect(detail()).toBe("Host default");
  f.props.graphics.preference = "vulkan";
  expect(detail()).toBe("Vulkan GPU");
});

it("uses committed dimensions for fill and Custom summaries", () => {
  const f = fixture();
  f.props.fillViewportSelected = true;
  f.props.fillViewportDetail = "1920 × 1080";
  const sizeDetail = () =>
    expand(f.render().props.children).find((item) => item.props?.label === "Display Size")?.props
      ?.detail;
  expect(sizeDetail()).toBe("Fill viewport · 1280 × 720");
  f.props.fillViewportSelected = false;
  f.props.viewport = { width: 1440, height: 900 };
  expect(sizeDetail()).toBe("Custom · 1440 × 900");
  f.press("Display Size");
  expect(f.menu().rows.find((item) => item.props?.label === "Custom")?.props?.detail).toBe(
    "1440 × 900",
  );
});

it("identifies the current mobile device on its parent rows", () => {
  const f = fixture();
  f.props.resolution.selectedPresetId = "pixel-7";
  f.props.viewport = { width: 412, height: 839 };
  expect(
    expand(f.render().props.children).find((item) => item.props?.label === "Display Size")?.props
      ?.detail,
  ).toBe("Pixel 7 · 412 × 839");
  f.press("Display Size");
  expect(f.menu().rows.find((item) => item.props?.label === "Mobile devices")?.props?.detail).toBe(
    "Pixel 7",
  );
  expect(f.menu().rows.find((item) => item.props?.label === "Custom")?.props?.detail).toBe(
    "Not selected",
  );
});

it("lists desktop sizes together and keeps favorites independent from selection", () => {
  const f = fixture();
  f.press("Display Size");
  const rows = f.menu().rows;
  const preset = DEVICE_PRESETS.find(
    (item) => !item.isMobile && item.viewport.width * 9 === item.viewport.height * 16,
  )!;
  const star = rows.find(
    (item) => item.props?.accessibilityLabel === `Add ${preset.label} to favorites`,
  )!;
  (star.props!.onPress as () => void)();
  expect(f.props.resolution.onToggleFavorite).toHaveBeenCalledExactlyOnceWith(preset.id);
  expect(f.props.resolution.onSelect).not.toHaveBeenCalled();
  const choice = rows.find((item) => item.props?.accessibilityLabel === `Emulate ${preset.label}`)!;
  (choice.props!.onPress as () => void)();
  expect(f.props.resolution.onSelect).toHaveBeenCalledExactlyOnceWith(preset.id);
  const desktop = DEVICE_PRESETS.filter((item) => !item.isMobile).sort(
    (a, b) => a.viewport.width - b.viewport.width || a.viewport.height - b.viewport.height,
  );
  expect(
    rows
      .filter((item) => String(item.props?.accessibilityLabel).startsWith("Emulate "))
      .map((item) => item.props?.accessibilityLabel),
  ).toEqual(desktop.map((item) => `Emulate ${item.label}`));
  expect(
    rows.filter((item) => ["16:9", "16:10", "1:1"].includes(String(item.props?.label))),
  ).toEqual([]);
});

it.each([false, true])(
  "Back preserves the parent page and its return-focus row (compact=%s)",
  (compact) => {
    const f = fixture(compact);
    f.press("Quality and mode");
    expect(
      f
        .menu()
        .rows.some((item) => item.props?.children === "Live video unavailable, screenshots active"),
    ).toBe(true);
    f.press("Video bitrate");
    expect(f.render().props.submenu?.pageKey).toBe("quality/bitrate");
    f.render().props.submenu!.onBack();
    expect(f.render().props.submenu?.pageKey).toBe("quality");
    expect(f.render().props.submenu?.initialFocusLabel).toBe("Video bitrate");
    f.render().props.submenu!.onBack();
    expect(f.render().props.submenu).toBeUndefined();
  },
);

it("switching desktop root groups resets the path rather than nesting unrelated settings", () => {
  const f = fixture();
  f.press("Display Size");
  f.press("Custom");
  const rootRows = expand(f.render().props.children);
  (rootRows.find((item) => item.props?.label === "Graphics")!.props!.onPress as () => void)();
  expect(f.render().props.submenu?.pageKey).toBe("graphics");
  expect(f.menu().rows.some((item) => item.props?.label === "Back")).toBe(false);
});

it("keeps the entire preset catalogue reachable with independent selection and favorite gating", () => {
  const f = fixture();
  f.props.resolution.selectDisabled = true;
  f.press("Display Size");
  const seen: string[] = [];
  for (const mobile of [false, true]) {
    if (mobile) f.press("Mobile devices");
    const choices = f
      .menu()
      .rows.filter((item) => String(item.props?.accessibilityLabel).startsWith("Emulate "));
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      expect(choice.props?.disabled).toBe(true);
      seen.push(String(choice.props?.accessibilityLabel));
    }
    expect(
      f
        .menu()
        .rows.filter((item) => String(item.props?.accessibilityLabel).startsWith("Add "))
        .every((item) => item.props?.disabled === false),
    ).toBe(true);
    if (mobile) f.render().props.submenu!.onBack();
  }
  expect(seen.sort()).toEqual(DEVICE_PRESETS.map((preset) => `Emulate ${preset.label}`).sort());
});

it("keeps capture detail automatic without a manual image-detail or density menu", () => {
  const f = fixture();
  f.press("Quality and mode");
  expect(
    f
      .menu()
      .rows.some((item) => ["Image detail", "Capture density"].includes(String(item.props?.label))),
  ).toBe(false);
});

it.each([false, true])(
  "groups JPEG quality separately after video controls (compact=%s)",
  (compact) => {
    const f = fixture(compact);
    f.props.quality.codec = {
      value: "webcodecs",
      bitrate: 100_000_000,
      available: true,
      unavailableReason: null,
      activeCodec: "avc1.42002a",
      fallbackReason: null,
      onChange: vi.fn(),
      onBitrateChange: vi.fn(),
      onRetry: vi.fn(),
    };
    f.press("Quality and mode");
    const rows = f.menu().rows;
    const sections = rows
      .filter(
        (item) => item.type === "Heading" || item.type === "MenuItem" || item.type === "Separator",
      )
      .map((item) => item.props?.label ?? item.props?.children ?? item.type);
    expect(sections.slice(sections.indexOf("Video"))).toEqual([
      "Video",
      "Video codec",
      "Video bitrate",
      "Video frame rate",
      "Separator",
      "Screenshots",
      "JPEG quality",
    ]);
    f.press("JPEG quality");
    expect(f.render().props.submenu?.pageKey).toBe("quality/jpeg");
    f.render().props.submenu!.onBack();
    expect(f.render().props.submenu?.pageKey).toBe("quality");
  },
);

it.each([false, true])("shows and returns focus to Mode (compact=%s)", (compact) => {
  const f = fixture(compact);
  f.press("Quality and mode");
  const mode = () => f.menu().rows.find((item) => item.props?.label === "Mode");
  expect(mode()?.props?.detail).toBe("Video");
  f.props.quality.liveVideoEnabled = false;
  expect(mode()?.props?.detail).toBe("Screenshots");
  f.press("Mode");
  expect(f.render().props.submenu?.title).toBe("Mode");
  expect(f.render().props.submenu?.pageKey).toBe("quality/video");
  f.render().props.submenu!.onBack();
  expect(f.render().props.submenu?.initialFocusLabel).toBe("Mode");
  expect(f.render().props.submenu?.pageKey).toBe("quality");
});

it.each(["off", "starting", "playing"] as const)(
  "omits the standalone normal playback line under Mode (%s)",
  (videoStatus) => {
    const f = fixture();
    f.props.quality.videoStatus = videoStatus;
    f.props.quality.playbackLabel = "H.264";
    f.press("Quality and mode");
    expect(f.menu().rows.some((item) => item.type === "Text")).toBe(false);
    expect(f.menu().rows.some((item) => item.props?.label === "Video bitrate")).toBe(true);
  },
);

it("retains the failure notice and codec fallback reason without normal codec text", () => {
  const f = fixture();
  f.props.quality.playbackLabel = "Video unavailable · screenshots";
  f.press("Quality and mode");
  expect(
    f.menu().rows.some((item) => item.props?.children === "Video unavailable · screenshots"),
  ).toBe(true);
  f.props.quality.videoStatus = "playing";
  f.props.quality.playbackLabel = "H.264";
  f.props.quality.codec = {
    value: "pyrowave",
    bitrate: 100_000_000,
    available: true,
    unavailableReason: null,
    activeCodec: "avc1.42002a",
    fallbackReason: "PyroWave unavailable on this connection",
    onChange: vi.fn(),
    onBitrateChange: vi.fn(),
    onRetry: vi.fn(),
  };
  expect(
    f
      .menu()
      .rows.some((item) => item.props?.children === "PyroWave unavailable on this connection"),
  ).toBe(true);
  expect(f.menu().rows.some((item) => item.props?.children === "H.264")).toBe(false);
});
