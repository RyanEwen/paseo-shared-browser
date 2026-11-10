import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type BrowserFrame,
  type BrowserState,
  didBrowserRuntimeRestart,
  isBrowserStateCurrent,
} from "../shared/browser";
import type { FrameCandidate } from "./browser-frame-buffer";
import { isFrameCurrent } from "./browser-video-currency";
import { isBrowserClosedError } from "./browser-viewer-recovery";
import { createFrameLifecycle } from "./frame-lifecycle";
import type { BrowserControlState } from "./use-browser-controlled-actions";
import { useBrowserFrameBuffer } from "./use-browser-frame-buffer";
import type { BrowserRpcClients } from "./use-browser-rpc-clients";
import { type BrowserTabState, useBrowserTabList } from "./use-browser-tabs";

/** What the attachment needs from the panel and the state hooks called before it. */
export interface BrowserAttachmentOptions {
  host: { id: string };
  workspaceId: string;
  viewerLabel: string;
  active: boolean;
  rpc: Pick<BrowserRpcClients, "attachBrowser" | "detachBrowser" | "listTabs">;
  tabs: BrowserTabState;
  control: BrowserControlState;
  setOperationError(message: string | null): void;
}

/** The panel's viewer attachment, accepted state and frame authority. */
export type BrowserAttachment = ReturnType<typeof useBrowserAttachment>;

/**
 * Attach this panel's viewer to the selected tab and own the state every other part of the
 * panel fences on: the accepted `BrowserState`, the active viewer token, the decoded frame
 * buffer and the input lifecycle epoch.
 *
 * A workspace switch, a tab selection, a reconnect and a closed browser each retire the
 * previous viewer, state and frames before anything can act on them. Effects run in the same
 * order as when this logic lived inline in the panel.
 */
export function useBrowserAttachment({
  host,
  workspaceId,
  viewerLabel,
  active,
  rpc,
  tabs,
  control,
  setOperationError,
}: BrowserAttachmentOptions) {
  const { attachBrowser, detachBrowser, listTabs } = rpc;
  const {
    selectedTabId,
    setSelectedTabId,
    tabMutationRequestRef,
    setTabMutationPending,
    setTabCloseConfirmation,
    setCloseConfirmationOpen,
    setRestartForGraphics,
  } = tabs;
  const { setControlToken, setControlRequest, setPendingControlAction } = control;

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
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [browserClosed, setBrowserClosed] = useState(false);

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
  const { tabsQuery, tabsQueryKey } = useBrowserTabList({
    hostId: host.id,
    workspaceId,
    viewerToken,
    active,
    listTabs,
    selectedTabId,
    setSelectedTabId,
    stateRef,
  });

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

  /** Revoke this panel's viewer, page and media after its browser closed for everyone. */
  const dropBrowserView = () => {
    inputLifecycle.bump();
    activeViewerTokenRef.current = null;
    stateRef.current = null;
    frameRef.current = null;
    reset();
    setState(null);
    setControlToken(null);
    setBrowserClosed(true);
  };

  return {
    mountedRef,
    activeViewerTokenRef,
    stateRef,
    controllerObservationRevision,
    frameRef,
    committedViewport,
    lastPointRef,
    inputLifecycle,
    legacyInputBusy,
    setLegacyInputBusy,
    admittedPaint,
    publishAdmittedPaint,
    state,
    runtimeNotice,
    setRuntimeNotice,
    reconnecting,
    setBrowserClosed,
    buffer,
    frame,
    receive,
    settled,
    imageError,
    acceptState,
    attachQuery,
    closedView,
    closedViewRef,
    viewerToken,
    tabsQuery,
    tabsQueryKey,
    reconnect,
    dropBrowserView,
  };
}
