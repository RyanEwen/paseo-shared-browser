/** Private IPC contracts. No remote RPC can choose worker/module paths or execute code. */
import { z } from "zod";
import { browserMediaObservationEpochSchema } from "../shared/browser-media-wire";
import { browserVideoMetadataSchema, VIDEO_MAX_PACKET_BYTES } from "../shared/browser-video";

const id = z.uuid(),
  requestId = z.number().int().positive().max(0xffffffff);
export const MEDIA_WORKER_MAX_PEERS = 8;
export const mediaWorkerRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open"),
    id,
    offer: z.string().min(1).max(65536),
    observationEpoch: browserMediaObservationEpochSchema,
    bindAddress: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal("frame"),
    id,
    requestId,
    metadata: browserVideoMetadataSchema,
    observationEpoch: browserMediaObservationEpochSchema,
    data: z.custom<Uint8Array>(
      (bytes) =>
        bytes instanceof Uint8Array &&
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= VIDEO_MAX_PACKET_BYTES,
    ),
  }),
  z.object({ kind: z.literal("close"), id }),
]);
export const mediaWorkerReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started") }),
  z.object({ kind: z.literal("answer"), id, sdp: z.string().min(1).max(65536) }),
  z.object({ kind: z.literal("ready"), id }),
  z.object({ kind: z.literal("epoch"), id, observationEpoch: browserMediaObservationEpochSchema }),
  z.object({ kind: z.literal("failed"), id }),
  z.object({ kind: z.literal("frame"), id, requestId, accepted: z.boolean() }),
]);
export type MediaWorkerRequest = z.infer<typeof mediaWorkerRequestSchema>;
export type MediaWorkerReply = z.infer<typeof mediaWorkerReplySchema>;
