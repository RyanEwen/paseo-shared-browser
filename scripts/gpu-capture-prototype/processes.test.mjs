import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createPrototypeProcesses } from "./processes.mjs";

/** Simulate only the private helper transport, without spawning a browser or opening a GPU. */
function fixture() {
  const handle = new EventEmitter();
  handle.stdin = new PassThrough();
  handle.stdout = new PassThrough();
  const { rpc } = createPrototypeProcesses({});
  return { handle, call: rpc(handle, 20) };
}

test("fragmented replies and domain failures preserve serial transport", async () => {
  const { handle, call } = fixture();
  const first = call("clock", { id: 999, operation: "override" });
  const command = JSON.parse(handle.stdin.read().toString());
  assert.equal(command.id, 1);
  assert.equal(command.operation, "clock");
  handle.stdout.write('{"id":1,"res');
  handle.stdout.write('ult":42}\n');
  assert.equal(await first, 42);
  const failed = call("poll");
  handle.stdout.write('{"id":2,"error":"retired"}\n');
  await assert.rejects(failed, /retired/);
  const next = call("clock");
  handle.stdout.write('{"id":3,"result":43}\n');
  assert.equal(await next, 43);
});

for (const reason of ["wrong id", "oversized", "timeout", "stdin failure", "exit"]) {
  test(`transport permanently fails after ${reason}`, async () => {
    const { handle, call } = fixture();
    const pending = call("poll");
    const rejection = assert.rejects(pending);
    if (reason === "wrong id") handle.stdout.write('{"id":9,"result":true}\n');
    if (reason === "oversized") handle.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
    if (reason === "stdin failure") handle.stdin.emit("error", new Error("closed"));
    if (reason === "exit") handle.emit("exit", 1);
    await rejection;
    handle.stdout.write('{"id":1,"result":true}\n');
    await assert.rejects(call("clock"));
  });
}

test("oversized commands fail before ownership or writes", async () => {
  const { handle, call } = fixture();
  await assert.rejects(call("move", { value: "x".repeat(65536) }), /command bound/);
  assert.equal(handle.stdin.read(), null);
  const next = call("clock");
  handle.stdout.write('{"id":2,"result":true}\n');
  assert.equal(await next, true);
});
