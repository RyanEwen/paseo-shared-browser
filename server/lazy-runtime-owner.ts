import { randomUUID } from "node:crypto";
import { CdpUnknownOutcomeError } from "./cdp";
import { EMPTY_WORKSPACE_OPERATIONS, NO_PAGE_OPEN_MESSAGE } from "./empty-workspace";
import {
  isJsonObject,
  type JsonValue,
  jsonObjectOrEmpty,
  RuntimeLostError,
  RuntimeProtocolError,
} from "./runtime-protocol";
import type { RuntimeInstance, RuntimeOwner } from "./supervisor";

const PAGE_CREATING_OPERATIONS: ReadonlySet<string> = new Set(["tabs.open", "tabs.create"]);

interface StartedRuntime<Runtime extends RuntimeInstance> {
  owner: RuntimeOwner<Runtime>;
  runtime: Runtime;
}

/**
 * A launch that failed and could not confirm its own cleanup. The process owner attaches
 * `retryCleanup` so the reservation can retry it instead of refusing replacement forever.
 */
interface UnconfirmedCleanup extends AggregateError {
  retryCleanup?: () => Promise<void>;
}

interface LazyRuntime<Runtime extends RuntimeInstance> extends RuntimeInstance {
  workspaceId: string;
  started: StartedRuntime<Runtime> | null;
  failure: boolean;
  cleanupFailure: UnconfirmedCleanup | null;
  stopped: boolean;
  /** Serializes first-page requests so concurrent openers produce one launch. */
  opening: Promise<void>;
}

/**
 * Launches the native browser for one workspace at a blank page. `beforeLaunch` must be
 * invoked immediately before native publication and throws when the opener lost authority.
 */
export type LazyRuntimeLauncher<Runtime extends RuntimeInstance> = (
  workspaceId: string,
  beforeLaunch: () => void,
) => Promise<StartedRuntime<Runtime>>;

export interface LazyRuntimeOwnerOptions {
  /**
   * Maximum concurrently running browsers. Reservations are cheap and are bounded separately by
   * the supervisor; this bounds actual Chromium processes, checked before each launch.
   */
  maxStarted?: number;
}

/** Raised before any native work when the running-browser limit is reached. */
class BrowserLimitReachedError extends RuntimeProtocolError {
  constructor(limit: number) {
    super(
      "RUNTIME_FAILURE",
      `Shared browser limit (${limit}) reached; close another workspace browser first`,
    );
  }
}

/** Running-browser slots shared by every reservation of one owner. */
interface BrowserSlots {
  /** Take a slot before any native work, or throw `BrowserLimitReachedError`. */
  claim(holder: object): void;
  /** Return a slot; releasing a holder without one is a no-op. */
  release(holder: object): void;
}

function createBrowserSlots(limit: number): BrowserSlots {
  const holders = new Set<object>();
  return {
    claim(holder) {
      if (holders.has(holder)) return;
      if (holders.size >= limit) throw new BrowserLimitReachedError(limit);
      holders.add(holder);
    },
    release(holder) {
      holders.delete(holder);
    },
  };
}

/** Matches the supervisor's historical per-host browser limit. */
const DEFAULT_MAX_STARTED = 8;

/** The outcome of one attempt to start the native browser for a reservation. */
type LaunchOutcome =
  | { kind: "started" }
  | { kind: "refused"; error: unknown }
  | { kind: "failed"; error: unknown };

/**
 * Reserve a workspace identity without creating Chromium, a display, a profile or a page.
 * Only explicit page creation launches, always at `about:blank`; a requested URL is then
 * navigated as an ordinary page operation, so an unreachable or slow site leaves a usable page
 * with a normal navigation error instead of a lost workspace. A failed launch is never retried
 * implicitly.
 */
export function createLazyRuntimeOwner<Runtime extends RuntimeInstance>(
  launch: LazyRuntimeLauncher<Runtime>,
  options: LazyRuntimeOwnerOptions = {},
): RuntimeOwner<LazyRuntime<Runtime>> {
  const slots = createBrowserSlots(options.maxStarted ?? DEFAULT_MAX_STARTED);

  return {
    async create(workspaceId) {
      return {
        workspaceId,
        runtimeId: randomUUID(),
        started: null,
        failure: false,
        cleanupFailure: null,
        stopped: false,
        opening: Promise.resolve(),
      };
    },

    async request(reservation, operation, input, beforeMutation) {
      assertAvailable(reservation);
      if (PAGE_CREATING_OPERATIONS.has(operation))
        return openPage(reservation, launch, slots, operation, input, beforeMutation);
      if (reservation.started)
        return reservation.started.owner.request(
          reservation.started.runtime,
          operation,
          input,
          beforeMutation,
        );
      return emptyReply(operation);
    },

    async stop(reservation) {
      reservation.stopped = true;
      await reservation.opening;
      await retryUnconfirmedCleanup(reservation);
      if (reservation.started) await reservation.started.owner.stop(reservation.started.runtime);
      slots.release(reservation);
    },
  };
}

/** Refuse every request once the reservation was stopped or its launch failed. */
function assertAvailable(reservation: LazyRuntime<RuntimeInstance>): void {
  if (reservation.stopped || reservation.failure)
    throw new RuntimeLostError("Workspace browser is no longer available; reconnect explicitly");
}

/**
 * Create a page, launching the browser first when none is running. Requests are serialized on
 * the reservation so two concurrent first pages produce one launch and two ordinary pages.
 */
async function openPage<Runtime extends RuntimeInstance>(
  reservation: LazyRuntime<Runtime>,
  launch: LazyRuntimeLauncher<Runtime>,
  slots: BrowserSlots,
  operation: string,
  input: JsonValue,
  beforeMutation: (() => void) | undefined,
): Promise<JsonValue> {
  const previous = reservation.opening;
  const completed = Promise.withResolvers<void>();
  reservation.opening = completed.promise;
  try {
    await previous;
    assertAvailable(reservation);
    beforeMutation?.();

    // Later pages share the running browser exactly like any other tab.
    if (reservation.started)
      return await reservation.started.owner.request(
        reservation.started.runtime,
        operation,
        input,
        beforeMutation,
      );

    // Claimed synchronously so concurrent first pages in other workspaces cannot overshoot.
    slots.claim(reservation);
    const outcome = await launchReservation(reservation, launch, beforeMutation);
    if (outcome.kind !== "started") slots.release(reservation);
    if (outcome.kind === "refused") throw outcome.error;
    if (outcome.kind === "failed") {
      const reason = outcome.error instanceof Error ? outcome.error.message : "unknown failure";
      throw new RuntimeLostError(
        `Browser startup failed; reconnect explicitly before retrying: ${reason}`,
      );
    }
    return await confirmFirstPage(reservation, requestedUrl(operation, input), beforeMutation);
  } finally {
    completed.resolve();
  }
}

/** The destination of a first page request, or null for an explicit blank tab. */
function requestedUrl(operation: string, input: JsonValue): string | null {
  if (operation !== "tabs.open") return null;
  return String(jsonObjectOrEmpty(input).url);
}

/**
 * Start the native browser. A refusal raised by the opener's own fence leaves the reservation
 * reusable; any other failure marks it lost, keeping unconfirmed cleanup for `stop()` to retry.
 */
async function launchReservation<Runtime extends RuntimeInstance>(
  reservation: LazyRuntime<Runtime>,
  launch: LazyRuntimeLauncher<Runtime>,
  beforeMutation: (() => void) | undefined,
): Promise<LaunchOutcome> {
  let refusal: unknown;
  const beforeLaunch = () => {
    try {
      if (reservation.stopped) throw new Error("Workspace browser stopped before launch");
      beforeMutation?.();
    } catch (error) {
      refusal = error;
      throw error;
    }
  };
  try {
    reservation.started = await launch(reservation.workspaceId, beforeLaunch);
    return { kind: "started" };
  } catch (error) {
    if (refusal !== undefined && error === refusal) return { kind: "refused", error };
    reservation.failure = true;
    if (error instanceof AggregateError) reservation.cleanupFailure = error;
    return { kind: "failed", error };
  }
}

/**
 * Publish the launch page and, for a URL request, navigate it. The page exists from here on,
 * so a lost fence becomes an unknown outcome (never replayed). A navigation failure is returned
 * with the page so the caller still moves its viewer there and reports the failure normally.
 */
async function confirmFirstPage<Runtime extends RuntimeInstance>(
  reservation: LazyRuntime<Runtime>,
  url: string | null,
  beforeMutation: (() => void) | undefined,
): Promise<JsonValue> {
  const started = reservation.started!;
  let targetId: string;
  try {
    beforeMutation?.();
    const identity = await started.owner.request(started.runtime, "identity", null);
    beforeMutation?.();
    if (reservation.stopped) throw new Error("Workspace browser stopped during startup");
    const value = isJsonObject(identity) ? identity.targetId : null;
    if (typeof value !== "string") throw new Error("First page identity unavailable");
    targetId = value;
  } catch {
    throw new CdpUnknownOutcomeError(
      "First browser page was created, but publication could not be confirmed; inspect tabs before another action",
    );
  }
  if (url === null) return { targetId };

  try {
    await started.owner.request(started.runtime, "navigate", { url, targetId }, beforeMutation);
    return { targetId };
  } catch (error) {
    // A timed-out navigation may still commit; keep that distinct from a definite failure.
    const message = error instanceof Error ? error.message : "Navigation failed";
    return {
      targetId,
      navigationError: message,
      navigationUnknown: error instanceof CdpUnknownOutcomeError,
    };
  }
}

/** Replies for observation of a workspace that has never opened a page. */
function emptyReply(operation: string): JsonValue {
  if (operation === "identity") return { empty: true, userAgent: "Chromium" };
  if (operation === "state")
    return { empty: true, url: "", title: "", canGoBack: false, canGoForward: false };
  if (operation === "tabs.list") return [];
  if (operation === "emulate" || EMPTY_WORKSPACE_OPERATIONS.has(operation)) return null;
  throw new Error(NO_PAGE_OPEN_MESSAGE);
}

/**
 * Retry cleanup of a launch whose failure could not confirm that Chromium and its display
 * stopped. Replacement stays refused only while the retry itself still fails.
 */
async function retryUnconfirmedCleanup(reservation: LazyRuntime<RuntimeInstance>): Promise<void> {
  const failure = reservation.cleanupFailure;
  if (!failure) return;
  try {
    if (!failure.retryCleanup) throw failure;
    await failure.retryCleanup();
    reservation.cleanupFailure = null;
  } catch {
    throw new RuntimeLostError("Browser startup cleanup is unconfirmed; replacement is refused");
  }
}
