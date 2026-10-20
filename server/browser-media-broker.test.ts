import { afterEach, expect, it, vi } from "vitest";
import { browserMediaSourceSchema, type OpenBrowserMediaInput } from "../shared/browser-media";
import type {
  BrowserVideoMetadata,
  BrowserVideoReadInput,
  BrowserVideoReadReply,
} from "../shared/browser-video";
import {
  browserMediaTestOffer,
  browserVideoTestMetadata,
  browserVideoTestState,
} from "../tests/fixtures/browser-video";
import { createBrowserMediaBroker } from "./browser-media-broker";
import type { BrowserMediaWorkerPeerOptions } from "./browser-media-worker-client";

afterEach(() => vi.useRealTimers());
function fixture() {
  const state = browserVideoTestState();
  let now = 0,
    enabled = true;
  const slots: {
    options: BrowserMediaWorkerPeerOptions;
    peer: {
      id: string;
      answer: Promise<string>;
      send: ReturnType<
        typeof vi.fn<(m: BrowserVideoMetadata, d: Uint8Array, e?: number) => Promise<boolean>>
      >;
      close: ReturnType<typeof vi.fn>;
    };
  }[] = [];
  const reads: { input: BrowserVideoReadInput; resolve(value: BrowserVideoReadReply): void }[] = [];
  const worker = {
    stopped: false,
    close: vi.fn(async () => {}),
    open: vi.fn(async (_offer: string, options: BrowserMediaWorkerPeerOptions) => {
      const peer = {
        id: "00000000-0000-4000-8000-000000000001" as const,
        answer: Promise.resolve("owned-answer"),
        send: vi.fn(async (_m: BrowserVideoMetadata, _d: Uint8Array, _e = 0) => true),
        close: vi.fn(),
      };
      slots.push({ options, peer });
      return peer;
    }),
  };
  const createWorker = vi.fn(() => worker);
  const broker = createBrowserMediaBroker({
    assets: async () => ({
      workerPath: "/trusted/worker.cjs",
      datachannelDirectory: "/trusted/dependency",
    }),
    enabled: () => enabled,
    readState: async () => ({ state: { ...state } }),
    readVideo: (input) => new Promise((resolve) => reads.push({ input, resolve })),
    createWorker,
    now: () => now,
  });
  const input: OpenBrowserMediaInput = {
    viewerToken: "v".repeat(32),
    source: browserMediaSourceSchema.parse(state),
    observationEpoch: 1,
    offer: browserMediaTestOffer(),
    bitrate: 100000000,
    fps: 30,
  };
  const packet = (sequence = 1) => ({
    ...browserVideoTestMetadata(),
    sequence,
    dataBase64: "AAAA",
  });
  const settle = (index: number, sequence = 1) =>
    reads[index]!.resolve({
      state: { ...state },
      status: "ready",
      streamId: "s".repeat(32),
      packets: [packet(sequence)],
    });
  return {
    broker,
    input,
    slots,
    reads,
    state,
    worker,
    createWorker,
    settle,
    setNow: (value: number) => {
      now = value;
    },
    off: () => {
      enabled = false;
    },
    finish: async () => {
      await broker.close();
      for (const read of reads)
        read.resolve({ state, status: "waiting", streamId: null, packets: [] });
    },
  };
}
it("keeps the epoch from before a pending read and never relabels its late picture", async () => {
  const f = fixture();
  try {
    expect((await f.broker.open(f.input)).status).toBe("ready");
    f.slots[0]!.options.onReady();
    await vi.waitFor(() => expect(f.reads).toHaveLength(1));
    f.slots[0]!.options.onObservationEpoch?.(2);
    f.settle(0);
    await vi.waitFor(() => expect(f.slots[0]!.peer.send).toHaveBeenCalledOnce());
    expect(f.slots[0]!.peer.send.mock.calls[0]![2]).toBe(1);
    await vi.waitFor(() => expect(f.reads).toHaveLength(2));
    f.settle(1, 2);
    await vi.waitFor(() => expect(f.slots[0]!.peer.send).toHaveBeenCalledTimes(2));
    expect(f.slots[0]!.peer.send.mock.calls[1]![2]).toBe(2);
  } finally {
    await f.finish();
  }
});

it("renews epochs through authenticated polling without relabeling an in-flight read", async () => {
  const f = fixture();
  try {
    const opened = await f.broker.open(f.input);
    f.slots[0]!.options.onReady();
    await vi.waitFor(() => expect(f.reads).toHaveLength(1));
    const poll = { viewerToken: f.input.viewerToken, transportId: opened.transportId! };
    expect(
      (await f.broker.poll({ ...poll, viewerToken: "x".repeat(32), observationEpoch: 99 })).status,
    ).toBe("reset");
    await f.broker.poll({ ...poll, observationEpoch: 5 });
    f.settle(0);
    await vi.waitFor(() => expect(f.slots[0]!.peer.send).toHaveBeenCalledOnce());
    expect(f.slots[0]!.peer.send.mock.calls[0]![2]).toBe(1);
    await vi.waitFor(() => expect(f.reads).toHaveLength(2));
    await f.broker.poll({ ...poll, observationEpoch: 3 });
    f.settle(1, 2);
    await vi.waitFor(() => expect(f.slots[0]!.peer.send).toHaveBeenCalledTimes(2));
    expect(f.slots[0]!.peer.send.mock.calls[1]![2]).toBe(5);
  } finally {
    await f.finish();
  }
});
it("revokes changed sources and refuses late read publication after closure", async () => {
  const f = fixture();
  try {
    const opened = await f.broker.open(f.input);
    f.slots[0]!.options.onReady();
    await vi.waitFor(() => expect(f.reads).toHaveLength(1));
    f.state.navigationGeneration++;
    expect(
      (await f.broker.poll({ viewerToken: f.input.viewerToken, transportId: opened.transportId! }))
        .status,
    ).toBe("reset");
    expect(f.slots[0]!.peer.close).toHaveBeenCalledOnce();
    f.settle(0);
    await Promise.resolve();
    expect(f.slots[0]!.peer.send).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});
it("does not let another viewer heartbeat or close an existing peer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const opened = await f.broker.open(f.input);
    f.setNow(14000);
    expect(
      (await f.broker.poll({ viewerToken: "x".repeat(32), transportId: opened.transportId! }))
        .status,
    ).toBe("reset");
    f.broker.closeViewer({ viewerToken: "x".repeat(32), transportId: opened.transportId! });
    expect(f.slots[0]!.peer.close).not.toHaveBeenCalled();
    f.setNow(16000);
    vi.advanceTimersByTime(1000);
    expect(f.slots[0]!.peer.close).toHaveBeenCalledOnce();
    expect(f.slots[0]!.options.signal.aborted).toBe(true);
  } finally {
    await f.finish();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("does not allocate transport while Off or for a stale source", async () => {
  const f = fixture();
  try {
    f.off();
    expect((await f.broker.open(f.input)).status).toBe("unsupported");
    expect(f.createWorker).not.toHaveBeenCalled();
    expect(
      (await f.broker.open({ ...f.input, source: { ...f.input.source, tabId: "wrong-tab" } }))
        .status,
    ).toBe("reset");
    expect(f.createWorker).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});

it("a channel failure keeps its old read behind the explicit close and replacement barriers", async () => {
  const f = fixture();
  try {
    const opened = await f.broker.open(f.input);
    f.slots[0]!.options.onReady();
    expect(f.reads).toHaveLength(1);
    f.slots[0]!.options.onFailure();
    let closeFinished = false;
    const closing = f.broker
      .closeViewer({ viewerToken: f.input.viewerToken, transportId: opened.transportId! })
      .then(() => {
        closeFinished = true;
      });
    const replacement = f.broker.open(f.input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeFinished).toBe(false);
    expect(f.worker.open).toHaveBeenCalledOnce();
    f.settle(0);
    await closing;
    expect((await replacement).status).toBe("ready");
    expect(f.slots[0]!.peer.send).not.toHaveBeenCalled();
    expect(f.worker.open).toHaveBeenCalledTimes(2);
  } finally {
    await f.finish();
  }
});

it("concurrent opens share exactly one replacement after a stopped worker drains", async () => {
  const f = fixture();
  const stopped = Promise.withResolvers<void>();
  const replacement = { ...f.worker, stopped: false, close: vi.fn(async () => {}) };
  try {
    await f.broker.open(f.input);
    f.worker.stopped = true;
    f.worker.close.mockImplementation(() => stopped.promise);
    f.createWorker.mockReturnValue(replacement);
    const first = f.broker.open({ ...f.input, viewerToken: "a".repeat(32) });
    const second = f.broker.open({ ...f.input, viewerToken: "b".repeat(32) });
    await vi.waitFor(() => expect(f.worker.close).toHaveBeenCalled());
    stopped.resolve();
    expect((await first).status).toBe("ready");
    expect((await second).status).toBe("ready");
    expect(f.createWorker).toHaveBeenCalledTimes(2);
    expect(f.worker.close).toHaveBeenCalledOnce();
  } finally {
    stopped.resolve();
    await f.finish();
  }
  expect(replacement.close).toHaveBeenCalledOnce();
});

it("broker shutdown during worker retirement cannot create another worker or peer", async () => {
  const f = fixture();
  const stopped = Promise.withResolvers<void>();
  const replacement = { ...f.worker, stopped: false, close: vi.fn(async () => {}) };
  try {
    await f.broker.open(f.input);
    f.worker.stopped = true;
    f.worker.close.mockImplementation(() => stopped.promise);
    f.createWorker.mockReturnValue(replacement);
    const opening = f.broker.open({ ...f.input, viewerToken: "b".repeat(32) });
    await vi.waitFor(() => expect(f.worker.close).toHaveBeenCalled());
    const closing = f.broker.close();
    stopped.resolve();
    expect((await opening).status).toBe("reset");
    await closing;
    expect(f.createWorker).toHaveBeenCalledOnce();
    expect(f.slots).toHaveLength(1);
    expect(f.worker.close).toHaveBeenCalledOnce();
  } finally {
    stopped.resolve();
    await f.finish();
  }
});

it("failed stopped-worker cleanup cannot allocate an overlapping replacement", async () => {
  const f = fixture();
  try {
    await f.broker.open(f.input);
    f.worker.stopped = true;
    f.worker.close.mockRejectedValueOnce(new Error("Owned worker did not exit"));
    const reply = await f.broker.open({ ...f.input, viewerToken: "b".repeat(32) });
    expect(reply.status).toBe("unsupported");
    expect(f.createWorker).toHaveBeenCalledOnce();
    expect(f.slots).toHaveLength(1);
  } finally {
    await f.finish();
  }
  expect(f.worker.close).toHaveBeenCalledTimes(2);
});
