import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { type BrowserCanvasDisplayMode, getBrowserCanvasLayout } from "./browser-canvas-layout";
import { physicalBrowserDisplaySize } from "./browser-display-demand";
import {
  isFrameCurrent,
  isFrameDisplayCurrent,
  isVideoSourceCurrent,
} from "./browser-video-currency";
import { supportsBrowserMedia } from "./browser-video-surface";
import { isBrowserClosedError, isExpiredBrowserViewerError } from "./browser-viewer-recovery";
import type { BrowserAttachment } from "./use-browser-attachment";
import { useBrowserDisplayDemand } from "./use-browser-display-demand";
import { useBrowserImageCapture } from "./use-browser-image-capture";
import type { BrowserRpcClients } from "./use-browser-rpc-clients";
import type { BrowserToolbarMenuKind } from "./use-browser-toolbar-menu";
import { useBrowserVideo } from "./use-browser-video";
import type { useResolutionFavorites } from "./use-resolution-favorites";

/** What the panel's pixels need from its attachment and display state. */
export interface BrowserMediaPresentationOptions {
  host: { id: string };
  workspaceId: string;
  active: boolean;
  session: BrowserAttachment;
  preferences: ReturnType<typeof useResolutionFavorites>;
  rpc: Pick<BrowserRpcClients, "readMediaCapabilities" | "captureBrowser" | "reportDisplayDemand">;
  toolbarMenu: BrowserToolbarMenuKind | null;
  activeInput: boolean;
  containerSize: { width: number; height: number };
  scaleMode: BrowserCanvasDisplayMode;
  screenPixelRatio: number;
}

/** The panel's video, image capture and the frame it currently presents. */
export type BrowserMediaPresentation = ReturnType<typeof useBrowserMediaPresentation>;

/**
 * Choose and present the panel's pixels: live video when available, otherwise captured JPEG
 * frames, and the canvas layout and physical display size they produce.
 *
 * Only a frame current for the accepted state is presented or admitted for input. Effects run
 * in the same relative order as when this logic lived inline in the panel.
 */
export function useBrowserMediaPresentation({
  host,
  workspaceId,
  active,
  session,
  preferences,
  rpc,
  toolbarMenu,
  activeInput,
  containerSize,
  scaleMode,
  screenPixelRatio,
}: BrowserMediaPresentationOptions) {
  const { readMediaCapabilities, captureBrowser, reportDisplayDemand } = rpc;
  const {
    mountedRef,
    activeViewerTokenRef,
    stateRef,
    frameRef,
    committedViewport,
    inputLifecycle,
    publishAdmittedPaint,
    setLegacyInputBusy,
    state,
    setBrowserClosed,
    buffer,
    frame,
    receive,
    acceptState,
    closedView,
    viewerToken,
  } = session;

  const useLiveVideo = preferences.liveVideoEnabled;
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
    active: active && useLiveVideo && state !== null && state.status !== "empty",
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
    active:
      active &&
      state !== null &&
      state.status !== "empty" &&
      (!useLiveVideo || !video.supported || video.active),
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

  const videoViewerExpired =
    video.errorViewerToken === viewerToken && isExpiredBrowserViewerError(video.error);
  const viewingExpired = videoViewerExpired || isExpiredBrowserViewerError(captureQuery.error);
  useEffect(() => {
    if (isBrowserClosedError(captureQuery.error) || isBrowserClosedError(video.error))
      setBrowserClosed(true);
  }, [captureQuery.error, video.error]);
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

  return {
    useLiveVideo,
    canTryPyrowave,
    mediaUnavailableReason,
    video,
    captureQuery,
    refreshCapture,
    retryFrameCapture,
    videoViewerExpired,
    viewingExpired,
    frontLayer,
    currentFrame,
    canvasLayout,
    displayRect,
  };
}
