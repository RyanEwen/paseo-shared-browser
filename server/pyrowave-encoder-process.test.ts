import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { writePyrowaveHeader } from "../shared/pyrowave-wire";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
const { createPyrowaveEncoderProcess } = await import("./pyrowave-encoder-process");
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pyrowave-process-unit-"));
  directories.push(directory);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit("exit", null, "SIGTERM");
      return true;
    }),
  });
  child.stdin.resume();
  child.stdin.once("finish", () => child.emit("exit", 0, null));
  mock.spawn.mockReturnValueOnce(child);
  const signal = new AbortController();
  const encoder = await createPyrowaveEncoderProcess({
    binaryPath: "/owned/encoder",
    cacheDirectory: directory,
    width: 64,
    height: 64,
    bitrate: 100_000_000,
    fps: 30,
    signal: signal.signal,
  });
  const header = {
    byteLength: 6144,
    sequence: 1,
    timestampUs: 12345,
    generation: 2,
    format: 1 as const,
  };
  const input = Buffer.concat([writePyrowaveHeader(header, "raw"), Buffer.alloc(6144)]);
  const reply = Buffer.concat([
    writePyrowaveHeader({ ...header, byteLength: 8 }, "encoded"),
    Buffer.from("testdata"),
  ]);
  return { child, encoder, signal, header, input, reply };
}

it("bounds work to one frame and matches partial native replies to the exact source metadata", async () => {
  const f = await fixture();
  try {
    const encoded = f.encoder.encode(f.input);
    await expect(f.encoder.encode(f.input)).rejects.toThrow("busy");
    f.child.stdout.write(f.reply.subarray(0, 11));
    f.child.stdout.write(f.reply.subarray(11));
    expect((await encoded).data.toString()).toBe("testdata");
    await expect(f.encoder.encode(f.input)).rejects.toThrow("Invalid raw");
    const options = mock.spawn.mock.calls[0]![2];
    expect(options.env).not.toHaveProperty("PASEO_SHARED_BROWSER_TICKET");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
  } finally {
    await f.encoder.close();
  }
});

it("revokes malformed native output and refuses every subsequent submission", async () => {
  const f = await fixture();
  const pending = f.encoder.encode(f.input);
  const rejected = expect(pending).rejects.toThrow("unavailable");
  const mismatched = f.reply.slice();
  mismatched.writeUInt32LE(3, 24);
  f.child.stdout.write(mismatched);
  await rejected;
  await expect(f.encoder.encode(f.input)).rejects.toThrow("unavailable");
  await f.encoder.close();
});

it("cancellation rejects in-flight work and idempotent cleanup stops only its own process", async () => {
  const f = await fixture();
  const pending = f.encoder.encode(f.input);
  const rejected = expect(pending).rejects.toThrow("unavailable");
  f.signal.abort();
  await rejected;
  await Promise.all([f.encoder.close(), f.encoder.close()]);
  expect(f.child.kill).not.toHaveBeenCalled();
  f.child.stdout.write(f.reply);
  await expect(f.encoder.encode(f.input)).rejects.toThrow("unavailable");
});
