/** Admission and idle budgets selected only by the host's trusted viewer route. */
export interface BrowserViewerPolicy {
  readonly kind: "human" | "agent";
  readonly frameTtlMs: number;
  readonly controlLeaseMs: number;
  readonly viewerTtlMs: number;
}

export const HUMAN_VIEWER_POLICY: BrowserViewerPolicy = Object.freeze({
  kind: "human",
  frameTtlMs: 5_000,
  controlLeaseMs: 30_000,
  viewerTtlMs: 45_000,
});

// A reasoning pause does not need background browser traffic to retain agent access.
// Human takeover and every identity/context fence still revoke agent authority immediately.
export const AGENT_VIEWER_POLICY: BrowserViewerPolicy = Object.freeze({
  kind: "agent",
  frameTtlMs: 60_000,
  controlLeaseMs: 300_000,
  viewerTtlMs: 300_000,
});
