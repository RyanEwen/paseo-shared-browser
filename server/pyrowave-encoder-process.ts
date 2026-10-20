/** One bounded native GPU encoder. Stdio is private to its parent, never a public transport. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  type PyrowaveConfiguration,
  pyrowaveConfigurationSchema,
} from "../shared/pyrowave-settings";
import {
  PYROWAVE_HEADER_BYTES,
  PYROWAVE_MAX_ENCODED_BYTES,
  type PyrowaveFrameHeader,
  readPyrowaveHeader,
} from "../shared/pyrowave-wire";

import { stopOwnedChild } from "./owned-child";

export interface PyrowaveEncoderProcessOptions extends PyrowaveConfiguration {
  binaryPath: string;
  cacheDirectory: string;
  signal?: AbortSignal;
}
export interface EncodedPyrowaveFrame {
  header: PyrowaveFrameHeader;
  data: Buffer;
}
interface PendingFrame {
  header: PyrowaveFrameHeader;
  resolve(frame: EncodedPyrowaveFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const FAILURE = "Native PyroWave encoder is unavailable";
const MAX_REPLY_BYTES = PYROWAVE_HEADER_BYTES + PYROWAVE_MAX_ENCODED_BYTES;

/** Allocate one validated process, with a private shader cache and no inherited agent secrets.
 * GPU initialization errors surface on the first frame; callers can retain H.264/JPEG fallback. */
export async function createPyrowaveEncoderProcess(options: PyrowaveEncoderProcessOptions) {
  const configuration = pyrowaveConfigurationSchema.parse(options);
  if (!isAbsolute(options.binaryPath) || !isAbsolute(options.cacheDirectory)) {
    throw new Error("PyroWave runtime paths must be absolute");
  }
  if (options.signal?.aborted) throw new Error("Native PyroWave encoder was cancelled");
  await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
  if (options.signal?.aborted) throw new Error("Native PyroWave encoder was cancelled");
  return new PyrowaveEncoderProcess(options, configuration);
}

/** Serialize at most one frame in flight. Busy callers must drop rather than queue raw media. */
class PyrowaveEncoderProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private pending: PendingFrame | null = null;
  private buffered = Buffer.allocUnsafe(MAX_REPLY_BYTES);
  private bufferedLength = 0;
  private lastSequence = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly abort = () => void this.close();

  constructor(
    private readonly options: PyrowaveEncoderProcessOptions,
    configuration: PyrowaveConfiguration,
  ) {
    this.child = spawn(
      options.binaryPath,
      [configuration.width, configuration.height, configuration.bitrate, configuration.fps].map(
        String,
      ),
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          XDG_CACHE_HOME: options.cacheDirectory,
        },
      },
    );
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        resolve();
        this.fail();
      });
      this.child.once("error", () => {
        resolve();
        this.fail();
      });
    });
    this.child.stdout.on("data", this.receive);
    this.child.stdout.on("error", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    // Drain diagnostics without forwarding paths or driver messages to viewers.
    this.child.stderr.resume();
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  /** Submit an exact contiguous I420/NV12 frame. The response echoes source timing/generation;
   * callers must still check current runtime/tab/document policy before publication. */
  encode(bytes: Buffer): Promise<EncodedPyrowaveFrame> {
    if (this.closed) return Promise.reject(new Error(FAILURE));
    if (this.pending) return Promise.reject(new Error("Native PyroWave encoder is busy"));
    let header: PyrowaveFrameHeader;
    try {
      header = readPyrowaveHeader(bytes, "raw");
      if (
        header.byteLength !== (this.options.width * this.options.height * 3) / 2 ||
        bytes.byteLength !== header.byteLength + PYROWAVE_HEADER_BYTES ||
        header.sequence <= this.lastSequence
      ) {
        throw new Error("Invalid raw PyroWave frame");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    this.lastSequence = header.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 5000);
      this.pending = { header, resolve, reject, timer };
      this.child.stdin.write(bytes, (error) => {
        if (error) this.fail();
      });
    });
  }

  /** Consume partial stdout chunks without allowing unbounded allocation or unsolicited output. */
  private readonly receive = (chunk: Buffer): void => {
    if (this.closed) return;
    const pending = this.pending;
    if (!pending || chunk.byteLength > MAX_REPLY_BYTES - this.bufferedLength) {
      this.fail();
      return;
    }
    chunk.copy(this.buffered, this.bufferedLength);
    this.bufferedLength += chunk.byteLength;
    if (this.bufferedLength < PYROWAVE_HEADER_BYTES) return;
    try {
      const header = readPyrowaveHeader(this.buffered, "encoded");
      const expected = pending.header;
      if (
        header.sequence !== expected.sequence ||
        header.timestampUs !== expected.timestampUs ||
        header.generation !== expected.generation ||
        header.format !== expected.format ||
        this.bufferedLength > PYROWAVE_HEADER_BYTES + header.byteLength
      ) {
        throw new Error(FAILURE);
      }
      if (this.bufferedLength < PYROWAVE_HEADER_BYTES + header.byteLength) return;
      // Consumers retain independent frames while the fixed read buffer is reused.
      const data = Buffer.from(this.buffered.subarray(PYROWAVE_HEADER_BYTES, this.bufferedLength));
      this.bufferedLength = 0;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve({ header, data });
    } catch {
      this.fail();
    }
  };

  /** Revoke pending authority before stopping a failed process, without exposing diagnostics. */
  private fail(): void {
    const pending = this.pending;
    this.pending = null;
    this.bufferedLength = 0;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(FAILURE));
    }
    void this.close();
  }

  /** Idempotently revoke admission, then stop only this exact child. A hung driver gets
   * a bounded grace period before stronger termination; no supervisor/daemon signal is sent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    const pending = this.pending;
    this.pending = null;
    this.buffered = Buffer.alloc(0);
    this.bufferedLength = 0;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(FAILURE));
    }
    this.closing = this.stopChild();
    return this.closing;
  }

  /** EOF normally releases the Vulkan device; escalation is confined to the owned ChildProcess. */
  private async stopChild(): Promise<void> {
    await stopOwnedChild(this.child, this.exited, () => this.child.stdin.end());
  }
}
