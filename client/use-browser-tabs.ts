import { type QueryClient, useQuery } from "@tanstack/react-query";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { BrowserState, BrowserTabCloseScope } from "../shared/browser";
import { type ControlRequestBasis, controlRequestBasis } from "./browser-control-request";
import { errorMessage } from "./browser-panel-errors";
import type { BrowserRpcClients } from "./use-browser-rpc-clients";

/** A pending tab-close confirmation, bound to the exact page and runtime it was opened for. */
export interface BrowserTabCloseConfirmation {
  basis: ControlRequestBasis;
  runtimeId: string;
  scope: BrowserTabCloseScope;
}

/** The panel's tab selection and tab/browser close state. */
export type BrowserTabState = ReturnType<typeof useBrowserTabState>;

/**
 * This panel's tab selection and the pending state of its tab and browser close flows. Holds
 * no effects; workspace and tab changes reset it from `useBrowserAttachment`.
 */
export function useBrowserTabState() {
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const selectedTabIdRef = useRef(selectedTabId);
  selectedTabIdRef.current = selectedTabId;
  const [tabMutationPending, setTabMutationPending] = useState(false);
  // A workspace switch retires this receipt. An old completion cannot clear
  // a newer workspace's pending operation, including a switch away and back.
  const tabMutationRequestRef = useRef<object | null>(null);
  const [tabCloseConfirmation, setTabCloseConfirmation] =
    useState<BrowserTabCloseConfirmation | null>(null);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [restartForGraphics, setRestartForGraphics] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [reopenPending, setReopenPending] = useState(false);

  return {
    selectedTabId,
    setSelectedTabId,
    selectedTabIdRef,
    tabMutationPending,
    setTabMutationPending,
    tabMutationRequestRef,
    tabCloseConfirmation,
    setTabCloseConfirmation,
    closeConfirmationOpen,
    setCloseConfirmationOpen,
    restartForGraphics,
    setRestartForGraphics,
    closePending,
    setClosePending,
    reopenPending,
    setReopenPending,
  };
}

/** The query key of one workspace's tab list on one host. */
export function browserTabsQueryKey(hostId: string, workspaceId: string) {
  return ["shared-browser", "tabs", hostId, workspaceId];
}

/**
 * Poll the workspace's tab list while this panel views it, and move the selection to the first
 * remaining tab when the selected one disappears.
 */
export function useBrowserTabList({
  hostId,
  workspaceId,
  viewerToken,
  active,
  listTabs,
  selectedTabId,
  setSelectedTabId,
  stateRef,
}: {
  hostId: string;
  workspaceId: string;
  viewerToken: string | null;
  active: boolean;
  listTabs: BrowserRpcClients["listTabs"];
  selectedTabId: string | null;
  setSelectedTabId(tabId: string | null): void;
  stateRef: MutableRefObject<BrowserState | null>;
}) {
  const tabsQueryKey = browserTabsQueryKey(hostId, workspaceId);
  const tabsQuery = useQuery({
    queryKey: tabsQueryKey,
    queryFn: () => listTabs({ viewerToken: viewerToken! }),
    enabled: Boolean(viewerToken) && active,
    refetchInterval: 2_000,
  });

  useEffect(() => {
    const tabs = tabsQuery.data?.tabs;
    const selected = selectedTabId ?? stateRef.current?.tabId;
    if (!tabs || !selected || tabs.some((tab) => tab.id === selected)) return;
    setSelectedTabId(tabs[0]?.id ?? null);
  }, [selectedTabId, tabsQuery.data]);

  return { tabsQuery, tabsQueryKey };
}

/** What the tab and browser close flows need from the rest of the panel. */
export interface BrowserTabActionsOptions {
  tabs: BrowserTabState;
  tabsQuery: ReturnType<typeof useBrowserTabList>["tabsQuery"];
  tabsQueryKey: readonly unknown[];
  queryClient: QueryClient;
  rpc: Pick<BrowserRpcClients, "createTab" | "closeTab" | "closeBrowser" | "reopenBrowser">;
  workspaceId: string;
  panelScope: string;
  panelScopeRef: MutableRefObject<string>;
  mountedRef: MutableRefObject<boolean>;
  activeViewerTokenRef: MutableRefObject<string | null>;
  stateRef: MutableRefObject<BrowserState | null>;
  controllerObservationRevision: MutableRefObject<number>;
  controlToken: string | null;
  controlledActionsRef: MutableRefObject<{ closeTab(): void } | null>;
  setOperationError(message: string | null): void;
  /** Revoke this panel's viewer, page and media and show the closed view. */
  dropBrowserView(): void;
  setBrowserClosed(closed: boolean): void;
  reconnect(): void;
  /** Ask for control before running an action that needs it. */
  requestControlled(label: string, run: () => void): void;
  requestIsCurrent(basis: ControlRequestBasis, checkController?: boolean): boolean;
}

/**
 * Tab creation and the tab, browser and reopen flows. Every completion is fenced on the panel
 * scope, viewer and request that started it, so a late reply never acts on another workspace
 * or selection. Holds no effects.
 */
export function useBrowserTabActions({
  tabs,
  tabsQuery,
  tabsQueryKey,
  queryClient,
  rpc,
  workspaceId,
  panelScope,
  panelScopeRef,
  mountedRef,
  activeViewerTokenRef,
  stateRef,
  controllerObservationRevision,
  controlToken,
  controlledActionsRef,
  setOperationError,
  dropBrowserView,
  setBrowserClosed,
  reconnect,
  requestControlled,
  requestIsCurrent,
}: BrowserTabActionsOptions) {
  const { createTab, closeTab, closeBrowser, reopenBrowser } = rpc;
  const {
    selectedTabId,
    setSelectedTabId,
    selectedTabIdRef,
    tabMutationPending,
    setTabMutationPending,
    tabMutationRequestRef,
    tabCloseConfirmation,
    setTabCloseConfirmation,
    setCloseConfirmationOpen,
    restartForGraphics,
    setRestartForGraphics,
    closePending,
    setClosePending,
    reopenPending,
    setReopenPending,
  } = tabs;

  /** Add a page to the shared profile and select it only for this panel. */
  const createBrowserTab = async () => {
    const viewerToken = activeViewerTokenRef.current;
    if (!viewerToken || tabMutationPending || tabMutationRequestRef.current) return;
    const request = {};
    tabMutationRequestRef.current = request;
    setTabMutationPending(true);
    setOperationError(null);
    try {
      const created = await createTab({ viewerToken });
      // A pre-creation list can otherwise undo selection through the missing-tab
      // fallback. Cancel its receipt and include the confirmed blank page first.
      await queryClient.cancelQueries({ queryKey: tabsQueryKey, exact: true });
      if (
        !mountedRef.current ||
        tabMutationRequestRef.current !== request ||
        panelScopeRef.current !== panelScope ||
        activeViewerTokenRef.current !== viewerToken
      ) {
        return;
      }
      queryClient.setQueryData<Awaited<ReturnType<BrowserRpcClients["listTabs"]>>>(
        tabsQueryKey,
        (previous) => {
          if (previous?.tabs.some((tab) => tab.id === created.tabId)) return previous;
          return {
            tabs: [
              ...(previous?.tabs ?? []),
              {
                id: created.tabId,
                title: "",
                url: "about:blank",
                viewerCount: 0,
                controllerLabel: null,
              },
            ],
          };
        },
      );
      setSelectedTabId(created.tabId);
      void tabsQuery.refetch();
    } catch (error) {
      if (tabMutationRequestRef.current === request) setOperationError(errorMessage(error));
    } finally {
      if (tabMutationRequestRef.current === request) {
        tabMutationRequestRef.current = null;
        setTabMutationPending(false);
      }
    }
  };

  /** Drop this panel's media after either confirmed path stops its workspace browser. */
  const acceptBrowserClosed = () => {
    dropBrowserView();
    setSelectedTabId(null);
    setTabCloseConfirmation(null);
    setCloseConfirmationOpen(false);
    setRestartForGraphics(false);
  };

  /** Bind the confirmation to the observed page and to its tab-only or final-tab effect. */
  const requestCloseSelectedTab = () => {
    const current = stateRef.current;
    const viewer = activeViewerTokenRef.current;
    const tabs = tabsQuery.data?.tabs;
    if (!current?.runtimeId || !viewer || !current.tabId || !tabs) return;
    if (!tabs.some((tab) => tab.id === current.tabId)) return;
    if (tabs.length === 1 && (!controlToken || current.controller !== "self")) {
      requestControlled("close the browser", () => controlledActionsRef.current?.closeTab());
      return;
    }
    setTabCloseConfirmation({
      basis: controlRequestBasis(
        panelScope,
        viewer,
        current,
        controllerObservationRevision.current,
      ),
      runtimeId: current.runtimeId,
      scope: tabs.length === 1 ? "last-tab" : "tab",
    });
  };

  /** Never upgrade a tab-only confirmation if it becomes the final page while the dialog is open. */
  const confirmCloseSelectedTab = async () => {
    const confirmation = tabCloseConfirmation;
    if (
      !confirmation ||
      (confirmation.scope === "last-tab" && !controlToken) ||
      tabMutationPending ||
      tabMutationRequestRef.current
    )
      return;
    if (!requestIsCurrent(confirmation.basis, confirmation.scope === "last-tab")) {
      setTabCloseConfirmation(null);
      setOperationError("The browser changed. Select Close tab again.");
      return;
    }
    const { basis, runtimeId, scope } = confirmation;
    const tabId = basis.tabId!;
    const request = {};
    tabMutationRequestRef.current = request;
    setTabMutationPending(true);
    setOperationError(null);
    try {
      const result = await closeTab({
        viewerToken: basis.viewerToken,
        ...(controlToken ? { controlToken } : {}),
        tabId,
        sessionId: basis.sessionId,
        runtimeId,
        scope,
      });
      if (
        tabMutationRequestRef.current !== request ||
        panelScopeRef.current !== basis.panelScope ||
        selectedTabIdRef.current !== selectedTabId ||
        activeViewerTokenRef.current !== basis.viewerToken ||
        stateRef.current?.runtimeId !== runtimeId
      )
        return;
      setTabCloseConfirmation(null);
      if (result.browserClosed) {
        acceptBrowserClosed();
        return;
      }
      const fallback = tabsQuery.data?.tabs.find((tab) => tab.id !== tabId);
      setSelectedTabId(fallback?.id ?? null);
      void tabsQuery.refetch();
    } catch (error) {
      if (tabMutationRequestRef.current === request) {
        setTabCloseConfirmation(null);
        setOperationError(errorMessage(error));
        void tabsQuery.refetch();
      }
    } finally {
      if (tabMutationRequestRef.current === request) {
        tabMutationRequestRef.current = null;
        setTabMutationPending(false);
      }
    }
  };

  /** Confirmed close ends every viewer's runtime and immediately drops this panel's media. */
  const confirmCloseBrowser = async () => {
    const current = stateRef.current;
    const viewerToken = activeViewerTokenRef.current;
    if (!current?.runtimeId || !viewerToken || !controlToken || closePending) return;
    const shouldReopen = restartForGraphics;
    setClosePending(true);
    setOperationError(null);
    try {
      await closeBrowser({
        viewerToken,
        controlToken,
        sessionId: current.sessionId,
        runtimeId: current.runtimeId,
      });
      if (panelScopeRef.current !== panelScope) return;
      acceptBrowserClosed();
      if (shouldReopen) {
        await reopenBrowser({ workspaceId });
        if (panelScopeRef.current !== panelScope) return;
        setBrowserClosed(false);
        reconnect();
      }
    } catch (error) {
      if (panelScopeRef.current === panelScope) setOperationError(errorMessage(error));
    } finally {
      if (panelScopeRef.current === panelScope) setClosePending(false);
    }
  };

  /** Explicit user action is the only way to clear the server's closed fence. */
  const reopenClosedBrowser = async () => {
    if (reopenPending) return;
    setReopenPending(true);
    setOperationError(null);
    try {
      await reopenBrowser({ workspaceId });
      if (panelScopeRef.current !== panelScope) return;
      setBrowserClosed(false);
      reconnect();
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setReopenPending(false);
    }
  };

  return {
    createBrowserTab,
    requestCloseSelectedTab,
    confirmCloseSelectedTab,
    confirmCloseBrowser,
    reopenClosedBrowser,
  };
}
