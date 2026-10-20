/** Authenticated binary loopback only. Public viewer delivery remains a separate policy layer. */
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  PYROWAVE_HEADER_BYTES,
  type PyrowaveFrameHeader,
  readPyrowaveHeader,
} from "../shared/pyrowave-wire";
import { type BrowserVideoColorSpace, videoColorSpaceSchema } from "../shared/video-color-space";
import { NATIVE_VIDEO_EXTENSION_ID } from "./native-video-extension";
import { PYROWAVE_CAPTURE_PROTOCOL } from "./pyrowave-capture-protocol";
import {
  createPyrowaveEncoderProcess,
  type PyrowaveEncoderProcessOptions,
} from "./pyrowave-encoder-process";

export { PYROWAVE_CAPTURE_PROTOCOL } from "./pyrowave-capture-protocol";
export interface PyrowaveCaptureChannelOptions extends PyrowaveEncoderProcessOptions {
  /** Caller persists this capability privately before starting the listener. Never put it in a URL. */
  credential: string;
  isCurrent(): boolean;
  /** Called only for the exact submitted source metadata. This does not grant input authority. */
  onFrame(header: PyrowaveFrameHeader, encoded: Buffer, colorSpace: BrowserVideoColorSpace): void;
  onFailure(): void;
}

/** Compare one fixed-size capability without logging credential-bearing request headers. */
function credentialMatches(value: string | undefined, expected: Buffer): boolean {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value);
  return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
}

/** Start a single-client hidden-extension feed with one raw frame in flight.
 * The returned URL has no secret. Only the exact extension origin plus subprotocol capability
 * can connect. Closure revokes admission before ending the socket, child process and listener. */
export async function createPyrowaveCaptureChannel(options: PyrowaveCaptureChannelOptions) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.credential)) {
    throw new Error("Invalid private capture credential");
  }
  const encoder = await createPyrowaveEncoderProcess(options);
  const credential = Buffer.from(options.credential);
  const server = createServer({ maxHeaderSize: 4096 }, (_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.maxConnections = 4;
  server.headersTimeout = 2000;
  server.requestTimeout = 2000;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: PYROWAVE_HEADER_BYTES + (options.width * options.height * 3) / 2,
    perMessageDeflate: false,
    handleProtocols: () => PYROWAVE_CAPTURE_PROTOCOL,
  });
  let client: WebSocket | null = null;
  let accepted = false;
  let busy = false;
  let pendingColor: BrowserVideoColorSpace | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  let startup: Promise<void> | null = null;
  const connections = new Set<Socket>();

  /** Revoke admission synchronously; await only cleanup of resources this channel owns. */
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    client?.terminate();
    for (const socket of connections) socket.destroy();
    closing = (async () => {
      sockets.close();
      // Cancellation may arrive while listen() is pending. Wait for that exact
      // attempt before closing, so a late bind cannot escape teardown.
      await startup?.catch(() => undefined);
      const listenerClosed = new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
      await Promise.all([listenerClosed, encoder.close()]);
    })();
    return closing;
  };
  const abort = () => void close();
  const fail = () => {
    if (closed) return;
    // A fixed classification reaches the owning cohort, never HTTP/parser/driver details.
    void close();
    try {
      options.onFailure();
    } catch {
      // A diagnostic callback cannot escape a socket event and kill the supervisor.
    }
  };

  /** Apply backpressure across copy, stdio and GPU completion. Duplicate/busy submissions
   * are protocol failures rather than a queue of raw browser surfaces. */
  const encode = async (socket: WebSocket, data: Buffer, binary: boolean) => {
    try {
      if (closed || busy || !options.isCurrent()) throw new Error("Capture revoked");
      if (!binary) {
        if (pendingColor || data.byteLength > 512)
          throw new Error("Invalid source colour metadata");
        pendingColor = videoColorSpaceSchema.parse(JSON.parse(data.toString("utf8")));
        return;
      }
      if (!pendingColor) throw new Error("Missing source colour metadata");
      const colorSpace = pendingColor;
      pendingColor = null;
      const header = readPyrowaveHeader(data, "raw");
      if (header.byteLength + PYROWAVE_HEADER_BYTES !== data.byteLength) {
        throw new Error("Incomplete raw frame");
      }
      busy = true;
      const result = await encoder.encode(data);
      if (closed || socket !== client || !options.isCurrent()) return;
      options.onFrame(result.header, result.data, colorSpace);
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      const credit = Buffer.allocUnsafe(4);
      credit.writeUInt32LE(result.header.sequence);
      socket.send(credit, { binary: true }, (error) => {
        if (error) fail();
      });
    } catch {
      fail();
    } finally {
      busy = false;
    }
  };

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setTimeout(2000, () => socket.destroy());
  });
  server.on("upgrade", (request, socket, head) => {
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim());
    if (
      closed ||
      accepted ||
      !options.isCurrent() ||
      !(socket instanceof Socket) ||
      socket.remoteAddress !== "127.0.0.1" ||
      request.url !== "/capture" ||
      request.headers.origin !== `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}` ||
      protocols?.length !== 2 ||
      protocols[0] !== PYROWAVE_CAPTURE_PROTOCOL ||
      !credentialMatches(protocols[1], credential)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // Reserve once, before upgrading. A disconnected capability cannot attach a replacement peer.
    accepted = true;
    socket.setTimeout(0);
    sockets.handleUpgrade(request, socket, head, (connected) => {
      client = connected;
      connected.on("message", (data, binary) => {
        if (!Buffer.isBuffer(data)) {
          fail();
          return;
        }
        void encode(connected, data, binary);
      });
      connected.once("error", fail);
      connected.once("close", fail);
    });
  });
  server.on("error", fail);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted || !options.isCurrent()) throw new Error("Capture revoked");
    startup = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    await startup;
    if (closed || options.signal?.aborted || !options.isCurrent()) {
      throw new Error("Capture revoked");
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Private listener unavailable");
    return { url: `ws://127.0.0.1:${address.port}/capture`, close };
  } catch {
    await close();
    throw new Error("Native PyroWave capture is unavailable");
  }
}
