import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { MutableRefObject, RefObject } from "react";
import { View } from "react-native";
import type { BrowserState } from "../shared/browser";
import { ChromeIconButton, ControlButton, Field } from "./browser-chrome";
import type { createStyles } from "./browser-panel-styles";
import type { ControlledActions } from "./use-browser-controlled-actions";
import type { BrowserToolbarMenuKind } from "./use-browser-toolbar-menu";

type Styles = ReturnType<typeof createStyles>;
type Theme = PluginWorkspacePanelProps["theme"];

const MAX_URL_LENGTH = 8_192;

/**
 * The tab row's control button: Release while this panel holds control, Take over while
 * another viewer does, otherwise Take control (or Reacquire after a lapsed lease).
 */
export function BrowserControlAction({
  styles,
  theme,
  state,
  controlToken,
  viewerToken,
  anyMutationPending,
  release,
  takeControl,
}: {
  styles: Styles;
  theme: Theme;
  state: BrowserState | null;
  controlToken: string | null;
  viewerToken: string | null;
  anyMutationPending: boolean;
  release(): void;
  takeControl(takeover: boolean): void;
}) {
  if (state?.controller === "self" && controlToken) {
    return (
      <ControlButton
        styles={styles}
        theme={theme}
        label="Release"
        icon="LogOut"
        iconOnly
        disabled={anyMutationPending}
        onPress={release}
      />
    );
  }
  if (state?.controller === "other") {
    return (
      <ControlButton
        styles={styles}
        theme={theme}
        label="Take over"
        icon="Crown"
        iconOnly
        danger
        disabled={!viewerToken || anyMutationPending}
        onPress={() => takeControl(true)}
      />
    );
  }
  return (
    <ControlButton
      styles={styles}
      theme={theme}
      label={state?.controller === "self" ? "Reacquire" : "Take control"}
      icon="MousePointer2"
      iconOnly
      primary
      disabled={!viewerToken || anyMutationPending}
      onPress={() => takeControl(false)}
    />
  );
}

/** Everything the address toolbar renders and calls. */
export interface BrowserToolbarProps {
  styles: Styles;
  theme: Theme;
  state: BrowserState | null;
  viewerToken: string | null;
  anyMutationPending: boolean;
  pageActionUnavailable: boolean;
  navigatePending: boolean;
  addressDraft: string;
  setAddressDraft(value: string): void;
  setAddressFocused(focused: boolean): void;
  toolbarMenu: BrowserToolbarMenuKind | null;
  toggleToolbarMenu(menu: BrowserToolbarMenuKind): void;
  displayAnchorRef: RefObject<View | null>;
  actionsAnchorRef: RefObject<View | null>;
  emulationMode: string;
  requestControlled(label: string, run: () => void): void;
  controlledActionsRef: MutableRefObject<ControlledActions | null>;
}

/**
 * The address toolbar: history and reload, the address field, the display menu, mobile
 * emulation and the browser menu. Every page action goes through `requestControlled`, which
 * asks for control first when this panel does not hold it.
 */
export function BrowserToolbar({
  styles,
  theme,
  state,
  viewerToken,
  anyMutationPending,
  pageActionUnavailable,
  navigatePending,
  addressDraft,
  setAddressDraft,
  setAddressFocused,
  toolbarMenu,
  toggleToolbarMenu,
  displayAnchorRef,
  actionsAnchorRef,
  emulationMode,
  requestControlled,
  controlledActionsRef,
}: BrowserToolbarProps) {
  return (
    <View style={styles.chrome}>
      <View style={styles.addressRow}>
        <ChromeIconButton
          styles={styles}
          theme={theme}
          label="Back"
          icon="ArrowLeft"
          disabled={!viewerToken || !state?.canGoBack || anyMutationPending}
          onPress={() =>
            requestControlled("go back", () => controlledActionsRef.current?.navigate("back"))
          }
        />
        <ChromeIconButton
          styles={styles}
          theme={theme}
          label="Forward"
          icon="ArrowRight"
          disabled={!viewerToken || !state?.canGoForward || anyMutationPending}
          onPress={() =>
            requestControlled("go forward", () => controlledActionsRef.current?.navigate("forward"))
          }
        />
        <ChromeIconButton
          styles={styles}
          theme={theme}
          label="Reload"
          icon="RotateCw"
          disabled={pageActionUnavailable || anyMutationPending}
          onPress={() =>
            requestControlled("reload the page", () =>
              controlledActionsRef.current?.navigate("reload"),
            )
          }
        />
        <Field
          styles={styles}
          theme={theme}
          value={addressDraft}
          accessibilityLabel="Browser address"
          placeholder="Enter a URL"
          editable={Boolean(viewerToken) && !navigatePending}
          dimWhenReadOnly={false}
          keyboardType="url"
          maxLength={MAX_URL_LENGTH}
          returnKeyType="go"
          style={[styles.addressInput, styles.chromeAddressInput]}
          onChangeText={setAddressDraft}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onSubmit={() => {
            const target = addressDraft;
            requestControlled("open this address", () =>
              controlledActionsRef.current?.navigate("goto", target),
            );
          }}
        />
        <View ref={displayAnchorRef} collapsable={false}>
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Display options"
            icon="Monitor"
            selected={toolbarMenu === "display"}
            expanded={toolbarMenu === "display"}
            onPress={() => toggleToolbarMenu("display")}
          />
        </View>
        <ChromeIconButton
          styles={styles}
          theme={theme}
          label={`${emulationMode === "mobile" ? "Disable" : "Enable"} mobile emulation`}
          icon="Smartphone"
          selected={emulationMode === "mobile"}
          disabled={pageActionUnavailable || anyMutationPending}
          onPress={() =>
            requestControlled("change mobile emulation", () =>
              controlledActionsRef.current?.toggleEmulation(),
            )
          }
        />
        <View ref={actionsAnchorRef} collapsable={false}>
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Browser menu"
            icon="EllipsisVertical"
            selected={toolbarMenu === "actions"}
            expanded={toolbarMenu === "actions"}
            onPress={() => toggleToolbarMenu("actions")}
          />
        </View>
      </View>
    </View>
  );
}
