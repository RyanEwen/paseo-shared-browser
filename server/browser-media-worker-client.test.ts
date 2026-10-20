import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { browserMediaTestOffer, browserVideoTestMetadata } from "../tests/fixtures/browser-video";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

import { BrowserMediaWorkerClient } from "./browser-media-worker-client";

/** Retain IPC flush callbacks to exercise aggregate backpressure independently of replies. */
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn((_message: unknown, _callback: (error: Error | null) => void) => true),
    kill: vi.fn(),
    disconnect() {
      child.connected = false;
      child.emit("exit", 0);
    },
  });
  fork.mockReturnValue(child);
  const worker = new BrowserMediaWorkerClient({
    workerPath: "/owned/browser-media-worker.cjs",
    datachannelDirectory: "/owned/node_modules/node-datachannel",
  });
  child.emit("message", { kind: "started" });
  const open = async () => {
    const abort = new AbortController();
    const onFailure = vi.fn();
    const peer = await worker.open(browserMediaTestOffer(), {
      signal: abort.signal,
      isCurrent: () => !abort.signal.aborted,
      onReady: vi.fn(),
      onFailure,
    });
    child.emit("message", { kind: "answer", id: peer.id, sdp: "fixture answer" });
    await peer.answer;
    return { peer, abort, onFailure };
  };
  return { child, worker, open };
}
afterEach(() => vi.clearAllMocks());

it("revokes pending frames on cancellation and isolates worker environment", async () => {
  const f = fixture();
  try {
    const options = fork.mock.calls[0]![2];
    expect(options.execArgv).toEqual([]);
    expect(Object.keys(options.env).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "HOME", "PATH"]);
    const { peer, abort, onFailure } = await f.open();
    const pending = peer.send(browserVideoTestMetadata(), new Uint8Array(100));
    expect(await peer.send(browserVideoTestMetadata(), new Uint8Array(100))).toBe(false);
    abort.abort();
    expect(await pending).toBe(false);
    expect(await peer.send(browserVideoTestMetadata(), new Uint8Array(100))).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  } finally {
    await f.worker.close();
  }
});

it("bounds aggregate unflushed IPC bytes and releases accounting on flush", async () => {
  const f = fixture();
  try {
    const first = await f.open(),
      second = await f.open();
    const bytes = new Uint8Array(2 * 1024 * 1024);
    const pending = first.peer.send(browserVideoTestMetadata(), bytes);
    expect(await second.peer.send(browserVideoTestMetadata(), bytes)).toBe(false);
    const [command, flushed] = f.child.send.mock.calls.find(
      ([message]) => (message as { kind: string }).kind === "frame",
    )!;
    flushed(null);
    f.child.emit("message", { kind: "frame", id: first.peer.id, requestId: 1, accepted: true });
    expect(await pending).toBe(true);
    const next = second.peer.send(browserVideoTestMetadata(), bytes);
    second.abort.abort();
    expect(await next).toBe(false);
    expect(command).toMatchObject({ observationEpoch: 0 });
  } finally {
    await f.worker.close();
  }
});

it("worker exit fails only its own viewers and settles outstanding frame promises", async () => {
  const f = fixture();
  const { peer, onFailure } = await f.open();
  const pending = peer.send(browserVideoTestMetadata(), new Uint8Array(100));
  f.child.emit("exit", 1);
  expect(await pending).toBe(false);
  expect(f.worker.stopped).toBe(true);
  expect(onFailure).toHaveBeenCalledOnce();
  await f.worker.close();
});
