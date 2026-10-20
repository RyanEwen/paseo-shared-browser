/** One owned, newest unencoded picture, independent of the two native codec slots. */
export const NATIVE_VIDEO_FRAME_RETENTION_MS = 250;

export const NATIVE_VIDEO_FRAME_SOURCE = `
/** Release retained pixels and cancel their wake before source/document retirement. */
function clearNativeFrame(source) {
  clearTimeout(source.frameTimer);
  source.frameTimer = null;
  const entry = source.latestFrame;
  source.latestFrame = null;
  entry?.frame.close();
}
/** Coalesce output/ACK/timer wakes. Submission itself is synchronous and cannot overlap. */
function wakeNativeFrame(source = capture, delay = 0) {
  if (!source || source !== capture || source.stopped || !source.latestFrame) return;
  const deadline = performance.now() + Math.max(0, delay);
  if (source.frameTimer !== null && source.frameWakeAt <= deadline) return;
  clearTimeout(source.frameTimer);
  source.frameWakeAt = deadline;
  source.frameTimer = setTimeout(() => {
    source.frameTimer = null;
    drainNativeFrame(source);
  }, Math.max(0, delay));
}
/** Transfer ownership only after source validation/correction, retaining original provenance. */
function offerNativeFrame(source, frame, generation, receivedAt) {
  clearNativeFrame(source);
  source.latestFrame = { frame, generation, receivedAt };
  drainNativeFrame(source);
}
/** Submit eligible cohorts once, or retain the newest picture until pacing/capacity permits.
 * Retention is capped from the original raw read, including asynchronous colour work.
 * Downstream calibrated source-clock admission remains the final freshness authority.
 * The timer neither renews source age nor evicts outstanding native work. */
function drainNativeFrame(source) {
  const entry = source.latestFrame;
  if (!entry) return;
  const now = performance.now();
  const remaining = ${NATIVE_VIDEO_FRAME_RETENTION_MS} - (now - entry.receivedAt);
  if (source !== capture || source.stopped || entry.generation !== source.generation ||
      entry.frame.timestamp < source.minimumTimestampUs || remaining <= 0) {
    clearNativeFrame(source);
    return;
  }
  let needed = false;
  let wakeAfter = remaining;
  for (const [quality, state] of encoders) {
    if (state.failed || now - state.lastRequestedAt > 2000 ||
        entry.frame.timestamp <= state.lastEncodedTimestampUs) continue;
    if (!recoverStalledNativeEncoder(quality, state, now)) continue;
    needed = true;
    if (state.pending.size + state.frameGenerations.size >= 2 ||
        state.encoder.encodeQueueSize >= 2) continue;
    const intervalMs = 1000 / state.configuration.framerate;
    const elapsedUs = entry.frame.timestamp - state.lastEncodedTimestampUs;
    const sourceReady = elapsedUs >= intervalMs * 1000 - 1;
    const pacingReady = now >= state.nextEncodeAt;
    if (!state.forceKey && (!sourceReady || state.deferredPacing) && !pacingReady) {
      wakeAfter = Math.min(wakeAfter, state.nextEncodeAt - now);
      continue;
    }
    // A deferred final frame has no future source timestamp to advance its FPS
    // test. Its monotonic deadline admits it once. Start the next deadline at
    // this actual submission, preventing catch-up credits and an immediate burst.
    state.deferredPacing = !sourceReady || (state.deferredPacing && !pacingReady);
    state.nextEncodeAt = now + intervalMs;
    state.lastEncodedTimestampUs = entry.frame.timestamp;
    state.frameGenerations.set(entry.frame.timestamp, {
      generation: entry.generation,
      submittedAt: now,
    });
    // Preserve settled idle text. This counts sustained admitted intervals,
    // not pixel motion. Explicit join/boundary/loss demand still forces a key.
    const activeThreshold = Math.ceil(state.configuration.framerate / 4);
    state.activeFrames = elapsedUs <= 250000
      ? Math.min(activeThreshold, state.activeFrames + 1) : 0;
    const periodicKey = state.framesSinceKey >= state.configuration.framerate &&
      state.activeFrames >= activeThreshold;
    const keyFrame = state.forceKey || periodicKey;
    try {
      state.encoder.encode(entry.frame, { keyFrame });
    } catch {
      failNativeEncoder(state);
      continue;
    }
    state.framesSinceKey = keyFrame ? 1 : state.framesSinceKey + 1;
    state.forceKey = false;
  }
  // Re-evaluate after synchronous fixture/native callbacks and per-cohort submission.
  needed = needed && [...encoders.values()].some(state => !state.failed &&
    now - state.lastRequestedAt <= 2000 &&
    entry.frame.timestamp > state.lastEncodedTimestampUs);
  if (!needed) clearNativeFrame(source);
  else wakeNativeFrame(source, Math.max(1, wakeAfter));
}
`;
