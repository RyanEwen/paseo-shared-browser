/** Keep native live typing separate from the shared, generation-fenced Compose sheet. */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import { TextInput } from "react-native";
import { ComposeTextControls } from "./browser-compose-controls";
import type { createStyles } from "./browser-panel-styles";
import type { useBrowserCanvasInput } from "./use-browser-canvas-input";

/** Native hosts keep a hidden typing sink mounted while toolbar menus close.
 * Compose uses upstream's host-owned draft and stale-callback fencing unchanged.
 */
export function NativeKeyboardControls({
  relay,
  cancelInput,
  request,
  enabled,
  ownershipKey,
  onRequestHandled,
  ...composeProps
}: {
  styles: ReturnType<typeof createStyles>;
  theme: PluginWorkspacePanelProps["theme"];
  relay: ReturnType<typeof useBrowserCanvasInput>["nativeKeyboard"];
  cancelInput(): void;
  enabled: boolean;
  ownershipKey: string;
  documentKey: string;
  request: { id: number; kind: "keyboard" | "compose" | "commit"; ownershipKey: string } | null;
  onRequestHandled(id: number): void;
  onRequestControlForCompose(): void;
  canRequestControl: boolean;
}) {
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || request.kind !== "keyboard" || handledRequest.current === request.id) return;
    handledRequest.current = request.id;
    if (enabled && request.ownershipKey === ownershipKey) relay.focus();
    onRequestHandled(request.id);
  }, [request, enabled, ownershipKey, relay, onRequestHandled]);

  const composeRequest =
    request && request.kind !== "keyboard" ? { ...request, kind: request.kind } : null;

  return (
    <>
      <TextInput
        key={relay.inputKey}
        ref={relay.inputRef}
        {...relay.inputProps}
        editable={enabled}
        caretHidden
        accessibilityLabel="Shared browser software keyboard"
        style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
      />
      <ComposeTextControls
        {...composeProps}
        enabled={enabled}
        ownershipKey={ownershipKey}
        request={composeRequest}
        onRequestHandled={onRequestHandled}
        composeText={relay.composeText}
        cancelInput={() => {
          relay.inputRef.current?.blur();
          relay.reset();
          cancelInput();
        }}
      />
    </>
  );
}
