import {
  type BrowserGestureEvent,
  type BrowserInputEvent,
  type BrowserState,
  browserCursorSchema,
  browserGestureEventSchema,
  mapDisplayedPoint,
} from "../shared/browser";
import { AgentPointerPresence } from "./agent-pointer";
import { createBrowserFrameRejection } from "./browser-frame-rejection";
import { BrowserGesture } from "./browser-gesture";
import type { SessionPolicyContext } from "./browser-session-context";
import type {
  BeginGestureInput,
  BrowserSession,
  EndGestureInput,
  SendInput,
  UpdateGestureInput,
  UpdateGestureReply,
} from "./browser-session-types";
import { runWithInputCleanup } from "./input-cleanup";
import { sameRuntimeInputAttachment } from "./input-generation";

/**
 * Discrete input and live gestures: admission against fresh frames, dispatch, navigation
 * during input, cursor sampling and cleanup.
 */
export class InputDispatch {
  /** @param context Shared session state and the other policy collaborators. */
  constructor(private readonly context: SessionPolicyContext) {}

  async sendInput(input: SendInput): Promise<{ state: BrowserState }> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.context.leases.requireMutationAccess(session, input);
      this.context.frames.requireRecentFrame(session, input.viewerToken, input.target);
      const assertTargetCurrent = this.discreteInputGuard(session, input);
      try {
        await this.cancelGesture(session);
        await this.dispatchDiscreteInput(session, input.event, assertTargetCurrent);
      } finally {
        const hadVideo = session.videoReceipts.size > 0 || session.videoReads.size > 0;
        // Revoke authority even if auxiliary capture fails. Source-age fencing
        // rejects buffered pre-action video and never overwrites the input outcome.
        this.context.frames.invalidateFrames(session);
        if (hadVideo)
          await this.context.request(session, "video.invalidate", null).catch(() => undefined);
      }
      this.context.leases.renewController(session, input.viewerToken);
      return { state: await this.context.snapshotState(session, input.viewerToken) };
    });
  }

  /**
   * Admit one human channel from a decoded frame receipt that is still fresh.
   * A receipt is bounded by its TTL and cleared by acknowledged input; an idle
   * reopen therefore needs new pixels, never a retained earlier admission. Native
   * begin pins the attachment/document. This never admits agent input.
   */
  async beginGesture(input: BeginGestureInput) {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      this.obsoleteGestureAdmission(session, input, false);
      await this.context.refreshPageMetadata(session);
      session.error = null;
      const refreshed = this.obsoleteGestureAdmission(session, input, true);
      if (refreshed) return refreshed;
      if (!this.context.frames.isRecentFrame(session, input.viewerToken, input.target)) {
        // A pre-input capture can decode after scroll revoked its token. Report
        // known non-publication, not an uncertain runtime failure. The client
        // may obtain another decoded frame before admitting its still-unsent input.
        const state = await this.context.snapshotState(session, input.viewerToken);
        const reconciled = this.obsoleteGestureAdmission(session, input, true);
        if (reconciled) return reconciled;
        if (state.status !== "ready")
          throw new Error(state.error ?? "Browser runtime is unavailable");
        return { state, admission: "stale-frame" as const };
      }
      if (session.inputGeneration === null)
        throw new Error("Browser input identity is unavailable");
      await this.cancelGesture(session);
      const gesture = new BrowserGesture(
        this.context.issueUniqueToken(),
        input.viewerToken,
        input.controlToken,
        input.pointerKind,
        { ...input.expected },
        { ...session.viewport },
        this.context.now(),
        session.inputGeneration,
      );
      session.gesture = gesture;
      try {
        await this.context.request(session, "input.begin", {
          gestureId: gesture.id,
          expectedInputGeneration: gesture.runtimeInputGeneration,
        });
        await this.assertGestureCurrent(session, gesture);
        this.context.leases.renewController(session, input.viewerToken);
        this.scheduleGestureTimeout(session, gesture);
        const state = this.context.projectState(session, input.viewerToken);
        await this.assertGestureCurrent(session, gesture);
        return { state, gestureId: gesture.id, nextSequence: gesture.nextSequence };
      } catch (error) {
        await this.cancelGesture(session, gesture);
        throw error;
      }
    });
  }

  /**
   * Refuse old-document admission without an operation failure or native publication.
   * Only an older navigation is ordinary obsolescence: all other authority fences,
   * future generations, malformed frame context and unavailable state remain errors.
   * Call only before input.begin; this never describes a possibly published mutation.
   * metadataFresh is true only after this admission's ordinary metadata read;
   * cached ready state must not conceal a runtime failure after earlier navigation.
   */
  private obsoleteGestureAdmission(
    session: BrowserSession,
    input: BeginGestureInput,
    metadataFresh: boolean,
  ) {
    this.context.leases.requireMutationAccess(session, {
      ...input,
      expected: { ...input.expected, navigationGeneration: session.navigationGeneration },
    });
    if (input.expected.navigationGeneration >= session.navigationGeneration) {
      this.context.leases.requireMutationAccess(session, input);
      return null;
    }
    if (
      input.target.navigationGeneration !== input.expected.navigationGeneration ||
      input.target.viewportGeneration !== input.expected.viewportGeneration
    ) {
      throw new Error("Browser frame context does not match its expected state");
    }
    if (!metadataFresh) return null;
    const state = this.context.projectState(session, input.viewerToken);
    if (state.status !== "ready") {
      throw new Error(state.error ?? "Browser runtime is unavailable");
    }
    return { state, admission: "obsolete-navigation" as const };
  }

  /**
   * Continue an admitted human channel independently of decoded-frame catchup.
   * Exact control/document/geometry/native checks fence every ordered packet, and
   * every new press (mouse down or first touch contact) needs its own fresh decoded
   * receipt. Held motion and releases reuse the channel. Uncertain publication
   * revokes observations and is never replayed.
   */
  async updateGesture(input: UpdateGestureInput): Promise<UpdateGestureReply> {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      const gesture = this.requireGesture(session, input);
      let publishedEvent: BrowserGestureEvent | null = null;
      let eventAcknowledged = false;
      try {
        this.assertGesturePacketContext(gesture, input.expected);
        const event = browserGestureEventSchema.parse(input.event);
        gesture.assertSequence(input.sequence, this.context.now());
        await this.assertGestureCurrent(session, gesture);
        gesture.validate(event);
        const hover = gesture.isHover(event);
        if (
          event.kind === "down" ||
          (event.kind === "touch" && event.type === "start" && gesture.touches.size === 0)
        ) {
          if (!input.target) throw new Error("A current frame is required for a new press");
          this.context.frames.requireRecentFrame(session, input.viewerToken, input.target);
        }
        // Revoke agent observations before an outcome can become unknown.
        this.invalidateGestureObservations(session, hover);
        if (event.kind === "key") {
          await this.context.request(session, "input.key", {
            gestureId: gesture.id,
            event: {
              kind: event.kind,
              type: event.type,
              key: event.key,
              code: event.code,
              modifiers: event.modifiers,
              repeat: event.repeat,
              ...(event.text !== undefined ? { text: event.text } : {}),
            },
          });
        } else if (event.kind === "text") {
          await this.context.request(session, "input.text", {
            gestureId: gesture.id,
            text: event.text,
          });
        } else if (event.kind === "leave") {
          await this.context.request(session, "mouse.leave", { gestureId: gesture.id });
          gesture.lastPoint = null;
        } else if (event.kind === "touch") {
          const points = event.points.map((point) => ({
            ...gesture.mapPoint(point),
            id: point.id,
          }));
          await this.context.request(session, "touch", {
            gestureId: gesture.id,
            type: event.type,
            points,
          });
        } else {
          const point = gesture.mapPoint(event.point);
          const operation =
            event.kind === "move"
              ? "mouse.move"
              : event.kind === "down"
                ? "mouse.down"
                : event.kind === "up"
                  ? "mouse.up"
                  : "mouse.wheel";
          await this.context.request(session, operation, {
            ...point,
            gestureId: gesture.id,
            ...(event.modifiers === undefined ? {} : { modifiers: event.modifiers }),
            ...(event.kind === "down" || event.kind === "up"
              ? { button: event.button, clickCount: event.clickCount }
              : {}),
            ...(event.kind === "scroll" ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}),
          });
        }
        publishedEvent = event;
        await this.assertGestureCurrent(session, gesture);
        gesture.acknowledge(event, this.context.now());
        eventAcknowledged = true;
        // Fence captures received during publication as well as earlier ones.
        this.invalidateGestureObservations(session, hover);
        this.context.leases.renewController(session, input.viewerToken);
        this.scheduleGestureTimeout(session, gesture);
        const cursor = await this.gestureCursor(session, gesture);
        // An ordinary held-input acknowledgement must not block video behind a
        // page metadata RPC. Native attachment/document checks remain mandatory;
        // their navigation failure uses the qualified completion path below.
        const state = this.context.projectState(session, input.viewerToken);
        await this.assertGestureCurrent(session, gesture);
        return { state, gestureId: gesture.id, nextSequence: gesture.nextSequence, cursor };
      } catch (error) {
        if (publishedEvent) {
          const completion = await this.completeNavigatingInput(
            session,
            gesture,
            publishedEvent,
            eventAcknowledged,
          ).catch(() => null);
          if (completion) return completion;
        }
        await this.cancelGesture(session, gesture);
        throw error;
      }
    });
  }

  /** Revoke observation authority without resetting the continuous video codec. */
  private invalidateGestureObservations(session: BrowserSession, hover: boolean): void {
    session.frameCache.clear();
    if (!hover) {
      session.recentFrames.clear();
      session.videoInputNotBefore = this.context.monotonicNow();
    }
  }

  /** Return a fresh viewing state after acknowledged input navigated, without admitting another input. */
  private async completeNavigatingInput(
    session: BrowserSession,
    gesture: BrowserGesture,
    event: BrowserGestureEvent,
    eventAcknowledged: boolean,
  ) {
    const state = await this.context.snapshotState(session, gesture.viewerToken);
    if (state.navigationGeneration === gesture.expected.navigationGeneration) return null;
    // Runtime inputGeneration is the private native attachment:document tuple.
    // A target replacement can also bump policy navigationGeneration, but must
    // never be accepted as same-attachment navigation after an acknowledged input.
    if (!sameRuntimeInputAttachment(gesture.runtimeInputGeneration, session.inputGeneration))
      return null;

    // Only the old document constraint may change after successful publication.
    // Takeover, viewport changes and runtime/bridge fences are still refused.
    this.context.leases.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: { ...gesture.expected, navigationGeneration: state.navigationGeneration },
    });
    if (!eventAcknowledged) gesture.acknowledge(event, this.context.now());
    await this.cancelGesture(session, gesture);
    const finalState = await this.context.snapshotState(session, gesture.viewerToken);
    if (!sameRuntimeInputAttachment(gesture.runtimeInputGeneration, session.inputGeneration))
      return null;
    this.context.leases.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: { ...gesture.expected, navigationGeneration: finalState.navigationGeneration },
    });
    this.context.frames.invalidateFrames(session);
    this.context.leases.renewController(session, gesture.viewerToken);
    return {
      state: finalState,
      gestureId: gesture.id,
      nextSequence: gesture.nextSequence,
      cursor: null,
      completion: "navigation" as const,
    };
  }

  /** Cancellation releases only this channel, even after a lost update reply or navigation drift. */
  async endGesture(input: EndGestureInput) {
    const session = this.context.leases.requireViewer(input.viewerToken);
    return this.context.serialize(session, async () => {
      const gesture = session.gesture;
      if (!gesture && input.cancel) {
        this.context.leases.requireController(session, input.viewerToken, input.controlToken);
        return { state: this.context.projectState(session, input.viewerToken), cursor: null };
      }
      const owned = this.requireGesture(session, input);
      try {
        if (!input.cancel) {
          this.assertGesturePacketContext(owned, input.expected);
          owned.assertSequence(input.sequence, this.context.now());
          await this.assertGestureCurrent(session, owned);
        }
      } finally {
        await this.cancelGesture(session, owned);
      }
      return { state: this.context.projectState(session, input.viewerToken), cursor: null };
    });
  }

  private requireGesture(
    session: BrowserSession,
    input: UpdateGestureInput | EndGestureInput,
  ): BrowserGesture {
    const gesture = session.gesture;
    if (
      !gesture ||
      gesture.id !== input.gestureId ||
      gesture.viewerToken !== input.viewerToken ||
      gesture.controlToken !== input.controlToken
    )
      throw new Error("Browser gesture is unavailable");
    return gesture;
  }

  private assertGesturePacketContext(
    gesture: BrowserGesture,
    expected: BeginGestureInput["expected"],
  ): void {
    // JSON member order is irrelevant; identity fields must match individually.
    for (const key of [
      "sessionId",
      "runtimeId",
      "bridgeEpoch",
      "navigationGeneration",
      "viewportGeneration",
    ] as const) {
      if (gesture.expected[key] !== expected[key])
        throw new Error("Browser gesture context changed");
    }
  }

  private async assertGestureCurrent(
    session: BrowserSession,
    gesture: BrowserGesture,
  ): Promise<void> {
    this.context.leases.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: gesture.expected,
    });
    if (
      session.gesture !== gesture ||
      this.context.now() >= gesture.idleUntil ||
      this.context.now() >= gesture.expiresAt
    )
      throw new Error("Browser gesture expired");
    // Runtime check pins the CDP document/attachment without repeating a full
    // metadata read for every drag point. Status or a media-generation mismatch
    // reconciles metadata; acknowledged navigation uses its explicit completion.
    await this.context.request(session, "input.check", { gestureId: gesture.id });
    this.context.leases.requireMutationAccess(session, {
      viewerToken: gesture.viewerToken,
      controlToken: gesture.controlToken,
      expected: gesture.expected,
    });
    if (session.gesture !== gesture) throw new Error("Browser gesture was cancelled");
  }

  private async gestureCursor(session: BrowserSession, gesture: BrowserGesture) {
    if (!gesture.lastPoint || gesture.pointerKind !== "mouse") return null;
    try {
      const raw = await this.context.request(session, "cursor", {
        ...gesture.lastPoint,
        gestureId: gesture.id,
      });
      const parsed = browserCursorSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private scheduleGestureTimeout(session: BrowserSession, gesture: BrowserGesture): void {
    if (gesture.timer) clearTimeout(gesture.timer);
    gesture.timer = setTimeout(
      () => {
        void this.context
          .serialize(session, async () => {
            if (
              session.gesture === gesture &&
              this.context.now() >= Math.min(gesture.idleUntil, gesture.expiresAt)
            ) {
              await this.cancelGesture(session, gesture);
            }
          })
          .catch(() => undefined);
      },
      Math.max(1, Math.min(gesture.idleUntil, gesture.expiresAt) - this.context.now()),
    );
    gesture.timer.unref?.();
  }

  async cancelGesture(session: BrowserSession, expected?: BrowserGesture): Promise<void> {
    const gesture = session.gesture;
    if (!gesture || (expected && gesture !== expected)) return;
    session.gesture = null;
    if (gesture.timer) clearTimeout(gesture.timer);
    // Cleanup targets the runtime's original attachment, never a newly navigated
    // or replaced page. Failure is best-effort and cannot replay the input.
    try {
      await this.context.request(session, "input.end", { gestureId: gesture.id });
    } catch {
      /* Best-effort old-attachment cleanup must not escape teardown. */
    }
  }

  /**
   * Retain one freshly admitted observation for this operation only. Runtime
   * latency cannot expire it after publication; control, native document and
   * every attachment/display fence still revoke it. No continuation is exposed.
   */
  private discreteInputGuard(session: BrowserSession, input: SendInput): () => Promise<void> {
    const context = {
      viewerToken: input.viewerToken,
      controlToken: input.controlToken,
      expected: {
        sessionId: session.sessionId,
        runtimeId: session.runtimeId,
        bridgeEpoch: session.bridgeEpoch,
        navigationGeneration: session.navigationGeneration,
        viewportGeneration: session.viewportGeneration,
      },
    };
    const inputGeneration = session.inputGeneration;
    const revision = session.frameRevision;
    return async () => {
      await this.context.refreshPageMetadata(session);
      if (
        inputGeneration !== session.inputGeneration ||
        revision !== session.frameRevision ||
        context.expected.navigationGeneration !== session.navigationGeneration ||
        context.expected.viewportGeneration !== session.viewportGeneration
      ) {
        throw createBrowserFrameRejection("admitted-input", "context-changed");
      }
      this.context.leases.requireMutationAccess(session, context);
    };
  }

  /** Every discrete native primitive (text, key, press, hover, wheel) runs on one private
   * channel pinned to the original attachment and document, which the runtime re-checks
   * before each publication. The ID is never returned to callers and grants no agent
   * continuation. Native end uses the original page even after navigation, revocation
   * or a lost down ACK. */
  private async dispatchDiscreteInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    assertTargetCurrent: () => Promise<void>,
  ): Promise<void> {
    // Reconcile the captured document before anything is published, hover included, so a
    // stalled or failed metadata read holds back every native primitive.
    await assertTargetCurrent();
    if (session.inputGeneration === null) {
      throw new Error("Browser input identity is unavailable");
    }
    const gestureId = this.context.issueUniqueToken();
    await runWithInputCleanup(
      async () => {
        await this.context.request(session, "input.begin", {
          gestureId,
          expectedInputGeneration: session.inputGeneration,
        });
        await this.dispatchInput(session, event, assertTargetCurrent, gestureId);
      },
      () => this.context.request(session, "input.end", { gestureId }),
    );
  }

  private async dispatchInput(
    session: BrowserSession,
    event: BrowserInputEvent,
    assertTargetCurrent: () => Promise<void>,
    gestureId: string,
  ): Promise<void> {
    // The document was reconciled and pinned by dispatchDiscreteInput; the runtime refuses
    // every primitive below once its attachment or document differs from that pin.
    if (event.kind === "move") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await this.context.request(session, "mouse.move", { x: point.x, y: point.y, gestureId });
      this.recordAgentPointer(session, point, "native", false);
      return;
    }
    if (event.kind === "type") {
      await this.context.request(session, "text.insert", {
        text: event.text,
        gestureId,
      });
      return;
    }
    if (event.kind === "key") {
      await this.context.request(session, "key.down", {
        key: event.key,
        gestureId,
      });
      await runWithInputCleanup(assertTargetCurrent, () =>
        this.context.request(session, "key.up", {
          key: event.key,
          gestureId,
        }),
      );
      return;
    }
    if (event.kind === "scroll") {
      const point = mapDisplayedPoint(event.point, session.viewport);
      await this.context.request(session, "mouse.move", { x: point.x, y: point.y, gestureId });
      this.recordAgentPointer(session, point, "native", false);
      await assertTargetCurrent();
      await this.context.request(session, "mouse.wheel", {
        x: point.x,
        y: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        gestureId,
      });
      return;
    }
    const start = mapDisplayedPoint(
      event.kind === "drag" ? event.start : event.point,
      session.viewport,
    );
    await this.context.request(session, "mouse.move", {
      x: start.x,
      y: start.y,
      gestureId,
    });
    this.recordAgentPointer(session, start, "native", false);
    await assertTargetCurrent();
    const count = event.kind === "click" ? event.clickCount : 1;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.context.request(session, "mouse.down", {
        x: start.x,
        y: start.y,
        button: event.button,
        clickCount,
        gestureId,
      });
      this.recordAgentPointer(session, start, "native", true);
      await runWithInputCleanup(
        async () => {
          await assertTargetCurrent();
          if (event.kind === "drag") {
            const end = mapDisplayedPoint(event.end, session.viewport);
            await this.context.request(session, "mouse.move", {
              x: end.x,
              y: end.y,
              gestureId,
            });
            this.recordAgentPointer(session, end, "native", false);
            await assertTargetCurrent();
          }
        },
        async () => {
          const end =
            event.kind === "drag" ? mapDisplayedPoint(event.end, session.viewport) : start;
          await this.context.request(session, "mouse.up", {
            x: end.x,
            y: end.y,
            button: event.button,
            clickCount,
            gestureId,
          });
        },
      );
    }
  }

  /** Publish only trusted agent activity after its native/semantic action acknowledges. */
  recordAgentPointer(
    session: BrowserSession,
    point: { x: number; y: number },
    source: "native" | "semantic",
    click: boolean,
  ): void {
    const controller = session.controller;
    const viewer = controller ? session.viewers.get(controller.viewerToken) : null;
    if (!controller || viewer?.policy.kind !== "agent") return;
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= session.viewport.width ||
      point.y >= session.viewport.height
    )
      return;
    session.agentPointer ??= new AgentPointerPresence();
    session.agentPointer.record(
      {
        runtimeId: session.runtimeId,
        bridgeEpoch: session.bridgeEpoch,
        controlToken: controller.controlToken,
        inputGeneration: session.inputGeneration,
        navigationGeneration: session.navigationGeneration,
        viewportGeneration: session.viewportGeneration,
      },
      { ...point, label: viewer.label, source },
      click,
      this.context.now(),
    );
  }
}
