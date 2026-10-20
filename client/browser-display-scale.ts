/** Local display-scale observation; never changes the emulated page or browser input. */
interface ResolutionQuery {
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}
export interface BrowserDisplayScaleSource {
  devicePixelRatio?: number;
  matchMedia?(query: string): ResolutionQuery;
  addEventListener?(type: "resize", listener: () => void): void;
  removeEventListener?(type: "resize", listener: () => void): void;
  visualViewport?: {
    scale?: number;
    addEventListener?(type: "resize", listener: () => void): void;
    removeEventListener?(type: "resize", listener: () => void): void;
  };
}

/** Prefer the live browser scale and local zoom; native/unsupported hosts use their RN scale. */
export function readBrowserDisplayScale(
  fallback: number,
  source: BrowserDisplayScaleSource = globalThis as BrowserDisplayScaleSource,
): number {
  const deviceScale = positiveScale(source.devicePixelRatio) ?? positiveScale(fallback) ?? 1;
  const localZoom = positiveScale(source.visualViewport?.scale) ?? 1;
  return deviceScale * localZoom;
}

/** Return valid scale measurements only; unavailable metrics must not create speculative demand. */
function positiveScale(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Monitor changes can alter DPR without a resize. Rearm the resolution query
 * after each change, and release every local listener when the viewer unmounts.
 */
export function observeBrowserDisplayScale(
  fallback: number,
  changed: (scale: number) => void,
  source: BrowserDisplayScaleSource = globalThis as BrowserDisplayScaleSource,
): () => void {
  let query: ResolutionQuery | undefined;
  let queryScale: number | null = null;
  let stopped = false;
  const update = () => {
    if (stopped) return;
    const nextScale = positiveScale(source.devicePixelRatio) ?? positiveScale(fallback) ?? 1;
    if (nextScale !== queryScale) {
      query?.removeEventListener?.("change", update);
      queryScale = nextScale;
      query = source.matchMedia?.(`(resolution: ${nextScale}dppx)`);
      query?.addEventListener?.("change", update);
    }
    changed(readBrowserDisplayScale(fallback, source));
  };

  source.addEventListener?.("resize", update);
  source.visualViewport?.addEventListener?.("resize", update);
  update();
  return () => {
    stopped = true;
    query?.removeEventListener?.("change", update);
    source.removeEventListener?.("resize", update);
    source.visualViewport?.removeEventListener?.("resize", update);
  };
}
