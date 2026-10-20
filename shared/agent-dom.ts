import { z } from "zod";

export const DOM_SNAPSHOT_TTL_MS = 60_000;
export const DOM_MAX_ENTRIES = 200;
export const DOM_MAX_TEXT = 24_000;
export const domSnapshotIdSchema = z.string().uuid();
export const domRefSchema = z.string().regex(/^e[1-9]\d{0,2}$/);
export const domActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ref: domRefSchema }),
  z.object({ kind: z.literal("hover"), ref: domRefSchema }),
  z.object({ kind: z.literal("fill"), ref: domRefSchema, text: z.string().max(4_000) }),
  z.object({ kind: z.literal("type"), ref: domRefSchema, text: z.string().max(4_000) }),
  z.object({
    kind: z.literal("select"),
    ref: domRefSchema,
    values: z.array(z.string().max(256)).min(1).max(20),
  }),
]);
export const domActionInputSchema = z.object({
  snapshotId: domSnapshotIdSchema,
  action: domActionSchema,
});
export const domEvaluateInputSchema = z.object({
  snapshotId: domSnapshotIdSchema,
  expression: z.string().min(1).max(8_192),
});
export const domEntrySchema = z.object({
  ref: domRefSchema,
  role: z.string().max(64),
  name: z.string().max(240),
  depth: z.number().int().min(0).max(20),
  disabled: z.boolean(),
  sensitive: z.boolean(),
  options: z.array(z.object({ value: z.string().max(256), label: z.string().max(80) })).max(40),
});
export const domSnapshotSchema = z.object({
  snapshotId: domSnapshotIdSchema,
  entries: z.array(domEntrySchema).max(DOM_MAX_ENTRIES),
  truncated: z.boolean(),
});
export type DomAction = z.infer<typeof domActionSchema>;
