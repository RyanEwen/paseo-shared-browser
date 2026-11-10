import { useRpc } from "@getpaseo/plugin/client";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  createBrowserTabRpc,
  detachBrowserRpc,
  endBrowserGestureRpc,
  listBrowserTabsRpc,
  navigateBrowserRpc,
  printBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  updateBrowserGestureRpc,
} from "../shared/browser";
import { browserDisplayDemandRpc } from "../shared/browser-display-demand";
import { browserMediaCapabilitiesRpc } from "../shared/browser-media";

/** Every Shared Browser RPC the workspace panel calls, bound to the current plugin surface. */
export type BrowserRpcClients = ReturnType<typeof useBrowserRpcClients>;

/**
 * Bind the panel's RPC clients once per render. `useRpc` only reads the plugin context, so this
 * hook has no effects and its position among the panel's hooks does not matter.
 */
export function useBrowserRpcClients() {
  return {
    attachBrowser: useRpc(attachBrowserRpc),
    detachBrowser: useRpc(detachBrowserRpc),
    captureBrowser: useRpc(captureBrowserRpc),
    closeBrowser: useRpc(closeBrowserRpc),
    closeTab: useRpc(closeBrowserTabRpc),
    createTab: useRpc(createBrowserTabRpc),
    listTabs: useRpc(listBrowserTabsRpc),
    reopenBrowser: useRpc(reopenBrowserRpc),
    acquireControl: useRpc(acquireControlRpc),
    releaseControl: useRpc(releaseControlRpc),
    navigateBrowser: useRpc(navigateBrowserRpc),
    printBrowser: useRpc(printBrowserRpc),
    resizeBrowser: useRpc(resizeBrowserRpc),
    reportDisplayDemand: useRpc(browserDisplayDemandRpc),
    applyDevicePreset: useRpc(applyDevicePresetRpc),
    sendBrowserInput: useRpc(sendBrowserInputRpc),
    beginBrowserGesture: useRpc(beginBrowserGestureRpc),
    updateBrowserGesture: useRpc(updateBrowserGestureRpc),
    endBrowserGesture: useRpc(endBrowserGestureRpc),
    readMediaCapabilities: useRpc(browserMediaCapabilitiesRpc),
  };
}
