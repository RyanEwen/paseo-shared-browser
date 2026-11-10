import { useCallback, useRef, useState } from "react";
import type { BrowserState } from "../shared/browser";

/** A request to open the native keyboard or a compose draft, owned by one control identity. */
export interface BrowserComposeRequest {
  id: number;
  kind: "keyboard" | "compose" | "commit";
  ownershipKey: string;
}

/** What opening the keyboard or compose controls needs. */
export interface BrowserComposeRequestOptions {
  viewerToken: string | null;
  controlToken: string | null;
  state: BrowserState | null;
  canSendInput: boolean;
  closeToolbarMenu(restoreFocus?: boolean): void;
}

/**
 * Requests to open the native keyboard or the compose draft. Each request carries the control
 * and page identity it was made under, so the controls refuse it after that identity changes.
 * Holds no effects.
 */
export function useBrowserComposeRequest({
  viewerToken,
  controlToken,
  state,
  canSendInput,
  closeToolbarMenu,
}: BrowserComposeRequestOptions) {
  const [composeRequest, setComposeRequest] = useState<BrowserComposeRequest | null>(null);
  const nextComposeRequest = useRef(0);

  const composeOwnershipKey = JSON.stringify([
    viewerToken,
    controlToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  const composeDocumentKey = JSON.stringify([
    viewerToken,
    state?.sessionId,
    state?.runtimeId,
    state?.bridgeEpoch,
    state?.navigationGeneration,
    state?.viewportGeneration,
  ]);
  const requestCompose = (kind: "keyboard" | "compose" | "commit") => {
    if (!canSendInput) return;
    nextComposeRequest.current += 1;
    closeToolbarMenu(false);
    setComposeRequest({ id: nextComposeRequest.current, kind, ownershipKey: composeOwnershipKey });
  };
  const composeRequestHandled = useCallback((id: number) => {
    setComposeRequest((current) => (current?.id === id ? null : current));
  }, []);

  return {
    composeRequest,
    composeOwnershipKey,
    composeDocumentKey,
    requestCompose,
    composeRequestHandled,
  };
}
