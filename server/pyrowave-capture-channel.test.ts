import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { writePyrowaveHeader } from "../shared/pyrowave-wire";
import { NATIVE_VIDEO_EXTENSION_ID } from "./native-video-extension";

const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./pyrowave-encoder-process", () => ({ createPyrowaveEncoderProcess: mock.create }));
const { createPyrowaveCaptureChannel, PYROWAVE_CAPTURE_PROTOCOL } = await import(
  "./pyrowave-capture-channel"
);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.clearAllMocks();
});
const origin = `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}`;
const credential = "synthetic-capture-test".padEnd(43, "x");
const header = {
  byteLength: 6144,
  sequence: 1,
  timestampUs: 12345,
  generation: 2,
  format: 1 as const,
};
const colorSpace = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false,
} as const;
const frame = () => Buffer.concat([writePyrowaveHeader(header, "raw"), Buffer.alloc(6144)]);

async function fixture() {
  const encode = vi
    .fn()
    .mockResolvedValue({ header: { ...header, byteLength: 8 }, data: Buffer.from("testdata") });
  const close = vi.fn().mockResolvedValue(undefined);
  mock.create.mockResolvedValueOnce({ encode, close });
  const onFrame = vi.fn(),
    onFailure = vi.fn();
  let current = true;
  const channel = await createPyrowaveCaptureChannel({
    binaryPath: "/owned/encoder",
    cacheDirectory: "/owned/cache",
    width: 64,
    height: 64,
    bitrate: 100_000_000,
    fps: 30,
    credential,
    isCurrent: () => current,
    onFrame,
    onFailure,
  });
  cleanup.push(channel.close);
  const connect = (token = credential, requestOrigin = origin) => {
    const client = new WebSocket(channel.url, [PYROWAVE_CAPTURE_PROTOCOL, token], {
      origin: requestOrigin,
      perMessageDeflate: false,
    });
    cleanup.push(async () => {
      client.terminate();
    });
    return client;
  };
  return {
    channel,
    connect,
    encode,
    close,
    onFrame,
    onFailure,
    revoke: () => {
      current = false;
    },
  };
}

it("requires both exact extension origin and private capability, then admits one exact peer", async () => {
  const f = await fixture();
  for (const [token, requestOrigin] of [
    ["wrong".padEnd(43, "x"), origin],
    [credential, "https://untrusted.example"],
  ]) {
    const rejected = f.connect(token, requestOrigin);
    await expect(once(rejected, "open")).rejects.toThrow("403");
  }
  expect(f.encode).not.toHaveBeenCalled();
  const peer = f.connect();
  await once(peer, "open");
  expect(peer.protocol).toBe(PYROWAVE_CAPTURE_PROTOCOL);
  const credit = once(peer, "message");
  peer.send(JSON.stringify(colorSpace));
  peer.send(frame());
  expect((await credit)[0]).toEqual(Buffer.from([1, 0, 0, 0]));
  expect(f.onFrame).toHaveBeenCalledExactlyOnceWith(
    { ...header, byteLength: 8 },
    Buffer.from("testdata"),
    colorSpace,
  );
  const duplicate = f.connect();
  await expect(once(duplicate, "open")).rejects.toThrow("403");
  expect(f.onFailure).not.toHaveBeenCalled();
});

it("revokes old asynchronous work before publication and closes only its own encoder", async () => {
  const f = await fixture();
  const deferred = Promise.withResolvers<{ header: typeof header; data: Buffer }>();
  f.encode.mockReturnValueOnce(deferred.promise);
  const peer = f.connect();
  await once(peer, "open");
  peer.send(JSON.stringify(colorSpace));
  peer.send(frame());
  await vi.waitFor(() => expect(f.encode).toHaveBeenCalledOnce());
  f.revoke();
  const closing = f.channel.close();
  deferred.resolve({ header, data: Buffer.from("obsolete") });
  await closing;
  expect(f.onFrame).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});

it("refuses raw backlog instead of retaining surfaces while native work is pending", async () => {
  const f = await fixture();
  const deferred = Promise.withResolvers<{ header: typeof header; data: Buffer }>();
  f.encode.mockReturnValueOnce(deferred.promise);
  const peer = f.connect();
  await once(peer, "open");
  peer.send(JSON.stringify(colorSpace));
  peer.send(frame());
  await vi.waitFor(() => expect(f.encode).toHaveBeenCalledOnce());
  peer.send(JSON.stringify(colorSpace));
  peer.send(frame());
  await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce());
  deferred.resolve({ header, data: Buffer.from("obsolete") });
  await f.channel.close();
  expect(f.encode).toHaveBeenCalledOnce();
  expect(f.onFrame).not.toHaveBeenCalled();
});

for (const [label, messages] of [
  ["missing", [frame()]],
  ["duplicate", [JSON.stringify(colorSpace), JSON.stringify(colorSpace)]],
  ["oversized", ["x".repeat(513)]],
  ["HDR", [JSON.stringify({ ...colorSpace, transfer: "smpte2084" })]],
] as const) {
  it(`refuses ${label} source colour metadata before native admission`, async () => {
    const f = await fixture();
    const peer = f.connect();
    await once(peer, "open");
    for (const message of messages) peer.send(message);
    await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce());
    expect(f.encode).not.toHaveBeenCalled();
  });
}
