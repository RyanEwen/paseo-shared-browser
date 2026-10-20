import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import {
  BROWSER_GRAPHICS_LABELS,
  type BrowserGraphicsPreference,
  type BrowserGraphicsState,
} from "../shared/browser-graphics";
import { BrowserMenuChoices } from "./browser-menu-choices";
import { BrowserMenuItem } from "./browser-toolbar-menu";

export interface BrowserGraphicsControlsProps {
  compact: boolean;
  theme: PluginHostProps["theme"];
  preference: BrowserGraphicsPreference;
  graphics: BrowserGraphicsState | null;
  disabled: boolean;
  applyDisabled: boolean;
  onChange(preference: BrowserGraphicsPreference): void;
  onApply(): void;
}

/** Compare saved startup intent with the running browser without inventing missing metadata. */
export function describeBrowserGraphics(
  preference: BrowserGraphicsPreference,
  graphics: BrowserGraphicsState | null,
) {
  const pending = Boolean(graphics && preference !== graphics.preference);
  return {
    pending,
    title:
      graphics?.hardware === true
        ? "Browser started with hardware GPU"
        : graphics?.hardware === false
          ? "Browser started with software rendering"
          : "Browser graphics status not reported",
  };
}

/** Saving changes startup intent only. Applying to open tabs is a separate controlled action. */
export function BrowserGraphicsControls(props: BrowserGraphicsControlsProps) {
  const { colors } = props.theme;
  const description = describeBrowserGraphics(props.preference, props.graphics);
  const choices = [
    { value: "host-default", label: BROWSER_GRAPHICS_LABELS["host-default"] },
    { value: "vulkan", label: `${BROWSER_GRAPHICS_LABELS.vulkan} · Linux` },
    { value: "wayland", label: `${BROWSER_GRAPHICS_LABELS.wayland} · Linux` },
    { value: "private-desktop", label: `${BROWSER_GRAPHICS_LABELS["private-desktop"]} · Linux` },
  ] as const;
  return (
    <View style={{ gap: 8 }}>
      <BrowserMenuChoices
        theme={props.theme}
        compact={props.compact}
        title="Graphics mode"
        heading="Graphics mode"
        disabled={props.disabled}
        value={props.preference}
        options={choices.map((choice) => ({
          ...choice,
          disabled:
            choice.value !== "host-default" &&
            Boolean(props.graphics && props.graphics.platform !== "linux"),
        }))}
        onChange={props.onChange}
      />
      <View
        accessibilityLiveRegion="polite"
        style={{ padding: 12, gap: 8, backgroundColor: colors.surface2, borderRadius: 8 }}
      >
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
          {description.title}
        </Text>
        {props.graphics?.renderer ? (
          <Text numberOfLines={3} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            {props.graphics.renderer}
          </Text>
        ) : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          Used for new browsers on this host. Host default keeps the existing setup, including WSL
          graphics. Changing the mode keeps open tabs running.
        </Text>
        {props.preference === "private-desktop" ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            Enables real Chromium print preview on an invisible private display. Requires Xvfb on
            this host. Select the Print preview tab after opening print. Use Cancel, then select
            your original tab. System print and save dialogs are unavailable.
          </Text>
        ) : null}
        {description.pending ? (
          <>
            <Text style={{ color: colors.foreground, fontSize: 12 }}>
              Selected graphics mode is not active in this browser.
            </Text>
            <Text style={{ color: colors.foreground, fontSize: 12 }}>
              Applying here restarts this workspace’s browser and closes its tabs for every viewer.
              Save your page work first.
            </Text>
            <BrowserMenuItem
              theme={props.theme}
              compact={props.compact}
              label="Apply graphics mode…"
              accessibilityLabel="Apply graphics mode"
              disabled={props.applyDisabled || props.disabled}
              onPress={props.onApply}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}
