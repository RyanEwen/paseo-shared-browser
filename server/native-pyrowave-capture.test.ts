/** Native GPU cohorts share the existing exact-source admission and teardown policy. */
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import type { CdpConnection } from "./cdp";
import { NativeVideoCapture } from "./native-video-capture";

const fixture = vi.hoisted(() => ({
  helper: null as unknown,
  cohorts: [] as {
    options: Parameters<typeof import("./native-pyrowave-cohort").createNativePyrowaveCohort>[0];
    close: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("./cdp", async () => ({
  ...(await vi.importActual<typeof import("./cdp")>("./cdp")),
  attachToTarget: async () => fixture.helper,
}));
vi.mock("./native-pyrowave-cohort", () => ({
  createNativePyrowaveCohort: async (options: (typeof fixture.cohorts)[number]["options"]) => {
    const close = vi.fn(async () => {});
    fixture.cohorts.push({ options, close });
    return { close, acquisitionExpression: () => 'addRawEncoder("owned")' };
  },
}));
class Helper extends EventEmitter {
  detached = 0;
  async send(method: string) {
    if (method === "Performance.getMetrics")
      return { metrics: [{ name: "Timestamp", value: performance.now() / 1000 }] };
    return { result: { value: true } };
  }
  async detach() {
    this.detached++;
  }
}
function setup() {
  fixture.cohorts = [];
  const helper = new Helper();
  fixture.helper = helper;
  let current = true;
  const capture = new NativeVideoCapture({
    connection: {
      isOpen: true,
      send: async () => ({ targetId: "owned-helper" }),
    } as unknown as CdpConnection,
    targetId: "owned-tab",
    width: 1280,
    height: 800,
    isCurrent: () => current,
    pyrowave: {
      binaryPath: "/trusted/encoder",
      cacheDirectory: "/private/cache",
      credentialDirectory: "/private/.secrets/media",
    },
  });
  return {
    capture,
    helper,
    replace: () => {
      current = false;
    },
  };
}
function emit(generation: number, sequence: number) {
  const cohort = fixture.cohorts[0]!;
  cohort.options.onFrame(
    {
      sequence,
      generation,
      timestampUs: Math.floor(performance.now() * 1000),
      byteLength: 16,
      format: 1,
    },
    Buffer.alloc(16),
    { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
  );
}
it("refuses stale document and wrong-attachment output without changing source timestamps", async () => {
  const { capture, replace } = setup();
  try {
    await capture.read({ codec: "pyrowave", waitMs: 0 });
    emit(1, 1);
    expect((await capture.read({ codec: "pyrowave", waitMs: 0 })).packets).toHaveLength(1);
    capture.invalidateQueuedFrames();
    emit(1, 2);
    expect((await capture.read({ codec: "pyrowave", waitMs: 0 })).packets).toHaveLength(0);
    emit(2, 3);
    const packet = (await capture.read({ codec: "pyrowave", waitMs: 0 })).packets[0]!;
    expect(packet.sequence).toBe(3);
    expect(packet.captureGeneration).toBe(2);
    expect(packet.capturedAtMonotonicMs).toBeLessThanOrEqual(performance.now() + 1);
    replace();
    emit(2, 4);
    expect((await capture.read({ codec: "pyrowave", waitMs: 0 })).status).toBe("unsupported");
  } finally {
    await capture.stop();
  }
  expect(fixture.cohorts[0]!.options.signal.aborted).toBe(true);
  expect(fixture.cohorts[0]!.close).toHaveBeenCalledOnce();
});
it("isolates GPU/device failure to its cohort and still tears down the helper if credential audit fails", async () => {
  const { capture, helper } = setup();
  try {
    await capture.read({ codec: "pyrowave", waitMs: 0 });
    fixture.cohorts[0]!.options.onFailure();
    expect((await capture.read({ codec: "pyrowave", waitMs: 0 })).status).toBe("unsupported");
    expect(capture.sourceFailure).toBeNull();
    expect((await capture.read({ bitrate: 12000000, waitMs: 0 })).status).toBe("waiting");
    fixture.cohorts[0]!.close.mockRejectedValueOnce(new Error("private storage error"));
  } finally {
    await capture.stop();
  }
  expect(helper.detached).toBe(1);
});
