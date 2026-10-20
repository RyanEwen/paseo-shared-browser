/** Production Actions menu, shared with isolated rendering proof so row layout cannot drift. */
import type { RefObject } from "react";
import { View } from "react-native";
import {
  BrowserMenuItem,
  BrowserMenuSeparator,
  BrowserToolbarMenu,
  type BrowserToolbarMenuProps,
} from "./browser-toolbar-menu";

interface Action {
  disabled: boolean;
  onPress(): void;
}

interface Props extends Omit<BrowserToolbarMenuProps, "children" | "title" | "preferredHeight"> {
  keyboard?: Action | undefined;
  compose?: Action | undefined;
  sendKeys: Action & { anchorRef: RefObject<View | null>; expanded: boolean };
  print: Action & { pending: boolean; available: boolean };
  reconnect: Action;
  closeBrowser: Action;
}

/** Keep the destructive browser close last and size every row from rendered content. */
export function BrowserActionsMenu({
  keyboard,
  compose,
  sendKeys,
  print,
  reconnect,
  closeBrowser,
  ...menu
}: Props) {
  const { theme, compact } = menu;
  return (
    <BrowserToolbarMenu {...menu} title="Browser menu">
      {keyboard ? (
        <BrowserMenuItem
          theme={theme}
          compact={compact}
          label="Keyboard"
          icon="Keyboard"
          {...keyboard}
        />
      ) : null}
      {compose ? (
        <BrowserMenuItem
          theme={theme}
          compact={compact}
          label="Compose text"
          icon="Pencil"
          {...compose}
        />
      ) : null}
      <View ref={sendKeys.anchorRef}>
        <BrowserMenuItem
          theme={theme}
          compact={compact}
          label="Send keys"
          icon="Keyboard"
          disabled={sendKeys.disabled}
          expanded={sendKeys.expanded}
          onPress={sendKeys.onPress}
        />
      </View>
      <BrowserMenuItem
        theme={theme}
        compact={compact}
        label={print.pending ? "Opening print…" : "Print…"}
        detail={
          print.available
            ? "Open real preview, then select its tab"
            : "Requires Private desktop in Graphics"
        }
        icon="Printer"
        disabled={print.disabled}
        onPress={print.onPress}
      />
      <BrowserMenuItem
        theme={theme}
        compact={compact}
        label="Reconnect viewer"
        icon="RotateCw"
        {...reconnect}
      />
      <BrowserMenuSeparator theme={theme} />
      <BrowserMenuItem
        theme={theme}
        compact={compact}
        label="Close shared browser"
        icon="X"
        {...closeBrowser}
      />
    </BrowserToolbarMenu>
  );
}
