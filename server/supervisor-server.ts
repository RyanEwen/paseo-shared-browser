/**
 * The supervisor's local socket server: startup lock, credential and endpoint publication,
 * line-delimited request admission, and the standalone process runner.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { readBrowserVideoRpc, runtimeVideoReadInputSchema } from "../shared/browser-video";
import { AgentBindingStore } from "./agent-binding-store";
import {
  formatSupervisorEndpoint,
  parseRuntimeRequest,
  RuntimeProtocolError,
  type RuntimeResponse,
} from "./runtime-protocol";
import { type RuntimeInstance, type RuntimeOwner, RuntimeSupervisor } from "./supervisor";
import { resolveSupervisorPaths, type SupervisorPaths } from "./supervisor-paths";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SOCKET_MODE = 0o600;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SOCKET_IN_FLIGHT = 16;
const MAX_GLOBAL_IN_FLIGHT = 64;
// Optional pixels must leave bounded headroom for ordered input and cleanup.
// JPEG fallback shares the media budget instead of filling those same slots.
const MAX_SOCKET_MEDIA_IN_FLIGHT = 12;
const MAX_GLOBAL_MEDIA_IN_FLIGHT = 48;
// The one active bridge needs maintenance capacity even when normal reads fill
// both limits. Duplicate maintenance remains bounded independently of work.
const MAX_HEARTBEATS_IN_FLIGHT = 1;

/** Bridge identity a socket claimed, released when that socket closes. */
interface ClaimedLease {
  bridgeId: string;
  epoch: number;
}

/**
 * Which capacity a request consumes: the reserved maintenance lane for the current bridge's
 * heartbeat, the bounded media share of ordinary work, or ordinary work.
 */
type AdmissionLane = "maintenance" | "media" | "work";

/** In-flight request counts for one socket or for the whole server. */
class InFlightCounts {
  work = 0;
  media = 0;
  heartbeats = 0;
}

/**
 * Bounds in-flight requests per socket and across the server. Maintenance has its own lane;
 * media shares the ordinary work limits and additionally its own smaller ones.
 */
class RequestAdmission {
  private readonly global = new InFlightCounts();

  /**
   * Claim a slot on a lane for one socket.
   *
   * @returns false, claiming nothing, when either the socket's or the server's limit is full.
   */
  tryAdmit(lane: AdmissionLane, socket: InFlightCounts): boolean {
    if (!this.hasCapacity(lane, socket)) return false;
    this.adjust(lane, socket, 1);
    return true;
  }

  /** Return a slot claimed by `tryAdmit`. */
  release(lane: AdmissionLane, socket: InFlightCounts): void {
    this.adjust(lane, socket, -1);
  }

  private hasCapacity(lane: AdmissionLane, socket: InFlightCounts): boolean {
    const global = this.global;
    if (lane === "maintenance") {
      return (
        socket.heartbeats < MAX_HEARTBEATS_IN_FLIGHT && global.heartbeats < MAX_HEARTBEATS_IN_FLIGHT
      );
    }
    if (socket.work >= MAX_SOCKET_IN_FLIGHT || global.work >= MAX_GLOBAL_IN_FLIGHT) return false;
    if (lane === "media") {
      return socket.media < MAX_SOCKET_MEDIA_IN_FLIGHT && global.media < MAX_GLOBAL_MEDIA_IN_FLIGHT;
    }
    return true;
  }

  private adjust(lane: AdmissionLane, socket: InFlightCounts, delta: number): void {
    for (const counts of [socket, this.global]) {
      if (lane === "maintenance") {
        counts.heartbeats += delta;
        continue;
      }
      counts.work += delta;
      if (lane === "media") counts.media += delta;
    }
  }
}

/**
 * One connected client. Lines run in order on a command tail, except authenticated heartbeats
 * and video reads, which bypass it on their own bounded capacity. A full limit answers that one
 * request with `RUNTIME_BUSY` and pauses the socket until the reply is written.
 */
class SupervisorConnection<Runtime extends RuntimeInstance> {
  private readonly counts = new InFlightCounts();
  private buffer = "";
  private claimed: ClaimedLease | null = null;
  private processing = Promise.resolve();
  private busyResponsePending = false;

  /**
   * @param socket The accepted client socket.
   * @param token This server's credential; every request except agent requests must carry it.
   * @param supervisor Dispatches each parsed request.
   * @param admission Server-wide capacity shared by all connections.
   * @param onClose Called once when the socket closes, after any claimed bridge is released.
   */
  constructor(
    private readonly socket: Socket,
    private readonly token: string,
    private readonly supervisor: RuntimeSupervisor<Runtime>,
    private readonly admission: RequestAdmission,
    onClose: () => void,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      this.drainBufferedLines();
    });
    socket.once("close", () => {
      onClose();
      if (this.claimed) supervisor.bridgeDisconnected(this.claimed.bridgeId, this.claimed.epoch);
    });
  }

  /**
   * Pausing transport does not consume lines already delivered in its current chunk. Drain
   * those after each bounded busy response, without replaying a refused line or creating an
   * unbounded queue of busy-response writes.
   */
  private drainBufferedLines(): void {
    if (this.socket.destroyed || this.busyResponsePending) return;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0 && !this.enqueue(line)) return;
      newline = this.buffer.indexOf("\n");
    }
    this.socket.resume();
  }

  /**
   * Admit one line and schedule its handling.
   *
   * @returns false when the line was refused, in which case draining stops until the busy
   *   reply has been written.
   */
  private enqueue(line: string): boolean {
    const concurrent = classifyConcurrentRequest(line, this.token);
    const maintenance = concurrent === "heartbeat" && isCurrentHeartbeat(line, this.supervisor);
    const media = !maintenance && isMediaRequest(line, this.token);
    let lane: AdmissionLane = "work";
    if (maintenance) lane = "maintenance";
    else if (media) lane = "media";
    if (!this.admission.tryAdmit(lane, this.counts)) return this.rejectBusy(line);

    // Video admission/result fencing already belongs to each workspace's
    // policy queue. Another workspace's teardown must not block that lane.
    const before = concurrent === null ? this.processing : Promise.resolve();
    const execution = before
      .then(() => this.handleAndReply(line))
      .catch(() => undefined)
      .finally(() => {
        this.admission.release(lane, this.counts);
        this.drainBufferedLines();
      });
    // Heartbeats must pass slow page operations, otherwise a healthy bridge
    // expires and its browser is stopped. Video waits also leave the command
    // tail. Only the authenticated current lease uses the separately bounded
    // maintenance lane. Auth, epoch checks and whole ID-keyed writes still apply.
    if (concurrent === null) this.processing = execution;
    return true;
  }

  /** Dispatch one line and write its whole response, remembering a bridge this socket claimed. */
  private async handleAndReply(line: string): Promise<void> {
    const { response, lease } = await handleLine(line, this.token, this.supervisor);
    if (lease) this.claimed = lease;
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(`${JSON.stringify(response)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  /**
   * Answer a refused line with `RUNTIME_BUSY` and pause until that reply is written. A line
   * without a readable request ID cannot be answered, so it closes the socket.
   *
   * @returns Always false, so the caller stops draining.
   */
  private rejectBusy(line: string): boolean {
    let id: string;
    try {
      const request = JSON.parse(line) as { id?: unknown };
      if (typeof request.id !== "string") throw new Error("Missing request id");
      id = request.id;
    } catch {
      this.socket.destroy();
      return false;
    }
    this.busyResponsePending = true;
    this.socket.pause();
    this.socket.write(
      `${JSON.stringify({
        id,
        ok: false,
        error: {
          code: "RUNTIME_BUSY",
          message: "Shared Browser supervisor is busy; retry the request",
        },
      })}\n`,
      (error) => {
        this.busyResponsePending = false;
        if (error) this.socket.destroy();
        else this.drainBufferedLines();
      },
    );
    return false;
  }
}

/**
 * Take the supervisor's startup lock, replacing a lock left by a process that no longer runs.
 *
 * @param path Lock directory; its `pid` file records the holder.
 * @returns A function that releases the lock.
 * @throws When a running process already holds the lock.
 */
export async function acquireStartupLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  await chmod(dirname(path), DIRECTORY_MODE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      await writeFile(join(path, "pid"), String(process.pid), {
        mode: FILE_MODE,
      });
      return async () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const pid = Number.parseInt(await readFile(join(path, "pid"), "utf8").catch(() => ""), 10);
      if (Number.isSafeInteger(pid) && processIsRunning(pid)) {
        throw new Error(`Runtime supervisor already holds startup lock (${pid})`);
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire runtime supervisor startup lock");
}

export interface SupervisorServerOptions {
  /**
   * Workspace reservations this supervisor tracks. With a lazy owner a reservation runs no
   * browser, so the entry point raises it and bounds running browsers in the owner.
   */
  maxWorkspaces?: number;
  /** This supervisor's own agent adapter, published for the stable launcher. */
  adapterPath?: string;
}

/**
 * Start the socket server for one supervisor.
 *
 * @param options See `SupervisorServerOptions`.
 */
export async function startSupervisorServer<Runtime extends RuntimeInstance>(
  owner: RuntimeOwner<Runtime>,
  paths = resolveSupervisorPaths(),
  options: SupervisorServerOptions = {},
): Promise<{
  close: () => Promise<void>;
  supervisor: RuntimeSupervisor<Runtime>;
}> {
  const releaseLock = await acquireStartupLock(paths.lock);
  const supervisor = new RuntimeSupervisor({
    owner,
    ...(options.maxWorkspaces === undefined ? {} : { maxWorkspaces: options.maxWorkspaces }),
    agentBindingStore: new AgentBindingStore(join(paths.root, "agent-bindings.json")),
  });
  const sockets = new Set<Socket>();
  const admission = new RequestAdmission();
  const token = randomBytes(32).toString("base64url");
  const server = createServer((socket) => {
    sockets.add(socket);
    new SupervisorConnection(socket, token, supervisor, admission, () => sockets.delete(socket));
  });

  try {
    await publishSupervisorEndpoint(server, paths, token, options.adapterPath);
  } catch (error) {
    server.close();
    await removeSupervisorEndpoint(paths, releaseLock);
    throw error;
  }

  let closed = false;
  return {
    supervisor,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        supervisor.stopAll(),
      ]);
      try {
        const shutdownFailures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (shutdownFailures.length > 0)
          throw new AggregateError(
            shutdownFailures.map((result) => result.reason),
            "Runtime supervisor shutdown failed",
          );
      } finally {
        await removeSupervisorEndpoint(paths, releaseLock);
      }
    },
  };
}

/**
 * Write the private credential, listen on the socket and only then publish the endpoint file
 * clients discover the supervisor by.
 */
async function publishSupervisorEndpoint(
  server: Server,
  paths: SupervisorPaths,
  token: string,
  adapterPath: string | undefined,
): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(paths.root, DIRECTORY_MODE);
  const tokenHandle = await open(paths.token, "w", FILE_MODE);
  try {
    await tokenHandle.writeFile(token);
  } finally {
    await tokenHandle.close();
  }
  await chmod(paths.token, FILE_MODE);
  await removeSupervisorSocket(paths.socket);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(paths.socket, SOCKET_MODE);
  await writeFile(paths.endpoint, formatSupervisorEndpoint(paths.socket, adapterPath), {
    mode: FILE_MODE,
  });
  await chmod(paths.endpoint, FILE_MODE);
}

/** Remove the socket, endpoint and credential, then release the startup lock; never throws. */
async function removeSupervisorEndpoint(
  paths: SupervisorPaths,
  releaseLock: () => Promise<void>,
): Promise<void> {
  await Promise.allSettled([
    removeSupervisorSocket(paths.socket),
    rm(paths.endpoint, { force: true }),
    rm(paths.token, { force: true }),
    releaseLock(),
  ]);
}

/** Remove a stale Unix socket file; Windows named pipes leave none. */
async function removeSupervisorSocket(path: string): Promise<void> {
  if (process.platform !== "win32") await rm(path, { force: true });
}

/** Classification already verified the token; stale leases cannot consume reserved capacity. */
function isCurrentHeartbeat(line: string, supervisor: RuntimeSupervisor): boolean {
  const request = parseRuntimeRequest(JSON.parse(line));
  return (
    request.method === "bridge.heartbeat" &&
    supervisor.isCurrentBridgeLease(request.bridgeId, request.epoch)
  );
}

/** Capacity-only classification, never an authorization or command-tail bypass. */
function isMediaRequest(line: string, token: string): boolean {
  try {
    const request = parseRuntimeRequest(JSON.parse(line));
    if (request.method === "agent.request") return request.operation === "capture";
    if (!tokensEqual(request.token, token)) return false;
    if (request.method !== "browser.request" && request.method !== "workspace.request")
      return false;
    return (
      request.operation === "video.read" ||
      request.operation === (request.method === "browser.request" ? "capture" : "frame")
    );
  } catch {
    return false;
  }
}

/** Classify authenticated maintenance/media calls without weakening command ordering. */
function classifyConcurrentRequest(line: string, token: string): "heartbeat" | "video" | null {
  try {
    const request = parseRuntimeRequest(JSON.parse(line));
    if (request.method === "agent.request" || !tokensEqual(request.token, token)) return null;
    if (request.method === "bridge.heartbeat") return "heartbeat";
    if (request.method !== "browser.request" && request.method !== "workspace.request") return null;
    if (request.operation !== "video.read") return null;
    const schema =
      request.method === "browser.request"
        ? readBrowserVideoRpc.input
        : runtimeVideoReadInputSchema;
    return schema.safeParse(request.input).success ? "video" : null;
  } catch {
    return null;
  }
}

/**
 * Authenticate and dispatch one request line, always producing a response with the request's
 * own ID when it is readable.
 *
 * @returns The response, and the bridge lease when the request was a successful claim.
 */
async function handleLine<Runtime extends RuntimeInstance>(
  line: string,
  token: string,
  supervisor: RuntimeSupervisor<Runtime>,
): Promise<{
  response: RuntimeResponse;
  lease: { bridgeId: string; epoch: number } | null;
}> {
  let id = "unknown";
  try {
    const raw: unknown = JSON.parse(line);
    // Preserve correlation even when schema validation rejects the operation.
    // Otherwise the caller waits forever for a response carrying its own ID.
    if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string") {
      id = raw.id;
    }
    const request = parseRuntimeRequest(raw);
    id = request.id;
    if (request.method !== "agent.request" && !tokensEqual(request.token, token))
      throw new RuntimeProtocolError("AUTHENTICATION_FAILED", "Invalid supervisor token");
    const result = await supervisor.dispatch(request);
    let lease: { bridgeId: string; epoch: number } | null = null;
    if (request.method === "bridge.claim") {
      if (!result || typeof result !== "object" || !("epoch" in result))
        throw new RuntimeProtocolError("RUNTIME_FAILURE", "Bridge claim returned no epoch");
      lease = { bridgeId: request.bridgeId, epoch: Number(result.epoch) };
    }
    return { response: { id, ok: true, result }, lease };
  } catch (error) {
    const protocolError =
      error instanceof RuntimeProtocolError
        ? error
        : new RuntimeProtocolError(
            "RUNTIME_FAILURE",
            error instanceof Error ? error.message : "Runtime operation failed",
          );
    return {
      response: {
        id,
        ok: false,
        error: { code: protocolError.code, message: protocolError.message },
      },
      lease: null,
    };
  }
}

/** Constant-time credential comparison. */
function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Whether a process exists; one owned by another user still counts as running. */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

/** Run the detached supervisor process until SIGINT or SIGTERM. */
export async function runStandaloneSupervisor(
  owner: RuntimeOwner,
  options: SupervisorServerOptions = {},
): Promise<void> {
  const running = await startSupervisorServer(owner, resolveSupervisorPaths(), options);
  const shutdown = () => void running.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
