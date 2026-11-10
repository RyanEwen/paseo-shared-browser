/**
 * Workspace browser panel orchestration: viewer/control ownership, current
 * decoded receipts, media handoff and menu actions. Native/DOM forwarding and
 * presentation models live in focused counterpart hooks; this module never
 * replays published mutations or substitutes visible pixels for input authority.
 */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { DEVICE_PRESETS, MAX_BROWSER_TABS, MAX_VIEWPORT, MIN_VIEWPORT } from "../shared/browser";
import { isPrintPreviewUrl } from "../shared/browser-page";
import { BrowserCanvasArea, BrowserCanvasStatus } from "./browser-canvas-area";
import { ErrorNotice } from "./browser-chrome";
import { ComposeTextControls } from "./browser-compose-controls";
import { matchingResolutionPresetId } from "./browser-emulation-mode";
import { NativeKeyboardControls } from "./browser-native-keyboard-controls";
import { BrowserClosedView, BrowserPanelDialogs } from "./browser-panel-dialogs";
import { errorMessage } from "./browser-panel-errors";
import { BrowserPanelActionsMenu, BrowserPanelDisplayMenu } from "./browser-panel-menus";
import {
  browserDeviceLabel,
  browserFrameSummary,
  browserStatusPresentation,
} from "./browser-panel-presentation";
import { createStyles } from "./browser-panel-styles";
import { BrowserTabs } from "./browser-tabs";
import { BrowserControlAction, BrowserToolbar } from "./browser-toolbar";
import { browserVideoPlaybackStatus, describeBrowserVideoTransport } from "./browser-video-status";
import { useBrowserAttachment } from "./use-browser-attachment";
import { useBrowserComposeRequest } from "./use-browser-compose-request";
import {
  useBrowserControlAuthority,
  useBrowserControlState,
  useBrowserMutations,
  useBrowserPanelCanvasInput,
  usePendingControlAction,
} from "./use-browser-controlled-actions";
import { useBrowserDisplayScale } from "./use-browser-display-scale";
import { useBrowserMediaPresentation } from "./use-browser-media-presentation";
import { useBrowserOperationError } from "./use-browser-operation-error";
import { useBrowserRpcClients } from "./use-browser-rpc-clients";
import { useBrowserTabActions, useBrowserTabState } from "./use-browser-tabs";
import { useBrowserAddressDraft, useBrowserToolbarMenu } from "./use-browser-toolbar-menu";
import { useBrowserViewSize } from "./use-browser-view-size";
import { useBrowserViewerRecovery } from "./use-browser-viewer-recovery";
import {
  useBrowserViewportActions,
  useBrowserViewportDraft,
  useFillViewportScope,
} from "./use-browser-viewport-actions";
import { useResolutionFavorites } from "./use-resolution-favorites";

// Preserve the existing contribution entry/test import while ownership lives in a focused module.
export { contributeSharedBrowserClient } from "./browser-client-presence";

const MAX_VIEWER_LABEL_LENGTH = 64;

interface Size {
  width: number;
  height: number;
}

/**
 * The Shared Browser workspace panel: attaches this client as a viewer of the workspace's browser
 * and composes the tab row, toolbar, canvas, menus and dialogs from focused hooks.
 */
export function SharedBrowserPanel({
  theme,
  host,
  layout,
  workspaceId,
  active = true,
}: PluginWorkspacePanelProps & { active?: boolean }) {
  const queryClient = useQueryClient();
  // Match the touch-first input policy, including wide native tablets.
  const touchFirstLayout = layout.platform !== "web" || layout.compact;
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const screenPixelRatio = useBrowserDisplayScale();
  const viewerLabel = useState(() =>
    `Paseo ${layout.platform} · ${host.label} · ${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`.slice(0, MAX_VIEWER_LABEL_LENGTH),
  )[0];
  const rpc = useBrowserRpcClients();
  const tabs = useBrowserTabState();
  const control = useBrowserControlState();
  const operationNotice = useBrowserOperationError(JSON.stringify([host.id, workspaceId]));
  const operationError = operationNotice.message;
  const setOperationError = operationNotice.publish;
  const preferences = useResolutionFavorites(host.id);
  const menu = useBrowserToolbarMenu();
  const [scaleMode, setScaleMode] = useBrowserViewSize(host.id, workspaceId);
  const panelScope = `${host.id}/${workspaceId}`;
  const { setFillViewportScope, fillViewportEnabled } = useFillViewportScope(panelScope);
  const panelScopeRef = useRef(panelScope);
  panelScopeRef.current = panelScope;
  const [activeInput, setActiveInput] = useState(false);
  const activeInputRef = useRef(false);
  /** Fence automatic timers immediately, before React commits a new physical press. */
  const handleInputActivity = useCallback((active: boolean) => {
    activeInputRef.current = active;
    setActiveInput(active);
  }, []);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  // Hook order matters where effects depend on each other, and that order is kept. The
  // control-token clear and the address/viewport draft effects now run after the media effects;
  // they only set state that nothing else reads in the same pass, so the move is safe.
  const session = useBrowserAttachment({
    host,
    workspaceId,
    viewerLabel,
    active,
    rpc,
    tabs,
    control,
    setOperationError,
  });
  const media = useBrowserMediaPresentation({
    host,
    workspaceId,
    active,
    session,
    preferences,
    rpc,
    toolbarMenu: menu.toolbarMenu,
    activeInput,
    containerSize,
    scaleMode,
    screenPixelRatio,
  });
  const mutations = useBrowserMutations({
    host,
    workspaceId,
    rpc,
    session,
    media,
    control,
    tabs,
    tabsQuery: session.tabsQuery,
    operationNotice,
    setFillViewportScope,
  });
  const authority = useBrowserControlAuthority({
    rpc,
    session,
    media,
    control,
    mutations,
    selectedTabId: tabs.selectedTabId,
    selectedTabIdRef: tabs.selectedTabIdRef,
    panelScope,
    panelScopeRef,
    toolbarMenu: menu.toolbarMenu,
    closeToolbarMenu: menu.closeToolbarMenu,
    setOperationError,
  });
  const { addressDraft, setAddressDraft, setAddressFocused } = useBrowserAddressDraft(
    session.state,
  );
  const { viewportWidth, setViewportWidth, viewportHeight, setViewportHeight } =
    useBrowserViewportDraft(session.state);
  const canvasInput = useBrowserPanelCanvasInput({
    rpc,
    session,
    media,
    control,
    mutations,
    authority,
    operationNotice,
    containerSize,
    scaleMode,
    handleInputActivity,
  });
  const {
    composeRequest,
    composeOwnershipKey,
    composeDocumentKey,
    requestCompose,
    composeRequestHandled,
  } = useBrowserComposeRequest({
    viewerToken: session.viewerToken,
    controlToken: control.controlToken,
    state: session.state,
    canSendInput: authority.canSendInput,
    closeToolbarMenu: menu.closeToolbarMenu,
  });
  // Touch-first surfaces (native and compact web) get the explicit draft; desktop web types on the canvas.
  const composeAvailable = touchFirstLayout;
  const handleCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);
  usePendingControlAction({ session, control, authority, setOperationError });
  const viewportActions = useBrowserViewportActions({
    host,
    workspaceId,
    platform: layout.platform,
    active,
    session,
    mutations,
    authority,
    viewportWidth,
    viewportHeight,
    containerSize,
    panelScope,
    fillViewportEnabled,
    setFillViewportScope,
    setScaleMode,
    activeInput,
    activeInputRef,
    pendingControlAction: control.pendingControlAction,
    closeToolbarMenu: menu.closeToolbarMenu,
    setOperationError,
  });
  const tabActions = useBrowserTabActions({
    tabs,
    tabsQuery: session.tabsQuery,
    tabsQueryKey: session.tabsQueryKey,
    queryClient,
    rpc,
    workspaceId,
    panelScope,
    panelScopeRef,
    mountedRef: session.mountedRef,
    activeViewerTokenRef: session.activeViewerTokenRef,
    stateRef: session.stateRef,
    controllerObservationRevision: session.controllerObservationRevision,
    controlToken: control.controlToken,
    controlledActionsRef: control.controlledActionsRef,
    setOperationError,
    dropBrowserView: session.dropBrowserView,
    setBrowserClosed: session.setBrowserClosed,
    reconnect: session.reconnect,
    requestControlled: authority.requestControlled,
    requestIsCurrent: authority.requestIsCurrent,
  });

  // The render below reads these under their original names.
  const {
    state,
    viewerToken,
    attachQuery,
    tabsQuery,
    runtimeNotice,
    setRuntimeNotice,
    reconnecting,
    closedView,
    reconnect,
    buffer,
    frame,
    settled,
    imageError,
  } = session;
  const {
    video,
    captureQuery,
    videoViewerExpired,
    viewingExpired,
    useLiveVideo,
    canTryPyrowave,
    currentFrame,
  } = media;
  const {
    controlToken,
    controlRequest,
    setControlRequest,
    controlRequestPending,
    controlledActionsRef,
  } = control;
  const { anyMutationPending, navigateMutation, resizeMutation, printMutation } = mutations;
  const {
    canControl,
    canSendInput,
    liveInputEnabled,
    takeControl,
    release,
    requestControlled,
    confirmControlRequest,
    navigate,
    print,
    sendEvent,
  } = authority;
  const { applyViewport, fillTarget, fillViewport, selectDevicePreset, emulation } =
    viewportActions;
  const {
    selectedTabId,
    setSelectedTabId,
    tabMutationPending,
    tabCloseConfirmation,
    setTabCloseConfirmation,
    closeConfirmationOpen,
    setCloseConfirmationOpen,
    restartForGraphics,
    setRestartForGraphics,
    closePending,
    reopenPending,
  } = tabs;
  const {
    createBrowserTab,
    requestCloseSelectedTab,
    confirmCloseSelectedTab,
    confirmCloseBrowser,
    reopenClosedBrowser,
  } = tabActions;
  const {
    toolbarMenu,
    paneRef,
    displayAnchorRef,
    actionsAnchorRef,
    setPaneSize,
    closeToolbarMenu,
    toggleToolbarMenu,
  } = menu;

  // Queued actions always resolve through this render's scoped mutation callbacks.
  // A callback captured before acquisition must never reuse its old control identity.
  controlledActionsRef.current = {
    navigate,
    print,
    applyViewport,
    fillViewport,
    selectDevicePreset,
    toggleEmulation: emulation.toggle,
    sendKey: (key) => sendEvent({ kind: "key", key }),
    openCompose: requestCompose,
    openNativeKeyboard: () => requestCompose("keyboard"),
    closeTab: requestCloseSelectedTab,
    closeBrowser: () => {
      setRestartForGraphics(false);
      setCloseConfirmationOpen(true);
    },
    applyGraphics: () => {
      setRestartForGraphics(true);
      closeToolbarMenu(false);
      setCloseConfirmationOpen(true);
    },
    confirmCloseTab: () => void confirmCloseSelectedTab(),
    confirmCloseBrowser: () => void confirmCloseBrowser(),
  };

  useBrowserViewerRecovery({
    identity: JSON.stringify([host.id, workspaceId]),
    viewerToken,
    failedViewerToken: videoViewerExpired ? video.errorViewerToken : viewerToken,
    captureError: videoViewerExpired ? video.error : captureQuery.error,
    pending: reconnecting || attachQuery.isFetching,
    reconnect,
  });

  // Expiry belongs to the viewing-only recovery path, not an action failure.
  // A failed reattachment still surfaces its attachQuery error and manual retry.
  const connectionError =
    attachQuery.error ?? (viewingExpired ? null : (captureQuery.error ?? video.error));
  const recoveryError =
    state?.recoveryState === "runtime-unavailable"
      ? (state.error ?? "Browser runtime unavailable.")
      : null;
  const visibleError =
    operationError ??
    recoveryError ??
    state?.error ??
    (connectionError ? errorMessage(connectionError) : null) ??
    (tabsQuery.error ? errorMessage(tabsQuery.error) : null);
  // An empty workspace has a viewer but no page; page actions wait for a URL or New Tab.
  const pageOpen = state !== null && state.status !== "empty";
  const pageActionUnavailable = !viewerToken || !pageOpen;
  const { label: statusLabel, color: statusColor } = browserStatusPresentation(
    state?.status,
    theme,
  );
  let closeTabLabel = "Close tab";
  if (tabCloseConfirmation?.scope === "last-tab") closeTabLabel = "Close browser";
  if (tabMutationPending) closeTabLabel = "Closing…";

  const activeDevicePreset = state?.devicePresetId
    ? DEVICE_PRESETS.find(({ id }) => id === state.devicePresetId)
    : null;
  const selectedResolutionPresetId = fillViewportEnabled ? null : matchingResolutionPresetId(state);
  const fillViewportResolution = fillTarget;
  const fillViewportDetail = fillViewportResolution
    ? `${fillViewportResolution.width} × ${fillViewportResolution.height}`
    : `Requires ${MIN_VIEWPORT.width}–${MAX_VIEWPORT.width} × ${MIN_VIEWPORT.height}–${MAX_VIEWPORT.height}`;
  const deviceLabel = browserDeviceLabel({
    emulationMode: emulation.mode,
    fillViewportEnabled,
    selectedResolutionPresetId,
    activeDevicePresetLabel: activeDevicePreset?.label,
  });
  const videoStatus = browserVideoPlaybackStatus({
    enabled: useLiveVideo,
    hasFrame: Boolean(video.front),
    updating: Boolean(video.fallbackRevision),
    supported: video.supported,
    hostCaptureEnabled: state?.videoCaptureEnabled,
    failed: Boolean(video.error && video.errorViewerToken === viewerToken),
  });
  const transportLabel = describeBrowserVideoTransport({
    status: videoStatus,
    updating: Boolean(video.front && video.fallbackRevision),
    activeCodec: video.front?.codec ?? null,
    requestedPyrowave: preferences.videoCodec === "pyrowave",
    fallback: Boolean(video.codecFallbackReason),
  });
  const showCodecNotice = Boolean(
    video.codecFallbackReason && !runtimeNotice && !visibleError && !state?.notice,
  );
  let noticeAction: string | undefined;
  let onNoticeAction: (() => void) | undefined;
  if (connectionError || reconnecting) {
    noticeAction = "Reconnect";
    onNoticeAction = reconnect;
  } else if (showCodecNotice && canTryPyrowave) {
    noticeAction = "Retry PyroWave";
    onNoticeAction = video.retry;
  }
  const dismissOperationError = () => operationNotice.dismiss(operationNotice.id!);
  let onDismissNotice: (() => void) | undefined;
  if (runtimeNotice) {
    onDismissNotice = () =>
      setRuntimeNotice((current) => (current === runtimeNotice ? null : current));
  } else if (operationError) {
    onDismissNotice = dismissOperationError;
  }
  const summaryFrame = video.front?.frame ?? currentFrame;
  let presentedBytes = frame?.byteLength ?? 0;
  if (video.front) {
    presentedBytes =
      "data" in video.front ? video.front.data.byteLength : (video.front.dataBase64.length * 3) / 4;
  }
  const frameSummary = browserFrameSummary({
    frame: summaryFrame,
    state,
    compact: layout.compact,
    presentedBytes,
    transportLabel,
    deviceLabel,
  });

  if (closedView) {
    return (
      <BrowserClosedView
        styles={styles}
        theme={theme}
        panelScope={panelScope}
        reopenPending={reopenPending}
        reopenClosedBrowser={reopenClosedBrowser}
        operationError={operationError}
        operationNoticeId={operationNotice.id}
        dismissOperationError={dismissOperationError}
      />
    );
  }

  const browserTabs = (
    <BrowserTabs
      styles={styles}
      bottom={touchFirstLayout}
      theme={theme}
      tabs={tabsQuery.data?.tabs ?? []}
      selectedId={selectedTabId ?? state?.tabId ?? null}
      selectedState={state}
      statusColor={statusColor}
      statusLabel={statusLabel}
      controlAction={
        <BrowserControlAction
          styles={styles}
          theme={theme}
          state={state}
          controlToken={controlToken}
          viewerToken={viewerToken}
          anyMutationPending={anyMutationPending}
          release={release}
          takeControl={takeControl}
        />
      }
      canCreate={
        Boolean(viewerToken) &&
        !tabMutationPending &&
        (tabsQuery.data?.tabs.filter((tab) => !isPrintPreviewUrl(tab.url)).length ?? 0) <
          MAX_BROWSER_TABS
      }
      canClose={
        Boolean(viewerToken) && !tabMutationPending && (tabsQuery.data?.tabs.length ?? 0) > 0
      }
      onSelect={setSelectedTabId}
      onCreate={() => void createBrowserTab()}
      onClose={requestCloseSelectedTab}
    />
  );

  const browserToolbar = (
    <BrowserToolbar
      styles={styles}
      theme={theme}
      state={state}
      viewerToken={viewerToken}
      anyMutationPending={anyMutationPending}
      pageActionUnavailable={pageActionUnavailable}
      navigatePending={navigateMutation.isPending}
      addressDraft={addressDraft}
      setAddressDraft={setAddressDraft}
      setAddressFocused={setAddressFocused}
      toolbarMenu={toolbarMenu}
      toggleToolbarMenu={toggleToolbarMenu}
      displayAnchorRef={displayAnchorRef}
      actionsAnchorRef={actionsAnchorRef}
      emulationMode={emulation.mode}
      requestControlled={requestControlled}
      controlledActionsRef={controlledActionsRef}
    />
  );

  const canvasStatus = (
    <BrowserCanvasStatus
      styles={styles}
      top={touchFirstLayout}
      title={state?.title || state?.url || "Shared browser"}
      frameSummary={frameSummary}
    />
  );

  const requestComposeControl = () =>
    requestControlled(
      "insert the composed text",
      () => controlledActionsRef.current?.openCompose("commit"),
      true,
    );

  return (
    <View
      ref={paneRef}
      collapsable={false}
      style={styles.screen}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPaneSize((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
      }}
    >
      {touchFirstLayout ? null : browserTabs}

      {touchFirstLayout ? canvasStatus : browserToolbar}

      {runtimeNotice || visibleError || state?.notice || video.codecFallbackReason ? (
        <ErrorNotice
          noticeScope={panelScope}
          styles={styles}
          theme={theme}
          message={
            runtimeNotice ?? visibleError ?? state?.notice ?? video.codecFallbackReason ?? ""
          }
          noticeId={
            runtimeNotice ??
            (operationError ? operationNotice.id : (connectionError ?? visibleError))
          }
          onDismiss={onDismissNotice}
          action={noticeAction}
          onAction={onNoticeAction}
          actionDisabled={attachQuery.isFetching}
        />
      ) : null}

      <BrowserCanvasArea
        styles={styles}
        theme={theme}
        layout={layout}
        touchFirstLayout={touchFirstLayout}
        scaleMode={scaleMode}
        containerSize={containerSize}
        canControl={canControl}
        onLayout={handleCanvasLayout}
        state={state}
        buffer={buffer}
        settled={settled}
        media={media}
        imageError={imageError}
        connectionError={connectionError}
        connecting={attachQuery.isPending || reconnecting}
        loading={attachQuery.isPending || reconnecting || captureQuery.isFetching}
        liveInputEnabled={liveInputEnabled}
        inputLayerRef={canvasInput.canvasRef}
        panHandlers={canvasInput.panHandlers}
        status={canvasStatus}
      />

      {touchFirstLayout ? (
        <>
          {browserTabs}
          {browserToolbar}
        </>
      ) : null}

      {layout.platform !== "web" ? (
        <NativeKeyboardControls
          styles={styles}
          theme={theme}
          relay={canvasInput.nativeKeyboard}
          cancelInput={canvasInput.cancel}
          enabled={canSendInput}
          ownershipKey={composeOwnershipKey}
          documentKey={composeDocumentKey}
          request={composeRequest}
          onRequestHandled={composeRequestHandled}
          canRequestControl={Boolean(viewerToken) && !canControl}
          onRequestControlForCompose={requestComposeControl}
        />
      ) : null}
      {layout.platform === "web" && composeAvailable ? (
        <ComposeTextControls
          styles={styles}
          theme={theme}
          composeText={canvasInput.composeText}
          cancelInput={canvasInput.cancel}
          enabled={canSendInput}
          ownershipKey={composeOwnershipKey}
          documentKey={composeDocumentKey}
          request={
            composeRequest && composeRequest.kind !== "keyboard"
              ? { ...composeRequest, kind: composeRequest.kind }
              : null
          }
          onRequestHandled={composeRequestHandled}
          canRequestControl={Boolean(viewerToken) && !canControl}
          onRequestControlForCompose={requestComposeControl}
        />
      ) : null}

      <BrowserPanelDialogs
        styles={styles}
        theme={theme}
        state={state}
        viewerToken={viewerToken}
        tabCloseConfirmation={tabCloseConfirmation}
        setTabCloseConfirmation={setTabCloseConfirmation}
        tabMutationPending={tabMutationPending}
        closeTabLabel={closeTabLabel}
        confirmCloseSelectedTab={confirmCloseSelectedTab}
        closeConfirmationOpen={closeConfirmationOpen}
        setCloseConfirmationOpen={setCloseConfirmationOpen}
        restartForGraphics={restartForGraphics}
        setRestartForGraphics={setRestartForGraphics}
        closePending={closePending}
        controlRequest={controlRequest}
        setControlRequest={setControlRequest}
        controlRequestPending={controlRequestPending}
        confirmControlRequest={confirmControlRequest}
        requestControlled={requestControlled}
        controlledActionsRef={controlledActionsRef}
      />
      {toolbarMenu === "display" ? (
        <BrowserPanelDisplayMenu
          styles={styles}
          theme={theme}
          layout={layout}
          touchFirstLayout={touchFirstLayout}
          menu={menu}
          panelScope={panelScope}
          scaleMode={scaleMode}
          setScaleMode={setScaleMode}
          state={state}
          preferences={preferences}
          media={media}
          selectedResolutionPresetId={selectedResolutionPresetId}
          pageActionUnavailable={pageActionUnavailable}
          anyMutationPending={anyMutationPending}
          fillViewportEnabled={fillViewportEnabled}
          fillViewportDetail={fillViewportDetail}
          fillViewportResolution={fillViewportResolution}
          videoStatus={videoStatus}
          transportLabel={transportLabel}
          notice={{
            visibleError,
            operationError,
            operationNoticeId: operationNotice.id,
            connectionError,
            dismissOperationError,
          }}
          viewportWidth={viewportWidth}
          setViewportWidth={setViewportWidth}
          viewportHeight={viewportHeight}
          setViewportHeight={setViewportHeight}
          viewportEditable={Boolean(viewerToken) && !resizeMutation.isPending}
          requestControlled={requestControlled}
          controlledActionsRef={controlledActionsRef}
        />
      ) : null}
      {toolbarMenu === "actions" ? (
        <BrowserPanelActionsMenu
          theme={theme}
          layout={layout}
          menu={menu}
          state={state}
          viewerToken={viewerToken}
          canControl={canControl}
          canSendInput={canSendInput}
          composeAvailable={composeAvailable}
          pageActionUnavailable={pageActionUnavailable}
          anyMutationPending={anyMutationPending}
          printPending={printMutation.isPending}
          reconnectDisabled={attachQuery.isFetching}
          reconnect={reconnect}
          resetNativeKeyboard={() => canvasInput.nativeKeyboard.reset()}
          requestControlled={requestControlled}
          controlledActionsRef={controlledActionsRef}
        />
      ) : null}
    </View>
  );
}
