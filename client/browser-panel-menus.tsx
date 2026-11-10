import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { MutableRefObject } from "react";
import { Text, View } from "react-native";
import type { BrowserState } from "../shared/browser";
import { isPrintPreviewUrl } from "../shared/browser-page";
import { BrowserActionsMenu } from "./browser-actions-menu";
import type { BrowserCanvasDisplayMode } from "./browser-canvas-layout";
import { ControlButton, ErrorNotice, Field } from "./browser-chrome";
import { BrowserDisplayMenu } from "./browser-display-menu";
import type { matchingResolutionPresetId } from "./browser-emulation-mode";
import type { createStyles } from "./browser-panel-styles";
import { BrowserMenuItem } from "./browser-toolbar-menu";
import type { browserVideoPlaybackStatus } from "./browser-video-status";
import type { ControlledActions, SpecialKey } from "./use-browser-controlled-actions";
import type { BrowserMediaPresentation } from "./use-browser-media-presentation";
import type { BrowserToolbarMenuState } from "./use-browser-toolbar-menu";
import type { useResolutionFavorites } from "./use-resolution-favorites";

type Styles = ReturnType<typeof createStyles>;
type Theme = PluginWorkspacePanelProps["theme"];
type Layout = PluginWorkspacePanelProps["layout"];

/** Keys the Send keys submenu offers, in menu order. */
const SPECIAL_KEYS: readonly { key: SpecialKey; label: string }[] = [
  { key: "Enter", label: "Enter" },
  { key: "Tab", label: "Tab" },
  { key: "Escape", label: "Esc" },
  { key: "Backspace", label: "Backspace" },
  { key: "Delete", label: "Delete" },
  { key: "ArrowUp", label: "↑" },
  { key: "ArrowDown", label: "↓" },
  { key: "ArrowLeft", label: "←" },
  { key: "ArrowRight", label: "→" },
  { key: "Home", label: "Home" },
  { key: "End", label: "End" },
  { key: "PageUp", label: "Page up" },
  { key: "PageDown", label: "Page down" },
  { key: "Space", label: "Space" },
];

/** The notice the display menu repeats above its custom viewport fields. */
export interface BrowserMenuNotice {
  visibleError: string | null;
  operationError: string | null;
  operationNoticeId: unknown;
  connectionError: unknown;
  dismissOperationError(): void;
}

/** Everything the display menu renders and calls. */
export interface BrowserPanelDisplayMenuProps {
  styles: Styles;
  theme: Theme;
  layout: Layout;
  touchFirstLayout: boolean;
  menu: BrowserToolbarMenuState;
  panelScope: string;
  scaleMode: BrowserCanvasDisplayMode;
  setScaleMode(mode: BrowserCanvasDisplayMode): void;
  state: BrowserState | null;
  preferences: ReturnType<typeof useResolutionFavorites>;
  media: BrowserMediaPresentation;
  selectedResolutionPresetId: ReturnType<typeof matchingResolutionPresetId>;
  pageActionUnavailable: boolean;
  anyMutationPending: boolean;
  fillViewportEnabled: boolean;
  fillViewportDetail: string;
  fillViewportResolution: unknown;
  videoStatus: ReturnType<typeof browserVideoPlaybackStatus>;
  transportLabel: string;
  notice: BrowserMenuNotice;
  viewportWidth: string;
  setViewportWidth(value: string): void;
  viewportHeight: string;
  setViewportHeight(value: string): void;
  viewportEditable: boolean;
  requestControlled(label: string, run: () => void): void;
  controlledActionsRef: MutableRefObject<ControlledActions | null>;
}

/**
 * The display menu: view size, resolution presets and favourites, Fill viewport, capture and
 * video quality, graphics, and the custom viewport fields.
 */
export function BrowserPanelDisplayMenu({
  styles,
  theme,
  layout,
  touchFirstLayout,
  menu,
  panelScope,
  scaleMode,
  setScaleMode,
  state,
  preferences,
  media,
  selectedResolutionPresetId,
  pageActionUnavailable,
  anyMutationPending,
  fillViewportEnabled,
  fillViewportDetail,
  fillViewportResolution,
  videoStatus,
  transportLabel,
  notice,
  viewportWidth,
  setViewportWidth,
  viewportHeight,
  setViewportHeight,
  viewportEditable,
  requestControlled,
  controlledActionsRef,
}: BrowserPanelDisplayMenuProps) {
  const { paneRef, paneSize, displayAnchorRef, closeToolbarMenu, menuRestoreFocus } = menu;
  const { video, canTryPyrowave, mediaUnavailableReason } = media;
  const { visibleError, operationError, connectionError } = notice;
  return (
    <BrowserDisplayMenu
      theme={theme}
      compact={touchFirstLayout}
      paneRef={paneRef}
      paneSize={paneSize}
      anchorRef={displayAnchorRef}
      onClose={() => closeToolbarMenu()}
      shouldRestoreFocus={() => menuRestoreFocus.current}
      scaleMode={scaleMode}
      viewport={state?.viewport ?? null}
      onScaleModeChange={(value) => {
        closeToolbarMenu();
        setScaleMode(value);
      }}
      resolution={{
        selectedPresetId: selectedResolutionPresetId,
        favoritePresetIds: preferences.favoritePresetIds,
        selectDisabled: pageActionUnavailable || anyMutationPending,
        favoriteDisabled: preferences.disabled,
        onSelect: (id) => {
          closeToolbarMenu();
          requestControlled("change the browser resolution", () =>
            controlledActionsRef.current?.selectDevicePreset(id),
          );
        },
        onToggleFavorite: preferences.toggleFavorite,
      }}
      fillViewportSelected={fillViewportEnabled}
      fillViewportDetail={fillViewportDetail}
      fillViewportDisabled={pageActionUnavailable || anyMutationPending || !fillViewportResolution}
      onFillViewport={() => {
        closeToolbarMenu();
        requestControlled("fill the browser viewport", () =>
          controlledActionsRef.current?.fillViewport(),
        );
      }}
      quality={{
        disabled: preferences.disabled,
        captureQuality: preferences.captureQuality,
        liveVideoEnabled: preferences.liveVideoEnabled,
        videoStatus,
        playbackLabel: transportLabel,
        codec: {
          value: preferences.videoCodec,
          bitrate: preferences.pyrowaveBitrate,
          available: canTryPyrowave,
          unavailableReason: mediaUnavailableReason,
          activeCodec: video.front?.codec ?? null,
          fallbackReason: video.codecFallbackReason,
          onChange: preferences.changeVideoCodec,
          onBitrateChange: preferences.changePyrowaveBitrate,
          onRetry: video.retry,
        },
        onLiveVideoChange: preferences.changeLiveVideoEnabled,
        videoBitrate: preferences.videoBitrate,
        videoFps: preferences.videoFps,
        onVideoBitrateChange: preferences.changeVideoBitrate,
        onVideoFpsChange: preferences.changeVideoFps,
        onQualityChange: preferences.changeQuality,
      }}
      graphics={{
        preference: preferences.graphicsPreference,
        graphics: state?.graphics ?? null,
        disabled: preferences.disabled,
        // With no page open the next launch already reads the saved mode; nothing to restart.
        applyDisabled: pageActionUnavailable || anyMutationPending,
        onChange: preferences.changeGraphicsPreference,
        onApply: () => {
          closeToolbarMenu(false);
          requestControlled("apply browser graphics", () =>
            controlledActionsRef.current?.applyGraphics(),
          );
        },
      }}
      error={
        preferences.error ? (
          <View style={{ padding: 12, gap: 8 }}>
            <ErrorNotice
              noticeScope={panelScope}
              styles={styles}
              theme={theme}
              message={preferences.error}
            />
            <BrowserMenuItem
              theme={theme}
              compact={layout.compact}
              label="Reload preferences"
              onPress={preferences.reload}
            />
          </View>
        ) : null
      }
      customViewport={
        <>
          {visibleError ? (
            <ErrorNotice
              noticeScope={panelScope}
              styles={styles}
              theme={theme}
              message={visibleError}
              noticeId={
                operationError ? notice.operationNoticeId : (connectionError ?? visibleError)
              }
              onDismiss={operationError ? notice.dismissOperationError : undefined}
            />
          ) : null}
          <View style={styles.customViewportRow}>
            <Field
              styles={styles}
              theme={theme}
              value={viewportWidth}
              accessibilityLabel="Canonical viewport width"
              editable={viewportEditable}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={4}
              selectTextOnFocus
              style={styles.viewportField}
              onChangeText={setViewportWidth}
              onSubmit={() => {
                if (pageActionUnavailable) return;
                requestControlled("resize the browser", () =>
                  controlledActionsRef.current?.applyViewport(),
                );
              }}
            />
            <Text style={styles.multiply}>×</Text>
            <Field
              styles={styles}
              theme={theme}
              value={viewportHeight}
              accessibilityLabel="Canonical viewport height"
              editable={viewportEditable}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={4}
              selectTextOnFocus
              style={styles.viewportField}
              onChangeText={setViewportHeight}
              onSubmit={() => {
                if (pageActionUnavailable) return;
                requestControlled("resize the browser", () =>
                  controlledActionsRef.current?.applyViewport(),
                );
              }}
            />
            <ControlButton
              styles={styles}
              theme={theme}
              label="Apply"
              disabled={pageActionUnavailable || anyMutationPending}
              onPress={() =>
                requestControlled("resize the browser", () =>
                  controlledActionsRef.current?.applyViewport(),
                )
              }
            />
          </View>
        </>
      }
    />
  );
}

/** Everything the actions menu renders and calls. */
export interface BrowserPanelActionsMenuProps {
  theme: Theme;
  layout: Layout;
  menu: BrowserToolbarMenuState;
  state: BrowserState | null;
  viewerToken: string | null;
  canControl: boolean;
  canSendInput: boolean;
  composeAvailable: boolean;
  pageActionUnavailable: boolean;
  anyMutationPending: boolean;
  printPending: boolean;
  reconnectDisabled: boolean;
  reconnect(): void;
  resetNativeKeyboard(): void;
  requestControlled(label: string, run: () => void, needsFrame?: boolean): void;
  controlledActionsRef: MutableRefObject<ControlledActions | null>;
}

/**
 * The browser menu: Send keys, the native keyboard or compose draft, print, reconnect and
 * close. Actions that publish input wait for an admitted current frame.
 */
export function BrowserPanelActionsMenu({
  theme,
  layout,
  menu,
  state,
  viewerToken,
  canControl,
  canSendInput,
  composeAvailable,
  pageActionUnavailable,
  anyMutationPending,
  printPending,
  reconnectDisabled,
  reconnect,
  resetNativeKeyboard,
  requestControlled,
  controlledActionsRef,
}: BrowserPanelActionsMenuProps) {
  const {
    toolbarMenu,
    paneRef,
    paneSize,
    actionsAnchorRef,
    keysAnchorRef,
    keysSubmenuOpen,
    setKeysSubmenuOpen,
    closeToolbarMenu,
    menuRestoreFocus,
  } = menu;
  return (
    <BrowserActionsMenu
      key={toolbarMenu}
      theme={theme}
      compact={layout.compact}
      paneRef={paneRef}
      paneSize={paneSize}
      anchorRef={actionsAnchorRef}
      onClose={() => closeToolbarMenu()}
      shouldRestoreFocus={() => menuRestoreFocus.current}
      onSubmenuOpen={() => {
        if (canSendInput) setKeysSubmenuOpen(true);
      }}
      submenu={
        toolbarMenu === "actions" && keysSubmenuOpen
          ? {
              title: "Send keys",
              anchorRef: keysAnchorRef,
              preferredHeight: 40 + SPECIAL_KEYS.length * (layout.compact ? 44 : 36),
              onBack: () => setKeysSubmenuOpen(false),
              children: SPECIAL_KEYS.map(({ key, label }) => (
                <BrowserMenuItem
                  key={key}
                  theme={theme}
                  compact={layout.compact}
                  label={label}
                  disabled={pageActionUnavailable || (canControl && !canSendInput)}
                  onPress={() => {
                    resetNativeKeyboard();
                    closeToolbarMenu();
                    requestControlled(
                      `send ${label}`,
                      () => controlledActionsRef.current?.sendKey(key),
                      true,
                    );
                  }}
                />
              )),
            }
          : undefined
      }
      keyboard={
        layout.platform !== "web"
          ? {
              disabled: pageActionUnavailable || (canControl && !canSendInput),
              onPress: () => {
                closeToolbarMenu();
                requestControlled(
                  "open the browser keyboard",
                  () => controlledActionsRef.current?.openNativeKeyboard(),
                  true,
                );
              },
            }
          : undefined
      }
      compose={
        composeAvailable
          ? {
              disabled: pageActionUnavailable || (canControl && !canSendInput),
              onPress: () => {
                closeToolbarMenu();
                requestControlled(
                  "compose browser text",
                  () => controlledActionsRef.current?.openCompose("compose"),
                  true,
                );
              },
            }
          : undefined
      }
      sendKeys={{
        anchorRef: keysAnchorRef,
        expanded: keysSubmenuOpen,
        disabled: pageActionUnavailable || (canControl && !canSendInput),
        onPress: () => requestControlled("send browser keys", () => setKeysSubmenuOpen(true)),
      }}
      print={{
        pending: printPending,
        available: state?.canPrint ?? false,
        disabled:
          !viewerToken ||
          anyMutationPending ||
          !state?.canPrint ||
          isPrintPreviewUrl(state?.url ?? ""),
        onPress: () => {
          closeToolbarMenu();
          requestControlled("open print preview", () => controlledActionsRef.current?.print());
        },
      }}
      reconnect={{
        disabled: reconnectDisabled,
        onPress: () => {
          closeToolbarMenu();
          reconnect();
        },
      }}
      closeBrowser={{
        disabled: pageActionUnavailable || anyMutationPending,
        onPress: () => {
          closeToolbarMenu(false);
          requestControlled("close the shared browser", () =>
            controlledActionsRef.current?.closeBrowser(),
          );
        },
      }}
    />
  );
}
