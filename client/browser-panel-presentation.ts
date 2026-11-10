import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { BrowserState } from "../shared/browser";

/**
 * Labels the browser panel derives from its state. Pure functions, so each choice reads as a
 * flat sequence of cases instead of nested conditionals in the render.
 */

const BYTES_PER_KIBIBYTE = 1_024;

/**
 * The status chip's label and colour for one browser state. An empty workspace is a normal
 * resting state, so it uses muted text rather than the warning colour of Starting.
 */
export function browserStatusPresentation(
  status: BrowserState["status"] | undefined,
  theme: PluginWorkspacePanelProps["theme"],
): { label: string; color: string } {
  switch (status) {
    case "ready":
      return { label: "Ready", color: theme.colors.statusSuccess };
    case "error":
      return { label: "Error", color: theme.colors.statusDanger };
    case "empty":
      return { label: "No pages", color: theme.colors.foregroundMuted };
    default:
      return { label: "Starting", color: theme.colors.statusWarning };
  }
}

/** The display summary's device part: Fill viewport, a matching preset, or a custom display. */
export function browserDeviceLabel({
  emulationMode,
  fillViewportEnabled,
  selectedResolutionPresetId,
  activeDevicePresetLabel,
}: {
  emulationMode: string;
  fillViewportEnabled: boolean;
  selectedResolutionPresetId: string | null;
  activeDevicePresetLabel: string | undefined;
}): string {
  if (fillViewportEnabled) return "Fill viewport";
  if (selectedResolutionPresetId) return activeDevicePresetLabel ?? "Custom display";
  return `${emulationMode === "mobile" ? "Mobile" : "Desktop"} · custom display`;
}

/**
 * The status bar's frame summary: the presented frame's size and transport (with size in KB
 * and the device label on wide layouts), the canonical viewport before a frame arrives, or
 * "No frame".
 */
export function browserFrameSummary({
  frame,
  state,
  compact,
  presentedBytes,
  transportLabel,
  deviceLabel,
}: {
  frame: { width: number; height: number } | null;
  state: BrowserState | null;
  compact: boolean;
  presentedBytes: number;
  transportLabel: string;
  deviceLabel: string;
}): string {
  if (frame && compact) return `${frame.width}×${frame.height} · ${transportLabel}`;
  if (frame) {
    const kilobytes = Math.ceil(presentedBytes / BYTES_PER_KIBIBYTE);
    return `${frame.width} × ${frame.height} · ${kilobytes} KB · ${transportLabel} · ${deviceLabel}`;
  }
  if (state) return `${state.viewport.width} × ${state.viewport.height} canonical`;
  return "No frame";
}

/** The browser close dialog's confirm label for a plain close or a graphics restart. */
export function closeBrowserConfirmLabel(restartForGraphics: boolean, pending: boolean): string {
  if (restartForGraphics) return pending ? "Restarting…" : "Restart and apply";
  return pending ? "Closing…" : "Close browser";
}
