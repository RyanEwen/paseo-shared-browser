/** Bounded private children, CDP attachments and JSON transport for isolated GPU experiments. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Bound every wait and fail with a phase label instead of silently switching capture paths. */
export async function until(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

/** Every call names its exact page attachment; evaluation stays inside owned test documents. */
export async function evaluate(page, expression) {
  const reply = await page.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    { timeoutMs: 15000 },
  );
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
/** Own all child handles and private browser connections for one experiment incarnation. */
export function createPrototypeProcesses({
  chrome,
  work,
  cleanEnvironment,
  CdpConnection,
  stopOwnedChild,
  reportDirectory,
}) {
  const children = [];
  const connections = [];
  /** Retain exact child handles; teardown never enumerates or kills other browser processes. */
  function child(command, args, name, environment = cleanEnvironment) {
    const handle = spawn(command, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const diagnostics = [];
    handle.stderr.on("data", (data) => {
      if (diagnostics.length < 500) diagnostics.push(data.toString().slice(0, 2000));
    });
    const exited = new Promise((resolve) => {
      handle.once("exit", resolve);
      handle.once("error", (error) => {
        diagnostics.push(String(error));
        resolve();
      });
    });
    children.push({ handle, name, diagnostics, exited });
    return handle;
  }

  /** Private, serial JSON protocol. Replies and pending commands have independent bounds. */
  function rpc(handle, timeoutMs = 15000) {
    let sequence = 0;
    let buffer = "";
    let pending = null;
    let failure = null;
    const fail = (error) => {
      failure ??= error;
      buffer = "";
      pending?.reject(failure);
      pending = null;
    };
    handle.stdout.on("data", (data) => {
      if (failure) return;
      buffer += data.toString();
      if (buffer.length > 8 * 1024 * 1024) {
        fail(new Error("GPU helper reply bound"));
        return;
      }
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const reply = JSON.parse(line);
          if (!pending || reply.id !== pending.id) throw new Error("Unexpected helper reply");
          const current = pending;
          pending = null;
          if (reply.error) current.reject(new Error(reply.error));
          else current.resolve(reply.result);
        } catch (error) {
          fail(error);
          return;
        }
        at = buffer.indexOf("\n");
      }
    });
    handle.once("exit", () => fail(new Error("GPU helper stopped")));
    handle.once("error", fail);
    handle.stdout.once("error", fail);
    handle.stdin.once("error", fail);
    return async (operation, data = {}) => {
      if (failure) throw failure;
      assert(!pending, "GPU helper commands must be serial");
      const id = ++sequence;
      const command = `${JSON.stringify({ ...data, id, operation })}\n`;
      assert(Buffer.byteLength(command) <= 65536, "GPU helper command bound");
      const reply = new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
      });
      const timer = setTimeout(
        () => fail(new Error(`GPU helper timed out: ${operation}`)),
        timeoutMs,
      );
      try {
        handle.stdin.write(command);
      } catch (error) {
        fail(error);
      }
      try {
        return await reply;
      } finally {
        clearTimeout(timer);
      }
    };
  }

  /** Launch an owned stock browser and connect only through its private port file. */
  async function browser(name, args, environment) {
    const profile = join(work, name);
    const process = child(
      chrome,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-backgrounding-occluded-windows",
        "--disable-infobars",
        ...args,
      ],
      name,
      environment,
    );
    const lines = await until(async () => {
      if (process.exitCode !== null) throw new Error(`${name} exited`);
      try {
        return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      } catch {
        return null;
      }
    }, `${name} debugging port`);
    const connection = await CdpConnection.connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    connections.push(connection);
    return connection;
  }

  return {
    child,
    rpc,
    browser,
    async close() {
      const failures = [];
      for (const connection of connections.reverse()) {
        try {
          connection.close();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const { handle, name, diagnostics, exited } of children.reverse()) {
        try {
          await stopOwnedChild(handle, exited, () => handle.stdin.end());
        } catch (error) {
          failures.push(error);
        }
        try {
          await writeFile(join(reportDirectory, `${name}.log`), diagnostics.join(""));
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Prototype cleanup failed");
    },
  };
}
