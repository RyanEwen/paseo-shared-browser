import {
  AGENT_POINTER_CLICK_MS,
  AGENT_POINTER_IDLE_MS,
  type AgentPointer,
} from "../shared/agent-pointer";

interface PointerContext {
  runtimeId: string;
  bridgeEpoch: number;
  controlToken: string;
  inputGeneration: string | null;
  navigationGeneration: number;
  viewportGeneration: number;
}

/** Retains one controller's real activity; identity changes and inactivity remove it permanently. */
export class AgentPointerPresence {
  private current: {
    context: PointerContext;
    pointer: Pick<AgentPointer, "x" | "y" | "label" | "source">;
    expiresAt: number;
    clickExpiresAt: number;
  } | null = null;

  /** Record CSS coordinates; a move clears an earlier click at a different position. */
  record(
    context: PointerContext,
    pointer: Pick<AgentPointer, "x" | "y" | "label" | "source">,
    click: boolean,
    now: number,
  ): void {
    const previous = this.read(context, now);
    let clickRemainingMs = 0;
    if (click) {
      clickRemainingMs = AGENT_POINTER_CLICK_MS;
    } else if (previous?.x === pointer.x && previous.y === pointer.y) {
      clickRemainingMs = previous.clickRemainingMs;
    }
    this.current = {
      context: { ...context },
      pointer: { ...pointer },
      expiresAt: now + AGENT_POINTER_IDLE_MS,
      clickExpiresAt: now + clickRemainingMs,
    };
  }

  /** Returns no presence after any owner, document, or geometry transition. */
  read(context: PointerContext | null, now: number): AgentPointer | null {
    const current = this.current;
    if (!current) return null;
    if (
      !context ||
      current.context.runtimeId !== context.runtimeId ||
      current.context.bridgeEpoch !== context.bridgeEpoch ||
      current.context.controlToken !== context.controlToken ||
      current.context.inputGeneration !== context.inputGeneration ||
      current.context.navigationGeneration !== context.navigationGeneration ||
      current.context.viewportGeneration !== context.viewportGeneration ||
      current.expiresAt <= now
    ) {
      this.current = null;
      return null;
    }
    return {
      ...current.pointer,
      remainingMs: current.expiresAt - now,
      clickRemainingMs: Math.max(0, current.clickExpiresAt - now),
    };
  }
}
