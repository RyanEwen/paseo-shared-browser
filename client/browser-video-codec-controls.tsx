/** Explicit codec and LAN budget choices; saving never changes browser layout or closes tabs. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { BrowserDisplayPreferences } from "../shared/browser-display-preferences";
import { PYROWAVE_BITRATES } from "../shared/pyrowave-settings";
import { formatVideoBitrate } from "../shared/video-settings";
import { BrowserMenuChoices } from "./browser-menu-choices";
import { BrowserMenuItem } from "./browser-toolbar-menu";
import { describeActiveVideoCodec } from "./browser-video-codec-label";

export interface BrowserVideoCodecSelection {
  value: BrowserDisplayPreferences["videoCodec"];
  bitrate: BrowserDisplayPreferences["pyrowaveBitrate"];
  available: boolean;
  unavailableReason: string | null;
  activeCodec: string | null;
  fallbackReason: string | null;
  onChange(value: BrowserDisplayPreferences["videoCodec"]): void;
  onBitrateChange(value: BrowserDisplayPreferences["pyrowaveBitrate"]): void;
  onRetry(): void;
}

/** Render short pages using the same checked rows and actions as adjacent display settings. */
export function BrowserVideoCodecControls(props: {
  theme: PluginHostProps["theme"];
  compact: boolean;
  disabled: boolean;
  selection: BrowserVideoCodecSelection;
  section: "codec" | "bitrate";
}) {
  const common = { theme: props.theme, compact: props.compact, disabled: props.disabled },
    selection = props.selection;
  const text = { padding: 12, fontSize: 11, color: props.theme.colors.foregroundMuted };
  if (props.section === "bitrate")
    return (
      <View>
        <BrowserMenuChoices
          {...common}
          title="PyroWave bitrate"
          value={selection.bitrate}
          options={PYROWAVE_BITRATES.map((value) => ({ value, label: formatVideoBitrate(value) }))}
          onChange={selection.onBitrateChange}
        />
        <Text style={text}>
          PyroWave uses much more bandwidth. Larger pages may need 250 Mbps for sharper text. Use a
          fast local connection.
        </Text>
      </View>
    );
  return (
    <View>
      <BrowserMenuChoices
        {...common}
        title="Video codec"
        value={selection.value}
        options={[
          { value: "webcodecs", label: "Standard", detail: "H.264 or VP8" },
          {
            value: "pyrowave",
            label: "PyroWave LAN",
            detail: "Experimental · 100–250 Mbps",
            disabled: !selection.available,
          },
        ]}
        onChange={selection.onChange}
      />
      <Text accessibilityLiveRegion="polite" style={text}>
        {selection.activeCodec
          ? `${describeActiveVideoCodec(selection.activeCodec) ?? "Standard video"} is active`
          : "Waiting for a live video frame"}
      </Text>
      {!selection.available && selection.unavailableReason ? (
        <Text style={text}>{selection.unavailableReason}</Text>
      ) : null}
      {selection.fallbackReason ? (
        <Text accessibilityRole="alert" style={text}>
          {selection.fallbackReason}
        </Text>
      ) : null}
      {selection.fallbackReason && selection.available ? (
        <BrowserMenuItem
          {...common}
          label="Retry PyroWave"
          icon="RefreshCw"
          onPress={selection.onRetry}
        />
      ) : null}
      <Text style={text}>
        Saved for this host. Changes apply automatically and keep your tabs open. Unsupported
        clients and connections use standard video, with a visible status.
      </Text>
    </View>
  );
}
