import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EncodedVideoHandle } from "./browser-video-host";

const host = vi.hoisted(() => ({
  platform: "android",
  component: (() => null) as unknown,
  cleanups: [] as Array<() => void>,
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => () => void) => host.cleanups.push(effect()),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return host.platform;
    },
  },
  View: () => null,
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  get EncodedVideo() {
    return host.component;
  },
}));
vi.mock("./web", () => ({ supportsBrowserVideo: () => true }));

import {
  type BrowserVideoCanvasNode,
  BrowserVideoSurface,
  createBrowserVideoEnvironment,
  supportsBrowserVideo,
} from "./browser-video-surface";

/** Bind a synthetic host handle through the actual surface's ready callback. */
function surface() {
  const handle: EncodedVideoHandle = {
    configure: vi.fn(),
    decode: vi.fn(),
    reset: vi.fn(),
    present: vi.fn(async () => {}),
    release: vi.fn(),
  };
  let node: BrowserVideoCanvasNode | null = null;
  const tree = BrowserVideoSurface({
    canvasRef: (next) => {
      node = next as BrowserVideoCanvasNode | null;
    },
    onError: vi.fn(),
    style: {},
  }) as unknown as {
    props: {
      children: {
        props: {
          ref: { current: EncodedVideoHandle | null };
          onReady(): void;
          onFrame(frame: {
            id: number;
            timestamp: number;
            displayWidth: number;
            displayHeight: number;
          }): void;
          onDequeue(): void;
        };
      };
    };
  };
  const props = tree.props.children.props;
  props.ref.current = handle;
  props.onReady();
  if (!node) throw new Error("Native video surface did not bind its host handle");
  return { handle, props, node };
}

/** Require a native adapter, while the stock web adapter may be unavailable. */
function nativeEnvironment(node: BrowserVideoCanvasNode, beforeDraw: () => void) {
  const adapter = createBrowserVideoEnvironment(node, beforeDraw);
  if (!adapter) throw new Error("Native video adapter is unavailable");
  return adapter.environment;
}

beforeEach(() => {
  host.platform = "android";
  host.component = () => null;
  host.cleanups = [];
});
afterEach(() => {
  for (const cleanup of host.cleanups) cleanup();
});

describe("optional Android video host", () => {
  it("retains Android video on fork hosts and JPEG fallback on stock hosts", () => {
    expect(supportsBrowserVideo()).toBe(true);
    host.component = undefined;
    expect(supportsBrowserVideo()).toBe(false);
    host.platform = "web";
    expect(supportsBrowserVideo()).toBe(true);
    host.platform = "ios";
    expect(supportsBrowserVideo()).toBe(false);
  });

  it("forwards codec configuration and base64 chunks and acknowledges native queue capacity", () => {
    const { handle, props, node } = surface();
    const output = vi.fn();
    const dequeue = vi.fn();
    const environment = nativeEnvironment(node, vi.fn());
    const codec = environment.createDecoder({ output, dequeue, error: vi.fn() });
    codec.configure({
      codec: "vp8",
      codedWidth: 1280,
      codedHeight: 800,
      optimizeForLatency: true,
      description: new Uint8Array([1, 2]),
    });
    expect(handle.configure).toHaveBeenCalledWith(
      expect.objectContaining({ descriptionBase64: "AQI=" }),
    );
    codec.decode(
      environment.createEncodedChunk!({ type: "key", timestamp: 1000, dataBase64: "AA==" }),
    );
    expect(handle.decode).toHaveBeenCalledWith({
      type: "key",
      timestamp: 1000,
      dataBase64: "AA==",
    });
    expect(codec.decodeQueueSize).toBe(1);
    props.onDequeue();
    expect(codec.decodeQueueSize).toBe(0);
    expect(dequeue).toHaveBeenCalledOnce();
  });

  it("revokes the old receipt before presentation and waits for the host's paint acknowledgement", async () => {
    const { handle, props, node } = surface();
    let painted!: () => void;
    const paint = new Promise<void>((resolve) => {
      painted = resolve;
    });
    vi.mocked(handle.present).mockReturnValue(paint);
    const beforeDraw = vi.fn();
    const environment = nativeEnvironment(node, beforeDraw);
    let frame!: Parameters<typeof environment.draw>[0];
    environment.createDecoder({
      output: (next) => {
        frame = next;
      },
      dequeue: vi.fn(),
      error: vi.fn(),
    });
    props.onFrame({ id: 7, timestamp: 1000, displayWidth: 1280, displayHeight: 800 });
    let completed = false;
    const drawing = Promise.resolve(environment.draw(frame)).then(() => {
      completed = true;
    });
    expect(beforeDraw).toHaveBeenCalledOnce();
    expect(handle.present).toHaveBeenCalledWith(7);
    expect(completed).toBe(false);
    painted();
    await drawing;
    expect(completed).toBe(true);
  });

  it("does not release an old retained frame through a replacement decoder generation", () => {
    const { handle, props, node } = surface();
    const environment = nativeEnvironment(node, vi.fn());
    let frame!: Parameters<typeof environment.draw>[0];
    const first = environment.createDecoder({
      output: (next) => {
        frame = next;
      },
      dequeue: vi.fn(),
      error: vi.fn(),
    });
    props.onFrame({ id: 7, timestamp: 1000, displayWidth: 1280, displayHeight: 800 });
    environment.createDecoder({ output: vi.fn(), dequeue: vi.fn(), error: vi.fn() });
    frame.close();
    first.close();
    expect(handle.release).not.toHaveBeenCalled();
    expect(handle.reset).not.toHaveBeenCalled();
  });
});
