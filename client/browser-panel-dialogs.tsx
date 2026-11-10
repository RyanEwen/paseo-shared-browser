import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type { MutableRefObject } from "react";
import { View } from "react-native";
import type { BrowserState } from "../shared/browser";
import { CanvasPlaceholder, ControlButton, ErrorNotice } from "./browser-chrome";
import { BrowserControlDialog } from "./browser-control-dialog";
import type { ControlRequest } from "./browser-control-request";
import { BrowserDialogBody, BrowserDialogPrimaryButton } from "./browser-dialog-body";
import { closeBrowserConfirmLabel } from "./browser-panel-presentation";
import type { createStyles } from "./browser-panel-styles";
import type { ControlledActions } from "./use-browser-controlled-actions";
import type { BrowserTabCloseConfirmation } from "./use-browser-tabs";

type Styles = ReturnType<typeof createStyles>;
type Theme = PluginWorkspacePanelProps["theme"];

/** Everything the panel's confirmation dialogs render and call. */
export interface BrowserPanelDialogsProps {
  styles: Styles;
  theme: Theme;
  state: BrowserState | null;
  viewerToken: string | null;
  tabCloseConfirmation: BrowserTabCloseConfirmation | null;
  setTabCloseConfirmation(confirmation: BrowserTabCloseConfirmation | null): void;
  tabMutationPending: boolean;
  closeTabLabel: string;
  confirmCloseSelectedTab(): Promise<void>;
  closeConfirmationOpen: boolean;
  setCloseConfirmationOpen(open: boolean): void;
  restartForGraphics: boolean;
  setRestartForGraphics(restart: boolean): void;
  closePending: boolean;
  controlRequest: ControlRequest | null;
  setControlRequest(request: ControlRequest | null): void;
  controlRequestPending: boolean;
  confirmControlRequest(): Promise<void>;
  requestControlled(label: string, run: () => void): void;
  controlledActionsRef: MutableRefObject<ControlledActions | null>;
}

/**
 * The panel's confirmations: closing a tab (or the final tab and browser), closing or
 * restarting the browser for everyone, and acquiring control before a queued action.
 */
export function BrowserPanelDialogs({
  styles,
  theme,
  state,
  viewerToken,
  tabCloseConfirmation,
  setTabCloseConfirmation,
  tabMutationPending,
  closeTabLabel,
  confirmCloseSelectedTab,
  closeConfirmationOpen,
  setCloseConfirmationOpen,
  restartForGraphics,
  setRestartForGraphics,
  closePending,
  controlRequest,
  setControlRequest,
  controlRequestPending,
  confirmControlRequest,
  requestControlled,
  controlledActionsRef,
}: BrowserPanelDialogsProps) {
  return (
    <>
      <Modal
        title={
          tabCloseConfirmation?.scope === "last-tab"
            ? "Close final tab and browser?"
            : "Close browser tab?"
        }
        icon={<Icon name="X" size={18} color={theme.colors.statusDanger} />}
        open={tabCloseConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !tabMutationPending) setTabCloseConfirmation(null);
        }}
      >
        <Modal.Content>
          <BrowserDialogBody
            styles={styles}
            actions={
              <>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Cancel"
                  disabled={tabMutationPending}
                  onPress={() => setTabCloseConfirmation(null)}
                />
                <BrowserDialogPrimaryButton
                  open={tabCloseConfirmation !== null}
                  styles={styles}
                  theme={theme}
                  label={closeTabLabel}
                  danger
                  disabled={!viewerToken || tabMutationPending}
                  onPress={() =>
                    tabCloseConfirmation?.scope === "last-tab"
                      ? requestControlled("close the browser", () =>
                          controlledActionsRef.current?.confirmCloseTab(),
                        )
                      : void confirmCloseSelectedTab()
                  }
                />
              </>
            }
          >
            {tabCloseConfirmation?.scope === "last-tab"
              ? "Closing the final tab closes the browser for every viewer and agent in this workspace. Unsaved page changes are lost. Saved site data is kept for an explicit reopen. Other workspaces stay open."
              : "This removes the tab for everyone viewing it, including agents. Unsaved page changes are lost. Other tabs stay open."}
          </BrowserDialogBody>
        </Modal.Content>
      </Modal>
      <Modal
        title={restartForGraphics ? "Apply graphics and restart browser?" : "Close shared browser?"}
        icon={<Icon name="X" size={18} color={theme.colors.statusDanger} />}
        open={closeConfirmationOpen}
        onOpenChange={(open) => {
          if (!closePending) {
            setCloseConfirmationOpen(open);
            if (!open) setRestartForGraphics(false);
          }
        }}
      >
        <Modal.Content>
          <BrowserDialogBody
            styles={styles}
            actions={
              <>
                <ControlButton
                  styles={styles}
                  theme={theme}
                  label="Cancel"
                  disabled={closePending}
                  onPress={() => {
                    setCloseConfirmationOpen(false);
                    setRestartForGraphics(false);
                  }}
                />
                <BrowserDialogPrimaryButton
                  open={closeConfirmationOpen}
                  styles={styles}
                  theme={theme}
                  label={closeBrowserConfirmLabel(restartForGraphics, closePending)}
                  disabled={!viewerToken || closePending}
                  onPress={() =>
                    requestControlled(
                      restartForGraphics
                        ? "restart the shared browser"
                        : "close the shared browser",
                      () => controlledActionsRef.current?.confirmCloseBrowser(),
                    )
                  }
                />
              </>
            }
          >
            {restartForGraphics
              ? "This restarts the browser for every viewer and agent in this workspace. All tabs close and unsaved page changes are lost. Saved site data is kept. Other workspaces stay open."
              : "This closes the browser for every viewer and agent in this workspace. Unsaved page changes are lost. Saved site data is kept for an explicit reopen. Other workspaces stay open."}
          </BrowserDialogBody>
        </Modal.Content>
      </Modal>
      <BrowserControlDialog
        styles={styles}
        theme={theme}
        state={state}
        request={controlRequest}
        pending={controlRequestPending}
        available={Boolean(viewerToken)}
        onCancel={() => setControlRequest(null)}
        onConfirm={() => void confirmControlRequest()}
      />
    </>
  );
}

/**
 * The panel after its browser closed for everyone: an explicit reopen, and any notice from a
 * failed reopen.
 */
export function BrowserClosedView({
  styles,
  theme,
  panelScope,
  reopenPending,
  reopenClosedBrowser,
  operationError,
  operationNoticeId,
  dismissOperationError,
}: {
  styles: Styles;
  theme: Theme;
  panelScope: string;
  reopenPending: boolean;
  reopenClosedBrowser(): Promise<void>;
  operationError: string | null;
  operationNoticeId: unknown;
  dismissOperationError(): void;
}) {
  return (
    <View style={styles.screen}>
      <CanvasPlaceholder
        styles={styles}
        theme={theme}
        title="Shared browser closed"
        detail="The browser was closed for everyone. Its saved site data is available when you reopen it."
      >
        <ControlButton
          styles={styles}
          theme={theme}
          label={reopenPending ? "Opening…" : "Open shared browser"}
          icon="PanelsTopLeft"
          primary
          large
          disabled={reopenPending}
          onPress={() => void reopenClosedBrowser()}
        />
      </CanvasPlaceholder>
      {operationError ? (
        <ErrorNotice
          noticeScope={panelScope}
          styles={styles}
          theme={theme}
          message={operationError}
          noticeId={operationNoticeId}
          onDismiss={dismissOperationError}
        />
      ) : null}
    </View>
  );
}
