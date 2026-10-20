/** Bridge rendered viewer geometry and application visibility to the shared demand reporter. */
import { useEffect, useLayoutEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import {
  type BrowserDisplayDemandOptions,
  createBrowserDisplayDemandReporter,
  isSameDisplayDemandSource,
} from "./browser-display-demand";

interface ViewerDocument {
  hidden?: boolean;
  addEventListener?(type: "visibilitychange", listener: () => void): void;
  removeEventListener?(type: "visibilitychange", listener: () => void): void;
}
interface ViewerWindow {
  document?: ViewerDocument;
  addEventListener?(type: "pagehide" | "pageshow", listener: () => void): void;
  removeEventListener?(type: "pagehide" | "pageshow", listener: () => void): void;
}

/** Hidden clients retract demand immediately, while late results remain bound to their attachment. */
export function useBrowserDisplayDemand(options: BrowserDisplayDemandOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const reporter = useRef<ReturnType<typeof createBrowserDisplayDemandReporter> | null>(null);
  if (!reporter.current) reporter.current = createBrowserDisplayDemandReporter();
  const publish = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const expectedKey = JSON.stringify(options.expected);

  useEffect(() => {
    const instance = reporter.current!;
    const host = Platform.OS === "web" ? (globalThis as ViewerWindow) : null;
    let applicationActive = AppState.currentState == null || AppState.currentState === "active";
    let suspended = false;
    const visible = () => applicationActive && !suspended && !host?.document?.hidden;
    const update = () => {
      const snapshot = latest.current;
      instance.update({
        ...snapshot,
        active: snapshot.active && visible(),
        onState: (state) => {
          // A reply can settle between render and effect cleanup. Read the
          // current attachment synchronously, not just the reporter snapshot.
          const current = latest.current;
          if (
            mounted.current &&
            current.active &&
            visible() &&
            current.identity === snapshot.identity &&
            current.viewerToken === snapshot.viewerToken &&
            isSameDisplayDemandSource(current.expected, snapshot.expected)
          ) {
            current.onState(state);
          }
        },
      });
    };
    const hide = () => {
      suspended = true;
      update();
    };
    const show = () => {
      suspended = false;
      update();
    };
    publish.current = update;
    const subscription = AppState.addEventListener("change", (state) => {
      applicationActive = state === "active";
      update();
    });
    host?.document?.addEventListener?.("visibilitychange", update);
    host?.addEventListener?.("pagehide", hide);
    host?.addEventListener?.("pageshow", show);
    update();
    return () => {
      publish.current = null;
      subscription.remove();
      host?.document?.removeEventListener?.("visibilitychange", update);
      host?.removeEventListener?.("pagehide", hide);
      host?.removeEventListener?.("pageshow", show);
      instance.stop();
    };
  }, []);
  useLayoutEffect(() => {
    publish.current?.();
  }, [
    options.identity,
    options.viewerToken,
    options.active,
    expectedKey,
    options.display?.width,
    options.display?.height,
  ]);
}
