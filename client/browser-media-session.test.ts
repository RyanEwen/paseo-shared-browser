/** Exercise cancellation, source replacement and observation epochs at the reader boundary. */
import { afterEach, expect, it, vi } from "vitest";
import type {
  OpenBrowserMediaReply,
  PollBrowserMediaInput,
  PollBrowserMediaReply,
} from "../shared/browser-media";
import {
  encodeBrowserMediaFrame,
  fragmentBrowserMediaFrame,
  readBrowserMediaObservationEpoch,
} from "../shared/browser-media-wire";
import { browserVideoTestMetadata, browserVideoTestState } from "../tests/fixtures/browser-video";
import {
  type BrowserMediaClientChannel,
  type BrowserMediaClientPeer,
  createBrowserMediaReader,
} from "./browser-media-session";

afterEach(() => vi.useRealTimers());

class Channel implements BrowserMediaClientChannel {
  binaryType = "";
  readyState = "connecting";
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  send(bytes: Uint8Array) {
    this.sent.push(bytes.slice());
  }
  close() {
    this.readyState = "closed";
    this.emit("close");
  }
  addEventListener(type: string, callback: (event: { data?: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, callback: (event: { data?: unknown }) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== callback),
    );
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(data === undefined ? {} : { data });
  }
}
class Peer implements BrowserMediaClientPeer {
  localDescription: { sdp: string } | null = null;
  iceGatheringState = "new";
  connectionState = "new";
  channel = new Channel();
  closes = 0;
  private listeners = new Map<string, (() => void)[]>();
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "owned-offer" };
  }
  async setLocalDescription() {
    this.localDescription = { sdp: "owned-offer" };
    this.iceGatheringState = "complete";
    for (const fn of this.listeners.get("icegatheringstatechange") ?? []) fn();
  }
  async setRemoteDescription() {
    this.connectionState = "connected";
    this.channel.readyState = "open";
    this.channel.emit("open");
  }
  addEventListener(type: string, callback: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, callback: () => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== callback),
    );
  }
  close() {
    this.closes++;
    this.connectionState = "closed";
  }
}
function fixture() {
  const state = browserVideoTestState(),
    peers: Peer[] = [];
  let epoch = 1;
  const ready = (): OpenBrowserMediaReply => ({
    state: { ...state },
    status: "ready",
    transportId: "00000000-0000-4000-8000-000000000001",
    answer: "owned-answer",
  });
  const open = vi.fn(async () => ready()),
    poll = vi.fn(
      async (_input: PollBrowserMediaInput): Promise<PollBrowserMediaReply> => ({
        state: { ...state },
        status: "streaming",
        sequence: 1,
      }),
    ),
    close = vi.fn(async () => ({ closed: true as const }));
  const reader = createBrowserMediaReader({
    environment: {
      createPeer: () => {
        const peer = new Peer();
        peers.push(peer);
        return peer;
      },
      now: () => 0,
    },
    viewerToken: "v".repeat(32),
    source: () => state,
    epoch: () => epoch,
    bitrate: 100000000,
    fps: 30,
    isSourceCurrent: (packet) => packet.frame.navigationGeneration === state.navigationGeneration,
    open,
    poll,
    close,
  });
  const transmit = (peer: Peer, observationEpoch: number, transferId = 1) => {
    const metadata = browserVideoTestMetadata();
    metadata.frame.navigationGeneration = state.navigationGeneration;
    for (const part of fragmentBrowserMediaFrame(
      encodeBrowserMediaFrame(metadata, new Uint8Array(40000), observationEpoch),
      transferId,
    ))
      peer.channel.emit("message", part.buffer);
  };
  return {
    reader,
    peers,
    state,
    open,
    poll,
    close,
    ready,
    transmit,
    setEpoch: (value: number) => {
      epoch = value;
      reader.setEpoch(value);
    },
  };
}
it("retains the server read epoch across late binary delivery and credits only presentation", async () => {
  const f = fixture();
  try {
    const reading = f.reader.read();
    await vi.waitFor(() => expect(f.peers[0]?.channel.readyState).toBe("open"));
    f.setEpoch(2);
    f.transmit(f.peers[0]!, 1);
    const result = await reading;
    expect(result.observationEpoch).toBe(1);
    expect(result.reply.packets).toHaveLength(1);
    expect(f.peers[0]!.channel.sent.filter((bytes) => bytes.byteLength === 4)).toHaveLength(0);
    expect(readBrowserMediaObservationEpoch(f.peers[0]!.channel.sent.at(-1)!)).toBe(2);
    f.reader.presented(result.reply.packets[0]!);
    expect(f.peers[0]!.channel.sent.at(-1)!.byteLength).toBe(4);
  } finally {
    await f.reader.close();
  }
});

it("renews a lost epoch through the existing reliable heartbeat without another action", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let serverEpoch = 1;
  f.poll.mockImplementation(async (input) => {
    serverEpoch = Math.max(serverEpoch, input.observationEpoch ?? 0);
    return { state: { ...f.state }, status: "streaming", sequence: 1 };
  });
  try {
    const first = f.reader.read();
    await vi.waitFor(() => expect(f.peers[0]?.channel.readyState).toBe("open"));
    f.setEpoch(2);
    // The unreliable update is sent but deliberately never delivered to the server.
    expect(readBrowserMediaObservationEpoch(f.peers[0]!.channel.sent.at(-1)!)).toBe(2);
    f.transmit(f.peers[0]!, serverEpoch);
    expect((await first).observationEpoch).toBe(1);
    await vi.advanceTimersByTimeAsync(750);
    expect(f.poll).toHaveBeenCalledWith(expect.objectContaining({ observationEpoch: 2 }));
    expect(serverEpoch).toBe(2);
    const fresh = f.reader.read();
    f.transmit(f.peers[0]!, serverEpoch, 2);
    expect((await fresh).observationEpoch).toBe(2);
    expect(f.peers).toHaveLength(1);
    expect(f.open).toHaveBeenCalledOnce();
  } finally {
    await f.reader.close();
  }
});
it("closes the original remote ID if signaling completes after local cancellation", async () => {
  const f = fixture(),
    answer = Promise.withResolvers<OpenBrowserMediaReply>();
  f.open.mockReturnValueOnce(answer.promise);
  const reading = f.reader.read();
  const failed = expect(reading).rejects.toThrow("ended");
  await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  const closing = f.reader.close();
  answer.resolve(f.ready());
  await closing;
  await failed;
  expect(f.close).toHaveBeenCalledExactlyOnceWith({
    viewerToken: "v".repeat(32),
    transportId: "00000000-0000-4000-8000-000000000001",
  });
  expect(f.peers[0]!.closes).toBe(1);
});
it("returns a reconciled source reset before reopening and ignores old channel output", async () => {
  const f = fixture();
  try {
    const first = f.reader.read();
    await vi.waitFor(() => expect(f.peers[0]?.channel.readyState).toBe("open"));
    f.state.navigationGeneration = 2;
    f.peers[0]!.channel.close();
    const reset = await first;
    expect(reset.reply.status).toBe("reset");
    expect(reset.reply.state.navigationGeneration).toBe(2);
    const second = f.reader.read();
    await vi.waitFor(() => expect(f.peers[1]?.channel.readyState).toBe("open"));
    f.transmit(f.peers[0]!, 1, 2);
    f.transmit(f.peers[1]!, 2, 1);
    const fresh = await second;
    expect(fresh.reply.status).toBe("ready");
    expect(fresh.observationEpoch).toBe(2);
    expect(fresh.reply.packets[0]!.frame.navigationGeneration).toBe(2);
  } finally {
    await f.reader.close();
  }
});
