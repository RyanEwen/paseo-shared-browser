import { z } from "zod";

export const AGENT_POINTER_IDLE_MS = 5_000;
export const AGENT_POINTER_CLICK_MS = 900;

/** Viewport CSS coordinates observed at an acknowledged native or semantic pointer action. */
export const agentPointerPointSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
});

/** Display-only presence. It never grants input authority or appears in captured page pixels. */
export const agentPointerSchema = agentPointerPointSchema.extend({
  label: z.string().min(1).max(64),
  source: z.enum(["native", "semantic"]),
  remainingMs: z.number().min(0).max(AGENT_POINTER_IDLE_MS),
  clickRemainingMs: z.number().min(0).max(AGENT_POINTER_CLICK_MS),
});

export type AgentPointer = z.infer<typeof agentPointerSchema>;
