import {
  type BrowserCursor,
  type BrowserGestureKeyEvent,
  browserCursorSchema,
  browserGestureKeySchema,
  MAX_HELD_BROWSER_KEYS,
} from "../shared/browser";
import type { RuntimeAttachment } from "./agent-browser-attachment";
import type { MouseButton } from "./agent-browser-types";
import { browserCursorExpression } from "./browser-cursor";
import { GESTURE_IDLE_MS, GESTURE_LIFETIME_MS } from "./browser-gesture";
import { type CdpSession, CdpUnavailableError } from "./cdp";
import { heldKeyModifiers, nativeKeyEvent, normalizeDiscreteKey } from "./keyboard-input";

// Cursor decoration must not hold the serialized input/video fence while page
// scripts are busy. A missed sample leaves input and its cleanup unchanged.
const CURSOR_SAMPLE_TIMEOUT_MS = 250;

/** Page operations input dispatch needs from its runtime. */
export interface RuntimeInputHost {
  /** The current page, restored and settled; may reconnect. */
  requirePage(): Promise<CdpSession>;
  /** Clear cached and awaited pixels, which input may have made stale. */
  invalidateScreencastFrame(): void;
}

/** A live input channel bound to one exact attachment and document. */
interface LiveInputChannel {
  id: string;
  page: CdpSession;
  generation: number;
  documentGeneration: number;
  idleUntil: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Native mouse, keyboard and touch input for one page controller, with the cleanup state for
 * everything it may still hold pressed.
 *
 * Cleanup intent is recorded at the send boundary, because a press can be published even when
 * its acknowledgement is lost. Held state belongs to the attachment it was published on and is
 * released only there, never replayed on a replacement.
 */
export class RuntimeInput {
  private heldButtons = new Set<MouseButton>();
  /** Last native pointer position sent, so cancelled drags release where they were. */
  private lastMousePoint = { x: 0, y: 0 };
  private heldKeys = new Map<string, { key: string; code: string }>();
  private heldTouches = false;
  /** Attachment on which the current held state was published; cleanup never targets another. */
  private heldOwner: CdpSession | null = null;
  private activeTouches = new Map<number, { x: number; y: number; id: number }>();
  private liveInput: LiveInputChannel | null = null;

  /**
   * @param attachment The controller's shared page attachment.
   * @param host Page operations owned by the runtime.
   */
  constructor(
    private readonly attachment: RuntimeAttachment,
    private readonly host: RuntimeInputHost,
  ) {}

  /** End the current live input channel, if any, releasing what it holds on its own page. */
  async endCurrentLiveInput(): Promise<void> {
    if (this.liveInput) await this.endLiveInput(this.liveInput.id);
  }

  /** End the current channel without waiting, after its document or page was replaced. */
  abandonLiveInput(): void {
    void this.endLiveInput(this.liveInput?.id ?? "").catch(() => undefined);
  }

  /**
   * Whether a DOM action may use this channel: it must be the current, unexpired channel bound
   * to exactly this page.
   */
  liveInputAdmits(gestureId: unknown, page: CdpSession): boolean {
    return !(
      !this.liveInput ||
      this.liveInput.id !== gestureId ||
      this.liveInput.page !== page ||
      Date.now() >= this.liveInput.idleUntil ||
      Date.now() >= this.liveInput.expiresAt
    );
  }

  /** Invalidate pre-input pixels even if Chromium cannot confirm the mutation. */
  private async dispatchInput(
    method: string,
    params: Record<string, unknown>,
    gestureId?: string,
    mouseModifiers?: number,
    track?: () => void,
  ): Promise<void> {
    try {
      const page = await this.host.requirePage();
      if (gestureId) await this.assertLiveInput(gestureId);
      // Authority is validated. Record cleanup intent only now, immediately before
      // native publication, so rejected unsent packets never alter it while an
      // uncertain acknowledgement still leaves it in place.
      if (track) {
        if (this.heldOwner && this.heldOwner !== page) this.discardHeldState();
        track();
        if (this.holdsInput()) this.heldOwner ??= page;
      }
      const originalInput = gestureId ? this.liveInput : null;
      // A physical DOM mouse event may arrive after Control/Shift was pressed
      // outside this canvas. Explicit zero also overrides a prior held-key mask.
      const modifiers = mouseModifiers ?? heldKeyModifiers(this.heldKeys.values());
      const nativeParams =
        method === "Input.dispatchMouseEvent" && (mouseModifiers !== undefined || modifiers !== 0)
          ? { ...params, modifiers }
          : params;
      await page.send(method, nativeParams, { mutation: true });
      if (gestureId) {
        // An input can synchronously activate a link or submit a form. Its CDP
        // acknowledgment succeeds even when navigation ends the old channel.
        // Attachment replacement and uncertain sends retain their failure path.
        if (
          originalInput &&
          page === this.attachment.page &&
          originalInput.generation === this.attachment.attachmentGeneration &&
          originalInput.documentGeneration !== this.attachment.documentGeneration
        ) {
          await this.endLiveInput(gestureId);
          return;
        }
        await this.assertLiveInput(gestureId);
        this.renewLiveInput(gestureId);
      }
    } finally {
      this.host.invalidateScreencastFrame();
    }
  }

  async mouseMove(x: number, y: number, gestureId?: string, modifiers?: number): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y,
        // Native scrollbar dragging needs the held button as well as its mask.
        button: this.heldMoveButton(),
        buttons: this.buttonMask(),
      },
      gestureId,
      modifiers,
      () => {
        this.lastMousePoint = { x, y };
      },
    );
  }

  /** Fixed native mouse departure; never maps an outside point to a page control. */
  async mouseLeave(gestureId: string): Promise<void> {
    if (this.heldButtons.size > 0) throw new Error("Release held mouse buttons before leaving");
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: -1,
        y: -1,
        button: "none",
        buttons: 0,
      },
      gestureId,
    );
  }

  async mouseDown(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
    gestureId?: string,
    modifiers?: number,
  ): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: this.buttonMask(button),
        clickCount,
      },
      gestureId,
      modifiers,
      () => {
        // Publication may succeed before an acknowledgement is lost, so a
        // possibly held button is tracked from the send boundary.
        this.heldButtons.add(button);
        this.lastMousePoint = { x, y };
      },
    );
  }

  async mouseUp(
    x: number,
    y: number,
    button: MouseButton = "left",
    clickCount = 1,
    gestureId?: string,
    modifiers?: number,
  ): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: this.buttonMask(undefined, button),
        clickCount,
      },
      gestureId,
      modifiers,
      () => {
        this.lastMousePoint = { x, y };
      },
    );
    this.heldButtons.delete(button);
  }

  async wheel(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    gestureId?: string,
    modifiers?: number,
  ): Promise<void> {
    this.assertPoint(x, y);
    this.assertMouseModifiers(modifiers);
    await this.dispatchInput(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        button: "none",
        buttons: this.buttonMask(),
      },
      gestureId,
      modifiers,
    );
  }

  /** Insert a committed paste/IME value on the original guarded attachment. */
  async insertText(text: string, gestureId?: string): Promise<void> {
    await this.dispatchInput("Input.insertText", { text }, gestureId);
  }

  /** Track cleanup intent before publication, including an uncertain key-down reply. */
  async dispatchKey(event: BrowserGestureKeyEvent, gestureId: string): Promise<void> {
    const parsed = browserGestureKeySchema.parse(event);
    await this.assertLiveInput(gestureId);
    const held = this.heldKeys.has(parsed.code);
    if (parsed.type === "down" && held !== parsed.repeat) {
      throw new Error(
        parsed.repeat ? "Key repeat has no matching press" : "Key is already pressed",
      );
    }
    if (parsed.type === "up" && !held) throw new Error("Key release has no matching press");
    if (parsed.type === "down") this.assertHeldKeyCapacity(parsed.code);
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      nativeKeyEvent(parsed),
      gestureId,
      undefined,
      parsed.type === "down"
        ? () => this.heldKeys.set(parsed.code, { key: parsed.key, code: parsed.code })
        : undefined,
    );
    if (parsed.type === "up") this.heldKeys.delete(parsed.code);
  }

  /** Track intent before publication. Internal discrete presses can use the
   * same opaque channel as live input so a lost ACK retains original-page cleanup. */
  async keyDown(key: string, code = key, gestureId?: string): Promise<void> {
    const normalized = normalizeDiscreteKey(key, code);
    if (gestureId) await this.assertLiveInput(gestureId);
    this.assertHeldKeyCapacity(normalized.code);
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      nativeKeyEvent({ kind: "key", type: "down", ...normalized, modifiers: 0, repeat: false }),
      gestureId,
      undefined,
      () => this.heldKeys.set(normalized.code, normalized),
    );
  }

  /** Release on a current channel; its end cleanup still owns the original
   * page if navigation or attachment loss prevents this ordinary key-up. */
  async keyUp(key: string, code = key, gestureId?: string): Promise<void> {
    const normalized = normalizeDiscreteKey(key, code);
    await this.dispatchInput(
      "Input.dispatchKeyEvent",
      nativeKeyEvent({ kind: "key", type: "up", ...normalized, modifiers: 0, repeat: false }),
      gestureId,
    );
    this.heldKeys.delete(normalized.code);
  }

  /**
   * The caller supplies the complete active contact set. CDP touchMove does not
   * release omitted contacts, so publish explicit contact ends before moving the
   * survivors. Any uncertain publication retains cleanup intent until cancel.
   */
  async touch(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    points: Array<{ x: number; y: number; id?: number }>,
    gestureId?: string,
  ): Promise<void> {
    for (const point of points) this.assertPoint(point.x, point.y);
    if (gestureId) await this.assertLiveInput(gestureId);
    const contacts = points.map((point, index) => ({ ...point, id: point.id ?? index }));
    const activeIds = new Set(contacts.map((point) => point.id));
    const removed =
      type === "touchMove"
        ? [...this.activeTouches.values()].filter((point) => !activeIds.has(point.id))
        : [];
    const hold = () => {
      this.heldTouches = true;
    };
    if (removed.length > 0) {
      await this.dispatchInput(
        "Input.dispatchTouchEvent",
        { type: "touchEnd", touchPoints: removed },
        gestureId,
        undefined,
        hold,
      );
    }
    await this.dispatchInput(
      "Input.dispatchTouchEvent",
      { type, touchPoints: contacts },
      gestureId,
      undefined,
      hold,
    );
    // Navigation cleanup already discarded this channel's contacts. Do not
    // recreate held-touch state after its acknowledged start caused navigation.
    if (gestureId && this.liveInput?.id !== gestureId) return;
    this.activeTouches.clear();
    if (type === "touchStart" || type === "touchMove") {
      for (const point of contacts) this.activeTouches.set(point.id, point);
    }
    this.heldTouches = this.activeTouches.size > 0;
  }

  /**
   * Bind decoded geometry to its exact native attachment and document. Compare
   * after cleanup/reattach awaits so a same-URL reload cannot silently admit a
   * press against a replacement page. A mismatch publishes no physical input.
   */
  async beginLiveInput(id: string, expectedInputGeneration: string): Promise<void> {
    if (this.liveInput) await this.endLiveInput(this.liveInput.id);
    const page = await this.host.requirePage();
    const actualInputGeneration = this.attachment.inputGeneration();
    if (expectedInputGeneration !== actualInputGeneration) {
      throw new CdpUnavailableError("Live browser input attachment changed before admission");
    }
    // No asynchronous boundary may separate this comparison from the binding.
    const now = Date.now();
    this.liveInput = {
      id,
      page,
      generation: this.attachment.attachmentGeneration,
      documentGeneration: this.attachment.documentGeneration,
      idleUntil: now + GESTURE_IDLE_MS,
      expiresAt: now + GESTURE_LIFETIME_MS,
      timer: null,
    };
    this.scheduleLiveInputExpiry();
  }

  /** Compare after every asynchronous transport boundary, including automatic reconnect/reattach. */
  async assertLiveInput(id: string): Promise<void> {
    const page = await this.host.requirePage();
    if (
      this.liveInput?.id === id &&
      (Date.now() >= this.liveInput.idleUntil || Date.now() >= this.liveInput.expiresAt)
    ) {
      await this.endLiveInput(id);
    }
    if (
      !this.liveInput ||
      this.liveInput.id !== id ||
      this.liveInput.page !== page ||
      this.liveInput.generation !== this.attachment.attachmentGeneration ||
      this.liveInput.documentGeneration !== this.attachment.documentGeneration
    ) {
      throw new CdpUnavailableError("Live browser input attachment changed");
    }
  }

  /** Cleanup is idempotent and targets the original attachment, never whatever is currently active. */
  async endLiveInput(id: string): Promise<void> {
    const current = this.liveInput;
    if (!current || current.id !== id) return;
    this.liveInput = null;
    if (current.timer) clearTimeout(current.timer);
    await this.releaseHeldInput(current.page);
  }

  /** Only acknowledged input extends idle time; metadata/checks cannot keep a stranded press alive. */
  private renewLiveInput(id: string): void {
    if (this.liveInput?.id !== id) return;
    this.liveInput.idleUntil = Date.now() + GESTURE_IDLE_MS;
    this.scheduleLiveInputExpiry();
  }

  /** Runtime-owned expiry survives plugin disconnect or a fenced supervisor IPC client. */
  private scheduleLiveInputExpiry(): void {
    const current = this.liveInput;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    const delay = Math.max(0, Math.min(current.idleUntil, current.expiresAt) - Date.now());
    current.timer = setTimeout(() => {
      if (this.liveInput !== current) return;
      void this.endLiveInput(current.id).catch(() => undefined);
    }, delay);
    current.timer.unref?.();
  }

  /** Fixed hit-test, safe cursor names only. Cursor failures cannot fail an acknowledged input. */
  async cursorAt(x: number, y: number, gestureId: string): Promise<BrowserCursor | null> {
    try {
      this.assertPoint(x, y);
      await this.assertLiveInput(gestureId);
      const page = this.liveInput!.page;
      const result = await page.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: browserCursorExpression(x, y),
          returnByValue: true,
        },
        { timeoutMs: Math.min(this.attachment.timeoutMs, CURSOR_SAMPLE_TIMEOUT_MS) },
      );
      await this.assertLiveInput(gestureId);
      const parsed = browserCursorSchema.safeParse(result.result.value);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private holdsInput(): boolean {
    return this.heldButtons.size > 0 || this.heldKeys.size > 0 || this.heldTouches;
  }

  /** Forget held state whose attachment is gone; it is never replayed on a replacement. */
  private discardHeldState(): void {
    this.heldButtons.clear();
    this.heldKeys.clear();
    this.heldTouches = false;
    this.activeTouches.clear();
    this.heldOwner = null;
  }

  /**
   * Release only what `page` itself holds. State published on another attachment
   * is left to that attachment's own cleanup, never retargeted here.
   */
  async releaseHeldInput(page = this.attachment.page): Promise<void> {
    if (!page) {
      this.discardHeldState();
      return;
    }
    if (this.heldOwner && this.heldOwner !== page) return;
    this.heldOwner = null;
    const buttons = [...this.heldButtons];
    const { x, y } = this.lastMousePoint;
    const keys = [...this.heldKeys.values()];
    this.heldButtons.clear();
    this.heldKeys.clear();
    const touchHeld = this.heldTouches;
    this.heldTouches = false;
    this.activeTouches.clear();
    await Promise.allSettled([
      ...(touchHeld
        ? [
            page.send(
              "Input.dispatchTouchEvent",
              { type: "touchCancel", touchPoints: [] },
              { mutation: true },
            ),
          ]
        : []),
      ...buttons.map((button) =>
        page.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x,
            y,
            button,
            buttons: 0,
            clickCount: 1,
          },
          { mutation: true },
        ),
      ),
      ...keys.map(({ key, code }) =>
        page.send(
          "Input.dispatchKeyEvent",
          {
            type: "keyUp",
            key,
            code,
          },
          { mutation: true },
        ),
      ),
    ]);
  }

  private assertPoint(x: number, y: number): void {
    const viewport = this.attachment.requireViewport();
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > viewport.width ||
      y > viewport.height
    ) {
      throw new RangeError("Input coordinates are outside the CSS viewport");
    }
  }

  /** CDP/Puppeteer priority for supported held buttons, independent of press order.
   * https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Input.ts
   */
  private heldMoveButton(): MouseButton | "none" {
    for (const button of ["left", "right", "middle"] as const) {
      if (this.heldButtons.has(button)) {
        return button;
      }
    }
    return "none";
  }

  /** Validate before recording held-button intent or sending a native packet. */
  private assertMouseModifiers(modifiers: number | undefined): void {
    if (
      modifiers !== undefined &&
      (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15)
    ) {
      throw new RangeError("Mouse modifiers must be an integer from 0 to 15");
    }
  }

  /** Both live and discrete keyboard paths must bound release fanout before sending. */
  private assertHeldKeyCapacity(code: string): void {
    if (!this.heldKeys.has(code) && this.heldKeys.size >= MAX_HELD_BROWSER_KEYS) {
      throw new Error("Too many simultaneously held browser keys");
    }
  }

  private buttonMask(add?: MouseButton, remove?: MouseButton): number {
    const active = new Set(this.heldButtons);
    if (add) active.add(add);
    if (remove) active.delete(remove);
    return (
      (active.has("left") ? 1 : 0) | (active.has("right") ? 2 : 0) | (active.has("middle") ? 4 : 0)
    );
  }
}
