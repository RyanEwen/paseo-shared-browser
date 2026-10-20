/**
 * Workspace browser panel orchestration: viewer/control ownership, current
 * decoded receipts, media handoff and menu actions. Native/DOM forwarding and
 * presentation models live in focused counterpart hooks; this module never
 * replays published mutations or substitutes visible pixels for input authority.
 */
import { type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserState,
  type BrowserTabCloseScope,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  createBrowserTabRpc,
  DEVICE_PRESETS,
  type DevicePresetId,
  detachBrowserRpc,
  didBrowserRuntimeRestart,
  endBrowserGestureRpc,
  isBrowserStateCurrent,
  listBrowserTabsRpc,
  MAX_BROWSER_TABS,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
  navigateBrowserRpc,
  printBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  updateBrowserGestureRpc,
} from "../shared/browser";
import { browserDisplayDemandRpc } from "../shared/browser-display-demand";
import { browserMediaCapabilitiesRpc } from "../shared/browser-media";
import { isPrintPreviewUrl } from "../shared/browser-page";
import type { BrowserFrameAuthority } from "../shared/browser-video";
import { BrowserActionsMenu } from "./browser-actions-menu";
import { BrowserAgentPointer } from "./browser-agent-pointer";
import { type BrowserCanvasDisplayMode, getBrowserCanvasLayout } from "./browser-canvas-layout";
import { BrowserCanvasViewport } from "./browser-canvas-viewport";
import {
  CanvasPlaceholder,
  ChromeIconButton,
  ControlButton,
  ErrorNotice,
  Field,
} from "./browser-chrome";
import { ComposeTextControls } from "./browser-compose-controls";
import { BrowserControlDialog } from "./browser-control-dialog";
import {
  type ControlRequest,
  type ControlRequestBasis,
  controlRequestBasis,
  isControlRequestCurrent,
} from "./browser-control-request";
import { BrowserDialogBody } from "./browser-dialog-body";
import { physicalBrowserDisplaySize } from "./browser-display-demand";
import { BrowserDisplayMenu } from "./browser-display-menu";
import { type EmulationSelection, matchingResolutionPresetId } from "./browser-emulation-mode";
import { getFillViewportResolution } from "./browser-fill-viewport";
import type { FrameCandidate } from "./browser-frame-buffer";
import { BrowserFrameImage } from "./browser-frame-image";
import { NativeKeyboardControls } from "./browser-native-keyboard-controls";
import { createStyles, DIMENSION, SPACE } from "./browser-panel-styles";
import { BrowserTabs } from "./browser-tabs";
import { BrowserMenuItem } from "./browser-toolbar-menu";
import { isFrameCurrent, isVideoSourceCurrent } from "./browser-video-currency";
import { browserVideoPlaybackStatus, describeBrowserVideoTransport } from "./browser-video-status";
import { BrowserVideoSurface, supportsBrowserMedia } from "./browser-video-surface";
import { isBrowserClosedError, isExpiredBrowserViewerError } from "./browser-viewer-recovery";
import { createFrameLifecycle } from "./frame-lifecycle";
import { useBrowserCanvasInput } from "./use-browser-canvas-input";
import { useBrowserDisplayDemand } from "./use-browser-display-demand";
import { useBrowserDisplayScale } from "./use-browser-display-scale";
import { useBrowserEmulationMode } from "./use-browser-emulation-mode";
import { useBrowserFillViewport } from "./use-browser-fill-viewport";
import { useBrowserFrameBuffer } from "./use-browser-frame-buffer";
import { useBrowserImageCapture } from "./use-browser-image-capture";
import { useBrowserScopedMutation } from "./use-browser-scoped-mutation";
import { useBrowserVideo } from "./use-browser-video";
import { useBrowserViewerRecovery } from "./use-browser-viewer-recovery";
import { useResolutionFavorites } from "./use-resolution-favorites";

// Preserve the existing contribution entry/test import while ownership lives in a focused module.
export { contributeSharedBrowserClient } from "./browser-client-presence";

const MAX_VIEWER_LABEL_LENGTH = 64;
const MAX_URL_LENGTH = 8_192;
const BYTES_PER_KIBIBYTE = 1_024;

type SpecialKey = Extract<BrowserInputEvent, { kind: "key" }>["key"];

interface Size {
  width: number;
  height: number;
}

interface ControlledActions {
  navigate(action: "back" | "forward" | "reload" | "goto", url?: string): void;
  print(): void;
  applyViewport(): void;
  fillViewport(): void;
  selectDevicePreset(id: DevicePresetId): void;
  toggleEmulation(): void;
  sendKey(key: SpecialKey): void;
  openCompose(kind: "compose" | "commit"): void;
  openNativeKeyboard(): void;
  closeTab(): void;
  closeBrowser(): void;
  applyGraphics(): void;
  confirmCloseTab(): void;
  confirmCloseBrowser(): void;
}

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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The shared browser request failed.";
}
function hasUnknownMutationOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code === "unknown_outcome") return true;
  if (
    code === "transport_closed_after_dispatch" ||
    code === "transport_lost_after_dispatch" ||
    code === "rpc_timeout" ||
    name === "RpcTimeoutError" ||
    name === "TransportLostAfterDispatchError"
  ) {
    return true;
  }
  const dispatched = record.dispatched === true || record.requestDispatched === true;
  return dispatched && /(transport|connection|timeout)/.test(code || name.toLowerCase());
}

/** A painted document may remain visible within the same source and geometry. */
function isFrameDisplayCurrent(frame: BrowserFrameAuthority, state: BrowserState): boolean {
  return Boolean(
    frame.runtimeId &&
      state.runtimeId &&
      frame.captureEpoch !== undefined &&
      state.bridgeEpoch !== undefined &&
      frame.sessionId === state.sessionId &&
      frame.runtimeId === state.runtimeId &&
      frame.captureEpoch === state.bridgeEpoch &&
      frame.viewportGeneration === state.viewportGeneration,
  );
}

export function SharedBrowserPanel({
  theme,
  host,
  layout,
  workspaceId,
  active = true,
}: PluginWorkspacePanelProps & { active?: boolean }) {
  const queryClient = useQueryClient();
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const screenPixelRatio = useBrowserDisplayScale();
  const viewerLabel = useState(() =>
    `Paseo ${layout.platform} · ${host.label} · ${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`.slice(0, MAX_VIEWER_LABEL_LENGTH),
  )[0];

  const attachBrowser = useRpc(attachBrowserRpc);
  const detachBrowser = useRpc(detachBrowserRpc);
  const captureBrowser = useRpc(captureBrowserRpc);
  const closeBrowser = useRpc(closeBrowserRpc);
  const closeTab = useRpc(closeBrowserTabRpc);
  const createTab = useRpc(createBrowserTabRpc);
  const listTabs = useRpc(listBrowserTabsRpc);
  const reopenBrowser = useRpc(reopenBrowserRpc);
  const acquireControl = useRpc(acquireControlRpc);
  const releaseControl = useRpc(releaseControlRpc);
  const navigateBrowser = useRpc(navigateBrowserRpc);
  const printBrowser = useRpc(printBrowserRpc);
  const resizeBrowser = useRpc(resizeBrowserRpc);
  const reportDisplayDemand = useRpc(browserDisplayDemandRpc);
  const applyDevicePreset = useRpc(applyDevicePresetRpc);
  const sendBrowserInput = useRpc(sendBrowserInputRpc);
  const beginBrowserGesture = useRpc(beginBrowserGestureRpc);
  const updateBrowserGesture = useRpc(updateBrowserGestureRpc);
  const endBrowserGesture = useRpc(endBrowserGestureRpc);

  const mountedRef = useRef(false);
  const activeViewerTokenRef = useRef<string | null>(null);
  const stateRef = useRef<BrowserState | null>(null);
  // Lease observations can change while acquisition awaits with no local token.
  // Count ownership transitions, not expiry renewals or ordinary media frames.
  const controllerObservationRevision = useRef(0);
  const frameRef = useRef<BrowserFrame | null>(null);
  const committedViewport = useRef<{ sessionId: string; generation: number } | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [inputLifecycle] = useState(createFrameLifecycle);
  const [legacyInputBusy, setLegacyInputBusy] = useState(false);
  // A visual-only old-read paint cannot wake strict initial-admission waiters.
  const [admittedPaint, setAdmittedPaint] = useState<{ frameId: string; epoch: number } | null>(
    null,
  );
  /** Notify initial-admission waiters only when the actual painted receipt gains input authority. */
  const publishAdmittedPaint = (frameId: string, epoch: number) => {
    setAdmittedPaint((previous) => {
      if (previous?.frameId === frameId && previous.epoch === epoch) return previous;
      return { frameId, epoch };
    });
  };

  const [state, setState] = useState<BrowserState | null>(null);
  const [controlToken, setControlToken] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [browserClosed, setBrowserClosed] = useState(false);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const selectedTabIdRef = useRef(selectedTabId);
  selectedTabIdRef.current = selectedTabId;
  const [tabMutationPending, setTabMutationPending] = useState(false);
  // A workspace switch retires this receipt. An old completion cannot clear
  // a newer workspace's pending operation, including a switch away and back.
  const tabMutationRequestRef = useRef<object | null>(null);
  const [tabCloseConfirmation, setTabCloseConfirmation] = useState<{
    basis: ControlRequestBasis;
    runtimeId: string;
    scope: BrowserTabCloseScope;
  } | null>(null);
  const [controlRequest, setControlRequest] = useState<ControlRequest | null>(null);
  const [pendingControlAction, setPendingControlAction] = useState<ControlRequest | null>(null);
  const [controlRequestPending, setControlRequestPending] = useState(false);
  const controlRequestPendingRef = useRef(false);
  const controlledActionsRef = useRef<ControlledActions | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [restartForGraphics, setRestartForGraphics] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [reopenPending, setReopenPending] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [viewportWidth, setViewportWidth] = useState("");
  const [viewportHeight, setViewportHeight] = useState("");
  const preferences = useResolutionFavorites(host.id);
  const [keysSubmenuOpen, setKeysSubmenuOpen] = useState(false);
  const keysAnchorRef = useRef<View | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<"display" | "actions" | null>(null);
  const [scaleMode, setScaleMode] = useState<BrowserCanvasDisplayMode>("fit");
  const paneRef = useRef<View | null>(null);
  const displayAnchorRef = useRef<View | null>(null);
  const actionsAnchorRef = useRef<View | null>(null);
  const [paneSize, setPaneSize] = useState<Size>({ width: 0, height: 0 });
  const panelScope = `${host.id}/${workspaceId}`;
  const [fillViewportScope, setFillViewportScope] = useState<string | null>(null);
  const fillViewportEnabled = fillViewportScope === panelScope;
  useEffect(() => {
    setFillViewportScope(null);
  }, [panelScope]);
  const panelScopeRef = useRef(panelScope);
  panelScopeRef.current = panelScope;
  const menuRestoreFocus = useRef(true);
  const closeToolbarMenu = useCallback((restoreFocus = true) => {
    menuRestoreFocus.current = restoreFocus;
    setKeysSubmenuOpen(false);
    setToolbarMenu(null);
  }, []);
  const toggleToolbarMenu = (menu: "display" | "actions") => {
    menuRestoreFocus.current = true;
    setKeysSubmenuOpen(false);
    setToolbarMenu((current) => (current === menu ? null : menu));
  };
  const [composeRequest, setComposeRequest] = useState<{
    id: number;
    kind: "keyboard" | "compose" | "commit";
    ownershipKey: string;
  } | null>(null);
  const nextComposeRequest = useRef(0);
  const [activeInput, setActiveInput] = useState(false);
  const activeInputRef = useRef(false);
  /** Fence automatic timers immediately, before React commits a new physical press. */
  const handleInputActivity = useCallback((active: boolean) => {
    activeInputRef.current = active;
    setActiveInput(active);
  }, []);
  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCandidateCurrent = useCallback((candidate: FrameCandidate) => {
    const current = stateRef.current;
    return (
      mountedRef.current &&
      candidate.viewerToken === activeViewerTokenRef.current &&
      candidate.mutationEpoch === inputLifecycle.epoch &&
      current !== null &&
      isFrameCurrent(candidate.frame, current)
    );
  }, []);
  const { buffer, frame, receive, settled, discardObsoletePending, reset } = useBrowserFrameBuffer(
    frameRef,
    isCandidateCurrent,
  );
  const imageError = buffer.imageError;

  const acceptState = useCallback(
    (next: BrowserState) => {
      const previous = stateRef.current;
      if (previous && !isBrowserStateCurrent(previous, next)) return false;
      // Server state projects "self" against this exact viewer token. Media can
      // observe our acquisition before its RPC returns the control token, so
      // that transition must not revoke its own still-pending settlement.
      // Competing ownership and subsequent release still advance the fence.
      const observesOwnAcquisition = previous?.controller !== "self" && next.controller === "self";
      if (
        previous &&
        !observesOwnAcquisition &&
        (previous.controller !== next.controller ||
          previous.controllerLabel !== next.controllerLabel)
      ) {
        controllerObservationRevision.current += 1;
      }
      const currentFrame = frameRef.current;
      if (previous && didBrowserRuntimeRestart(previous, next)) {
        setRuntimeNotice(
          "Browser restarted. The preserved viewer connection now targets the new runtime.",
        );
        setControlToken(null);
      }
      if (currentFrame && !isFrameCurrent(currentFrame, next)) {
        lastPointRef.current = null;
      }
      stateRef.current = next;
      // Repeated captures in the new generation must not cancel its slow decoder.
      discardObsoletePending();
      setState(next);
      return true;
    },
    [discardObsoletePending],
  );

  const attachQuery = useQuery({
    queryKey: ["shared-browser", "attach", host.id, workspaceId, viewerLabel, selectedTabId],
    queryFn: async () => {
      const result = await attachBrowser({
        workspaceId,
        viewerLabel,
        ...(selectedTabId ? { tabId: selectedTabId } : {}),
      });
      if (!mountedRef.current) {
        await detachBrowser({ viewerToken: result.viewerToken }).catch(() => undefined);
        throw new Error("The browser panel closed before attachment completed.");
      }
      return result;
    },
    retry: false,
    enabled: !browserClosed,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const closedView = browserClosed || isBrowserClosedError(attachQuery.error);
  const closedViewRef = useRef(closedView);
  closedViewRef.current = closedView;
  const attachedTabMatches = !selectedTabId || attachQuery.data?.state.tabId === selectedTabId;
  const viewerToken =
    reconnecting || closedView || !attachedTabMatches
      ? null
      : (attachQuery.data?.viewerToken ?? null);
  const tabsQueryKey = ["shared-browser", "tabs", host.id, workspaceId];
  const tabsQuery = useQuery({
    queryKey: tabsQueryKey,
    queryFn: () => listTabs({ viewerToken: viewerToken! }),
    enabled: Boolean(viewerToken) && active,
    refetchInterval: 2_000,
  });

  useEffect(() => {
    const tabs = tabsQuery.data?.tabs;
    const selected = selectedTabId ?? stateRef.current?.tabId;
    if (!tabs || !selected || tabs.some((tab) => tab.id === selected)) return;
    setSelectedTabId(tabs[0]?.id ?? null);
  }, [selectedTabId, tabsQuery.data]);

  useEffect(() => {
    if (isBrowserClosedError(attachQuery.error)) setBrowserClosed(true);
  }, [attachQuery.error]);

  useEffect(() => {
    if (!closedView) return;
    setControlRequest(null);
    setPendingControlAction(null);
  }, [closedView]);

  useEffect(() => {
    if (!viewerToken) return;
    activeViewerTokenRef.current = viewerToken;
    return () => {
      if (activeViewerTokenRef.current === viewerToken) activeViewerTokenRef.current = null;
      void detachBrowser({ viewerToken }).catch(() => undefined);
    };
  }, [detachBrowser, viewerToken]);

  useEffect(() => {
    if (!reconnecting && attachQuery.data) acceptState(attachQuery.data.state);
  }, [acceptState, attachQuery.data, reconnecting]);

  useEffect(() => {
    stateRef.current = null;
    frameRef.current = null;
    setState(null);
    reset();
    inputLifecycle.bump();
    inputLifecycle.reset();
    setLegacyInputBusy(false);
    setControlToken(null);
    setOperationError(null);
    setRuntimeNotice(null);
    setBrowserClosed(false);
    setSelectedTabId(null);
    tabMutationRequestRef.current = null;
    setTabMutationPending(false);
    setTabCloseConfirmation(null);
    setControlRequest(null);
    setPendingControlAction(null);
    setCloseConfirmationOpen(false);
    setRestartForGraphics(false);
  }, [reset, workspaceId, host.id, inputLifecycle]);

  useEffect(() => {
    // A tab selection changes the viewer's page and frame authority, even
    // though the underlying Chromium process and saved profile stay shared.
    inputLifecycle.bump();
    activeViewerTokenRef.current = null;
    stateRef.current = null;
    frameRef.current = null;
    reset();
    setState(null);
    setControlToken(null);
    setControlRequest(null);
    setPendingControlAction(null);
    setOperationError(null);
    setReconnecting(false);
  }, [selectedTabId, inputLifecycle, reset]);

  useLayoutEffect(() => {
    committedViewport.current = state
      ? { sessionId: state.sessionId, generation: state.viewportGeneration }
      : null;
  }, [state?.sessionId, state?.viewportGeneration]);

  const useLiveVideo = preferences.liveVideoEnabled;
  const readMediaCapabilities = useRpc(browserMediaCapabilitiesRpc);
  const mediaCapabilities = useQuery({
    queryKey: ["shared-browser-media-capabilities-v1", host.id],
    queryFn: () => readMediaCapabilities({}),
    enabled: active && (toolbarMenu === "display" || preferences.videoCodec === "pyrowave"),
    retry: false,
  });
  const clientMediaAvailable = supportsBrowserMedia();
  const canTryPyrowave = clientMediaAvailable && mediaCapabilities.data?.pyrowave === true;
  let mediaUnavailableReason: string | null = null;
  if (!clientMediaAvailable)
    mediaUnavailableReason = "PyroWave needs a web or desktop client with WebGPU.";
  else if (mediaCapabilities.isFetching && !mediaCapabilities.data)
    mediaUnavailableReason = "Checking PyroWave availability…";
  else if (!mediaCapabilities.data?.pyrowave)
    mediaUnavailableReason =
      mediaCapabilities.data?.reason ?? "PyroWave availability could not be checked.";
  const video = useBrowserVideo({
    videoCodec: preferences.videoCodec,
    pyrowaveBitrate: preferences.pyrowaveBitrate,
    state: () => stateRef.current,
    active: active && useLiveVideo,
    viewerToken,
    quality: "high",
    bitrate: preferences.videoBitrate,
    fps: preferences.videoFps,
    epoch: () => inputLifecycle.epoch,
    viewport: () => stateRef.current?.viewport ?? null,
    isCurrent: (packet, epoch) =>
      isVideoSourceCurrent(
        {
          mounted: mountedRef.current,
          viewerActive: activeViewerTokenRef.current === viewerToken,
          epoch: inputLifecycle.epoch,
          committedViewport: committedViewport.current,
          state: stateRef.current,
        },
        packet,
        epoch,
      ),
    isDisplayCurrent: (packet) => {
      const current = stateRef.current;
      return (
        mountedRef.current &&
        activeViewerTokenRef.current === viewerToken &&
        current !== null &&
        isFrameDisplayCurrent(packet.frame, current)
      );
    },
    acceptState,
    onPresented: (packet, epoch) => {
      inputLifecycle.accept(epoch, packet.frame);
      publishAdmittedPaint(packet.frame.frameId, epoch);
      setLegacyInputBusy(inputLifecycle.busy);
    },
  });

  const {
    query: captureQuery,
    refreshCapture,
    retryFrameCapture,
  } = useBrowserImageCapture({
    active: active && (!useLiveVideo || !video.supported || video.active),
    viewerToken,
    quality: preferences.captureQuality,
    activeInput,
    fallbackRevision: video.fallbackRevision,
    videoOwnsPresentation: Boolean(
      video.front &&
        !video.fallbackRevision &&
        state &&
        isFrameDisplayCurrent(video.front.frame, state),
    ),
    hasVideoPresentation: () =>
      Boolean(
        video.front &&
          !video.fallbackRevision &&
          activeViewerTokenRef.current === viewerToken &&
          stateRef.current &&
          isFrameDisplayCurrent(video.front.frame, stateRef.current),
      ),
    refreshVideo: video.refresh,
    mutationEpoch: () => inputLifecycle.epoch,
    knownFrame: () => frameRef.current,
    capture: captureBrowser,
  });

  useEffect(() => {
    const result = captureQuery.data;
    if (
      !result ||
      result.viewerToken !== activeViewerTokenRef.current ||
      result.captureQuality !== preferences.captureQuality ||
      result.mutationEpoch !== inputLifecycle.epoch ||
      !acceptState(result.state)
    ) {
      return;
    }
    if (result.frame && isFrameCurrent(result.frame, result.state)) {
      receive({
        frame: result.frame,
        viewport: result.state.viewport,
        viewerToken: result.viewerToken,
        mutationEpoch: result.mutationEpoch,
        fallbackRevision: result.fallbackRevision,
      });
    }
  }, [acceptState, captureQuery.data, preferences.captureQuality, receive]);

  useEffect(() => {
    if (state?.controller !== "self" && controlToken) setControlToken(null);
  }, [controlToken, state?.controller, state?.sessionId]);

  useEffect(() => {
    if (!state || addressFocused) return;
    setAddressDraft(state.url);
  }, [addressFocused, state?.sessionId, state?.url]);

  useEffect(() => {
    if (!state) return;
    setViewportWidth(String(state.viewport.width));
    setViewportHeight(String(state.viewport.height));
  }, [state?.sessionId, state?.viewport.height, state?.viewport.width]);

  const mutationFailed = useCallback(
    (error: unknown) => {
      const message = errorMessage(error);
      setOperationError(
        hasUnknownMutationOutcome(error)
          ? `${message} Mutation outcome is unknown; state refreshed and the action was not replayed.`
          : message,
      );
      refreshCapture();
    },
    [refreshCapture],
  );

  const mutationSucceeded = useCallback(
    (next: BrowserState) => {
      setOperationError(null);
      acceptState(next);
      refreshCapture();
    },
    [acceptState, refreshCapture],
  );

  const mutationIdentity = JSON.stringify([
    host.id,
    workspaceId,
    viewerToken,
    controlToken,
    controllerObservationRevision.current,
  ]);
  // Ref observations revoke settlement immediately, before the state commit.
  const currentMutationIdentity = () =>
    JSON.stringify([
      host.id,
      workspaceId,
      activeViewerTokenRef.current,
      controlToken,
      controllerObservationRevision.current,
    ]);
  const acquireMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: acquireControl,
    onSuccess: (result) => {
      setControlToken(result.controlToken);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const releaseMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: releaseControl,
    onSuccess: (result) => {
      setControlToken(null);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const printMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: printBrowser,
    onSuccess: (result) => {
      mutationSucceeded(result.state);
      setRuntimeNotice(
        "Inspect the tab list and select Print preview. Do not repeat Print while a preview is open.",
      );
      void tabsQuery.refetch();
    },
    onError: (error) => {
      mutationFailed(error);
      void tabsQuery.refetch();
    },
  });
  const navigateMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: navigateBrowser,
    onSuccess: (result) => {
      mutationSucceeded(result.state);
      // Only acknowledged navigation grants explicit viewing recovery. Ordinary
      // gesture/image refresh does not rearm an exhausted video reader.
      video.retry();
    },
    onError: mutationFailed,
  });
  const resizeMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: resizeBrowser,
    onSuccess: (result) => {
      mutationSucceeded(result.state);
    },
    onError: (error) => {
      setFillViewportScope(null);
      mutationFailed(error);
    },
  });
  const deviceMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: applyDevicePreset,
    onSuccess: (result) => mutationSucceeded(result.state),
    onError: mutationFailed,
  });
  // Upstream's settlement gate protects discrete key controls and native text fallback.
  // Continuous gestures retain their own ordered channel without waiting per event.
  const settleLegacyInput = () => {
    inputLifecycle.settle();
    setLegacyInputBusy(true);
  };
  const inputMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: sendBrowserInput,
    onSuccess: (result) => {
      settleLegacyInput();
      mutationSucceeded(result.state);
    },
    onError: (error) => {
      settleLegacyInput();
      mutationFailed(error);
    },
  });

  const anyMutationPending =
    acquireMutation.isPending ||
    releaseMutation.isPending ||
    navigateMutation.isPending ||
    printMutation.isPending ||
    resizeMutation.isPending ||
    deviceMutation.isPending ||
    inputMutation.isPending ||
    controlRequestPending ||
    tabMutationPending ||
    closePending;
  const videoViewerExpired =
    video.errorViewerToken === viewerToken && isExpiredBrowserViewerError(video.error);
  const viewingExpired = videoViewerExpired || isExpiredBrowserViewerError(captureQuery.error);
  useEffect(() => {
    if (isBrowserClosedError(captureQuery.error) || isBrowserClosedError(video.error))
      setBrowserClosed(true);
  }, [captureQuery.error, video.error]);
  const canControl = Boolean(
    viewerToken &&
      controlToken &&
      state?.controller === "self" &&
      (!selectedTabId || state.tabId === selectedTabId) &&
      !viewingExpired,
  );
  const frontLayer = buffer.front === null ? null : buffer.layers[buffer.front];
  useLayoutEffect(() => {
    const candidate = frontLayer?.candidate;
    if (
      candidate &&
      candidate.fallbackRevision === video.fallbackRevision &&
      candidate.mutationEpoch === inputLifecycle.epoch &&
      candidate.viewerToken === viewerToken &&
      state &&
      isFrameCurrent(candidate.frame, state)
    )
      video.completeFallback(candidate.fallbackRevision ?? 0);
  }, [frontLayer, video.fallbackRevision, state, viewerToken, inputLifecycle]);
  const videoFrame =
    video.front && state && isFrameCurrent(video.front.frame, state) ? video.front.frame : null;
  const currentFrame =
    videoFrame ??
    (frame &&
    state &&
    frontLayer?.candidate.viewerToken === viewerToken &&
    isFrameCurrent(frame, state)
      ? frame
      : null);
  useEffect(() => {
    const candidate = frontLayer?.candidate;
    if (videoFrame || !frame || !candidate || candidate.mutationEpoch !== inputLifecycle.epoch)
      return;
    inputLifecycle.accept(candidate.mutationEpoch, frame);
    publishAdmittedPaint(frame.frameId, candidate.mutationEpoch);
    setLegacyInputBusy(inputLifecycle.busy);
  }, [frame, frontLayer, inputLifecycle, videoFrame]);
  const canSendInput =
    canControl && Boolean(currentFrame) && !inputMutation.isPending && !legacyInputBusy;

  // Layout belongs to the decoded front frame. A denser capture adds detail,
  // not a larger 100% layout; scale never writes to the shared browser state.
  const visualFrame = video.front?.frame ?? frame;
  const canvasLayout = useMemo(
    () =>
      visualFrame
        ? getBrowserCanvasLayout(
            containerSize,
            visualFrame,
            video.front
              ? (video.frontViewport ?? visualFrame)
              : (frontLayer?.candidate.viewport ?? state?.viewport ?? visualFrame),
            scaleMode,
          )
        : null,
    [
      containerSize,
      visualFrame,
      frontLayer,
      state?.viewport,
      scaleMode,
      video.front,
      video.frontViewport,
    ],
  );
  const displayRect = canvasLayout?.frameRect ?? null;
  useBrowserDisplayDemand({
    identity: JSON.stringify([host.id, workspaceId, viewerToken]),
    viewerToken,
    expected:
      state?.runtimeId && state.bridgeEpoch !== undefined
        ? {
            sessionId: state.sessionId,
            runtimeId: state.runtimeId,
            bridgeEpoch: state.bridgeEpoch,
            navigationGeneration: state.navigationGeneration,
            viewportGeneration: state.viewportGeneration,
          }
        : null,
    display: physicalBrowserDisplaySize(displayRect, screenPixelRatio),
    active: active && !closedView && !viewingExpired && state?.status === "ready",
    report: reportDisplayDemand,
    onState: acceptState,
  });

  const controlContext = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    const current = stateRef.current;
    if (
      viewingExpired ||
      !viewer ||
      !controlToken ||
      !current ||
      current.controller !== "self" ||
      (selectedTabId && current.tabId !== selectedTabId)
    )
      return null;
    return {
      viewerToken: viewer,
      controlToken,
      expected: {
        sessionId: current.sessionId,
        navigationGeneration: current.navigationGeneration,
        viewportGeneration: current.viewportGeneration,
      },
    };
  }, [controlToken, viewingExpired, selectedTabId]);

  const inputContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    const targetVideo = video.frontRef.current;
    // A revoked video remains painted until React commits the fallback. Never
    // borrow the JPEG token while those older video pixels still cover it.
    if (video.front && !targetVideo) return null;
    const targetFrame = targetVideo?.frame ?? frameRef.current;
    if (
      !context ||
      !current ||
      !targetFrame ||
      !isFrameCurrent(targetFrame, current) ||
      (!targetVideo && frontLayer?.candidate.viewerToken !== context.viewerToken)
    ) {
      return null;
    }
    return {
      ...context,
      target: {
        frameId: targetFrame.frameId,
        navigationGeneration: targetFrame.navigationGeneration,
        viewportGeneration: targetFrame.viewportGeneration,
      },
    };
  }, [controlContext, frontLayer, video.frontRef, video.front]);

  const requireControlContext = useCallback(() => {
    const context = controlContext();
    if (!context) {
      setOperationError("Take control before changing the browser.");
      return null;
    }
    return context;
  }, [controlContext]);

  /** Publish once with the current controlled source; tab discovery remains explicit. */
  const print = () => {
    const context = requireControlContext();
    if (context) printMutation.mutate(context);
  };

  const requireInputContext = useCallback(() => {
    const context = inputContext();
    if (!context) {
      setOperationError("A current frame and active control lease are required for browser input.");
      refreshCapture();
      return null;
    }
    return context;
  }, [inputContext, refreshCapture]);

  const sendEvent = useCallback(
    (event: BrowserInputEvent) => {
      const context = requireInputContext();
      if (!context || inputMutation.isPending || !inputLifecycle.begin()) return;
      setLegacyInputBusy(true);
      inputMutation.mutate({ ...context, event });
    },
    [inputMutation, requireInputContext],
  );

  const liveInputEnabled =
    canSendInput &&
    !navigateMutation.isPending &&
    !resizeMutation.isPending &&
    !deviceMutation.isPending &&
    !releaseMutation.isPending &&
    !acquireMutation.isPending &&
    toolbarMenu === null;
  /** Existing channels retain control incarnation while their next frame decodes. */
  const gestureControlContext = useCallback(() => {
    const context = controlContext();
    const current = stateRef.current;
    if (!mountedRef.current || !context || !current?.runtimeId || current.bridgeEpoch === undefined)
      return null;
    return {
      ...context,
      expected: {
        ...context.expected,
        runtimeId: current.runtimeId,
        bridgeEpoch: current.bridgeEpoch,
      },
    };
  }, [controlContext]);

  // Forward physical mouse events and genuine touch on every remote preset.
  const canvasInput = useBrowserCanvasInput({
    authority: () => {
      const input = inputContext();
      const context = gestureControlContext();
      return input && context ? { ...context, target: input.target } : null;
    },
    controlAuthority: gestureControlContext,
    transport: { begin: beginBrowserGesture, update: updateBrowserGesture, end: endBrowserGesture },
    ownershipKey: JSON.stringify([
      viewerToken,
      controlToken,
      state?.sessionId,
      state?.runtimeId,
      state?.bridgeEpoch,
      state?.navigationGeneration,
      state?.viewportGeneration,
      displayRect?.width,
      displayRect?.height,
      containerSize.width,
      containerSize.height,
      scaleMode,
      liveInputEnabled,
    ]),
    decodedFrameId: admittedPaint?.epoch === inputLifecycle.epoch ? admittedPaint.frameId : null,
    enabled: liveInputEnabled,
    displaySize: displayRect,
    viewport: state?.viewport ?? null,
    onState: acceptState,
    onError: mutationFailed,
    onFinish: refreshCapture,
    onPoint: (point) => {
      lastPointRef.current = { x: point.x, y: point.y };
    },
    onActivity: handleInputActivity,
    onInputAcknowledged: () => {
      // Pixels requested before the host acknowledged this input cannot authorize
      // the next press, even when their request began after the local press.
      inputLifecycle.bump();
    },
    onInputBoundary: () => {
      inputLifecycle.bump();
    },
  });

  const composeOwnershipKey = JSON.stringify([
    viewerToken,
    controlToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  const composeDocumentKey = JSON.stringify([
    viewerToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  // Touch-first surfaces (native and compact web) get the explicit draft; desktop web types on the canvas.
  const composeAvailable = layout.platform !== "web" || layout.compact;
  const requestCompose = (kind: "keyboard" | "compose" | "commit") => {
    if (!canSendInput) return;
    nextComposeRequest.current += 1;
    closeToolbarMenu(false);
    setComposeRequest({ id: nextComposeRequest.current, kind, ownershipKey: composeOwnershipKey });
  };
  const composeRequestHandled = useCallback((id: number) => {
    setComposeRequest((current) => (current?.id === id ? null : current));
  }, []);

  const handleCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);

  const takeControl = useCallback(
    (takeover: boolean) => {
      if (!viewerToken || acquireMutation.isPending) return;
      inputLifecycle.bump();
      acquireMutation.mutate({ viewerToken, takeover });
    },
    [acquireMutation, viewerToken],
  );

  /** Ask for authority before running an action, preserving its exact tab and page basis. */
  const requestControlled = (label: string, run: () => void, needsFrame = false) => {
    if (anyMutationPending || controlRequestPendingRef.current) return;
    if (controlContext()) {
      run();
      return;
    }
    const current = stateRef.current;
    const viewer = activeViewerTokenRef.current;
    if (!current || !viewer || (selectedTabId && current.tabId !== selectedTabId) || viewingExpired)
      return;
    closeToolbarMenu(false);
    setControlRequest({
      label,
      basis: controlRequestBasis(
        panelScope,
        viewer,
        current,
        controllerObservationRevision.current,
      ),
      needsFrame,
      run,
    });
  };

  const requestIsCurrent = useCallback(
    (basis: ControlRequestBasis) =>
      !closedViewRef.current &&
      (!selectedTabIdRef.current || selectedTabIdRef.current === basis.tabId) &&
      isControlRequestCurrent(
        basis,
        panelScopeRef.current,
        activeViewerTokenRef.current,
        stateRef.current,
        controllerObservationRevision.current,
      ),
    [],
  );

  /** Acquire once, then let the committed controlled render run the queued action once. */
  const confirmControlRequest = async () => {
    const request = controlRequest;
    if (!request || controlRequestPendingRef.current) return;
    const current = stateRef.current;
    if (!requestIsCurrent(request.basis)) {
      setControlRequest(null);
      setOperationError("The browser changed. Select the action again.");
      return;
    }

    controlRequestPendingRef.current = true;
    setControlRequestPending(true);
    setOperationError(null);
    try {
      inputLifecycle.bump();
      const result = await acquireControl({
        viewerToken: request.basis.viewerToken,
        takeover: current?.controller === "other",
      });
      if (!mountedRef.current || !requestIsCurrent(request.basis)) {
        await releaseControl({
          viewerToken: request.basis.viewerToken,
          controlToken: result.controlToken,
        }).catch(() => undefined);
        return;
      }
      setControlRequest(null);
      if (!acceptState(result.state)) {
        await releaseControl({
          viewerToken: request.basis.viewerToken,
          controlToken: result.controlToken,
        }).catch(() => undefined);
        setOperationError("The browser changed. Select the action again.");
        return;
      }
      setControlToken(result.controlToken);
      refreshCapture();
      if (
        requestIsCurrent(request.basis) &&
        isControlRequestCurrent(
          request.basis,
          panelScopeRef.current,
          activeViewerTokenRef.current,
          result.state,
          controllerObservationRevision.current,
        )
      ) {
        setPendingControlAction(request);
      } else {
        setOperationError("The browser changed. Select the action again.");
      }
    } catch (error) {
      setControlRequest(null);
      mutationFailed(error);
    } finally {
      controlRequestPendingRef.current = false;
      if (mountedRef.current) setControlRequestPending(false);
    }
  };

  useEffect(() => {
    if (!pendingControlAction || controlRequestPending) return;
    if (!requestIsCurrent(pendingControlAction.basis)) {
      setPendingControlAction(null);
      setOperationError("The browser changed. Select the action again.");
      return;
    }
    if (
      !canControl ||
      (pendingControlAction.needsFrame &&
        (!canSendInput || admittedPaint?.epoch !== inputLifecycle.epoch))
    )
      return;
    setPendingControlAction(null);
    pendingControlAction.run();
  }, [
    pendingControlAction,
    controlRequestPending,
    canControl,
    canSendInput,
    admittedPaint,
    state,
    requestIsCurrent,
  ]);

  const release = useCallback(() => {
    const viewer = activeViewerTokenRef.current;
    if (
      !viewer ||
      !controlToken ||
      stateRef.current?.controller !== "self" ||
      releaseMutation.isPending
    ) {
      return;
    }
    inputLifecycle.bump();
    releaseMutation.mutate({ viewerToken: viewer, controlToken });
  }, [controlToken, releaseMutation]);

  const navigate = useCallback(
    (action: "back" | "forward" | "reload" | "goto", url?: string) => {
      const context = requireControlContext();
      if (!context || navigateMutation.isPending) return;
      if (action === "goto") {
        const nextUrl = url?.trim();
        if (!nextUrl) {
          setOperationError("Enter an address to navigate.");
          return;
        }
        inputLifecycle.bump();
        navigateMutation.mutate({ ...context, action: { kind: "goto", url: nextUrl } });
        return;
      }
      inputLifecycle.bump();
      navigateMutation.mutate({ ...context, action: { kind: action } });
    },
    [navigateMutation, requireControlContext],
  );

  const applyViewport = useCallback(() => {
    const context = requireControlContext();
    if (!context || resizeMutation.isPending) return;
    const width = Number(viewportWidth);
    const height = Number(viewportHeight);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < MIN_VIEWPORT.width ||
      width > MAX_VIEWPORT.width ||
      height < MIN_VIEWPORT.height ||
      height > MAX_VIEWPORT.height
    ) {
      setOperationError(
        `Viewport must be ${MIN_VIEWPORT.width}–${MAX_VIEWPORT.width} × ${MIN_VIEWPORT.height}–${MAX_VIEWPORT.height}.`,
      );
      return;
    }
    inputLifecycle.bump();
    setFillViewportScope(null);
    resizeMutation.mutate({ ...context, viewport: { width, height } });
  }, [requireControlContext, resizeMutation, viewportHeight, viewportWidth]);

  const fillTarget = getFillViewportResolution(containerSize);

  /** Enable following and resize using current geometry after control acquisition. */
  const fillViewport = useCallback(() => {
    const context = requireControlContext();
    if (!context || resizeMutation.isPending) return;
    const viewport = fillTarget;
    if (!viewport) {
      setOperationError("The visible browser area is outside the supported display size range.");
      return;
    }
    inputLifecycle.bump();
    setFillViewportScope(panelScope);
    setScaleMode("fit");
    resizeMutation.mutate({
      ...context,
      viewport,
      preserveEmulation: true,
    });
  }, [
    requireControlContext,
    resizeMutation,
    containerSize,
    inputLifecycle,
    panelScope,
    fillTarget,
  ]);

  useBrowserFillViewport({
    identity: mutationIdentity,
    enabled: fillViewportEnabled,
    canResize:
      active && canControl && !activeInput && !anyMutationPending && state?.status === "ready",
    target: fillTarget,
    viewport: state?.viewport ?? null,
    apply: () => {
      if (!activeInputRef.current) fillViewport();
    },
  });

  const selectDevicePreset = useCallback(
    (presetId: DevicePresetId) => {
      const context = requireControlContext();
      if (!context || deviceMutation.isPending) return;
      inputLifecycle.bump();
      setFillViewportScope(null);
      closeToolbarMenu();
      deviceMutation.mutate({ ...context, presetId });
    },
    [closeToolbarMenu, deviceMutation, requireControlContext],
  );

  const applyEmulationSelection = useCallback(
    (selection: EmulationSelection) => {
      const context = requireControlContext();
      if (!context || anyMutationPending) return;
      inputLifecycle.bump();
      deviceMutation.mutate({ ...context, ...selection });
    },
    [requireControlContext, anyMutationPending, inputLifecycle, deviceMutation],
  );
  const emulation = useBrowserEmulationMode({
    identity: JSON.stringify([host.id, workspaceId]),
    platform: layout.platform,
    state,
    canControl,
    pending: anyMutationPending || Boolean(pendingControlAction),
    apply: applyEmulationSelection,
  });

  const reconnect = useCallback(() => {
    if (attachQuery.isFetching) return;
    inputLifecycle.bump();
    // Immediately revoke local input while the viewing-only reattachment awaits.
    activeViewerTokenRef.current = null;
    setReconnecting(true);
    setControlToken(null);
    setOperationError(null);
    void attachQuery.refetch({ cancelRefetch: false }).then((result) => {
      if (!result.error) setReconnecting(false);
    });
  }, [attachQuery.isFetching, attachQuery.refetch]);

  /** Add a page to the shared profile and select it only for this panel. */
  const createBrowserTab = async () => {
    const viewerToken = activeViewerTokenRef.current;
    if (!viewerToken || tabMutationPending || tabMutationRequestRef.current) return;
    const request = {};
    tabMutationRequestRef.current = request;
    setTabMutationPending(true);
    setOperationError(null);
    try {
      const created = await createTab({ viewerToken });
      // A pre-creation list can otherwise undo selection through the missing-tab
      // fallback. Cancel its receipt and include the confirmed blank page first.
      await queryClient.cancelQueries({ queryKey: tabsQueryKey, exact: true });
      if (
        !mountedRef.current ||
        tabMutationRequestRef.current !== request ||
        panelScopeRef.current !== panelScope ||
        activeViewerTokenRef.current !== viewerToken
      ) {
        return;
      }
      queryClient.setQueryData<Awaited<ReturnType<typeof listTabs>>>(tabsQueryKey, (previous) => {
        if (previous?.tabs.some((tab) => tab.id === created.tabId)) return previous;
        return {
          tabs: [
            ...(previous?.tabs ?? []),
            {
              id: created.tabId,
              title: "",
              url: "about:blank",
              viewerCount: 0,
              controllerLabel: null,
            },
          ],
        };
      });
      setSelectedTabId(created.tabId);
      void tabsQuery.refetch();
    } catch (error) {
      if (tabMutationRequestRef.current === request) setOperationError(errorMessage(error));
    } finally {
      if (tabMutationRequestRef.current === request) {
        tabMutationRequestRef.current = null;
        setTabMutationPending(false);
      }
    }
  };

  /** Drop this panel's media after either confirmed path stops its workspace browser. */
  const acceptBrowserClosed = () => {
    inputLifecycle.bump();
    activeViewerTokenRef.current = null;
    stateRef.current = null;
    frameRef.current = null;
    reset();
    setState(null);
    setSelectedTabId(null);
    setControlToken(null);
    setBrowserClosed(true);
    setTabCloseConfirmation(null);
    setCloseConfirmationOpen(false);
    setRestartForGraphics(false);
  };

  /** Bind the confirmation to the observed page and to its tab-only or final-tab effect. */
  const requestCloseSelectedTab = () => {
    const current = stateRef.current;
    const viewer = activeViewerTokenRef.current;
    const tabs = tabsQuery.data?.tabs;
    if (!current?.runtimeId || !viewer || !current.tabId || !tabs) return;
    if (!tabs.some((tab) => tab.id === current.tabId)) return;
    setTabCloseConfirmation({
      basis: controlRequestBasis(
        panelScope,
        viewer,
        current,
        controllerObservationRevision.current,
      ),
      runtimeId: current.runtimeId,
      scope: tabs.length === 1 ? "last-tab" : "tab",
    });
  };

  /** Never upgrade a tab-only confirmation if it becomes the final page while the dialog is open. */
  const confirmCloseSelectedTab = async () => {
    const confirmation = tabCloseConfirmation;
    if (!confirmation || !controlToken || tabMutationPending || tabMutationRequestRef.current)
      return;
    if (!requestIsCurrent(confirmation.basis)) {
      setTabCloseConfirmation(null);
      setOperationError("The browser changed. Select Close tab again.");
      return;
    }
    const { basis, runtimeId, scope } = confirmation;
    const tabId = basis.tabId!;
    const request = {};
    tabMutationRequestRef.current = request;
    setTabMutationPending(true);
    setOperationError(null);
    try {
      const result = await closeTab({
        viewerToken: basis.viewerToken,
        controlToken,
        tabId,
        sessionId: basis.sessionId,
        runtimeId,
        scope,
      });
      if (
        tabMutationRequestRef.current !== request ||
        panelScopeRef.current !== basis.panelScope ||
        selectedTabIdRef.current !== selectedTabId ||
        activeViewerTokenRef.current !== basis.viewerToken ||
        stateRef.current?.runtimeId !== runtimeId
      )
        return;
      setTabCloseConfirmation(null);
      if (result.browserClosed) {
        acceptBrowserClosed();
        return;
      }
      const fallback = tabsQuery.data?.tabs.find((tab) => tab.id !== tabId);
      setSelectedTabId(fallback?.id ?? null);
      void tabsQuery.refetch();
    } catch (error) {
      if (tabMutationRequestRef.current === request) {
        setTabCloseConfirmation(null);
        setOperationError(errorMessage(error));
        void tabsQuery.refetch();
      }
    } finally {
      if (tabMutationRequestRef.current === request) {
        tabMutationRequestRef.current = null;
        setTabMutationPending(false);
      }
    }
  };

  /** Confirmed close ends every viewer's runtime and immediately drops this panel's media. */
  const confirmCloseBrowser = async () => {
    const current = stateRef.current;
    const viewerToken = activeViewerTokenRef.current;
    if (!current?.runtimeId || !viewerToken || !controlToken || closePending) return;
    const shouldReopen = restartForGraphics;
    setClosePending(true);
    setOperationError(null);
    try {
      await closeBrowser({
        viewerToken,
        controlToken,
        sessionId: current.sessionId,
        runtimeId: current.runtimeId,
      });
      if (panelScopeRef.current !== panelScope) return;
      acceptBrowserClosed();
      if (shouldReopen) {
        await reopenBrowser({ workspaceId });
        if (panelScopeRef.current !== panelScope) return;
        setBrowserClosed(false);
        reconnect();
      }
    } catch (error) {
      if (panelScopeRef.current === panelScope) setOperationError(errorMessage(error));
    } finally {
      if (panelScopeRef.current === panelScope) setClosePending(false);
    }
  };

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

  /** Explicit user action is the only way to clear the server's closed fence. */
  const reopenClosedBrowser = async () => {
    if (reopenPending) return;
    setReopenPending(true);
    setOperationError(null);
    try {
      await reopenBrowser({ workspaceId });
      if (panelScopeRef.current !== panelScope) return;
      setBrowserClosed(false);
      reconnect();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setReopenPending(false);
    }
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
  const statusColor =
    state?.status === "ready"
      ? theme.colors.statusSuccess
      : state?.status === "error"
        ? theme.colors.statusDanger
        : theme.colors.statusWarning;
  let closeTabLabel = "Close tab";
  if (tabCloseConfirmation?.scope === "last-tab") closeTabLabel = "Close browser";
  if (tabMutationPending) closeTabLabel = "Closing…";

  const statusLabel =
    state?.status === "ready" ? "Ready" : state?.status === "error" ? "Error" : "Starting";
  const activeDevicePreset = state?.devicePresetId
    ? DEVICE_PRESETS.find(({ id }) => id === state.devicePresetId)
    : null;
  const selectedResolutionPresetId = fillViewportEnabled ? null : matchingResolutionPresetId(state);
  const fillViewportResolution = fillTarget;
  const fillViewportDetail = fillViewportResolution
    ? `${fillViewportResolution.width} × ${fillViewportResolution.height}`
    : `Requires ${MIN_VIEWPORT.width}–${MAX_VIEWPORT.width} × ${MIN_VIEWPORT.height}–${MAX_VIEWPORT.height}`;
  let deviceLabel = `${emulation.mode === "mobile" ? "Mobile" : "Desktop"} · custom display`;
  if (fillViewportEnabled) {
    deviceLabel = "Fill viewport";
  } else if (selectedResolutionPresetId) {
    deviceLabel = activeDevicePreset?.label ?? "Custom display";
  }
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
  const summaryFrame = video.front?.frame ?? currentFrame;
  let presentedBytes = frame?.byteLength ?? 0;
  if (video.front) {
    presentedBytes =
      "data" in video.front ? video.front.data.byteLength : (video.front.dataBase64.length * 3) / 4;
  }
  const frameSummary = summaryFrame
    ? layout.compact
      ? `${summaryFrame.width}×${summaryFrame.height} · ${transportLabel}`
      : `${summaryFrame.width} × ${summaryFrame.height} · ${Math.ceil(presentedBytes / BYTES_PER_KIBIBYTE)} KB · ${transportLabel} · ${deviceLabel}`
    : state
      ? `${state.viewport.width} × ${state.viewport.height} canonical`
      : "No frame";

  let controlAction: ReactNode = null;
  if (state?.controller === "self" && controlToken) {
    controlAction = (
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
  } else if (state?.controller === "other") {
    controlAction = (
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
  } else {
    controlAction = (
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

  const interactionStyle = displayRect
    ? [
        styles.interactionLayer,
        {
          left: displayRect.x,
          top: displayRect.y,
          width: displayRect.width,
          height: displayRect.height,
        },
      ]
    : styles.interactionLayer;

  if (closedView) {
    return (
      <View style={styles.screen}>
        <CanvasPlaceholder
          styles={styles}
          theme={theme}
          title="Shared browser closed"
          detail="The browser was closed for everyone. Its saved site data is available when you reopen it."
        >
          <ControlButton
            styles={styles}
            theme={theme}
            label={reopenPending ? "Opening…" : "Open shared browser"}
            icon="PanelsTopLeft"
            primary
            large
            disabled={reopenPending}
            onPress={() => void reopenClosedBrowser()}
          />
        </CanvasPlaceholder>
        {operationError ? (
          <ErrorNotice styles={styles} theme={theme} message={operationError} />
        ) : null}
      </View>
    );
  }

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
      <BrowserTabs
        styles={styles}
        theme={theme}
        tabs={tabsQuery.data?.tabs ?? []}
        selectedId={selectedTabId ?? state?.tabId ?? null}
        selectedState={state}
        statusColor={statusColor}
        statusLabel={statusLabel}
        controlAction={controlAction}
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
        onClose={() =>
          requestControlled("close this tab", () => controlledActionsRef.current?.closeTab())
        }
      />

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
              requestControlled("go forward", () =>
                controlledActionsRef.current?.navigate("forward"),
              )
            }
          />
          <ChromeIconButton
            styles={styles}
            theme={theme}
            label="Reload"
            icon="RotateCw"
            disabled={!viewerToken || anyMutationPending}
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
            editable={Boolean(viewerToken) && !navigateMutation.isPending}
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
            label={`${emulation.mode === "mobile" ? "Disable" : "Enable"} mobile emulation`}
            icon="Smartphone"
            selected={emulation.mode === "mobile"}
            disabled={!viewerToken || anyMutationPending}
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

      {runtimeNotice || visibleError || state?.notice || video.codecFallbackReason ? (
        <ErrorNotice
          styles={styles}
          theme={theme}
          message={
            runtimeNotice ?? visibleError ?? state?.notice ?? video.codecFallbackReason ?? ""
          }
          action={noticeAction}
          onAction={onNoticeAction}
          actionDisabled={attachQuery.isFetching}
        />
      ) : null}

      <View style={styles.canvasShell}>
        <BrowserCanvasViewport
          mode={scaleMode}
          style={styles.canvas}
          contentSize={canvasLayout?.contentSize ?? containerSize}
          localPanEnabled={layout.platform === "web" || !canControl}
          onLayout={handleCanvasLayout}
        >
          {buffer.layers.map((layer, slot) => {
            if (!layer) return null;
            const rect = getBrowserCanvasLayout(
              containerSize,
              layer.candidate.frame,
              layer.candidate.viewport ?? state?.viewport ?? layer.candidate.frame,
              scaleMode,
            )?.frameRect;
            if (!rect) return null;
            const visible = slot === buffer.front;
            return (
              <BrowserFrameImage
                key={layer.ticket}
                ticket={layer.ticket}
                visible={visible}
                label={state?.title ? `Shared browser: ${state.title}` : "Shared browser frame"}
                settled={settled}
                retry={retryFrameCapture}
                source={layer.source}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                cornerRadius={layout.compact ? DIMENSION.screenRadius - SPACE.xs : 0}
              />
            );
          })}
          {video.supported ? (
            <BrowserVideoSurface
              canvasRef={video.canvasRef}
              onError={video.surfaceError}
              style={{
                position: "absolute",
                left: displayRect?.x ?? 0,
                top: displayRect?.y ?? 0,
                width: displayRect?.width ?? containerSize.width,
                height: displayRect?.height ?? containerSize.height,
                opacity: video.front ? 1 : 0,
                overflow: "hidden",
                borderRadius: layout.compact ? DIMENSION.screenRadius - SPACE.xs : 0,
              }}
            />
          ) : null}
          {currentFrame && displayRect ? (
            <View
              ref={canvasInput.canvasRef}
              {...canvasInput.panHandlers}
              accessible={false}
              pointerEvents={liveInputEnabled ? "auto" : "none"}
              style={interactionStyle}
            />
          ) : video.front ? null : imageError ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Frame could not be displayed"
              detail="The JPEG frame was received but the client could not decode it. Capture will continue."
            />
          ) : connectionError ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Connection failed"
              detail="Reconnect to attach a fresh viewer and resume frame capture."
            />
          ) : state?.recoveryState === "runtime-unavailable" || state?.status === "error" ? (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title="Browser unavailable"
              detail={state.error ?? "The browser runtime is temporarily unavailable."}
            />
          ) : (
            <CanvasPlaceholder
              styles={styles}
              theme={theme}
              title={
                attachQuery.isPending || reconnecting
                  ? "Connecting to shared browser"
                  : "Waiting for frame"
              }
              detail="The browser remains active in this workspace when viewers detach."
              loading={attachQuery.isPending || reconnecting || captureQuery.isFetching}
            />
          )}
          {state && currentFrame && displayRect ? (
            <BrowserAgentPointer
              state={state}
              frame={currentFrame}
              rect={displayRect}
              theme={theme}
            />
          ) : null}
        </BrowserCanvasViewport>
        <View style={styles.canvasFooter}>
          <Text numberOfLines={1} style={styles.canvasFooterText}>
            {state?.title || state?.url || "Shared browser"}
          </Text>
          <Text numberOfLines={1} style={styles.canvasFooterText}>
            {frameSummary}
          </Text>
        </View>
      </View>

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
          onRequestControlForCompose={() =>
            requestControlled(
              "insert the composed text",
              () => controlledActionsRef.current?.openCompose("commit"),
              true,
            )
          }
        />
      ) : composeAvailable ? (
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
          onRequestControlForCompose={() =>
            requestControlled(
              "insert the composed text",
              () => controlledActionsRef.current?.openCompose("commit"),
              true,
            )
          }
        />
      ) : null}

      <Modal
        title={
          tabCloseConfirmation?.scope === "last-tab"
            ? "Close final tab and browser?"
            : "Close browser tab?"
        }
        icon={<Icon name="X" size={18} color={theme.colors.statusDanger} />}
        open={tabCloseConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !tabMutationPending) setTabCloseConfirmation(null);
        }}
      >
        <Modal.Content>
          <BrowserDialogBody
            styles={styles}
            actions={
              <>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Cancel"
                  disabled={tabMutationPending}
                  onPress={() => setTabCloseConfirmation(null)}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label={closeTabLabel}
                  danger
                  disabled={!viewerToken || tabMutationPending}
                  onPress={() =>
                    requestControlled("close this tab", () =>
                      controlledActionsRef.current?.confirmCloseTab(),
                    )
                  }
                />
              </>
            }
          >
            {tabCloseConfirmation?.scope === "last-tab"
              ? "Closing the final tab closes the browser for every viewer and agent in this workspace. Unsaved page changes are lost. Saved site data is kept for an explicit reopen. Other workspaces stay open."
              : "This removes the tab for everyone viewing it, including agents. Unsaved page changes are lost. Other tabs stay open."}
          </BrowserDialogBody>
        </Modal.Content>
      </Modal>
      <Modal
        title={restartForGraphics ? "Apply graphics and restart browser?" : "Close shared browser?"}
        icon={<Icon name="X" size={18} color={theme.colors.statusDanger} />}
        open={closeConfirmationOpen}
        onOpenChange={(open) => {
          if (!closePending) {
            setCloseConfirmationOpen(open);
            if (!open) setRestartForGraphics(false);
          }
        }}
      >
        <Modal.Content>
          <BrowserDialogBody
            styles={styles}
            actions={
              <>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Cancel"
                  disabled={closePending}
                  onPress={() => {
                    setCloseConfirmationOpen(false);
                    setRestartForGraphics(false);
                  }}
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label={
                    restartForGraphics
                      ? closePending
                        ? "Restarting…"
                        : "Restart and apply"
                      : closePending
                        ? "Closing…"
                        : "Close browser"
                  }
                  disabled={!viewerToken || closePending}
                  onPress={() =>
                    requestControlled(
                      restartForGraphics
                        ? "restart the shared browser"
                        : "close the shared browser",
                      () => controlledActionsRef.current?.confirmCloseBrowser(),
                    )
                  }
                />
              </>
            }
          >
            {restartForGraphics
              ? "This restarts the browser for every viewer and agent in this workspace. All tabs close and unsaved page changes are lost. Saved site data is kept. Other workspaces stay open."
              : "This closes the browser for every viewer and agent in this workspace. Unsaved page changes are lost. Saved site data is kept for an explicit reopen. Other workspaces stay open."}
          </BrowserDialogBody>
        </Modal.Content>
      </Modal>
      <BrowserControlDialog
        styles={styles}
        theme={theme}
        state={state}
        request={controlRequest}
        pending={controlRequestPending}
        available={Boolean(viewerToken)}
        onCancel={() => setControlRequest(null)}
        onConfirm={() => void confirmControlRequest()}
      />
      {toolbarMenu === "display" ? (
        <BrowserDisplayMenu
          theme={theme}
          compact={layout.compact || layout.platform !== "web"}
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
            selectDisabled: !viewerToken || anyMutationPending,
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
          fillViewportDisabled={!viewerToken || anyMutationPending || !fillViewportResolution}
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
            applyDisabled: !viewerToken || anyMutationPending,
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
                <Text accessibilityRole="alert" style={styles.mutedText}>
                  {preferences.error}
                </Text>
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
                <ErrorNotice styles={styles} theme={theme} message={visibleError} />
              ) : null}
              <View style={styles.customViewportRow}>
                <Field
                  styles={styles}
                  theme={theme}
                  value={viewportWidth}
                  accessibilityLabel="Canonical viewport width"
                  editable={Boolean(viewerToken) && !resizeMutation.isPending}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={4}
                  selectTextOnFocus
                  style={styles.viewportField}
                  onChangeText={setViewportWidth}
                  onSubmit={() =>
                    requestControlled("resize the browser", () =>
                      controlledActionsRef.current?.applyViewport(),
                    )
                  }
                />
                <Text style={styles.multiply}>×</Text>
                <Field
                  styles={styles}
                  theme={theme}
                  value={viewportHeight}
                  accessibilityLabel="Canonical viewport height"
                  editable={Boolean(viewerToken) && !resizeMutation.isPending}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={4}
                  selectTextOnFocus
                  style={styles.viewportField}
                  onChangeText={setViewportHeight}
                  onSubmit={() =>
                    requestControlled("resize the browser", () =>
                      controlledActionsRef.current?.applyViewport(),
                    )
                  }
                />
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Apply"
                  disabled={!viewerToken || anyMutationPending}
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
      ) : toolbarMenu === "actions" ? (
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
                      disabled={!viewerToken || (canControl && !canSendInput)}
                      onPress={() => {
                        canvasInput.nativeKeyboard.reset();
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
                  disabled: !viewerToken || (canControl && !canSendInput),
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
                  disabled: !viewerToken || (canControl && !canSendInput),
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
            disabled: !viewerToken || (canControl && !canSendInput),
            onPress: () => requestControlled("send browser keys", () => setKeysSubmenuOpen(true)),
          }}
          print={{
            pending: printMutation.isPending,
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
            disabled: attachQuery.isFetching,
            onPress: () => {
              closeToolbarMenu();
              reconnect();
            },
          }}
          closeBrowser={{
            disabled: !viewerToken || anyMutationPending,
            onPress: () => {
              closeToolbarMenu(false);
              requestControlled("close the shared browser", () =>
                controlledActionsRef.current?.closeBrowser(),
              );
            },
          }}
        />
      ) : null}
    </View>
  );
}
