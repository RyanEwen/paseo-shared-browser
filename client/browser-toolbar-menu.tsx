/**
 * One anchored menu surface for workspace-panel toolbar controls. The public SDK
 * has no inline menu, so use its theme and public RN primitives without importing
 * host internals. Placement stays inside the pane, including compact clients.
 */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  browserMenuPlacement,
  browserMenuUsesBackNavigation,
  type MenuRect,
} from "./browser-menu-placement";
import { bindBrowserToolbarMenuWeb, focusBrowserMenuTrigger } from "./browser-toolbar-menu-web";
import { type BrowserSubmenu, BrowserToolbarSubmenu } from "./browser-toolbar-submenu";

type Theme = PluginHostProps["theme"];
const STYLES = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 100 },
  menu: { position: "absolute", borderWidth: 1, borderRadius: 8, overflow: "hidden", elevation: 8 },
  content: { paddingVertical: 4 },
  item: {
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  // The parent fills the row width. Text keeps its measured height, including scaled/wrapped lines.
  label: { fontSize: 13 },
  heading: {
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  separator: { borderBottomWidth: 1, marginVertical: 4 },
});

export interface BrowserToolbarMenuProps {
  theme: Theme;
  title: string;
  compact: boolean;
  paneRef: RefObject<View | null>;
  anchorRef: RefObject<View | null>;
  paneSize: { width: number; height: number };
  /** Initial estimate only. Measured content determines height, bounded by the pane. */
  preferredHeight?: number;
  onClose(): void;
  shouldRestoreFocus(): boolean;
  children: ReactNode;
  submenu?: BrowserSubmenu | undefined;
  onSubmenuOpen?(): void;
}

/** Measure after layout, reject obsolete callbacks, and re-anchor on pane resizing. */
export function BrowserToolbarMenu(props: BrowserToolbarMenuProps) {
  const compact = browserMenuUsesBackNavigation(props.paneSize.width, props.compact, Platform.OS);
  const previousSubmenu = useRef<BrowserSubmenu | undefined>(undefined);
  const [placement, setPlacement] = useState<MenuRect | null>(null);
  const [contentSize, setContentSize] = useState<{ page: string; height: number } | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const page = compact && props.submenu ? (props.submenu.pageKey ?? props.submenu.title) : "root";
  const bodyHeight = contentSize?.page === page ? contentSize.height : null;
  const visibleHeaderHeight = compact && props.submenu ? headerHeight : 0;
  const estimatedHeight = props.preferredHeight ?? props.paneSize.height;
  const desiredHeight =
    bodyHeight === null ? estimatedHeight : bodyHeight + visibleHeaderHeight + 2;
  const menuRef = useRef<View | null>(null);
  const overlayRef = useRef<View | null>(null);
  const current = useRef(props);
  current.current = props;
  useLayoutEffect(() => {
    let active = true;
    props.paneRef.current?.measureInWindow((paneX, paneY) => {
      if (!active) return;
      props.anchorRef.current?.measureInWindow((x, y, width, height) => {
        if (!active) return;
        setPlacement(
          browserMenuPlacement(
            props.paneSize,
            { x: x - paneX, y: y - paneY, width, height },
            desiredHeight,
          ),
        );
      });
    });
    return () => {
      active = false;
    };
  }, [
    props.paneRef,
    props.anchorRef,
    props.paneSize.width,
    props.paneSize.height,
    desiredHeight,
    compact,
    props.submenu?.preferredHeight,
  ]);
  const overflowing =
    placement !== null &&
    bodyHeight !== null &&
    bodyHeight + visibleHeaderHeight + 2 > placement.height + 1;
  const scrollHintHeight = overflowing ? 22 : 0;

  useEffect(() => {
    if (!placement) return;
    const dispose = bindBrowserToolbarMenuWeb(
      menuRef.current,
      props.anchorRef.current,
      () => current.current.onClose(),
      () => current.current.shouldRestoreFocus(),
      overlayRef.current,
      {
        openSubmenu: () => current.current.onSubmenuOpen?.(),
        ...(compact && props.submenu?.initialFocusLabel
          ? { initialFocusLabel: props.submenu.initialFocusLabel }
          : {}),
        ...(compact && props.submenu ? { back: () => current.current.submenu?.onBack() } : {}),
      },
    );
    if (compact && previousSubmenu.current && !props.submenu) {
      focusBrowserMenuTrigger(previousSubmenu.current.anchorRef.current);
    }
    previousSubmenu.current = props.submenu;
    return dispose;
  }, [
    Boolean(placement),
    props.anchorRef,
    compact,
    compact && Boolean(props.submenu),
    compact && props.submenu?.pageKey,
  ]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (current.current.submenu) current.current.submenu.onBack();
      else current.current.onClose();
      return true;
    });
    return () => subscription.remove();
  }, []);

  return (
    <View ref={overlayRef} style={STYLES.overlay} accessibilityViewIsModal>
      <Pressable
        accessible={false}
        focusable={false}
        accessibilityLabel={`Close ${props.title}`}
        style={StyleSheet.absoluteFillObject}
        onPress={props.onClose}
      />
      {placement ? (
        <View
          ref={menuRef}
          accessibilityRole="menu"
          accessibilityLabel={props.title}
          onAccessibilityEscape={compact && props.submenu ? props.submenu.onBack : props.onClose}
          style={[
            STYLES.menu,
            { overflow: "visible" },
            {
              left: placement.x,
              top: placement.y,
              width: placement.width,
              maxHeight: placement.height,
              borderColor: props.theme.colors.border,
              backgroundColor: props.theme.colors.surface1,
            },
          ]}
        >
          {compact && props.submenu ? (
            <View
              style={{ flexShrink: 0 }}
              onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
            >
              <BrowserMenuItem
                theme={props.theme}
                compact
                label="Back"
                icon="ChevronLeft"
                onPress={props.submenu.onBack}
              />
              <BrowserMenuHeading theme={props.theme}>{props.submenu.title}</BrowserMenuHeading>
            </View>
          ) : null}
          <ScrollView
            style={{
              maxHeight: Math.max(1, placement.height - visibleHeaderHeight - scrollHintHeight - 2),
              flexShrink: 1,
              borderRadius: 8,
            }}
            onContentSizeChange={(_width, height) => {
              setContentSize((previous) =>
                previous?.page === page && previous.height === height ? previous : { page, height },
              );
            }}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={STYLES.content}
          >
            {compact && props.submenu ? props.submenu.children : props.children}
          </ScrollView>
          {overflowing ? (
            <Text
              style={{
                height: scrollHintHeight,
                flexShrink: 0,
                fontSize: 11,
                textAlign: "center",
                color: props.theme.colors.foregroundMuted,
              }}
            >
              Scroll for more actions
            </Text>
          ) : null}
          {!compact && props.submenu ? (
            <BrowserToolbarSubmenu
              theme={props.theme}
              submenu={props.submenu}
              paneRef={props.paneRef}
              paneSize={props.paneSize}
              parent={placement}
              onClose={props.onClose}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Standard menu row; checked choices use an indicator instead of a raised action button. */
export function BrowserMenuItem({
  theme,
  compact,
  label,
  accessibilityLabel,
  detail,
  icon,
  selected,
  disabled = false,
  expanded,
  onPress,
}: {
  theme: Theme;
  compact: boolean;
  label: string;
  accessibilityLabel?: string;
  detail?: string;
  icon?: string;
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{
        disabled,
        ...(expanded === undefined ? {} : { expanded }),
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => [
        STYLES.item,
        {
          minHeight: compact ? 44 : 36,
          backgroundColor: hovered || focused ? theme.colors.surface2 : "transparent",
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
        },
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={theme.colors.foregroundMuted} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={[STYLES.label, { color: theme.colors.foreground }]}>{label}</Text>
        {detail ? (
          <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{detail}</Text>
        ) : null}
      </View>
      {expanded !== undefined ? (
        <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
      ) : null}
      {selected ? <Icon name="Check" size={16} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

/** Group labels and separators share the same themed menu chrome. */
export function BrowserMenuHeading({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <Text style={[STYLES.heading, { color: theme.colors.foregroundMuted }]}>{children}</Text>;
}

export function BrowserMenuSeparator({ theme }: { theme: Theme }) {
  return <View style={[STYLES.separator, { borderBottomColor: theme.colors.border }]} />;
}
