/** Error presentation shared by the browser panel's actions. */

/**
 * The message a panel notice shows for a failed request. An expired-frame admission refusal
 * becomes plain guidance, because that action was never sent.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    if (
      !hasUnknownMutationOutcome(error) &&
      /^(?:Request failed: )?Browser frame is stale \(stage=admission; reason=expired; ageMs=\d+\)(?: requestType=plugin\.rpc\.invoke\.request code=handler_error)?$/.test(
        error.message,
      )
    ) {
      return "The view expired before this action could start. The action was not sent. Wait for the view to refresh, then try again.";
    }
    return error.message;
  }
  return "The shared browser request failed.";
}

/**
 * Whether a failure happened after the request may have been dispatched, so its mutation
 * outcome is unknown and must be observed rather than replayed.
 */
export function hasUnknownMutationOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name : "";
  if (code === "unknown_outcome") return true;
  if (
    code === "transport_closed_after_dispatch" ||
    code === "transport_lost_after_dispatch" ||
    code === "rpc_timeout" ||
    name === "RpcTimeoutError" ||
    name === "TransportLostAfterDispatchError"
  ) {
    return true;
  }
  const dispatched = record.dispatched === true || record.requestDispatched === true;
  return dispatched && /(transport|connection|timeout)/.test(code || name.toLowerCase());
}
