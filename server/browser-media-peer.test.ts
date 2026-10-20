import { afterEach, expect, it, vi } from "vitest";
import {
  type BrowserMediaPeerOptions,
  createBrowserMediaPeer,
  type NativeMediaChannel,
  type NativeMediaPeer,
  validateBrowserMediaOffer,
} from "./browser-media-peer";

const offer = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}\r\n`;
afterEach(() => vi.useRealTimers());
function fixture() {
  let gathering = (_state: string) => {},
    open = () => {},
    message = (_data: string | Uint8Array | ArrayBuffer) => {},
    extra = (_channel: NativeMediaChannel) => {};
  const peerClose = vi.fn(),
    channelClose = vi.fn(),
    onReady = vi.fn(),
    onFailure = vi.fn(),
    abort = new AbortController();
  let current = true;
  const channel: NativeMediaChannel = {
    close: channelClose,
    isOpen: () => true,
    bufferedAmount: () => 0,
    maxMessageSize: () => 16384,
    sendMessageBinary: () => true,
    onOpen: (fn) => {
      open = fn;
    },
    onClosed: () => {},
    onError: () => {},
    onMessage: (fn) => {
      message = fn;
    },
  };
  const peer: NativeMediaPeer = {
    close: peerClose,
    setRemoteDescription: vi.fn(),
    setLocalDescription: vi.fn(),
    localDescription: () => ({ type: "answer", sdp: "owned-answer" }),
    createDataChannel: () => channel,
    onLocalDescription: () => {},
    onGatheringStateChange: (fn) => {
      gathering = fn;
    },
    onStateChange: () => {},
    onDataChannel: (fn) => {
      extra = fn;
    },
  };
  const createPeer = vi.fn(
    (_name: string, _configuration: Parameters<BrowserMediaPeerOptions["createPeer"]>[1]) => peer,
  );
  const media = createBrowserMediaPeer({
    offer,
    createPeer,
    signal: abort.signal,
    isCurrent: () => current,
    onReady,
    onFailure,
  });
  return {
    media,
    abort,
    peerClose,
    channelClose,
    onReady,
    onFailure,
    createPeer,
    answer: () => gathering("complete"),
    open: () => open(),
    message: (data: string | Uint8Array | ArrayBuffer) => message(data),
    extra: (value: NativeMediaChannel) => extra(value),
    replace: () => {
      current = false;
    },
  };
}
it("bounds offers before native allocation and keeps fingerprint verification and external ICE at safe defaults", async () => {
  for (const invalid of [
    "",
    offer + "x".repeat(65536),
    offer.replace("application", "video"),
    `${offer}m=audio 9 UDP/TLS/RTP/SAVPF 0\r\n`,
    offer.replace("sha-256", "sha-1"),
  ])
    expect(() => validateBrowserMediaOffer(invalid)).toThrow();
  const f = fixture();
  try {
    f.answer();
    expect(await f.media.answer).toBe("owned-answer");
    f.open();
    expect(f.onReady).toHaveBeenCalledOnce();
    expect(f.createPeer.mock.calls[0]![1]).toMatchObject({
      iceServers: [],
      enableIceTcp: false,
      disableAutoNegotiation: true,
      maxMessageSize: 16384,
    });
    expect(f.createPeer.mock.calls[0]![1]).not.toHaveProperty("disableFingerprintVerification");
  } finally {
    f.media.close();
  }
  expect(f.peerClose).toHaveBeenCalledOnce();
  expect(f.channelClose).toHaveBeenCalledOnce();
});
it("expires negotiation and connection setup independently, including a gathered peer that never opens", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.answer();
  await f.media.answer;
  vi.advanceTimersByTime(8000);
  expect(f.peerClose).toHaveBeenCalledOnce();
  expect(f.onFailure).toHaveBeenCalledOnce();
  expect(f.onReady).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const second = fixture();
  second.abort.abort();
  await expect(second.media.answer).rejects.toThrow("ended");
  second.open();
  expect(second.onReady).not.toHaveBeenCalled();
  expect(second.peerClose).toHaveBeenCalledOnce();
});
it("rejects control/text payloads and closes only its owned peer on revoked authority", () => {
  const f = fixture();
  f.answer();
  f.open();
  f.message("not a presentation credit");
  expect(f.peerClose).toHaveBeenCalledOnce();
  expect(f.onFailure).toHaveBeenCalledOnce();
  const second = fixture();
  second.answer();
  second.replace();
  second.open();
  expect(second.peerClose).toHaveBeenCalledOnce();
  expect(second.onReady).not.toHaveBeenCalled();
});
