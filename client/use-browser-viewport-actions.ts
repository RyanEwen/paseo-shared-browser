import { useCallback, useEffect, useState } from "react";
import {
  type BrowserState,
  type DevicePresetId,
  MAX_VIEWPORT,
  MIN_VIEWPORT,
} from "../shared/browser";
import type { BrowserCanvasDisplayMode } from "./browser-canvas-layout";
import type { EmulationSelection } from "./browser-emulation-mode";
import { getFillViewportResolution } from "./browser-fill-viewport";
import type { BrowserAttachment } from "./use-browser-attachment";
import type { BrowserControlAuthority, BrowserMutations } from "./use-browser-controlled-actions";
import { useBrowserEmulationMode } from "./use-browser-emulation-mode";
import { useBrowserFillViewport } from "./use-browser-fill-viewport";

/**
 * Whether Fill viewport follows this panel's size. The choice belongs to one host/workspace
 * pair and is cleared whenever the panel switches to another.
 */
export function useFillViewportScope(panelScope: string) {
  const [fillViewportScope, setFillViewportScope] = useState<string | null>(null);
  const fillViewportEnabled = fillViewportScope === panelScope;
  useEffect(() => {
    setFillViewportScope(null);
  }, [panelScope]);
  return { setFillViewportScope, fillViewportEnabled };
}

/** The custom viewport fields' drafts, reset from the browser whenever its viewport changes. */
export function useBrowserViewportDraft(state: BrowserState | null) {
  const [viewportWidth, setViewportWidth] = useState("");
  const [viewportHeight, setViewportHeight] = useState("");

  useEffect(() => {
    if (!state) return;
    setViewportWidth(String(state.viewport.width));
    setViewportHeight(String(state.viewport.height));
  }, [state?.sessionId, state?.viewport.height, state?.viewport.width]);

  return { viewportWidth, setViewportWidth, viewportHeight, setViewportHeight };
}

/** What the viewport and device actions need. */
export interface BrowserViewportActionsOptions {
  host: { id: string };
  workspaceId: string;
  platform: "ios" | "android" | "web";
  active: boolean;
  session: BrowserAttachment;
  mutations: BrowserMutations;
  authority: BrowserControlAuthority;
  viewportWidth: string;
  viewportHeight: string;
  containerSize: { width: number; height: number };
  panelScope: string;
  fillViewportEnabled: boolean;
  setFillViewportScope(scope: string | null): void;
  setScaleMode(mode: BrowserCanvasDisplayMode): void;
  activeInput: boolean;
  activeInputRef: { current: boolean };
  pendingControlAction: unknown;
  closeToolbarMenu(restoreFocus?: boolean): void;
  setOperationError(message: string | null): void;
}

/**
 * Controlled viewport and device changes: a custom size, Fill viewport (which then follows the
 * panel's size while it stays enabled), device presets and mobile emulation.
 */
export function useBrowserViewportActions({
  host,
  workspaceId,
  platform,
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
  pendingControlAction,
  closeToolbarMenu,
  setOperationError,
}: BrowserViewportActionsOptions) {
  const { inputLifecycle, state } = session;
  const { mutationIdentity, resizeMutation, deviceMutation, anyMutationPending } = mutations;
  const { canControl, requireControlContext } = authority;

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
    setScaleMode,
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
    platform,
    state,
    canControl,
    pending: anyMutationPending || Boolean(pendingControlAction),
    apply: applyEmulationSelection,
  });

  return {
    applyViewport,
    fillTarget,
    fillViewport,
    selectDevicePreset,
    emulation,
  };
}
