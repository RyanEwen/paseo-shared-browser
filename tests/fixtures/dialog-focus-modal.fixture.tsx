/** Modal lifecycle adapter only. Uses the actual host focus scope, not a focus mock. */
import { useWebOverlayRegistration } from "fixture-host-overlay";
import type { ReactNode, RefCallback } from "react";

export { TextInput } from "react-native";

export const Icon = () => null;
export function Modal({
  open,
  children,
  onOpenChange,
}: {
  open: boolean;
  children: ReactNode;
  onOpenChange(open: boolean): void;
}) {
  const scope = useWebOverlayRegistration({
    active: open,
    layer: 20,
    onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onOpenChange(false);
      return true;
    },
  });
  // Keep descendants attached while closed to exercise the host's retained exit window.
  return (
    <div role="dialog" tabIndex={-1} ref={scope as RefCallback<HTMLDivElement>}>
      {children}
    </div>
  );
}
Modal.Content = ({ children }: { children: ReactNode }) => children;
