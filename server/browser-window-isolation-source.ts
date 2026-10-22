/** Trusted extension program: keep existing content tabs visible without selecting or recreating them. */
export const BROWSER_WINDOW_ISOLATION_SOURCE = `
globalThis.sharedBrowserWindows = new class {
  dirty = true;
  tail = Promise.resolve();
  identities = new Map();

  constructor() {
    const changed = () => {
      this.dirty = true;
      if (typeof sharedBrowserWindowDirty === 'function') sharedBrowserWindowDirty('changed');
      // Event work is best-effort; every explicit observation/input admission awaits
      // this same queue and receives failures instead of using an unisolated target.
      void this.settle().catch(() => {});
    };
    chrome.tabs.onCreated.addListener(changed);
    chrome.tabs.onAttached.addListener(changed);
    chrome.tabs.onRemoved.addListener(changed);
    chrome.tabs.onReplaced.addListener(changed);
    chrome.tabs.onUpdated.addListener((_tabId, change) => {
      if (change.status || change.url) changed();
    });
  }

  /** Native preview UI and our hidden helper pages are never independent content tabs. */
  eligible(target) {
    if (target.type !== 'page' || !Number.isInteger(target.tabId)) return false;
    try {
      const url = new URL(target.url);
      if (url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id) return false;
      if (url.protocol === 'chrome:' && url.hostname === 'print') return false;
      if (url.protocol === 'chrome-untrusted:' && url.hostname === 'print') return false;
      return true;
    } catch { return false; }
  }

  /** Serialize startup, tab events and exact-target callers; a failed pass remains dirty. */
  settle(targetId) {
    const operation = this.tail.then(async () => {
      try {
        // Explicit creation can precede both the event and debugger tabId metadata.
        // Wait only for readiness; never repeat the target/window creation command.
        const deadline = performance.now() + 1500;
        if (targetId && !this.identities.has(targetId)) this.dirty = true;
        for (let pass = 0; this.dirty; pass++) {
          if (pass === 8) throw new Error('Native browser windows did not settle');
          this.dirty = false;
          await this.reconcile();
        }
        while (targetId && !this.identities.has(targetId) && performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
          await this.reconcile();
        }
        if (!targetId) return {targetIds:[...this.identities.keys()]};
        const identity = this.identities.get(targetId);
        if (!identity) throw new Error('Exact browser window target is unavailable');
        return {...identity, targetIds:[...this.identities.keys()]};
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  /** Move surplus tabs by exact debugger identity, retaining document, opener and window.name. */
  async reconcile() {
    const targets = (await chrome.debugger.getTargets()).filter(target => this.eligible(target));
    const tabs = await chrome.tabs.query({});
    const identities = new Map();
    const occupied = new Set();
    for (const target of targets) {
      const matches = targets.filter(candidate => candidate.tabId === target.tabId);
      const tab = tabs.find(candidate => candidate.id === target.tabId);
      if (matches.length !== 1 || !tab) continue;
      let windowId = tab.windowId;
      if (occupied.has(windowId)) {
        // Moving a live tab does not navigate it. focused:false never activates a
        // participant's native window; all windows belong to our invisible display.
        const created = await chrome.windows.create({tabId:tab.id, focused:false});
        const moved = await chrome.tabs.get(tab.id);
        if (!created || moved.windowId !== created.id) throw new Error('Browser window move was not confirmed');
        windowId = moved.windowId;
      }
      if (occupied.has(windowId)) throw new Error('Browser tabs still share a native window');
      occupied.add(windowId);
      identities.set(target.id, {targetId:target.id, tabId:tab.id, windowId});
    }
    this.identities = identities;
  }
};
`;
