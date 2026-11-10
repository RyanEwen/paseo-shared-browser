import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { type GestureResponderHandlers, type LayoutChangeEvent, Text, View } from "react-native";
import type { BrowserState } from "../shared/browser";
import { BrowserAgentPointer } from "./browser-agent-pointer";
import { type BrowserCanvasDisplayMode, getBrowserCanvasLayout } from "./browser-canvas-layout";
import { BrowserCanvasViewport } from "./browser-canvas-viewport";
import { CanvasPlaceholder } from "./browser-chrome";
import { BrowserFrameImage } from "./browser-frame-image";
import { type createStyles, DIMENSION, SPACE } from "./browser-panel-styles";
import { BrowserVideoSurface } from "./browser-video-surface";
import type { useBrowserFrameBuffer } from "./use-browser-frame-buffer";
import type { BrowserMediaPresentation } from "./use-browser-media-presentation";

type Styles = ReturnType<typeof createStyles>;
type Theme = PluginWorkspacePanelProps["theme"];
type FrameRect = NonNullable<ReturnType<typeof getBrowserCanvasLayout>>["frameRect"];

/** What the canvas shows when no current frame accepts input. */
interface BrowserCanvasOverlayProps {
  styles: Styles;
  theme: Theme;
  state: BrowserState | null;
  currentFrame: BrowserMediaPresentation["currentFrame"];
  displayRect: FrameRect | null;
  videoPresenting: boolean;
  imageError: unknown;
  connectionError: unknown;
  connecting: boolean;
  loading: boolean;
  liveInputEnabled: boolean;
  inputLayerRef: React.Ref<View>;
  panHandlers: GestureResponderHandlers;
}

/**
 * The layer above the pixels: the input layer over a current frame, nothing while video is
 * presenting, otherwise the placeholder that explains why there is no frame.
 */
function BrowserCanvasOverlay({
  styles,
  theme,
  state,
  currentFrame,
  displayRect,
  videoPresenting,
  imageError,
  connectionError,
  connecting,
  loading,
  liveInputEnabled,
  inputLayerRef,
  panHandlers,
}: BrowserCanvasOverlayProps) {
  if (currentFrame && displayRect) {
    return (
      <View
        ref={inputLayerRef}
        {...panHandlers}
        accessible={false}
        pointerEvents={liveInputEnabled ? "auto" : "none"}
        style={[
          styles.interactionLayer,
          {
            left: displayRect.x,
            top: displayRect.y,
            width: displayRect.width,
            height: displayRect.height,
          },
        ]}
      />
    );
  }
  if (videoPresenting) return null;
  if (state?.status === "empty") {
    return (
      <CanvasPlaceholder
        styles={styles}
        theme={theme}
        title="No pages open"
        detail="Enter a URL or open a new tab to start browsing."
      />
    );
  }
  if (imageError) {
    return (
      <CanvasPlaceholder
        styles={styles}
        theme={theme}
        title="Frame could not be displayed"
        detail="The JPEG frame was received but the client could not decode it. Capture will continue."
      />
    );
  }
  if (connectionError) {
    return (
      <CanvasPlaceholder
        styles={styles}
        theme={theme}
        title="Connection failed"
        detail="Reconnect to attach a fresh viewer and resume frame capture."
      />
    );
  }
  if (state?.recoveryState === "runtime-unavailable" || state?.status === "error") {
    return (
      <CanvasPlaceholder
        styles={styles}
        theme={theme}
        title="Browser unavailable"
        detail={state.error ?? "The browser runtime is temporarily unavailable."}
      />
    );
  }
  return (
    <CanvasPlaceholder
      styles={styles}
      theme={theme}
      title={connecting ? "Connecting to shared browser" : "Waiting for frame"}
      detail="The browser remains active in this workspace when viewers detach."
      loading={loading}
    />
  );
}

/** The page title and frame summary shown above or below the canvas. */
export function BrowserCanvasStatus({
  styles,
  top,
  title,
  frameSummary,
}: {
  styles: Styles;
  /** Touch-first layouts place the status above the canvas. */
  top: boolean;
  title: string;
  frameSummary: string;
}) {
  return (
    <View style={[styles.canvasFooter, top ? styles.canvasStatusTop : null]}>
      <Text numberOfLines={1} style={styles.canvasFooterText}>
        {title}
      </Text>
      <Text numberOfLines={1} style={styles.canvasFooterText}>
        {frameSummary}
      </Text>
    </View>
  );
}

/** Everything the canvas area renders. */
export interface BrowserCanvasAreaProps {
  styles: Styles;
  theme: Theme;
  layout: PluginWorkspacePanelProps["layout"];
  touchFirstLayout: boolean;
  scaleMode: BrowserCanvasDisplayMode;
  containerSize: { width: number; height: number };
  canControl: boolean;
  onLayout(event: LayoutChangeEvent): void;
  state: BrowserState | null;
  buffer: ReturnType<typeof useBrowserFrameBuffer>["buffer"];
  settled: ReturnType<typeof useBrowserFrameBuffer>["settled"];
  media: BrowserMediaPresentation;
  imageError: unknown;
  connectionError: unknown;
  connecting: boolean;
  loading: boolean;
  liveInputEnabled: boolean;
  inputLayerRef: React.Ref<View>;
  panHandlers: GestureResponderHandlers;
  /** Shown below the canvas on non-touch layouts. */
  status: ReactNode;
}

/**
 * The browser canvas: the decoded JPEG layers, the video surface, the input layer or
 * placeholder above them, and the agent pointer.
 */
export function BrowserCanvasArea({
  styles,
  theme,
  layout,
  touchFirstLayout,
  scaleMode,
  containerSize,
  canControl,
  onLayout,
  state,
  buffer,
  settled,
  media,
  imageError,
  connectionError,
  connecting,
  loading,
  liveInputEnabled,
  inputLayerRef,
  panHandlers,
  status,
}: BrowserCanvasAreaProps) {
  const { video, canvasLayout, displayRect, currentFrame, retryFrameCapture } = media;
  return (
    <View style={[styles.canvasShell, touchFirstLayout ? styles.canvasShellFlexible : null]}>
      <BrowserCanvasViewport
        mode={scaleMode}
        style={styles.canvas}
        contentSize={canvasLayout?.contentSize ?? containerSize}
        localPanEnabled={layout.platform === "web" || !canControl}
        onLayout={onLayout}
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
        <BrowserCanvasOverlay
          styles={styles}
          theme={theme}
          state={state}
          currentFrame={currentFrame}
          displayRect={displayRect}
          videoPresenting={Boolean(video.front)}
          imageError={imageError}
          connectionError={connectionError}
          connecting={connecting}
          loading={loading}
          liveInputEnabled={liveInputEnabled}
          inputLayerRef={inputLayerRef}
          panHandlers={panHandlers}
        />
        {state && currentFrame && displayRect ? (
          <BrowserAgentPointer
            state={state}
            frame={currentFrame}
            rect={displayRect}
            theme={theme}
          />
        ) : null}
      </BrowserCanvasViewport>
      {touchFirstLayout ? null : status}
    </View>
  );
}
