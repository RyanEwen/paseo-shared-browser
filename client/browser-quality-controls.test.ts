import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("./browser-toolbar-menu", () => ({
  BrowserMenuItem: (props: Record<string, unknown>) => ({
    type: "Pressable",
    props: {
      ...props,
      accessibilityLabel: props.accessibilityLabel ?? props.label,
      children: props.label,
    },
  }),
  BrowserMenuHeading: (props: Record<string, unknown>) => ({ type: "Text", props }),
}));

const { DEFAULT_CAPTURE_QUALITY } = await import("../shared/capture-settings");
const { jpegQualityOptions } = await import("./browser-quality-controls");

it("badges exactly the actual default JPEG quality, not a hard-coded tier", () => {
  const options = jpegQualityOptions();
  expect(options.filter((option) => "detail" in option && option.detail === "Default")).toEqual([
    expect.objectContaining({ value: DEFAULT_CAPTURE_QUALITY, label: "65%" }),
  ]);
  expect(options.find((option) => option.value === "high")).not.toHaveProperty("detail");
  expect(options.find((option) => option.value === "maximum")).toHaveProperty(
    "detail",
    "Largest JPEGs",
  );
});

it("keeps Mode limited to its choices while applying changes without a restart", async () => {
  const { BrowserQualityControls } = await import("./browser-quality-controls");
  const change = vi.fn();
  type Element = {
    type?: string | ((props: Record<string, unknown>) => unknown);
    props?: Record<string, unknown>;
  };
  const expand = (node: unknown): Element[] => {
    if (Array.isArray(node)) return node.flatMap(expand);
    if (!node || typeof node !== "object") return [];
    const el = node as Element;
    if (typeof el.type === "function") return expand(el.type(el.props ?? {}));
    return [el, ...expand(el.props?.children)];
  };
  const theme = {
    colors: {
      foreground: "#111",
      foregroundMuted: "#666",
      border: "#bbb",
      accent: "#26f",
      surface1: "#fff",
      surface2: "#eee",
    },
  } as Parameters<typeof BrowserQualityControls>[0]["theme"];
  const props = {
    theme,
    compact: false,
    section: "video" as const,
    disabled: false,
    captureQuality: "medium" as const,
    videoBitrate: 12_000_000 as const,
    videoFps: 30 as const,
    onQualityChange: vi.fn(),
    onVideoBitrateChange: vi.fn(),
    onVideoFpsChange: vi.fn(),
    onLiveVideoChange: change,
  };
  const off = expand(
    BrowserQualityControls({ ...props, liveVideoEnabled: false, videoStatus: "off" }),
  );
  const on = off.find((e) => e.props?.accessibilityLabel === "Mode: Video")!;
  expect(on.props?.disabled).toBe(false);
  (on.props!.onPress as () => void)();
  expect(change).toHaveBeenCalledWith(true);
  const video = expand(
    BrowserQualityControls({ ...props, liveVideoEnabled: true, videoStatus: "playing" }),
  );
  expect(video.find((e) => e.props?.accessibilityLabel === "Mode: Video")?.props?.selected).toBe(
    true,
  );
  const screenshots = video.find((e) => e.props?.accessibilityLabel === "Mode: Screenshots")!;
  (screenshots.props!.onPress as () => void)();
  expect(change).toHaveBeenLastCalledWith(false);
  expect(
    off.find((e) => e.props?.accessibilityLabel === "Mode: Screenshots")?.props?.selected,
  ).toBe(true);
  const bitrate = (enabled: boolean) =>
    expand(
      BrowserQualityControls({
        ...props,
        section: "bitrate",
        liveVideoEnabled: enabled,
        videoStatus: "off",
      }),
    );
  expect(
    bitrate(false)
      .filter((e) => String(e.props?.accessibilityLabel).startsWith("Video bitrate:"))
      .every((e) => e.props?.disabled === true),
  ).toBe(true);
  const jpeg = expand(
    BrowserQualityControls({
      ...props,
      section: "jpeg",
      liveVideoEnabled: false,
      videoStatus: "off",
    }),
  );
  expect(
    jpeg.find((e) => e.props?.accessibilityLabel === "JPEG quality target: 65%")?.props?.disabled,
  ).toBe(false);
  const pending = expand(
    BrowserQualityControls({ ...props, liveVideoEnabled: true, videoStatus: "starting" }),
  );
  expect(pending.some((e) => e.props?.children === "Starting live video…")).toBe(false);
  expect(pending.some((e) => String(e.props?.children).includes("Restart this"))).toBe(false);
  expect(
    pending.some((e) => String(e.props?.children).includes("tabs and unsaved work stay open")),
  ).toBe(true);
  for (const videoStatus of ["playing", "unavailable"] as const) {
    const status = expand(
      BrowserQualityControls({
        ...props,
        liveVideoEnabled: true,
        videoStatus,
        playbackLabel: "PyroWave LAN",
      }),
    );
    expect(
      status.some(
        (e) =>
          e.props?.children ===
          (videoStatus === "playing"
            ? "Live video active"
            : "Live video unavailable, screenshots active"),
      ),
    ).toBe(false);
    expect(status.some((e) => e.props?.children === "PyroWave LAN")).toBe(false);
  }
  expect(
    bitrate(true)
      .filter((e) => String(e.props?.accessibilityLabel).startsWith("Video bitrate:"))
      .every((e) => e.props?.disabled === false),
  ).toBe(true);
  for (const value of [48, 96]) {
    const option = bitrate(true).find(
      (e) => e.props?.accessibilityLabel === `Video bitrate: ${value} Mbps`,
    );
    expect(option).toBeDefined();
    expect(props.onVideoBitrateChange).not.toHaveBeenCalled();
    (option!.props!.onPress as () => void)();
    expect(props.onVideoBitrateChange).toHaveBeenLastCalledWith(value * 1_000_000);
    props.onVideoBitrateChange.mockClear();
  }
  const disabled = expand(
    BrowserQualityControls({
      ...props,
      disabled: true,
      liveVideoEnabled: false,
      videoStatus: "off",
    }),
  );
  expect(disabled.find((e) => e.props?.accessibilityLabel === "Mode: Video")?.props?.disabled).toBe(
    true,
  );
});
