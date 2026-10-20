/** Single-flight physical-display reporting, independent of browser control and input authority. */
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type browserDisplayDemandRpc,
  DISPLAY_DEMAND_HEARTBEAT_MS,
  displayPixelSizeSchema,
} from "../shared/browser-display-demand";

type Request = RpcInput<typeof browserDisplayDemandRpc>;
type Response = RpcOutput<typeof browserDisplayDemandRpc>;
export type BrowserDisplayDemandExpected = Request["expected"];
export interface BrowserDisplayDemandOptions {
  /** Host/workspace/viewer attachment identity; deliberately excludes control ownership. */
  identity: string;
  viewerToken: string | null;
  expected: BrowserDisplayDemandExpected | null;
  display: Request["display"];
  active: boolean;
  report(input: Request): Promise<Response>;
  onState(state: Response["state"]): void;
}
interface PendingClear {
  identity: string;
  input: Request;
  report: BrowserDisplayDemandOptions["report"];
}
const COALESCE_MS = 250;

/** Convert only the painted image's logical dimensions, excluding letterboxing and pane chrome. */
export function physicalBrowserDisplaySize(
  image: { width: number; height: number } | null,
  scale: number,
): Request["display"] {
  if (!image || !Number.isFinite(scale) || scale <= 0) return null;
  const result = displayPixelSizeSchema.safeParse({
    width: image.width * scale,
    height: image.height * scale,
  });
  return result.success ? result.data : null;
}

/** Reject late results across any source fence, including a runtime replacement under the same viewer. */
export function isSameDisplayDemandSource(
  left: BrowserDisplayDemandExpected | null,
  right: BrowserDisplayDemandExpected | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.sessionId === right.sessionId &&
      left.runtimeId === right.runtimeId &&
      left.bridgeEpoch === right.bridgeEpoch &&
      left.navigationGeneration === right.navigationGeneration &&
      left.viewportGeneration === right.viewportGeneration,
  );
}

/** Build a scoped report only when this viewer has committed browser identity. */
function requestFor(options: BrowserDisplayDemandOptions, clear = false): Request | null {
  if (!options.viewerToken || !options.expected) return null;
  return {
    viewerToken: options.viewerToken,
    expected: { ...options.expected },
    display: clear || !options.active || !options.display ? null : { ...options.display },
  };
}

/**
 * Coalesce measurement changes and renew active reports every five seconds. Retired
 * reports are cleared after their in-flight write settles, so cleanup cannot be
 * overtaken by a late measurement. stop() is restartable for React effect replay.
 */
export function createBrowserDisplayDemandReporter() {
  let current: BrowserDisplayDemandOptions | null = null;
  let fingerprint: string | null = null;
  let incarnation = 0;
  let stopped = false;
  let inFlight = false;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const clears: PendingClear[] = [];

  const cancelTimers = () => {
    if (timer !== null) clearTimeout(timer);
    if (heartbeat !== null) clearInterval(heartbeat);
    timer = null;
    heartbeat = null;
  };
  const clearDemand = (options: BrowserDisplayDemandOptions) => {
    const input = requestFor(options, true);
    if (!input) return;
    const previous = clears.findIndex(
      (entry) =>
        entry.identity === options.identity && entry.input.viewerToken === input.viewerToken,
    );
    if (previous >= 0) clears.splice(previous, 1);
    clears.push({ identity: options.identity, input, report: options.report });
  };

  /** Publish one request at a time, prioritizing retired-viewer cleanup over new demand. */
  const flush = async (): Promise<void> => {
    if (inFlight) return;
    const clear = clears.shift();
    const options = current;
    if (!clear && (stopped || !ready || !options)) return;
    const input = clear?.input ?? (options ? requestFor(options) : null);
    if (!input) return;
    const report = clear?.report ?? options!.report;
    const sentIncarnation = incarnation;
    const sentIdentity = options?.identity;
    if (!clear) ready = false;
    inFlight = true;
    try {
      const result = await report(input);
      if (
        !clear &&
        !stopped &&
        current?.active &&
        incarnation === sentIncarnation &&
        current.identity === sentIdentity &&
        current.viewerToken === input.viewerToken &&
        isSameDisplayDemandSource(current.expected, input.expected)
      ) {
        // accepted:false carries fresh state too. Commit it normally; a changed
        // source schedules the next report, without a retry loop or control prompt.
        if (!result.accepted) ready = false;
        current.onState(result.state);
      }
    } catch {
      // Measurement is best-effort. The normal heartbeat renews measured demand;
      // capture/viewer recovery remains owned by the existing viewer lifecycle.
    } finally {
      inFlight = false;
      if (clears.length || ready) void flush();
    }
  };

  return {
    /** Update render facts without publishing unstable geometry or acquiring control. */
    update(options: BrowserDisplayDemandOptions): void {
      const request = requestFor(options);
      const measured = request !== null && request.display !== null;
      const previous = current;
      const identityChanged =
        previous !== null &&
        (previous.identity !== options.identity || previous.viewerToken !== options.viewerToken);
      const lostMeasurement = previous?.active && previous.display !== null && !measured;
      if (identityChanged || lostMeasurement) clearDemand(previous!);
      if (stopped || identityChanged) incarnation += 1;
      stopped = false;
      current = options;

      const nextFingerprint = JSON.stringify([options.identity, request]);
      if (nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      cancelTimers();
      ready = false;
      if (!measured) {
        if (!lostMeasurement && !identityChanged) clearDemand(options);
        void flush();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        ready = true;
        void flush();
      }, COALESCE_MS);
      heartbeat = setInterval(() => {
        ready = true;
        void flush();
      }, DISPLAY_DEMAND_HEARTBEAT_MS);
      // A replacement viewer must not keep its predecessor's demand alive.
      if (clears.length) void flush();
    },
    /** Stop renewal and clear the last attachment after any published request finishes. */
    stop(): void {
      cancelTimers();
      stopped = true;
      incarnation += 1;
      ready = false;
      fingerprint = null;
      if (current) clearDemand(current);
      current = null;
      void flush();
    },
  };
}
