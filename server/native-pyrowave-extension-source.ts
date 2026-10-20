/** Trusted exact-tab raw feed. Its capability is supplied only to the hidden extension session. */

import {
  PYROWAVE_HEADER_BYTES,
  PYROWAVE_RAW_MAGIC,
  PYROWAVE_WIRE_VERSION,
} from "../shared/pyrowave-wire";
import { PYROWAVE_CAPTURE_PROTOCOL } from "./pyrowave-capture-protocol";

export const NATIVE_PYROWAVE_EXTENSION_SOURCE = `
const rawEncoders = new Map();

/** Revoke copies and network callbacks synchronously before closing a cohort. */
function removeRawEncoder(key) {
  const state = rawEncoders.get(key);
  if (!state) return;
  rawEncoders.delete(key);
  state.closed = true;
  state.ownedFrame?.close();
  state.ownedFrame = null;
  state.socket.close();
}
function stopRawEncoders() {
  for (const key of [...rawEncoders.keys()]) removeRawEncoder(key);
}
function touchRawEncoder(key, force = false) {
  const state = rawEncoders.get(key);
  if (!state) return;
  state.lastRequestedAt = performance.now();
  if (force) state.forceNext = true;
}

/** Reserve one source cohort before awaiting its authenticated local socket. */
async function addRawEncoder(key, streamId, bitrate, fps, url, credential) {
  const source = capture;
  if (!source || source.width % 2 || source.height % 2)
    throw new Error("Raw video requires even source dimensions");
  if (![100000000, 200000000, 250000000].includes(bitrate) || ![15, 30, 60].includes(fps))
    throw new Error("Unknown raw video settings");
  if (rawEncoders.has(key)) {
    const existing = rawEncoders.get(key);
    if (existing.streamId !== streamId || existing.bitrate !== bitrate || existing.fps !== fps)
      throw new Error("Raw encoder identity changed");
    touchRawEncoder(key);
    return;
  }
  if (encoders.size + pendingEncoders.size + rawEncoders.size >= 3)
    throw new Error("Native encoder limit reached");
  if (!/^ws:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/capture$/.test(url) || !/^[A-Za-z0-9_-]{43}$/.test(credential))
    throw new Error("Invalid private capture channel");

  const socket = new WebSocket(url, [${JSON.stringify(PYROWAVE_CAPTURE_PROTOCOL)}, credential]);
  socket.binaryType = "arraybuffer";
  const pixels = source.width * source.height;
  const state = {
    streamId, bitrate, fps, socket, source, sequence: 0, pendingSequence: 0,
    busy: false, closed: false, forceNext: true, ownedFrame: null,
    lastRequestedAt: performance.now(), lastTimestampUs: -Infinity,
    bytes: new Uint8Array(${PYROWAVE_HEADER_BYTES} + pixels * 3 / 2),
    i420Layout: [
      { offset: 0, stride: source.width },
      { offset: pixels, stride: source.width / 2 },
      { offset: pixels * 5 / 4, stride: source.width / 2 },
    ],
    nv12Layout: [ { offset: 0, stride: source.width }, { offset: pixels, stride: source.width } ],
  };
  rawEncoders.set(key, state);
  const failure = () => {
    if (state.closed) return;
    removeRawEncoder(key);
    nativeVideoPacket(JSON.stringify({ error: "Native raw encoder stopped", streamId }));
  };
  socket.addEventListener("message", (event) => {
    if (state.closed) return;
    if (!state.pendingSequence || !(event.data instanceof ArrayBuffer) || event.data.byteLength !== 4 ||
        new DataView(event.data).getUint32(0, true) !== state.pendingSequence) {
      failure();
      return;
    }
    state.pendingSequence = 0;
    state.busy = false;
  });
  socket.addEventListener("close", failure);
  socket.addEventListener("error", failure);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Private capture unavailable")), 3000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Private capture unavailable")); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Private capture closed")); }, { once: true });
    });
    if (state.closed || capture !== source || rawEncoders.get(key) !== state)
      throw new Error("Raw capture changed");
  } catch (error) {
    // Cancellation may already have installed a new allocation under this key.
    // Only the state that owns this completion may retire the registered cohort.
    if (rawEncoders.get(key) === state) removeRawEncoder(key);
    throw error;
  }
}

/** Clone at admission, before the caller closes the track frame. One reusable byte buffer
 * per cohort prevents raw-frame queues and per-frame multi-megabyte allocations. */
function encodeRawFrame(source, frame, softwareColorCorrection = false) {
  for (const [key, state] of rawEncoders) {
    if (state.closed || state.source !== source || state.busy ||
        state.socket.readyState !== WebSocket.OPEN ||
        performance.now() - state.lastRequestedAt > 2000) continue;
    if (!state.forceNext && frame.timestamp - state.lastTimestampUs < 1000000 / state.fps - 1) continue;
    state.busy = true;
    state.forceNext = false;
    state.lastTimestampUs = frame.timestamp;
    const owned = new VideoFrame(frame);
    state.ownedFrame = owned;
    const generation = source.generation;
    const timestamp = frame.timestamp;
    void (async () => {
      try {
        const rect = owned.visibleRect;
        if (!["I420", "NV12"].includes(owned.format) || !rect || rect.x || rect.y ||
            rect.width !== source.width || rect.height !== source.height ||
            !Number.isSafeInteger(timestamp) || timestamp < 0 || state.sequence === 0xffffffff)
          throw new Error("Unexpected raw source layout");
        await owned.copyTo(state.bytes.subarray(${PYROWAVE_HEADER_BYTES}), {
          rect: { x: 0, y: 0, width: source.width, height: source.height },
          layout: owned.format === "NV12" ? state.nv12Layout : state.i420Layout,
        });
        if (state.closed || capture !== source || source.stopped ||
            generation !== source.generation || timestamp < source.minimumTimestampUs) {
          state.busy = false;
          return;
        }
        const header = new DataView(state.bytes.buffer, 0, ${PYROWAVE_HEADER_BYTES});
        const sequence = ++state.sequence;
        header.setUint32(0, ${PYROWAVE_RAW_MAGIC}, true);
        header.setUint32(4, state.bytes.length - ${PYROWAVE_HEADER_BYTES}, true);
        header.setUint32(8, sequence, true);
        header.setUint32(12, ${PYROWAVE_WIRE_VERSION}, true);
        header.setUint32(16, timestamp % 4294967296, true);
        header.setUint32(20, Math.floor(timestamp / 4294967296), true);
        header.setUint32(24, generation, true);
        header.setUint32(28, owned.format === "NV12" ? 0 : 1, true);
        state.pendingSequence = sequence;
        // Raw YUV has no container VUI. Carry the qualified matrix correction as
        // metadata rather than copying all planes into a reconstructed VideoFrame.
        const color = softwareCaptureColorOverride(owned, softwareColorCorrection) ??
          owned.colorSpace.toJSON();
        state.socket.send(JSON.stringify(color));
        state.socket.send(state.bytes.buffer);
      } catch {
        if (!state.closed) {
          removeRawEncoder(key);
          nativeVideoPacket(JSON.stringify({ error: "Native raw encoder stopped", streamId: state.streamId }));
        }
      } finally {
        if (state.ownedFrame === owned) {
          state.ownedFrame = null;
          owned.close();
        }
      }
    })();
  }
}
`;
