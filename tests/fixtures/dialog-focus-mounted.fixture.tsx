/** Render real production controls; only the host Modal presentation is adapted. */

import { ControlButton } from "../../client/browser-control-button";
import { BrowserControlDialog } from "../../client/browser-control-dialog";
import { BrowserDialogBody, BrowserDialogPrimaryButton } from "../../client/browser-dialog-body";
import { Modal } from "./dialog-focus-modal.fixture";

const styles = {} as Parameters<typeof BrowserControlDialog>[0]["styles"];
const theme = { colors: {} } as Parameters<typeof BrowserControlDialog>[0]["theme"];

export { Modal as HostScopeFixture };
export function Fixture({
  open,
  disabled,
  takeover,
  close,
  mounted = true,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  disabled: boolean;
  takeover: boolean;
  close: boolean;
  mounted?: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  if (!mounted) return null;
  if (!close) {
    return (
      <BrowserControlDialog
        styles={styles}
        theme={theme}
        state={
          { controller: takeover ? "other" : "none" } as Parameters<
            typeof BrowserControlDialog
          >[0]["state"]
        }
        request={
          open
            ? ({ label: "continue" } as Parameters<typeof BrowserControlDialog>[0]["request"])
            : null
        }
        available
        pending={disabled}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    );
  }
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value) onCancel();
      }}
    >
      <BrowserDialogBody
        styles={styles}
        actions={
          <>
            <ControlButton styles={styles} theme={theme} label="Cancel" onPress={onCancel} />
            <BrowserDialogPrimaryButton
              open={open}
              styles={styles}
              theme={theme}
              label="Close browser"
              disabled={disabled}
              onPress={onConfirm}
            />
          </>
        }
      >
        Close browser fixture
      </BrowserDialogBody>
    </Modal>
  );
}
