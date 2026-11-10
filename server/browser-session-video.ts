import {
  type BrowserVideoReadInput,
  type BrowserVideoReadReply,
  readBrowserVideoRpc,
  VIDEO_MAX_BATCH_BYTES,
  VIDEO_SOURCE_CLOCK_TOLERANCE_MS,
} from "../shared/browser-video";
import { captureDimensions } from "../shared/capture-settings";
import type { SessionPolicyContext } from "./browser-session-context";
import { asRecord, type BrowserSession, MAX_RECENT_FRAMES } from "./browser-session-types";
import { runtimeVideoPacketSchema } from "./native-video-packet";
import { NAVIGATION_METADATA_TIMEOUT_MS } from "./navigation-budget";
import { createViewerCaptureLifetime } from "./viewer-capture-lifetime";

/**
 * Native video reads for viewers, with the receipts and lifetime that keep idle video from
 * outliving its viewers.
 */
export class VideoReads {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  /**
   * Wait outside mutation serialization. Normal media reads use cached policy
   * state and native generation fences. A newly observed native document needs
   * one bounded reconciliation because video viewers may not request JPEG/status.
   * The transition read never admits packets, even after reconciliation succeeds.
   */
  async readVideo(input: BrowserVideoReadInput): Promise<BrowserVideoReadReply> {
    input = readBrowserVideoRpc.input.parse(input);
    const session = this.context.leases.requireViewer(input.viewerToken);
    const before = await this.context.serialize(session, async () => {
      this.context.leases.pruneExpired(session);
      this.context.leases.heartbeatViewer(session, input.viewerToken);
      if (session.videoReads.has(input.viewerToken)) {
        throw new Error("A video read is already pending for this viewer");
      }
      const state = this.context.projectState(session, input.viewerToken);
      session.videoReads.add(input.viewerToken);
      this.armVideoLifetime(session);
      return {
        state,
        inputGeneration: session.inputGeneration,
        frameRevision: session.frameRevision,
      };
    });

    try {
      const raw = asRecord(
        await this.context.request(session, "video.read", {
          ...(input.codec === undefined ? {} : { codec: input.codec }),
          quality: input.quality,
          ...(input.bitrate === undefined ? {} : { bitrate: input.bitrate }),
          ...(input.fps === undefined ? {} : { fps: input.fps }),
          streamId: input.streamId,
          afterSequence: input.afterSequence,
          waitMs: input.waitMs,
          requestKeyFrame: input.requestKeyFrame,
        }),
      );
      return await this.context.serialize(session, async () => {
        if (this.context.leases.requireViewer(input.viewerToken) !== session || session.archived) {
          throw new Error("Video viewer attachment changed");
        }
        if (raw.inputGeneration !== session.inputGeneration) {
          // External/script navigation must not depend on visual fallback to
          // reconcile policy state. Revoke old receipts first, and discard this
          // entire read: neither pre-transition nor mixed-document pixels qualify.
          this.context.frames.invalidateFrames(session);
          const state = await this.context.snapshotState(
            session,
            input.viewerToken,
            NAVIGATION_METADATA_TIMEOUT_MS,
          );
          if (
            this.context.leases.requireViewer(input.viewerToken) !== session ||
            session.archived
          ) {
            throw new Error("Video viewer attachment changed");
          }
          return { state, status: "reset", streamId: null, packets: [] };
        }
        const state = this.context.projectState(session, input.viewerToken);
        const changed =
          session.frameRevision !== before.frameRevision ||
          state.sessionId !== before.state.sessionId ||
          state.runtimeId !== before.state.runtimeId ||
          state.bridgeEpoch !== before.state.bridgeEpoch ||
          state.navigationGeneration !== before.state.navigationGeneration ||
          state.viewportGeneration !== before.state.viewportGeneration ||
          session.inputGeneration !== before.inputGeneration ||
          raw.inputGeneration !== session.inputGeneration;
        if (changed || state.status !== "ready") {
          return { state, status: "reset", streamId: null, packets: [] };
        }
        const dimensions = captureDimensions(session.viewport, session.captureScale);
        const packets: BrowserVideoReadReply["packets"] = [];
        let bytes = 0;
        if (Array.isArray(raw.packets)) {
          for (const value of raw.packets.slice(0, 32)) {
            const parsed = runtimeVideoPacketSchema.safeParse(value);
            if (!parsed.success) throw new Error("Runtime returned an invalid video packet");
            // Private source time cannot be supplied or changed by a remote viewer.
            const { capturedAtMonotonicMs, ...packet } = parsed.data;
            const age = this.context.monotonicNow() - capturedAtMonotonicMs;
            if (
              (session.videoNotBefore !== null && capturedAtMonotonicMs < session.videoNotBefore) ||
              age < -VIDEO_SOURCE_CLOCK_TOLERANCE_MS ||
              age > 1000 ||
              packet.width !== dimensions.width ||
              packet.height !== dimensions.height
            ) {
              return { state, status: "reset", streamId: null, packets: [] };
            }
            bytes += Buffer.byteLength(packet.dataBase64, "base64");
            if (bytes > VIDEO_MAX_BATCH_BYTES)
              throw new Error("Runtime returned an oversized video batch");
            if (packet.streamId !== raw.streamId)
              throw new Error("Video stream identity changed within a batch");
            const receipt = JSON.stringify([
              packet.streamId,
              packet.captureGeneration,
              packet.sequence,
              packet.timestampUs,
            ]);
            const remembered = session.videoReceipts.get(receipt);
            if (remembered && remembered.capturedAtMonotonicMs !== capturedAtMonotonicMs) {
              throw new Error("Runtime changed an existing video receipt timestamp");
            }
            let frame = remembered?.frame;
            if (!frame) {
              frame = {
                frameId: this.context.issueUniqueToken(),
                sessionId: session.sessionId,
                runtimeId: session.runtimeId,
                captureEpoch: session.bridgeEpoch,
                navigationGeneration: session.navigationGeneration,
                viewportGeneration: session.viewportGeneration,
                width: packet.width,
                height: packet.height,
                capturedAt: packet.capturedAt,
              };
              session.videoReceipts.set(receipt, { frame, capturedAtMonotonicMs });
            }
            // False when input revoked this capture's time: it may still be painted,
            // but it can never authorize a press, and the viewer must not try.
            const actionable = this.context.frames.rememberFrame(
              session,
              input.viewerToken,
              frame,
              capturedAtMonotonicMs,
            );
            packets.push({ ...packet, frame, actionable });
          }
        }
        while (session.videoReceipts.size > MAX_RECENT_FRAMES) {
          const oldest = session.videoReceipts.keys().next().value;
          if (oldest === undefined) break;
          session.videoReceipts.delete(oldest);
        }
        return readBrowserVideoRpc.output.parse({
          state,
          status: raw.status,
          streamId: raw.streamId,
          packets,
          ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
          ...(raw.reasonCode === "encoder-capacity" || raw.reasonCode === "video-disabled"
            ? { reasonCode: raw.reasonCode }
            : {}),
        });
      });
    } finally {
      session.videoReads.delete(input.viewerToken);
    }
  }

  /** Cleanup depends on viewer ownership, never on whether capture produced pixels. */
  async stopUnusedVideo(session: BrowserSession): Promise<void> {
    if (session.viewers.size !== 0) return;
    session.videoLifetime?.cancel();
    await this.context.request(session, "video.stop", null).catch(() => undefined);
    this.context.frames.invalidateFrames(session);
  }

  /** Recheck leases under the same session queue before stopping optional capture. */
  private armVideoLifetime(session: BrowserSession): void {
    session.videoLifetime ??= createViewerCaptureLifetime({
      now: this.context.now,
      latestExpiry: () =>
        session.viewers.size > 0
          ? Math.max(...[...session.viewers.values()].map((viewer) => viewer.expiresAt))
          : null,
      onExpired: () =>
        this.context.serialize(session, async () => {
          if (this.context.sessions.get(session.key) !== session || session.archived) return;
          this.context.leases.pruneExpired(session);
          await this.stopUnusedVideo(session);
        }),
    });
    session.videoLifetime.arm();
  }
}
