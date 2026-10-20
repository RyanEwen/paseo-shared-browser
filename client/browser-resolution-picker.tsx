/** Resolution menu rows with independent host favorites. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, View } from "react-native";
import type { DevicePresetId } from "../shared/device-presets";
import type { ResolutionPreset } from "../shared/resolution-menu";
import { BrowserMenuItem } from "./browser-toolbar-menu";
import { FavoriteStar } from "./favorite-star";

export interface BrowserResolutionPickerProps {
  theme: PluginHostProps["theme"];
  compact: boolean;
  presets: readonly ResolutionPreset[];
  selectedPresetId: DevicePresetId | null;
  favoritePresetIds: readonly DevicePresetId[];
  selectDisabled: boolean;
  favoriteDisabled: boolean;
  onSelect(id: DevicePresetId): void;
  onToggleFavorite(id: DevicePresetId): void;
}

/** Keeps star presses separate: favoriting never resizes the browser or closes the menu. */
export function BrowserResolutionPicker(props: BrowserResolutionPickerProps) {
  return (
    <View>
      {props.presets.map((preset) => {
        const favorite = props.favoritePresetIds.includes(preset.id);
        return (
          <View key={preset.id} style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <BrowserMenuItem
                theme={props.theme}
                compact={props.compact}
                label={preset.label}
                detail={`${preset.viewport.width} × ${preset.viewport.height}`}
                accessibilityLabel={`Emulate ${preset.label}`}
                icon={preset.isMobile ? "Smartphone" : "Monitor"}
                selected={preset.id === props.selectedPresetId}
                disabled={props.selectDisabled}
                onPress={() => props.onSelect(preset.id)}
              />
            </View>
            <Pressable
              accessibilityRole="menuitem"
              accessibilityLabel={`${favorite ? "Remove" : "Add"} ${preset.label} ${favorite ? "from" : "to"} favorites`}
              accessibilityState={{ selected: favorite, disabled: props.favoriteDisabled }}
              disabled={props.favoriteDisabled}
              onPress={() => props.onToggleFavorite(preset.id)}
              style={({ pressed }) => ({
                width: 44,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
                opacity: props.favoriteDisabled ? 0.45 : pressed ? 0.72 : 1,
              })}
            >
              <FavoriteStar
                filled={favorite}
                size={18}
                color={favorite ? props.theme.colors.accent : props.theme.colors.foregroundMuted}
              />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
