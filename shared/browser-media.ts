/** Authenticated signaling only. Media never carries browser mutation/control commands. */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { browserFrameSchema, browserStateSchema } from "./browser";
import { browserMediaObservationEpochSchema } from "./browser-media-wire";
import { nativeVideoPacketSchema } from "./browser-video";
import { pyrowaveBitrateSchema } from "./pyrowave-settings";
import { videoFrameRateSchema } from "./video-settings";

export const browserMediaSourceSchema = browserStateSchema
  .pick({
    workspaceId: true,
    tabId: true,
    sessionId: true,
    runtimeId: true,
    bridgeEpoch: true,
    navigationGeneration: true,
    viewportGeneration: true,
  })
  .required();
export type BrowserMediaSource = z.infer<typeof browserMediaSourceSchema>;
/** Exact source binding, including tab/workspace, checked before and after asynchronous work. */
export function isBrowserMediaSourceCurrent(
  source: BrowserMediaSource,
  state: z.infer<typeof browserStateSchema>,
): boolean {
  return (
    state.status === "ready" &&
    source.workspaceId === state.workspaceId &&
    source.tabId === state.tabId &&
    source.sessionId === state.sessionId &&
    source.runtimeId === state.runtimeId &&
    source.bridgeEpoch === state.bridgeEpoch &&
    source.navigationGeneration === state.navigationGeneration &&
    source.viewportGeneration === state.viewportGeneration
  );
}
export const browserMediaCapabilitiesRpc = defineRpc({
  name: "shared-browser.media.capabilities",
  input: z.object({}),
  output: z.object({ pyrowave: z.boolean(), reason: z.string().max(256).optional() }),
});
const viewerToken = browserFrameSchema.shape.frameId;
export const openBrowserMediaRpc = defineRpc({
  name: "shared-browser.media.open",
  input: z.object({
    viewerToken,
    source: browserMediaSourceSchema,
    offer: z.string().min(1).max(65536),
    observationEpoch: browserMediaObservationEpochSchema,
    bitrate: pyrowaveBitrateSchema,
    fps: videoFrameRateSchema,
  }),
  output: z.object({
    state: browserStateSchema,
    status: z.enum(["ready", "unsupported", "reset"]),
    transportId: z.uuid().nullable(),
    answer: z.string().max(65536).nullable(),
    reason: z.string().max(256).optional(),
  }),
});
export const pollBrowserMediaRpc = defineRpc({
  name: "shared-browser.media.poll",
  input: z.object({
    viewerToken,
    transportId: z.uuid(),
    // Reliable heartbeats renew observation after a lost unreliable epoch message.
    observationEpoch: browserMediaObservationEpochSchema.optional(),
  }),
  output: z.object({
    state: browserStateSchema,
    status: z.enum(["connecting", "streaming", "unsupported", "reset"]),
    sequence: nativeVideoPacketSchema.shape.sequence,
    reason: z.string().max(256).optional(),
  }),
});
export const closeBrowserMediaRpc = defineRpc({
  name: "shared-browser.media.close",
  input: z.object({ viewerToken, transportId: z.uuid() }),
  output: z.object({ closed: z.literal(true) }),
});
export type OpenBrowserMediaInput = z.infer<typeof openBrowserMediaRpc.input>;
export type OpenBrowserMediaReply = z.infer<typeof openBrowserMediaRpc.output>;
export type PollBrowserMediaInput = z.infer<typeof pollBrowserMediaRpc.input>;
export type PollBrowserMediaReply = z.infer<typeof pollBrowserMediaRpc.output>;
