import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { BrowserState, FrameRect } from "../shared/browser";
import type { BrowserFrameAuthority } from "../shared/browser-video";

/** Draw acknowledged agent activity in the displayed frame, never intercepting local input. */
export function BrowserAgentPointer({
  state,
  frame,
  rect,
  theme,
}: {
  state: BrowserState;
  frame: BrowserFrameAuthority;
  rect: FrameRect;
  theme: PluginWorkspacePanelProps["theme"];
}) {
  const pointer = state.agentPointer;
  const [, render] = useState(0);
  const now = performance.now();
  // Durations start on this client's monotonic clock. Host wall-clock skew cannot
  // hide activity immediately or keep a pulse visible indefinitely.
  const receipt = useRef<{
    pointer: typeof pointer;
    expiresAt: number;
    clickExpiresAt: number;
  } | null>(null);
  if (!receipt.current || receipt.current.pointer !== pointer) {
    const receivedAt = performance.now();
    receipt.current = {
      pointer,
      expiresAt: receivedAt + (pointer?.remainingMs ?? 0),
      clickExpiresAt: receivedAt + (pointer?.clickRemainingMs ?? 0),
    };
  }
  useEffect(() => {
    if (!pointer) return;
    const deadlines = [receipt.current!.expiresAt, receipt.current!.clickExpiresAt];
    const timers = deadlines
      .filter((deadline) => deadline > performance.now())
      .map((deadline) =>
        setTimeout(() => render((value) => value + 1), Math.ceil(deadline - performance.now())),
      );
    return () => timers.forEach(clearTimeout);
  }, [pointer]);

  if (
    !pointer ||
    state.status !== "ready" ||
    state.controller === "none" ||
    receipt.current.expiresAt <= now ||
    frame.sessionId !== state.sessionId ||
    frame.runtimeId !== state.runtimeId ||
    frame.captureEpoch !== state.bridgeEpoch ||
    frame.navigationGeneration !== state.navigationGeneration ||
    frame.viewportGeneration !== state.viewportGeneration
  )
    return null;

  const x = (pointer.x / state.viewport.width) * rect.width;
  const y = (pointer.y / state.viewport.height) * rect.height;
  const clicked = now < receipt.current.clickExpiresAt;
  const labelLeft = x > rect.width / 2;
  const labelAbove = y > rect.height - 44;
  // Lucide's arrow tip sits at (3, 3); the semantic crosshair is centered at (10, 10).
  const iconOffset = pointer.source === "semantic" ? 10 : 3;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        overflow: "hidden",
      }}
    >
      {clicked ? (
        <View
          style={{
            position: "absolute",
            left: x - 14,
            top: y - 14,
            width: 28,
            height: 28,
            borderRadius: 14,
            borderWidth: 3,
            borderColor: theme.colors.accent,
          }}
        />
      ) : null}
      <View style={{ position: "absolute", left: x - iconOffset, top: y - iconOffset }}>
        <Icon
          name={pointer.source === "semantic" ? "Crosshair" : "MousePointer2"}
          size={20}
          color={theme.colors.accent}
        />
        <View
          style={{
            position: "absolute",
            top: labelAbove ? -24 : 20,
            ...(labelLeft ? { right: 4 } : { left: 14 }),
            maxWidth: Math.min(220, rect.width),
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderRadius: 4,
            backgroundColor: theme.colors.accent,
          }}
        >
          <Text numberOfLines={1} style={{ fontSize: 11, color: theme.colors.accentForeground }}>
            {pointer.label}
          </Text>
        </View>
      </View>
    </View>
  );
}
