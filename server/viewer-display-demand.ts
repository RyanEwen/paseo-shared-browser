/** Bounded visible-viewer demand lifetime, independent of capture/status heartbeats. */
import {
  DISPLAY_DEMAND_TTL_MS,
  type DisplayPixelSize,
  densityForDisplayDemands,
} from "../shared/browser-display-demand";
import type { CaptureDensity } from "../shared/capture-density";

interface Options {
  now(): number;
  viewport(): DisplayPixelSize;
  density(): number;
  current(): boolean;
  viewerCurrent(token: string): boolean;
  /** Runs under the session queue. False defers an active gesture or changed target. */
  apply(density: CaptureDensity): Promise<boolean>;
  failed(): void;
}

/** Own at most sixteen authenticated viewer reports and one coalescing/expiry timer.
 * Failure pauses the same target instead of retrying a broken runtime indefinitely.
 * A new aggregate target or a new session can attempt again. No controller is acquired. */
export function createViewerDisplayDemand(options: Options) {
  const reports = new Map<string, { display: DisplayPixelSize; expiresAt: number }>();
  let managed = false,
    disposed = false,
    running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failedTarget: CaptureDensity | null = null;
  let scheduledAt = Infinity;
  const prune = () => {
    for (const [token, report] of reports)
      if (report.expiresAt <= options.now() || !options.viewerCurrent(token)) reports.delete(token);
  };
  const targetFor = (viewport: DisplayPixelSize): CaptureDensity | null => {
    prune();
    return managed
      ? densityForDisplayDemands(
          viewport,
          [...reports.values()].map((r) => r.display),
        )
      : null;
  };
  const target = () => targetFor(options.viewport());
  const schedule = (delay = 250) => {
    if (disposed || running) return;
    const due = options.now() + delay;
    if (timer !== null && scheduledAt <= due) return;
    if (timer !== null) clearTimeout(timer);
    scheduledAt = due;
    timer = setTimeout(() => {
      timer = null;
      scheduledAt = Infinity;
      void reconcile();
    }, delay);
    timer.unref?.();
  };
  const reconcile = async () => {
    if (disposed || running) return;
    if (!options.current()) {
      dispose();
      return;
    }
    running = true;
    let deferred = false;
    try {
      const wanted = target();
      if (wanted !== failedTarget) failedTarget = null;
      if (wanted !== null && wanted !== options.density() && wanted !== failedTarget) {
        try {
          deferred = !(await options.apply(wanted));
        } catch {
          failedTarget = wanted;
          options.failed();
        }
      }
    } finally {
      running = false;
      if (!disposed) {
        // Once the last viewer leaves and detail has settled, agent-only sessions
        // regain their explicit density policy instead of retaining hidden ownership.
        prune();
        if (!reports.size && options.density() === 1) managed = false;
        const remaining = target();
        if (
          deferred ||
          (remaining !== null && remaining !== options.density() && failedTarget === null)
        )
          schedule();
        else if (reports.size) {
          const nextExpiry = Math.min(...[...reports.values()].map((r) => r.expiresAt));
          schedule(Math.max(1, nextExpiry - options.now()));
        }
      }
    }
  };
  const dispose = () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    reports.clear();
  };
  return {
    report(token: string, display: DisplayPixelSize | null) {
      if (disposed) return;
      prune();
      if (display) {
        if (!reports.has(token) && reports.size >= 16)
          throw new Error("Display viewer limit reached");
        managed = true;
        reports.set(token, {
          display: { ...display },
          expiresAt: options.now() + DISPLAY_DEMAND_TTL_MS,
        });
      } else reports.delete(token);
      schedule();
    },
    remove(token: string) {
      if (reports.delete(token)) schedule();
    },
    refresh: () => schedule(),
    target,
    targetFor,
    dispose,
  };
}
export type ViewerDisplayDemand = ReturnType<typeof createViewerDisplayDemand>;
