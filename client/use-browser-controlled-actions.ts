import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { BrowserInputEvent, BrowserState, DevicePresetId } from "../shared/browser";
import {
  type ControlRequest,
  type ControlRequestBasis,
  controlRequestBasis,
  isControlRequestCurrent,
} from "./browser-control-request";
import { errorMessage, hasUnknownMutationOutcome } from "./browser-panel-errors";
import { isFrameCurrent } from "./browser-video-currency";
import type { BrowserAttachment } from "./use-browser-attachment";
import { useBrowserCanvasInput } from "./use-browser-canvas-input";
import type { BrowserMediaPresentation } from "./use-browser-media-presentation";
import type { useBrowserOperationError } from "./use-browser-operation-error";
import type { BrowserRpcClients } from "./use-browser-rpc-clients";
import { useBrowserScopedMutation } from "./use-browser-scoped-mutation";
import type { BrowserTabState, useBrowserTabList } from "./use-browser-tabs";
import type { BrowserToolbarMenuKind } from "./use-browser-toolbar-menu";

/** A key the actions menu can send. */
export type SpecialKey = Extract<BrowserInputEvent, { kind: "key" }>["key"];

/**
 * Actions that require control. Queued actions always resolve through the render that holds
 * control, so a callback captured before acquisition never reuses an old control identity.
 */
export interface ControlledActions {
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

/** The panel's control lease and pending control request state. */
export type BrowserControlState = ReturnType<typeof useBrowserControlState>;

/**
 * This panel's control token, the control request dialog's request, an action queued until
 * control is acquired, and the latest controlled action table. Holds no effects.
 */
export function useBrowserControlState() {
  const [controlToken, setControlToken] = useState<string | null>(null);
  const [controlRequest, setControlRequest] = useState<ControlRequest | null>(null);
  const [pendingControlAction, setPendingControlAction] = useState<ControlRequest | null>(null);
  const [controlRequestPending, setControlRequestPending] = useState(false);
  const controlRequestPendingRef = useRef(false);
  const controlledActionsRef = useRef<ControlledActions | null>(null);

  return {
    controlToken,
    setControlToken,
    controlRequest,
    setControlRequest,
    pendingControlAction,
    setPendingControlAction,
    controlRequestPending,
    setControlRequestPending,
    controlRequestPendingRef,
    controlledActionsRef,
  };
}

/** What the panel's mutations need. */
export interface BrowserMutationsOptions {
  host: { id: string };
  workspaceId: string;
  rpc: BrowserRpcClients;
  session: BrowserAttachment;
  media: BrowserMediaPresentation;
  control: BrowserControlState;
  tabs: BrowserTabState;
  tabsQuery: ReturnType<typeof useBrowserTabList>["tabsQuery"];
  operationNotice: ReturnType<typeof useBrowserOperationError>;
  setFillViewportScope(scope: string | null): void;
}

/** The panel's scoped mutations. */
export type BrowserMutations = ReturnType<typeof useBrowserMutations>;

/**
 * Every browser mutation the panel sends, scoped to the host, workspace, viewer and control
 * identity that started it. Failures publish a notice (with unknown outcomes marked as not
 * replayed) and refresh capture; successes accept the returned state.
 */
export function useBrowserMutations({
  host,
  workspaceId,
  rpc,
  session,
  media,
  control,
  tabs,
  tabsQuery,
  operationNotice,
  setFillViewportScope,
}: BrowserMutationsOptions) {
  const {
    acquireControl,
    releaseControl,
    printBrowser,
    navigateBrowser,
    resizeBrowser,
    applyDevicePreset,
    sendBrowserInput,
  } = rpc;
  const {
    activeViewerTokenRef,
    controllerObservationRevision,
    inputLifecycle,
    setLegacyInputBusy,
    setRuntimeNotice,
    acceptState,
    viewerToken,
  } = session;
  const { refreshCapture, video } = media;
  const { controlToken, setControlToken, controlRequestPending } = control;
  const { tabMutationPending, closePending } = tabs;
  const setOperationError = operationNotice.publish;

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
    mutationFn: (input: Parameters<typeof acquireControl>[0]) =>
      operationNotice.recover(() => acquireControl(input)),
    onSuccess: (result) => {
      setControlToken(result.controlToken);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const releaseMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: (input: Parameters<typeof releaseControl>[0]) =>
      operationNotice.recover(() => releaseControl(input)),
    onSuccess: (result) => {
      setControlToken(null);
      mutationSucceeded(result.state);
    },
    onError: mutationFailed,
  });
  const printMutation = useBrowserScopedMutation({
    identity: mutationIdentity,
    currentIdentity: currentMutationIdentity,
    mutationFn: (input: Parameters<typeof printBrowser>[0]) =>
      operationNotice.recover(() => printBrowser(input)),
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
    mutationFn: (input: Parameters<typeof navigateBrowser>[0]) =>
      operationNotice.recover(() => navigateBrowser(input)),
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
    mutationFn: (input: Parameters<typeof resizeBrowser>[0]) =>
      operationNotice.recover(() => resizeBrowser(input)),
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
    mutationFn: (input: Parameters<typeof applyDevicePreset>[0]) =>
      operationNotice.recover(() => applyDevicePreset(input)),
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
    mutationFn: (input: Parameters<typeof sendBrowserInput>[0]) =>
      operationNotice.recover(() => sendBrowserInput(input)),
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

  return {
    mutationFailed,
    mutationIdentity,
    acquireMutation,
    releaseMutation,
    printMutation,
    navigateMutation,
    resizeMutation,
    deviceMutation,
    inputMutation,
    anyMutationPending,
  };
}

/** What control authority needs. */
export interface BrowserControlAuthorityOptions {
  rpc: Pick<BrowserRpcClients, "acquireControl" | "releaseControl">;
  session: BrowserAttachment;
  media: BrowserMediaPresentation;
  control: BrowserControlState;
  mutations: BrowserMutations;
  selectedTabId: string | null;
  selectedTabIdRef: MutableRefObject<string | null>;
  panelScope: string;
  panelScopeRef: MutableRefObject<string>;
  toolbarMenu: BrowserToolbarMenuKind | null;
  closeToolbarMenu(restoreFocus?: boolean): void;
  setOperationError(message: string | null): void;
}

/** The panel's control and input authority. */
export type BrowserControlAuthority = ReturnType<typeof useBrowserControlAuthority>;

/**
 * Whether this panel may act, and the exact control and input contexts each action is sent
 * with. Actions without control open the control request dialog bound to the observed page;
 * a confirmed acquisition queues the action for the next controlled render instead of
 * running a stale callback.
 */
export function useBrowserControlAuthority({
  rpc,
  session,
  media,
  control,
  mutations,
  selectedTabId,
  selectedTabIdRef,
  panelScope,
  panelScopeRef,
  toolbarMenu,
  closeToolbarMenu,
  setOperationError,
}: BrowserControlAuthorityOptions) {
  const { acquireControl, releaseControl } = rpc;
  const {
    mountedRef,
    activeViewerTokenRef,
    stateRef,
    controllerObservationRevision,
    frameRef,
    inputLifecycle,
    legacyInputBusy,
    setLegacyInputBusy,
    state,
    acceptState,
    closedViewRef,
    viewerToken,
  } = session;
  const { video, refreshCapture, viewingExpired, frontLayer, currentFrame } = media;
  const {
    controlToken,
    setControlToken,
    controlRequest,
    setControlRequest,
    setPendingControlAction,
    setControlRequestPending,
    controlRequestPendingRef,
  } = control;
  const {
    mutationFailed,
    acquireMutation,
    releaseMutation,
    printMutation,
    navigateMutation,
    resizeMutation,
    deviceMutation,
    inputMutation,
    anyMutationPending,
  } = mutations;

  useEffect(() => {
    if (state?.controller !== "self" && controlToken) setControlToken(null);
  }, [controlToken, state?.controller, state?.sessionId]);

  const canControl = Boolean(
    viewerToken &&
      controlToken &&
      state?.controller === "self" &&
      (!selectedTabId || state.tabId === selectedTabId) &&
      !viewingExpired,
  );
  const canSendInput =
    canControl && Boolean(currentFrame) && !inputMutation.isPending && !legacyInputBusy;

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

  /** Viewer-only tab management keeps page fences while allowing another controller's handoff. */
  const requestIsCurrent = useCallback(
    (basis: ControlRequestBasis, checkController = true) =>
      !closedViewRef.current &&
      (!selectedTabIdRef.current || selectedTabIdRef.current === basis.tabId) &&
      isControlRequestCurrent(
        basis,
        panelScopeRef.current,
        activeViewerTokenRef.current,
        stateRef.current,
        checkController ? controllerObservationRevision.current : basis.controllerRevision,
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

  return {
    canControl,
    canSendInput,
    controlContext,
    inputContext,
    requireControlContext,
    print,
    sendEvent,
    liveInputEnabled,
    gestureControlContext,
    takeControl,
    requestControlled,
    requestIsCurrent,
    confirmControlRequest,
    release,
    navigate,
  };
}

/** What forwarding canvas gestures needs. */
export interface BrowserPanelCanvasInputOptions {
  rpc: Pick<
    BrowserRpcClients,
    "beginBrowserGesture" | "updateBrowserGesture" | "endBrowserGesture"
  >;
  session: BrowserAttachment;
  media: BrowserMediaPresentation;
  control: BrowserControlState;
  mutations: BrowserMutations;
  authority: BrowserControlAuthority;
  operationNotice: ReturnType<typeof useBrowserOperationError>;
  containerSize: { width: number; height: number };
  scaleMode: string;
  handleInputActivity(active: boolean): void;
}

/**
 * Forward physical mouse events and genuine touch from the canvas as ordered gesture channels,
 * owned by the exact viewer, control lease, page and geometry they started on.
 */
export function useBrowserPanelCanvasInput({
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
}: BrowserPanelCanvasInputOptions) {
  const { beginBrowserGesture, updateBrowserGesture, endBrowserGesture } = rpc;
  const { lastPointRef, inputLifecycle, admittedPaint, state, acceptState, viewerToken } = session;
  const { refreshCapture, displayRect } = media;
  const { controlToken } = control;
  const { mutationFailed } = mutations;
  const { inputContext, gestureControlContext, liveInputEnabled } = authority;

  return useBrowserCanvasInput({
    authority: () => {
      const input = inputContext();
      const context = gestureControlContext();
      return input && context ? { ...context, target: input.target } : null;
    },
    controlAuthority: gestureControlContext,
    transport: {
      begin: beginBrowserGesture,
      update: (input) =>
        input.event.kind === "move" || input.event.kind === "leave"
          ? updateBrowserGesture(input)
          : operationNotice.recover(() => updateBrowserGesture(input)),
      end: endBrowserGesture,
    },
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
}

/** What running a queued controlled action needs. */
export interface PendingControlActionOptions {
  session: BrowserAttachment;
  control: BrowserControlState;
  authority: BrowserControlAuthority;
  setOperationError(message: string | null): void;
}

/**
 * Run the action queued by a confirmed control request once the committed render holds
 * control (and, when the action needs one, an admitted current frame). A request whose page
 * basis changed meanwhile is dropped with a notice instead of running.
 */
export function usePendingControlAction({
  session,
  control,
  authority,
  setOperationError,
}: PendingControlActionOptions): void {
  const { inputLifecycle, admittedPaint, state } = session;
  const { pendingControlAction, setPendingControlAction, controlRequestPending } = control;
  const { canControl, canSendInput, requestIsCurrent } = authority;

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
}
