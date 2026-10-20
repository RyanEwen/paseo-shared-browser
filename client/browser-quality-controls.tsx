/** Viewer compression and rate pages, independent of page size and browser startup graphics. */

import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { BrowserDisplayPreferences } from "../shared/browser-display-preferences";
import { DEFAULT_CAPTURE_QUALITY, JPEG_QUALITY } from "../shared/capture-settings";
import { formatVideoBitrate, VIDEO_BITRATES, VIDEO_FRAME_RATES } from "../shared/video-settings";
import { BrowserMenuChoices } from "./browser-menu-choices";
import {
  BrowserVideoCodecControls,
  type BrowserVideoCodecSelection,
} from "./browser-video-codec-controls";

import type { BrowserVideoStatus } from "./browser-video-status";

export { type BrowserVideoStatus, describeBrowserVideoStatus } from "./browser-video-status";
export type BrowserQualitySection = "video" | "jpeg" | "bitrate" | "fps" | "codec";

export interface BrowserQualityControlsProps {
  codec?: BrowserVideoCodecSelection;
  playbackLabel?: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
  disabled: boolean;
  captureQuality: BrowserDisplayPreferences["captureQuality"];
  liveVideoEnabled: boolean;
  videoStatus: BrowserVideoStatus;
  onLiveVideoChange(value: boolean): void;
  videoBitrate: BrowserDisplayPreferences["videoBitrate"];
  videoFps: BrowserDisplayPreferences["videoFps"];
  onQualityChange(value: BrowserDisplayPreferences["captureQuality"]): void;
  onVideoBitrateChange(value: BrowserDisplayPreferences["videoBitrate"]): void;
  onVideoFpsChange(value: BrowserDisplayPreferences["videoFps"]): void;
}

/** Show the actual encoder values and badge the shared default instead of a UI assumption. */
export function jpegQualityOptions() {
  return (["low", "medium", "high", "maximum"] as const).map((value) => ({
    value,
    label: `${JPEG_QUALITY[value]}%`,
    ...(value === DEFAULT_CAPTURE_QUALITY
      ? { detail: "Default" }
      : value === "maximum"
        ? { detail: "Largest JPEGs" }
        : {}),
  }));
}

/** Render one short settings page; changing these choices keeps open tabs running. */
export function BrowserQualityControls(
  props: BrowserQualityControlsProps & { section: BrowserQualitySection },
) {
  const common = { theme: props.theme, compact: props.compact, disabled: props.disabled };
  let controls: ReactNode;
  let detail: string;
  switch (props.section) {
    case "codec":
      controls = props.codec ? (
        <BrowserVideoCodecControls
          {...common}
          disabled={props.disabled || !props.liveVideoEnabled}
          selection={props.codec}
          section="codec"
        />
      ) : null;
      detail = "";
      break;
    case "video":
      controls = (
        <BrowserMenuChoices
          {...common}
          title="Mode"
          value={props.liveVideoEnabled}
          options={[
            { value: false, label: "Screenshots" },
            { value: true, label: "Video" },
          ]}
          onChange={props.onLiveVideoChange}
        />
      );
      detail =
        "Saved for this host and shared across its workspaces. Changes apply automatically. Your tabs and unsaved work stay open.";
      break;
    case "jpeg":
      controls = (
        <BrowserMenuChoices
          {...common}
          title="JPEG quality target"
          value={props.captureQuality}
          options={jpegQualityOptions()}
          onChange={props.onQualityChange}
        />
      );
      detail =
        "Large JPEGs may reduce quality to fit the frame limit. Screenshots remain available when video is unsupported.";
      break;
    case "bitrate":
      if (props.codec?.value === "pyrowave") {
        controls = (
          <BrowserVideoCodecControls
            {...common}
            disabled={props.disabled || !props.liveVideoEnabled}
            selection={props.codec}
            section="bitrate"
          />
        );
        detail = "";
        break;
      }
      controls = (
        <BrowserMenuChoices
          {...common}
          disabled={props.disabled || !props.liveVideoEnabled}
          title="Video bitrate"
          value={props.videoBitrate}
          options={VIDEO_BITRATES.map((value) => ({ value, label: formatVideoBitrate(value) }))}
          onChange={props.onVideoBitrateChange}
        />
      );
      detail =
        "Higher bitrate keeps movement clearer and uses more bandwidth. Use 48 or 96 Mbps on a fast connection.";
      break;
    case "fps":
      controls = (
        <BrowserMenuChoices
          {...common}
          disabled={props.disabled || !props.liveVideoEnabled}
          title="Video frame rate"
          value={props.videoFps}
          options={VIDEO_FRAME_RATES.map((value) => ({ value, label: `${value} FPS` }))}
          onChange={props.onVideoFpsChange}
        />
      );
      detail =
        "Higher frame rates use more bandwidth. Applies where live video is supported; other clients use JPEGs.";
      break;
  }
  return (
    <View>
      {controls}
      {detail ? (
        <Text style={{ padding: 12, fontSize: 11, color: props.theme.colors.foregroundMuted }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}
