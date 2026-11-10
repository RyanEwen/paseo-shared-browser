import { useCallback, useEffect, useRef, useState } from "react";
import type { View } from "react-native";
import type { BrowserState } from "../shared/browser";

/** Which toolbar menu is open; at most one at a time. */
export type BrowserToolbarMenuKind = "display" | "actions";

/** Pane size used to place toolbar menus. */
export interface BrowserPaneSize {
  width: number;
  height: number;
}

/** Toolbar menu state shared by the toolbar buttons and the menus they open. */
export type BrowserToolbarMenuState = ReturnType<typeof useBrowserToolbarMenu>;

/**
 * Open/close state, anchors and focus restoration for the toolbar's display and actions menus,
 * including the actions menu's Send keys submenu. Holds no effects.
 */
export function useBrowserToolbarMenu() {
  const [keysSubmenuOpen, setKeysSubmenuOpen] = useState(false);
  const keysAnchorRef = useRef<View | null>(null);
  const [toolbarMenu, setToolbarMenu] = useState<BrowserToolbarMenuKind | null>(null);
  const paneRef = useRef<View | null>(null);
  const displayAnchorRef = useRef<View | null>(null);
  const actionsAnchorRef = useRef<View | null>(null);
  const [paneSize, setPaneSize] = useState<BrowserPaneSize>({ width: 0, height: 0 });
  const menuRestoreFocus = useRef(true);

  /**
   * Close any open menu.
   *
   * @param restoreFocus False when the closing action moves focus elsewhere itself, such as
   *   into a dialog it opens.
   */
  const closeToolbarMenu = useCallback((restoreFocus = true) => {
    menuRestoreFocus.current = restoreFocus;
    setKeysSubmenuOpen(false);
    setToolbarMenu(null);
  }, []);

  /** Open a menu, or close it when it is already open. */
  const toggleToolbarMenu = (menu: BrowserToolbarMenuKind) => {
    menuRestoreFocus.current = true;
    setKeysSubmenuOpen(false);
    setToolbarMenu((current) => (current === menu ? null : menu));
  };

  return {
    keysSubmenuOpen,
    setKeysSubmenuOpen,
    keysAnchorRef,
    toolbarMenu,
    paneRef,
    displayAnchorRef,
    actionsAnchorRef,
    paneSize,
    setPaneSize,
    menuRestoreFocus,
    closeToolbarMenu,
    toggleToolbarMenu,
  };
}

/**
 * The address field's draft. It follows the page URL while the field is not focused, so typing
 * is never overwritten by a navigation that lands meanwhile.
 */
export function useBrowserAddressDraft(state: BrowserState | null) {
  const [addressDraft, setAddressDraft] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);

  useEffect(() => {
    if (!state || addressFocused) return;
    setAddressDraft(state.url);
  }, [addressFocused, state?.sessionId, state?.url]);

  return { addressDraft, setAddressDraft, setAddressFocused };
}
