/** Display settings use short drill-in pages inside the existing anchored toolbar surface. */
import { type ReactNode, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { BROWSER_GRAPHICS_LABELS } from "../shared/browser-graphics";
import { groupResolutionPresets } from "../shared/resolution-menu";
import { formatVideoBitrate } from "../shared/video-settings";
import {
  BrowserGraphicsControls,
  type BrowserGraphicsControlsProps,
} from "./browser-graphics-controls";
import { browserMenuUsesBackNavigation } from "./browser-menu-placement";
import {
  BrowserQualityControls,
  type BrowserQualityControlsProps,
  describeBrowserVideoStatus,
  jpegQualityOptions,
} from "./browser-quality-controls";
import {
  BrowserResolutionPicker,
  type BrowserResolutionPickerProps,
} from "./browser-resolution-picker";
import {
  BrowserMenuHeading,
  BrowserMenuItem,
  BrowserMenuSeparator,
  BrowserToolbarMenu,
  type BrowserToolbarMenuProps,
} from "./browser-toolbar-menu";
import { describeActiveVideoCodec } from "./browser-video-codec-label";

type DisplayPage =
  | "size"
  | "quality"
  | "graphics"
  | "favorites"
  | "custom"
  | "video"
  | "jpeg"
  | "bitrate"
  | "fps"
  | "codec"
  | "mobile";
const TITLES: Record<DisplayPage, string> = {
  size: "Display Size",
  quality: "Quality and mode",
  graphics: "Graphics",
  favorites: "Favorite resolutions",
  custom: "Custom",
  video: "Mode",
  jpeg: "JPEG quality",
  bitrate: "Video bitrate",
  fps: "Video frame rate",
  codec: "Video codec",
  mobile: "Mobile devices",
};

export interface BrowserDisplayMenuProps
  extends Omit<
    BrowserToolbarMenuProps,
    "title" | "preferredHeight" | "children" | "submenu" | "onSubmenuOpen"
  > {
  scaleMode: "fit" | "actual";
  viewport: { width: number; height: number } | null;
  onScaleModeChange(value: "fit" | "actual"): void;
  resolution: Omit<BrowserResolutionPickerProps, "theme" | "compact" | "presets">;
  quality: Omit<BrowserQualityControlsProps, "theme" | "compact">;
  graphics: Omit<BrowserGraphicsControlsProps, "theme" | "compact">;
  fillViewportSelected: boolean;
  fillViewportDetail: string;
  fillViewportDisabled: boolean;
  onFillViewport(): void;
  customViewport: ReactNode;
  error: ReactNode;
}

/** Name the selected transport; a retained PyroWave frame cannot identify a new Standard codec. */
function describeMenuVideoCodec(codec: BrowserQualityControlsProps["codec"]): string {
  if (codec?.value === "pyrowave") return "PyroWave";
  if (codec?.activeCodec === "pyrowave") return "Standard";
  return describeActiveVideoCodec(codec?.activeCodec) ?? "Standard";
}

/** Reuse one flyout on desktop and one Back stack on compact/native clients. */
export function BrowserDisplayMenu(props: BrowserDisplayMenuProps) {
  const compact = browserMenuUsesBackNavigation(props.paneSize.width, props.compact, Platform.OS);
  const [navigation, setNavigation] = useState<{
    pages: DisplayPage[];
    initialFocusLabel?: string;
  }>({ pages: [] });
  const sizeAnchor = useRef<View | null>(null);
  const qualityAnchor = useRef<View | null>(null);
  const graphicsAnchor = useRef<View | null>(null);
  const pages = navigation.pages;
  const page = pages[pages.length - 1];
  const common = { theme: props.theme, compact };
  const groups = groupResolutionPresets();
  const presets = groups.flatMap((group) => group.presets);
  const selectedPreset = presets.find(({ id }) => id === props.resolution.selectedPresetId);
  const viewportDetail = props.viewport
    ? `${props.viewport.width} × ${props.viewport.height}`
    : "Unavailable";
  const customSelected = !props.fillViewportSelected && !selectedPreset;
  // Report committed browser dimensions, never unsubmitted Custom fields or a pending fill target.
  const sizeDetail = props.fillViewportSelected
    ? `Fill viewport · ${viewportDetail}`
    : selectedPreset
      ? `${selectedPreset.label} · ${viewportDetail}`
      : `Custom · ${viewportDetail}`;
  const jpegQuality = jpegQualityOptions().find(
    (option) => option.value === props.quality.captureQuality,
  )?.label;
  // Both summaries use the selected codec budget, independent of temporary playback fallback.
  const videoBitrate = formatVideoBitrate(
    props.quality.codec?.value === "pyrowave"
      ? props.quality.codec.bitrate
      : props.quality.videoBitrate,
  );
  const videoCodec = describeMenuVideoCodec(props.quality.codec);
  const qualityDetail = props.quality.liveVideoEnabled
    ? `${videoCodec} · ${videoBitrate} · ${props.quality.videoFps} FPS`
    : `Screenshots · JPEG ${jpegQuality}`;
  const detailStyle = {
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 11,
    color: props.theme.colors.foregroundMuted,
  };

  const open = (next: DisplayPage) => {
    // Root groups remain visible on desktop. Switching one starts a fresh path.
    const rootPage = next === "size" || next === "quality" || next === "graphics";
    setNavigation({ pages: rootPage ? [next] : [...pages, next] });
  };
  const back = () => {
    if (!page) return;
    setNavigation({ pages: pages.slice(0, -1), initialFocusLabel: TITLES[page] });
  };
  const branch = (next: DisplayPage, detail?: string) => (
    <BrowserMenuItem
      {...common}
      label={TITLES[next]}
      {...(detail ? { detail } : {})}
      expanded={pages.includes(next)}
      onPress={() => open(next)}
    />
  );
  const resolutionList = (choices: typeof presets) => (
    <BrowserResolutionPicker {...common} {...props.resolution} presets={choices} />
  );

  let content: ReactNode = null;
  if (page === "size") {
    content = (
      <>
        <BrowserMenuItem
          {...common}
          label="Fill viewport"
          icon="Maximize"
          selected={props.fillViewportSelected}
          disabled={props.fillViewportDisabled}
          detail={props.fillViewportDetail}
          onPress={props.onFillViewport}
        />
        <BrowserMenuSeparator theme={props.theme} />
        {branch("favorites", `${props.resolution.favoritePresetIds.length} saved`)}
        {branch("mobile", selectedPreset?.isMobile ? selectedPreset.label : "None")}
        {branch("custom", customSelected ? viewportDetail : "Not selected")}
        <BrowserMenuSeparator theme={props.theme} />
        {resolutionList(
          presets
            .filter((preset) => !preset.isMobile)
            .sort(
              (a, b) =>
                a.viewport.width - b.viewport.width || a.viewport.height - b.viewport.height,
            ),
        )}
        <Text style={detailStyle}>
          Presets change viewport, touch behavior, and user agent. Rendering remains Chromium.
        </Text>
      </>
    );
  } else if (page === "favorites") {
    content = props.resolution.favoritePresetIds.length ? (
      resolutionList(
        presets.filter((preset) => props.resolution.favoritePresetIds.includes(preset.id)),
      )
    ) : (
      <Text style={detailStyle}>Star display sizes or mobile devices to add them here.</Text>
    );
  } else if (page === "custom") {
    content = (
      <View style={{ padding: 12, gap: 8 }} role="group" accessibilityLabel="Custom display size">
        {props.customViewport}
      </View>
    );
  } else if (page === "quality") {
    content = (
      <>
        {branch("video", props.quality.liveVideoEnabled ? "Video" : "Screenshots")}
        {props.quality.videoStatus === "unavailable" || props.quality.codec?.fallbackReason ? (
          <Text accessibilityLiveRegion="polite" style={detailStyle}>
            {props.quality.codec?.fallbackReason ??
              props.quality.playbackLabel ??
              describeBrowserVideoStatus(props.quality.videoStatus)}
          </Text>
        ) : null}
        <BrowserMenuSeparator theme={props.theme} />
        <BrowserMenuHeading theme={props.theme}>Video</BrowserMenuHeading>
        {props.quality.codec
          ? branch("codec", props.quality.codec.value === "pyrowave" ? "PyroWave LAN" : "Standard")
          : null}
        {branch("bitrate", videoBitrate)}
        {branch("fps", `${props.quality.videoFps} FPS`)}
        <BrowserMenuSeparator theme={props.theme} />
        <BrowserMenuHeading theme={props.theme}>Screenshots</BrowserMenuHeading>
        {branch("jpeg", jpegQuality)}
      </>
    );
  } else if (page === "graphics") {
    content = <BrowserGraphicsControls {...common} {...props.graphics} />;
  } else if (
    page === "video" ||
    page === "jpeg" ||
    page === "bitrate" ||
    page === "fps" ||
    page === "codec"
  ) {
    content = <BrowserQualityControls {...common} {...props.quality} section={page} />;
  } else if (page === "mobile") {
    content = resolutionList(presets.filter((preset) => preset.isMobile));
  }

  return (
    <BrowserToolbarMenu
      {...props}
      title="Display options"
      preferredHeight={compact ? 300 : 264}
      submenu={
        page
          ? {
              title: TITLES[page],
              pageKey: pages.join("/"),
              ...(navigation.initialFocusLabel
                ? { initialFocusLabel: navigation.initialFocusLabel }
                : {}),
              anchorRef:
                pages[0] === "size"
                  ? sizeAnchor
                  : pages[0] === "quality"
                    ? qualityAnchor
                    : graphicsAnchor,
              preferredHeight: page === "graphics" ? 580 : 500,
              onBack: back,
              children: (
                <>
                  {!compact ? (
                    <>
                      {pages.length > 1 ? (
                        <BrowserMenuItem
                          {...common}
                          label="Back"
                          icon="ChevronLeft"
                          onPress={back}
                        />
                      ) : null}
                      <BrowserMenuHeading theme={props.theme}>{TITLES[page]}</BrowserMenuHeading>
                    </>
                  ) : null}
                  {content}
                  {props.error}
                </>
              ),
            }
          : undefined
      }
    >
      <BrowserMenuHeading theme={props.theme}>View size</BrowserMenuHeading>
      <BrowserMenuItem
        {...common}
        label="Fit to panel"
        icon="Minimize"
        selected={props.scaleMode === "fit"}
        onPress={() => props.onScaleModeChange("fit")}
      />
      <BrowserMenuItem
        {...common}
        label="Actual size (100%)"
        icon="Maximize"
        selected={props.scaleMode === "actual"}
        onPress={() => props.onScaleModeChange("actual")}
      />
      {compact && props.scaleMode === "actual" ? (
        <Text style={detailStyle}>
          Release control to pan this view. While controlling, swipes go to the page.
        </Text>
      ) : null}
      <BrowserMenuSeparator theme={props.theme} />
      <View ref={sizeAnchor} collapsable={false}>
        {branch("size", sizeDetail)}
      </View>
      <View ref={qualityAnchor} collapsable={false}>
        {branch("quality", qualityDetail)}
      </View>
      <View ref={graphicsAnchor} collapsable={false}>
        {branch("graphics", BROWSER_GRAPHICS_LABELS[props.graphics.preference])}
      </View>
      {props.error}
    </BrowserToolbarMenu>
  );
}
