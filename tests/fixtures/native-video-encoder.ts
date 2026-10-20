/** Controlled native codec callbacks execute the actual shipped capture helper. */
import { createContext, runInContext } from "node:vm";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "../../server/native-video-extension-source";

/** Delayed native codec output and ACKs, with the shipped trusted program unmodified. */
export async function createNativeVideoEncoderFixture(failFirstEncoder = false, fps = 30) {
  const packets: {
    sequence?: number;
    type?: string;
    timestampUs?: number;
    streamId?: string;
    captureGeneration?: number;
    error?: string;
  }[] = [];
  let now = 100;
  let timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let deliver: (result: unknown) => void = () => {};
  let rejectRead: (error: Error) => void = () => {};
  const reader = {
    read: () =>
      new Promise((resolve, reject) => {
        deliver = resolve;
        rejectRead = reject;
      }),
    cancel: async () => deliver({ done: true }),
  };
  const encoded: { timestamp: number; keyFrame: boolean }[] = [];
  let encoder: Encoder;
  const instances: Encoder[] = [];
  class Encoder {
    pending: { timestamp: number; type: string }[] = [];
    submitted: { timestamp: number; keyFrame: boolean }[] = [];
    closed = false;
    lastOutput: { timestamp: number; type: string } | null = null;
    static async isConfigSupported(candidate: unknown) {
      return { supported: true, config: candidate };
    }
    encodeQueueSize = 0;
    constructor(
      readonly callbacks: {
        output(chunk: unknown, metadata: unknown): void;
        error?(error: unknown): void;
      },
    ) {
      encoder = this;
      instances.push(this);
    }
    configure() {}
    reset() {}
    close() {
      this.closed = true;
    }
    encode(frame: { timestamp: number }, options: { keyFrame: boolean }) {
      if (this.closed) throw new Error("Retired codec cannot accept work");
      if (failFirstEncoder && this === instances[0]) throw new Error("Codec stopped");
      this.encodeQueueSize++;
      const submission = { timestamp: frame.timestamp, keyFrame: options.keyFrame };
      encoded.push(submission);
      this.submitted.push(submission);
      this.pending.push({ timestamp: frame.timestamp, type: options.keyFrame ? "key" : "delta" });
    }
    output() {
      const value = this.pending.shift();
      if (!value) throw new Error("No queued fixture frame");
      this.encodeQueueSize--;
      this.lastOutput = value;
      this.emit(value);
    }
    /** Inject a late duplicate after its timestamp metadata has already been consumed. */
    repeatOutput() {
      if (!this.lastOutput) throw new Error("No previous fixture output");
      this.emit(this.lastOutput);
    }
    private emit(value: { timestamp: number; type: string }) {
      this.callbacks.output(
        { ...value, byteLength: 10, copyTo: (bytes: Uint8Array) => bytes.fill(1) },
        {},
      );
    }
  }
  const context = createContext({
    setTimeout(run: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    chrome: {
      debugger: { getTargets: async () => [{ id: "exact", type: "page", tabId: 7 }] },
      tabCapture: { getMediaStreamId: async () => "stream" },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({
          getVideoTracks: () => [{ getSettings: () => ({ width: 320, height: 240 }) }],
          getTracks: () => [{ stop() {} }],
        }),
      },
    },
    MediaStreamTrackProcessor: class {
      readable = { getReader: () => reader };
    },
    VideoEncoder: Encoder,
    nativeVideoPacket: (json: string) => packets.push(JSON.parse(json)),
    performance: { now: () => now },
    Uint8Array,
    Map,
    Set,
    Object,
    JSON,
    Number,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, context);
  await runInContext('startCapture("exact",320,240,1)', context);
  await runInContext(`addEncoder("high","stream",12000000,${fps})`, context);
  if (failFirstEncoder) {
    await runInContext('addEncoder("low","healthy",2000000,30)', context);
  }
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    packets,
    encoded,
    instances,
    /** Execute due virtual wakes without moving time or creating catch-up credits. */
    runTimers() {
      let count = 0;
      for (;;) {
        const next = [...timers].find(([, timer]) => timer.at <= now);
        if (!next) break;
        if (++count > 100) throw new Error("Unbounded fixture timer loop");
        timers.delete(next[0]);
        next[1].run();
      }
    },
    timerCount: () => timers.size,
    async endReader() {
      deliver({ done: true });
      await turn();
    },
    async failReader() {
      rejectRead(new Error("Owned fixture reader failed"));
      await turn();
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    touch: (quality = "high") => runInContext(`touchEncoder(${JSON.stringify(quality)})`, context),
    addEncoder: (quality: string, streamId: string, bitrate = 2_000_000, frameRate = 30) =>
      runInContext(
        `addEncoder(${JSON.stringify(quality)},${JSON.stringify(streamId)},${bitrate},${frameRate})`,
        context,
      ),
    reset: (generation: number, minimumTimestampUs: number) =>
      runInContext(`resetCapture(${generation},${minimumTimestampUs})`, context),
    async frame(timestamp: number) {
      const frame = {
        timestamp,
        displayWidth: 320,
        displayHeight: 240,
        closes: 0,
        close() {
          this.closes++;
        },
      };
      deliver({ value: frame, done: false });
      await turn();
      return frame;
    },
    output: (index = instances.length - 1) => instances[index]!.output(),
    drop: (index = instances.length - 1) => {
      const codec = instances[index]!;
      if (!codec.pending.shift()) throw new Error("No queued frame to drop");
      codec.encodeQueueSize--;
    },
    repeatOutput: () => encoder!.repeatOutput(),
    ack: () =>
      runInContext(
        'for(const p of fixturePackets) if(typeof p.streamId === "string" && Number.isInteger(p.sequence)) acknowledge(p.streamId,p.sequence)',
        Object.assign(context, { fixturePackets: packets }),
      ),
    request: () => runInContext('requestKeyFrame("high")', context),
    acknowledge: (streamId: string, sequence: number) =>
      runInContext(`acknowledge(${JSON.stringify(streamId)},${sequence})`, context),
    stop: () => runInContext("stopCapture()", context),
  };
}
