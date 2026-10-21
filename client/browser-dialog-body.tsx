/** Shared confirmation layout for short Shared Browser dialogs. */
import { type ReactNode, useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { ControlButton, type ControlButtonProps } from "./browser-control-button";
import type { createStyles } from "./browser-panel-styles";

/** Focus the enabled confirmation once per opening, after the host registers its focus scope. */
export function BrowserDialogPrimaryButton({
  open,
  ...props
}: Omit<ControlButtonProps, "ref"> & { open: boolean }) {
  const buttonRef = useRef<unknown>(null);
  const focusedThisOpening = useRef(false);

  useEffect(() => {
    if (!open) {
      focusedThisOpening.current = false;
      return;
    }
    if (props.disabled || focusedThisOpening.current) return;

    const button = buttonRef.current;
    if (
      button &&
      typeof button === "object" &&
      "focus" in button &&
      typeof button.focus === "function"
    ) {
      // Let the host retain Escape, Tab containment and restoration. Native refs without focus are inert.
      button.focus();
      focusedThisOpening.current = true;
    }
  }, [open, props.disabled]);

  return <ControlButton {...props} ref={buttonRef} />;
}

/** Keep confirmation copy and actions aligned within the host modal's own inset. */
export function BrowserDialogBody({
  styles,
  children,
  actions,
}: {
  styles: ReturnType<typeof createStyles>;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <View style={styles.dialogBody}>
      <Text style={styles.dialogMessage}>{children}</Text>
      <View style={styles.dialogActions}>{actions}</View>
    </View>
  );
}
