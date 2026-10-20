import { afterEach, expect, it, vi } from "vitest";
import { browserVideoTestState } from "../tests/fixtures/browser-video";
import type { BrowserMediaRead } from "./browser-media-session";

const { createReader } = vi.hoisted(() => ({ createReader: vi.fn() }));
vi.mock("./browser-media-session", () => ({ createBrowserMediaReader: createReader }));

import { createBrowserVideoTransport } from "./browser-video-transport";

/** A held read/close lets a retired transport finish after fallback without publishing. */
function fixture() {
  const read = Promise.withResolvers<BrowserMediaRead>();
  const close = Promise.withResolvers<void>();
  createReader.mockReturnValue({ read: () => read.promise, close: () => close.promise });
  const state = browserVideoTestState();
  let stopped = false;
  const reply = { state, status: "waiting" as const, streamId: null, packets: [] };
  const readRpc = vi.fn(
      async (_input: import("../shared/browser-video").BrowserVideoReadInput) => reply,
    ),
    onFallback = vi.fn(),
    onMediaResume = vi.fn();
  const transport = createBrowserVideoTransport({
    viewerToken: "owned-viewer",
    quality: "medium",
    bitrate: 12000000,
    codec: "pyrowave",
    source: () => state,
    epoch: () => 3,
    isSourceCurrent: () => true,
    isStopped: () => stopped,
    environment: { createPeer: vi.fn(), now: () => 0 },
    readRpc,
    mediaRpcs: { open: vi.fn(), poll: vi.fn(), close: vi.fn() },
    pendingRead: { current: null },
    pendingClose: { current: null },
    onFallback,
    onMediaResume,
  });
  return {
    transport,
    read,
    close,
    reply,
    readRpc,
    onFallback,
    onMediaResume,
    state,
    stop: () => {
      stopped = true;
    },
  };
}
afterEach(() => vi.clearAllMocks());
const input = { streamId: null, afterSequence: 0, requestKeyFrame: true };

it("discards a late LAN result and waits for remote teardown before compatible reads", async () => {
  const f = fixture();
  const pending = f.transport.read(input);
  f.transport.fallback("Connection lost");
  f.read.resolve({ reply: f.reply, observationEpoch: 1 });
  expect(await pending).toBeNull();
  const compatible = f.transport.read(input);
  await Promise.resolve();
  expect(f.readRpc).not.toHaveBeenCalled();
  f.close.resolve();
  expect(await compatible).toEqual({ reply: f.reply, observationEpoch: 3 });
  expect(f.readRpc.mock.calls[0]?.[0]).toMatchObject({ bitrate: 12000000 });
  expect(f.onFallback).toHaveBeenCalledExactlyOnceWith("Connection lost");
  f.transport.close();
});

it("closing a viewer fences a pending LAN result without issuing a compatible read", async () => {
  const f = fixture();
  const pending = f.transport.read(input);
  f.transport.close();
  f.read.resolve({ reply: f.reply, observationEpoch: 1 });
  f.close.resolve();
  expect(await pending).toBeNull();
  expect(await f.transport.read(input)).toBeNull();
  expect(f.readRpc).not.toHaveBeenCalled();
  expect(f.onFallback).not.toHaveBeenCalled();
});

it("recovers an odd startup source after automatic 2x detail settles, without Retry", async () => {
  const f = fixture();
  f.state.viewport = { width: 1279, height: 799 };
  const refused = { ...f.state };
  const pending = f.transport.read(input);
  f.read.resolve({
    reply: { ...f.reply, state: refused, status: "unsupported", reason: "Unsupported geometry" },
    observationEpoch: 3,
  });
  expect((await pending)?.reply.status).toBe("unsupported");
  // The panel accepts the source before selecting compatible fallback.
  f.transport.fallback("Unsupported geometry", refused);
  const waitingForClose = f.transport.read(input);
  await Promise.resolve();
  expect(createReader).toHaveBeenCalledTimes(1);
  expect(f.readRpc).not.toHaveBeenCalled();
  f.close.resolve();
  await waitingForClose;
  // Repeated reads of an unchanged invalid source use compatible video, no signaling loop.
  await f.transport.read(input);
  expect(createReader).toHaveBeenCalledTimes(1);
  expect(f.onMediaResume).not.toHaveBeenCalled();

  // A new invalid viewport also stays on compatible video without retry churn.
  f.state.viewport = { width: 1277, height: 797 };
  f.state.viewportGeneration++;
  await f.transport.read(input);
  expect(createReader).toHaveBeenCalledTimes(1);
  // Changed pixels without a committed source generation cannot rearm authority.
  const sameSource = { ...f.state };
  f.state.viewportGeneration = refused.viewportGeneration;
  f.state.captureScale = 2;
  await f.transport.read(input);
  expect(createReader).toHaveBeenCalledTimes(1);
  f.state.viewportGeneration = sameSource.viewportGeneration + 1;
  const ready = { reply: { ...f.reply, state: { ...f.state } }, observationEpoch: 3 };
  const recovered = { read: vi.fn(async () => ready), close: vi.fn(async () => {}) };
  createReader.mockReturnValueOnce(recovered);
  expect(await f.transport.read(input)).toEqual(ready);
  expect(f.transport.usingMedia).toBe(true);
  expect(createReader).toHaveBeenCalledTimes(2);
  expect(f.onMediaResume).toHaveBeenCalledExactlyOnceWith();
  const compatibleReads = f.readRpc.mock.calls.length;
  await f.transport.read(input);
  expect(f.readRpc).toHaveBeenCalledTimes(compatibleReads);
  expect(f.onMediaResume).toHaveBeenCalledTimes(1);
  f.transport.close();
});

it("keeps genuine transport failures on manual retry after a valid source change", async () => {
  const f = fixture();
  f.transport.fallback("Connection lost");
  f.close.resolve();
  f.state.viewportGeneration++;
  f.state.captureScale = 2;
  await f.transport.read(input);
  expect(createReader).toHaveBeenCalledTimes(1);
  expect(f.transport.usingMedia).toBe(false);
  expect(f.onMediaResume).not.toHaveBeenCalled();
  f.transport.close();
});

it.each(["closed", "stopped"] as const)(
  "never recovers a %s viewer after pending teardown",
  async (mode) => {
    const f = fixture();
    f.state.viewport = { width: 1279, height: 799 };
    f.transport.fallback("Unsupported geometry", { ...f.state });
    const pending = f.transport.read(input);
    f.state.captureScale = 2;
    f.state.viewportGeneration++;
    if (mode === "closed") f.transport.close();
    else f.stop();
    f.close.resolve();
    expect(await pending).toBeNull();
    expect(createReader).toHaveBeenCalledTimes(1);
    expect(f.readRpc).not.toHaveBeenCalled();
    expect(f.onMediaResume).not.toHaveBeenCalled();
    f.transport.close();
  },
);
