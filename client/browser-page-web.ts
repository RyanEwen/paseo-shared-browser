/**
 * Web-only page signals for the panel: display scale and page visibility. Every export returns
 * null on native platforms, which use React Native's own scale and AppState instead. Keeping these
 * globals here preserves the rule that only `*-web.ts` modules touch browser APIs.
 */
import { Platform } from "react-native";
import type { BrowserDisplayScaleSource } from "./browser-display-scale";

interface PageDocument {
  hidden?: boolean;
  addEventListener?(type: "visibilitychange", listener: () => void): void;
  removeEventListener?(type: "visibilitychange", listener: () => void): void;
}
interface PageWindow {
  document?: PageDocument;
  addEventListener?(type: "pagehide" | "pageshow", listener: () => void): void;
  removeEventListener?(type: "pagehide" | "pageshow", listener: () => void): void;
}

/** The page's display-scale source on web, or null on native platforms. */
export function webDisplayScaleSource(): BrowserDisplayScaleSource | null {
  return Platform.OS === "web" ? (globalThis as BrowserDisplayScaleSource) : null;
}

/** Listeners for page visibility changes and bfcache hide/show transitions. */
export interface PageVisibilityListeners {
  visibilityChanged(): void;
  hidden(): void;
  shown(): void;
}

/**
 * Observe page visibility on web.
 *
 * @returns `isHidden` reads the document's current visibility; `stop` removes every listener.
 * Null on native platforms.
 */
export function observeWebPageVisibility(
  listeners: PageVisibilityListeners,
): { isHidden(): boolean; stop(): void } | null {
  if (Platform.OS !== "web") return null;
  const page = globalThis as PageWindow;
  page.document?.addEventListener?.("visibilitychange", listeners.visibilityChanged);
  page.addEventListener?.("pagehide", listeners.hidden);
  page.addEventListener?.("pageshow", listeners.shown);
  return {
    isHidden: () => page.document?.hidden === true,
    stop: () => {
      page.document?.removeEventListener?.("visibilitychange", listeners.visibilityChanged);
      page.removeEventListener?.("pagehide", listeners.hidden);
      page.removeEventListener?.("pageshow", listeners.shown);
    },
  };
}
