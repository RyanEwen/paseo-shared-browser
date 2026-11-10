import type { BrowserState } from "../shared/browser";
import { type JsonValue, RuntimeProtocolError, requireJsonObject } from "./runtime-protocol";

/**
 * Validation helpers shared by the supervisor's browser and agent request handlers. Every
 * refusal is an `INVALID_REQUEST` or `RUNTIME_FAILURE` protocol error so callers see the same
 * codes whichever handler received the request.
 */

/** Require a request's input to be a JSON object. */
export function asObject(value: JsonValue): Record<string, JsonValue> {
  return requireJsonObject(
    value,
    () => new RuntimeProtocolError("INVALID_REQUEST", "Browser input must be an object"),
  );
}

/** Read a required non-empty string field from a request's input. */
export function requireText(value: Record<string, JsonValue>, key: string): string {
  const text = value[key];
  if (typeof text !== "string" || text.length === 0)
    throw new RuntimeProtocolError("INVALID_REQUEST", `${key} must be a non-empty string`);
  return text;
}

/** Read the browser state every policy result carries. */
export function stateFromPolicyResult(result: unknown): BrowserState {
  if (!result || typeof result !== "object" || !("state" in result))
    throw new RuntimeProtocolError("RUNTIME_FAILURE", "Browser policy returned no state");
  return result.state as BrowserState;
}
