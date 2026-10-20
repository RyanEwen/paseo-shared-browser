/** Exercise the shipped helper program's raw-copy admission and cancellation policy. */
import { createContext, runInContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { readPyrowaveHeader } from "../shared/pyrowave-wire";
import { NATIVE_PYROWAVE_EXTENSION_SOURCE } from "./native-pyrowave-extension-source";
import { NATIVE_VIDEO_COLOR_SOURCE } from "./native-video-color-source";

function fixture() {
  const errors: unknown[] = [];
  const copies: { close: ReturnType<typeof vi.fn>; finish(): void }[] = [];
  const sent: Buffer[] = [];
  const colors: unknown[] = [];
  let socket: Socket;
  class Socket {
    static OPEN = 1;
    listeners = new Map<string, ((event: { data?: ArrayBuffer }) => void)[]>();
    readyState = 1;
    close = vi.fn();
    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      socket = this;
    }
    addEventListener(name: string, fn: (event: { data?: ArrayBuffer }) => void) {
      const handlers = this.listeners.get(name) ?? [];
      handlers.push(fn);
      this.listeners.set(name, handlers);
    }
    send(bytes: ArrayBuffer | string) {
      if (typeof bytes === "string") colors.push(JSON.parse(bytes));
      else sent.push(Buffer.from(bytes.slice(0)));
    }
  }
  const emit = (name: string, data?: ArrayBuffer, target = socket) => {
    for (const fn of target.listeners.get(name) ?? []) fn(data ? { data } : {});
  };
  const source = { width: 64, height: 64, generation: 1, minimumTimestampUs: 0, stopped: false };
  const context = createContext({
    capture: source,
    encoders: new Map(),
    pendingEncoders: new Map(),
    performance: { now: () => 1 },
    WebSocket: Socket,
    Uint8Array,
    ArrayBuffer,
    DataView,
    setTimeout,
    clearTimeout,
    nativeVideoPacket: (value: string) => errors.push(JSON.parse(value)),
    VideoFrame: class {
      format = "I420";
      colorSpace = {
        toJSON: () => ({
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          fullRange: false,
        }),
      };
      visibleRect = { x: 0, y: 0, width: 64, height: 64 };
      close = vi.fn();
      constructor(readonly frame: { timestamp: number }) {
        copies.push(this as unknown as (typeof copies)[number]);
      }
      copyTo() {
        return new Promise<void>((resolve) => {
          (this as unknown as (typeof copies)[number]).finish = resolve;
        });
      }
    },
  });
  runInContext(NATIVE_VIDEO_COLOR_SOURCE + NATIVE_PYROWAVE_EXTENSION_SOURCE, context);
  const start = async () => {
    const pending = runInContext(
      `addRawEncoder("raw","stream",100000000,30,"ws://127.0.0.1:1234/capture","${"s".repeat(43)}")`,
      context,
    );
    emit("open");
    await pending;
  };
  const frame = (timestamp: number, correctColor = false) => {
    context.frame = { timestamp };
    runInContext(`encodeRawFrame(capture,frame,${correctColor})`, context);
  };
  const credit = (sequence: number) => {
    const bytes = new ArrayBuffer(4);
    new DataView(bytes).setUint32(0, sequence, true);
    emit("message", bytes);
  };
  return {
    context,
    emit,
    source,
    errors,
    copies,
    sent,
    colors,
    start,
    frame,
    credit,
    socket: () => socket!,
  };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

it("corrects qualified raw colour metadata using its sole existing plane copy", async () => {
  const f = fixture();
  await f.start();
  f.frame(100000, true);
  expect(f.copies).toHaveLength(1);
  f.copies[0]!.finish();
  await turn();
  expect(f.colors).toEqual([
    { primaries: "bt709", transfer: "bt709", matrix: "smpte170m", fullRange: false },
  ]);
  expect(readPyrowaveHeader(f.sent[0]!, "raw")).toMatchObject({
    timestampUs: 100000,
    generation: 1,
  });
  expect(f.copies[0]!.close).toHaveBeenCalledOnce();
  expect(f.errors).toEqual([]);
  runInContext("stopRawEncoders()", f.context);
});

it("allows one copy/encode in flight, validates credit, and closes a pending owned frame", async () => {
  const f = fixture();
  await f.start();
  expect(f.socket().protocols).toHaveLength(2);
  f.frame(100000);
  f.frame(133333);
  expect(f.copies).toHaveLength(1);
  f.copies[0]!.finish();
  await turn();
  expect(f.colors[0]).toEqual({
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    fullRange: false,
  });
  expect(readPyrowaveHeader(f.sent[0]!, "raw")).toMatchObject({
    sequence: 1,
    timestampUs: 100000,
    generation: 1,
  });
  f.frame(166666);
  expect(f.copies).toHaveLength(1);
  f.credit(1);
  f.frame(200000);
  expect(f.copies).toHaveLength(2);
  // An old credit must never release a different copy still waiting on its own bytes.
  f.credit(1);
  expect(f.errors).toHaveLength(1);
  expect(f.socket().close).toHaveBeenCalledOnce();
  expect(f.copies[1]!.close).toHaveBeenCalledOnce();
  f.copies[1]!.finish();
  await turn();
  expect(f.sent).toHaveLength(1);
  expect(f.copies[1]!.close).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "drops copied bytes after document replacement with colour correction=%s",
  async (correctColor) => {
    const f = fixture();
    await f.start();
    f.frame(100000, correctColor);
    f.source.generation = 2;
    f.source.minimumTimestampUs = 150000;
    f.copies[0]!.finish();
    await turn();
    expect(f.sent).toHaveLength(0);
    f.frame(200000, correctColor);
    f.copies[1]!.finish();
    await turn();
    expect(f.colors[0]).toEqual({
      primaries: "bt709",
      transfer: "bt709",
      matrix: correctColor ? "smpte170m" : "bt709",
      fullRange: false,
    });
    expect(readPyrowaveHeader(f.sent[0]!, "raw")).toMatchObject({
      sequence: 1,
      timestampUs: 200000,
      generation: 2,
    });
    runInContext("stopRawEncoders()", f.context);
    expect(f.errors).toHaveLength(0);
  },
);

afterEach(() => vi.useRealTimers());
it.each(["close", "error", "timeout"])(
  "cancelled raw allocation cannot retire its replacement after old %s",
  async (event) => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = runInContext(
      `addRawEncoder("raw","old-stream",100000000,30,"ws://127.0.0.1:1234/capture","${"s".repeat(43)}")`,
      f.context,
    );
    const rejected = expect(pending).rejects.toThrow();
    const oldSocket = f.socket();
    runInContext('removeRawEncoder("raw")', f.context);
    await f.start();
    const replacement = f.socket();
    if (event === "timeout") await vi.advanceTimersByTimeAsync(3000);
    else f.emit(event, undefined, oldSocket);
    await rejected;
    expect(replacement.close).not.toHaveBeenCalled();
    expect(runInContext('rawEncoders.get("raw").streamId', f.context)).toBe("stream");
    f.frame(100000);
    f.copies[0]!.finish();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    runInContext("stopRawEncoders()", f.context);
    expect(vi.getTimerCount()).toBe(0);
  },
);
