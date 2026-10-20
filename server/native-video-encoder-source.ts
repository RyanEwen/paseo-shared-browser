/** Trusted WebCodecs lifecycle and bounded stall recovery for individual cohorts. */
export const NATIVE_ENCODER_OUTPUT_DEADLINE_MS = 1_000;
export const NATIVE_ENCODER_MAX_STALL_RECOVERIES = 3;

export const NATIVE_VIDEO_ENCODER_SOURCE = `
/** A replaced or removed codec can never publish through its old callbacks. */
function nativeEncoderIsCurrent(quality, state, incarnation) {
  return capture && !capture.stopped && encoders.get(quality) === state && !state.failed &&
    state.encoderIncarnation === incarnation;
}
/** Invalidate callbacks before closing, then fail only this encoder cohort. */
function failNativeEncoder(state, error = "Native video encoder stopped") {
  if (state.failed) return;
  state.failed = true;
  state.encoderIncarnation = null;
  try { state.encoder?.close(); } catch {}
  state.frameGenerations.clear();
  state.pending.clear();
  nativeVideoPacket(JSON.stringify({ error, streamId: state.streamId }));
  wakeNativeFrame();
}
/** Replace one codec without changing its stream sequence or other cohorts.
 * Keep ACK pressure for already-published pictures; cancel only old codec work. */
function replaceNativeEncoder(quality, state) {
  const incarnation = {};
  state.encoderIncarnation = incarnation;
  try { state.encoder?.close(); } catch {}
  state.encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (!nativeEncoderIsCurrent(quality, state, incarnation)) return;
      const submitted = state.frameGenerations.get(chunk.timestamp);
      const generation = submitted?.generation;
      state.frameGenerations.delete(chunk.timestamp);
      wakeNativeFrame();
      if (!submitted) {
        state.forceKey = true;
        state.needsKey = true;
        return;
      }
      // Retiring a document does not retire the codec. Old output releases its
      // native slot but cannot publish or disturb a newer generation's key state.
      if (generation !== capture.generation) return;
      if (chunk.byteLength > 2097152) {
        failNativeEncoder(state, "Native video quality exceeds its packet bound");
        return;
      }
      if (state.pending.size >= 2) {
        state.forceKey = true;
        state.needsKey = true;
        return;
      }
      if (state.needsKey && chunk.type !== "key") return;
      if (chunk.type === "key") state.needsKey = false;
      state.stallRecoveries = 0;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      const sequence = ++state.sequence;
      state.pending.add(sequence);
      const description = metadata.decoderConfig && metadata.decoderConfig.description;
      nativeVideoPacket(
        JSON.stringify({
          streamId: state.streamId,
          captureGeneration: generation,
          sequence,
          timestampUs: chunk.timestamp,
          type: chunk.type,
          codec: state.codec,
          width: capture.width,
          height: capture.height,
          ...(description ? { descriptionBase64: bytes64(new Uint8Array(description)) } : {}),
          dataBase64: bytes64(bytes),
        }),
      );
    },
    error: () => {
      if (nativeEncoderIsCurrent(quality, state, incarnation)) failNativeEncoder(state);
    },
  });
  state.encoder.configure(state.configuration);
}
/** Real-time codecs may drop submitted frames without an output callback.
 * Never free a timestamp slot and keep admitting work to that same codec. Once
 * its oldest unmatched work expires, close that incarnation before clearing its
 * accounting. Fresh source pictures and existing two-slot pressure still apply. */
function recoverStalledNativeEncoder(quality, state, now) {
  const expired = [...state.frameGenerations.values()].some(
    frame => now - frame.submittedAt >= ${NATIVE_ENCODER_OUTPUT_DEADLINE_MS}
  );
  if (!expired) return true;
  if (state.stallRecoveries >= ${NATIVE_ENCODER_MAX_STALL_RECOVERIES}) {
    failNativeEncoder(state, "Native video encoder recovery exhausted");
    return false;
  }
  state.stallRecoveries += 1;
  state.forceKey = true;
  state.needsKey = true;
  state.framesSinceKey = 0;
  state.activeFrames = 0;
  try {
    replaceNativeEncoder(quality, state);
    state.frameGenerations.clear();
    return !state.failed;
  } catch {
    failNativeEncoder(state);
    return false;
  }
}
`;
