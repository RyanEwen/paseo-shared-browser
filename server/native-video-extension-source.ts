/**
 * Trusted extension-page program. It captures one exact tab, never reads site DOM,
 * and shares a bounded native track among at most three independent encoders.
 * Binding acknowledgements limit outstanding packets; a dropped output forces a
 * new keyframe before another delta can be forwarded.
 */

import { VIDEO_BITRATES, VIDEO_FRAME_RATES } from "../shared/video-settings";
import { NATIVE_PYROWAVE_EXTENSION_SOURCE } from "./native-pyrowave-extension-source";
import { NATIVE_VIDEO_COLOR_SOURCE } from "./native-video-color-source";
import { NATIVE_VIDEO_ENCODER_SOURCE } from "./native-video-encoder-source";
import { NATIVE_VIDEO_FRAME_SOURCE } from "./native-video-frame-source";

export const NATIVE_VIDEO_EXTENSION_SOURCE = `${NATIVE_VIDEO_COLOR_SOURCE}
${NATIVE_PYROWAVE_EXTENSION_SOURCE}
${NATIVE_VIDEO_ENCODER_SOURCE}
${NATIVE_VIDEO_FRAME_SOURCE}
let capture = null;
const encoders = new Map();
const pendingEncoders = new Map();
const bytes64 = (bytes) => {
  // Native byte conversion avoids constructing/copying a large binary string.
  // Retain the bounded legacy path for browsers without the newer byte API.
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(result);
};
/** Revoke the source, codecs and pending allocations before awaiting reader cleanup. */
async function stopCapture() {
  const previous = capture;
  capture = null;
  pendingEncoders.clear();
  stopRawEncoders();
  if (!previous) return;
  previous.stopped = true;
  clearNativeFrame(previous);
  for (const encoder of encoders.values()) {
    try {
      encoder.encoder.close();
    } catch {}
  }
  encoders.clear();
  for (const track of previous.stream.getTracks()) track.stop();
  await previous.reader.cancel().catch(() => {});
  await previous.loop.catch(() => {});
}
/** Preserve requested geometry across Chromium's even-aligned YUV capture.
 * Only the known one-pixel rounding is resampled by VideoEncoder. Other source
 * changes remain failures; cloning retains the source timestamp and lifetime.
 */
function frameForViewport(frame, width, height) {
  if (frame.displayWidth === width && frame.displayHeight === height) return frame;
  if (
    !["I420", "NV12"].includes(frame.format) ||
    frame.displayWidth !== (width & ~1) ||
    frame.displayHeight !== (height & ~1)
  ) return null;
  return new VideoFrame(frame, { displayWidth: width, displayHeight: height });
}
/** Start one exact tab at physical pixel dimensions; generation fences previously queued frames. */
async function startCapture(targetId, width, height, generation, softwareColorCorrection = false) {
  await stopCapture();
  let stream;
  try {
    const targets = await chrome.debugger.getTargets();
    const matched = targets.filter(
      (target) =>
        target.id === targetId && target.type === "page" && Number.isInteger(target.tabId),
    );
    if (matched.length !== 1) throw new Error("Exact capture target is unavailable");
    const sourceId = await chrome.tabCapture.getMediaStreamId({ targetTabId: matched[0].tabId });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: sourceId,
          maxWidth: width,
          maxHeight: height,
          minFrameRate: 1,
          maxFrameRate: 60,
        },
      },
    });
    const track = stream.getVideoTracks()[0];
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    const current = {
      stream,
      reader,
      width,
      height,
      generation,
      minimumTimestampUs: -Infinity,
      stopped: false,
      latestFrame: null,
      frameTimer: null,
      frameWakeAt: 0,
      loop: null,
    };
    capture = current;
    current.loop = (async () => {
      try {
        while (capture === current && !current.stopped) {
          const { value: frame, done } = await reader.read();
          if (done) {
            if (capture === current && !current.stopped)
              nativeVideoPacket(JSON.stringify({ error: "Native video capture stopped" }));
            break;
          }
          const generation = current.generation;
          const receivedAt = performance.now();
          let encodingFrame = null;
          let transferredSourceFrame = false;
          try {
            if (capture !== current || current.stopped) break;
            if (frame.timestamp < current.minimumTimestampUs) continue;
            // New raw input supersedes any retained older picture, including
            // while software colour correction awaits its bounded plane copy.
            clearNativeFrame(current);
            encodingFrame = frameForViewport(frame, width, height);
            if (!encodingFrame) {
              // Only native YUV even-alignment is correctable. Keep unexpected
              // source geometry terminal without changing viewport or density.
              nativeVideoPacket(
                JSON.stringify({
                  error: "Native video dimensions changed",
                  reasonCode: "source-dimensions",
                }),
              );
              break;
            }
            // Raw capture owns a clone and its sole plane copy. It can preserve
            // corrected colour metadata without WebCodecs' reconstruction copy.
            encodeRawFrame(current, encodingFrame, softwareColorCorrection);
            if (encoders.size === 0) continue;
            const corrected = await correctSoftwareCaptureColor(encodingFrame, softwareColorCorrection);
            if (corrected !== encodingFrame) {
              if (encodingFrame !== frame) encodingFrame.close();
              encodingFrame = corrected;
            }
            // A source can retire during the bounded plane copy. Never publish
            // its late frame to either codec after cancellation or document reset.
            if (capture !== current || current.stopped || current.generation !== generation ||
                frame.timestamp < current.minimumTimestampUs) continue;
            transferredSourceFrame = encodingFrame === frame;
            offerNativeFrame(current, encodingFrame, generation, receivedAt);
            encodingFrame = null;

          } finally {
            if (encodingFrame && encodingFrame !== frame) encodingFrame.close();
            if (!transferredSourceFrame) frame.close();
          }
        }
      } catch {
        if (capture === current)
          nativeVideoPacket(JSON.stringify({ error: "Native video capture stopped" }));
      } finally {
        // Reader completion, failure and geometry rejection all revoke retained
        // pixels synchronously. Do not await stopCapture here: it awaits this loop.
        current.stopped = true;
        clearNativeFrame(current);
      }
    })();
    return { width, height, settings: track.getSettings() };
  } catch (error) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}
/** Allocate a cohort selected by its stable quality/configuration key. Bitrate is bits per second,
 * fps is the requested frame ceiling. Reserve capacity before asynchronous codec probes. */
async function addEncoder(quality, streamId, bitrate, fps) {
  if (!capture || capture.stopped) throw new Error("Native capture is not running");
  const bitrates = { low: 2000000, medium: 5000000, high: 12000000 };
  bitrate ??= bitrates[quality];
  fps ??= 30;
  if (!${JSON.stringify(VIDEO_BITRATES)}.includes(bitrate) || !${JSON.stringify(VIDEO_FRAME_RATES)}.includes(fps))
    throw new Error("Unknown video settings");
  const existing = encoders.get(quality);
  if (existing) {
    if (
      existing.streamId !== streamId ||
      existing.configuration.bitrate !== bitrate ||
      existing.configuration.framerate !== fps
    )
      throw new Error("Encoder identity changed");
    touchEncoder(quality);
    return { codec: existing.codec };
  }
  const pending = pendingEncoders.get(quality);
  if (pending) {
    if (pending.streamId !== streamId || pending.bitrate !== bitrate || pending.fps !== fps)
      throw new Error("Encoder allocation identity changed");
    return pending.promise;
  }
  if (encoders.size + pendingEncoders.size + rawEncoders.size >= 3) throw new Error("Native encoder limit reached");
  // Reserve before any codec probe. A timed-out CDP request can continue in this
  // page, so host-side serialization alone cannot enforce the encoder ceiling.
  const source = capture;
  const reservation = { streamId, bitrate, fps, promise: null };
  pendingEncoders.set(quality, reservation);
  const assertAllocation = () => {
    if (capture !== source || source.stopped || pendingEncoders.get(quality) !== reservation)
      throw new Error("Native encoder allocation changed");
  };
  reservation.promise = (async () => {
    let state = null;
    try {
      let configuration;
      for (const codec of ["avc1.420033", "vp8"]) {
        const candidate = {
          codec,
          width: source.width,
          height: source.height,
          bitrate,
          framerate: fps,
          latencyMode: "realtime",
          hardwareAcceleration: "no-preference",
          ...(codec.startsWith("avc") ? { avc: { format: "annexb" } } : {}),
        };
        const support = await VideoEncoder.isConfigSupported(candidate);
        assertAllocation();
        if (support.supported) {
          configuration = candidate;
          break;
        }
      }
      if (!configuration) throw new Error("Native encoder is unavailable");
      state = {
        streamId,
        codec: configuration.codec,
        sequence: 0,
        pending: new Set(),
        forceKey: true,
        framesSinceKey: 0,
        activeFrames: 0,
        lastEncodedTimestampUs: -Infinity,
        nextEncodeAt: -Infinity,
        deferredPacing: false,
        lastRequestedAt: performance.now(),
        needsKey: true,
        configuration,
        frameGenerations: new Map(),
        failed: false,
        encoder: null,
        encoderIncarnation: null,
        stallRecoveries: 0,
      };
      replaceNativeEncoder(quality, state);
      assertAllocation();
      pendingEncoders.delete(quality);
      encoders.set(quality, state);
      return { codec: state.codec };
    } catch (error) {
      try {
        state?.encoder?.close();
      } catch {}
      throw error;
    } finally {
      if (pendingEncoders.get(quality) === reservation) pendingEncoders.delete(quality);
    }
  })();
  return reservation.promise;
}
/** Cancel an uncertain allocation and release only the selected cohort. */
function removeEncoder(quality) {
  removeRawEncoder(quality);
  // Cancel uncertain pending allocation before its async support probe returns.
  pendingEncoders.delete(quality);
  const state = encoders.get(quality);
  if (!state) return;
  encoders.delete(quality);
  state.encoderIncarnation = null;
  try {
    state.encoder.close();
  } catch {}
  state.pending.clear();
  state.frameGenerations.clear();
  wakeNativeFrame();
}
/** Renew viewing demand without allocating or resetting a codec. */
function touchEncoder(quality) {
  touchRawEncoder(quality);
  const state = encoders.get(quality);
  if (state) state.lastRequestedAt = performance.now();
}
/** Request the next eligible independent picture while preserving healthy in-flight deltas. */
function requestKeyFrame(quality) {
  touchRawEncoder(quality, true);
  const state = encoders.get(quality);
  if (state) {
    state.lastRequestedAt = performance.now();
    // Joining/recovering viewers need an additional key, but healthy viewers
    // can keep consuming an intact in-flight chain until that key is encoded.
    // Preserve any existing needsKey from actual output loss or source reset.
    state.forceKey = true;
    wakeNativeFrame();
  }
}
/** Release producer pressure for this exact stream/sequence, including refused stale packets. */
function acknowledge(streamId, sequence) {
  for (const state of encoders.values())
    if (state.streamId === streamId) state.pending.delete(sequence);
  wakeNativeFrame();
}
/** Fence pre-transition output using source-clock microseconds without replacing the track. */
function resetCapture(generation, minimumTimestampUs) {
  if (!capture) return;
  if (generation < capture.generation) return;
  clearNativeFrame(capture);
  capture.generation = generation;
  capture.minimumTimestampUs = minimumTimestampUs;
  for (const state of encoders.values()) {
    if (state.failed) continue;
    state.forceKey = true;
    state.needsKey = true;
    state.pending.clear();
    state.framesSinceKey = 0;
    state.activeFrames = 0;
    // A route/action boundary retires receipts, not the physical capture source.
    // Keep the codec warm and retain unmatched native work in the two-slot bound.
    // Its original generation rejects old output; the next fresh submission is
    // an independent key. Silent drops retain the existing deadline recovery.
  }
}
`;
