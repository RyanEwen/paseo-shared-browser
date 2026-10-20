/** Detached from the supervisor's JS/native heap. This process owns every peer it can close. */
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { createBrowserMediaPeer } from "./browser-media-peer";
import {
  MEDIA_WORKER_MAX_PEERS,
  type MediaWorkerReply,
  mediaWorkerRequestSchema,
} from "./browser-media-worker-protocol";

const peers = new Map<
  string,
  { abort: AbortController; media: ReturnType<typeof createBrowserMediaPeer> | null }
>();
let closing = false,
  binding: typeof import("node-datachannel") | null = null;
/** Only bounded fixed-shape responses reach the parent; never SDP/parser diagnostics. */
function reply(value: MediaWorkerReply): void {
  if (closing || !process.connected) return;
  try {
    process.send?.(value, () => {});
  } catch {
    /* Parent disconnection owns shutdown. */
  }
}
function remove(id: string): void {
  const record = peers.get(id);
  if (!record) return;
  peers.delete(id);
  record.abort.abort();
  record.media?.close();
}
/** Every native peer belongs to this worker, so library cleanup cannot touch user services. */
function stop(): void {
  if (closing) return;
  closing = true;
  for (const id of peers.keys()) remove(id);
  try {
    binding?.cleanup();
  } finally {
    process.exit(0);
  }
}
process.once("disconnect", stop);
process.once("SIGTERM", stop);

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || !isAbsolute(directory) || !process.send)
    throw new Error("Missing private transport assets");
  binding = createRequire(join(directory, "package.json"))(
    "node-datachannel",
  ) as typeof import("node-datachannel");
  if (closing) return;
  const native = binding;
  process.on("message", (value) => {
    const parsed = mediaWorkerRequestSchema.safeParse(value);
    if (!parsed.success) {
      stop();
      return;
    }
    const message = parsed.data;
    if (message.kind === "close") {
      remove(message.id);
      return;
    }
    if (message.kind === "frame") {
      const record = peers.get(message.id);
      const transfer =
        record?.media?.send(message.metadata, message.data, message.observationEpoch) ?? null;
      reply({
        kind: "frame",
        id: message.id,
        requestId: message.requestId,
        accepted: transfer !== null,
      });
      return;
    }
    if (peers.has(message.id) || peers.size >= MEDIA_WORKER_MAX_PEERS) {
      reply({ kind: "failed", id: message.id });
      return;
    }
    const record = {
      abort: new AbortController(),
      media: null as ReturnType<typeof createBrowserMediaPeer> | null,
    };
    peers.set(message.id, record);
    try {
      record.media = createBrowserMediaPeer({
        observationEpoch: message.observationEpoch,
        onObservationEpoch: (epoch) =>
          reply({ kind: "epoch", id: message.id, observationEpoch: epoch }),
        offer: message.offer,
        ...(message.bindAddress ? { bindAddress: message.bindAddress } : {}),
        signal: record.abort.signal,
        isCurrent: () => !closing && peers.get(message.id) === record,
        createPeer: (name, configuration) => new native.PeerConnection(name, configuration),
        onReady: () => reply({ kind: "ready", id: message.id }),
        onFailure: () => {
          remove(message.id);
          reply({ kind: "failed", id: message.id });
        },
      });
      void record.media.answer
        .then((sdp) => {
          if (peers.get(message.id) === record) reply({ kind: "answer", id: message.id, sdp });
        })
        .catch(() => {
          remove(message.id);
          reply({ kind: "failed", id: message.id });
        });
    } catch {
      remove(message.id);
      reply({ kind: "failed", id: message.id });
    }
  });
  reply({ kind: "started" });
}
void main().catch(() => {
  closing = true;
  process.exit(1);
});
