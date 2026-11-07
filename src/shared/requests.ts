import { z } from "zod";
export const selectionSchema = z
  .object({
    text: z.string().min(1).max(500000),
    from: z.number().int().min(0),
    to: z.number().int().min(1),
  })
  .strict()
  .refine((s) => s.to > s.from);
export const blueprintNodeSchema = z
  .object({
    id: z.string().uuid(),
    level: z.enum(["section", "synopsis", "volume", "chapter", "scene"]),
    parentId: z.string().uuid().nullable(),
    chapterId: z.string().uuid().nullable(),
    title: z.string().trim().min(1).max(500),
    content: z.string().max(500000),
  })
  .strict();
const base = z.object({
  requestId: z.string().uuid(),
  projectId: z.string().uuid(),
  mode: z.enum(["explore", "novel"]),
  instruction: z.string().max(200000),
  model: z.string().trim().min(1).max(500).optional(),
  conversationId: z.string().uuid().optional(),
  parentTurnId: z.string().uuid().optional(),
});
export const blueprintTargetSchema = z
  .object({
    level: z.enum(["section", "synopsis", "volume", "chapter", "scene"]),
    id: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
    chapterId: z.string().uuid().optional(),
    count: z.number().int().min(1).max(30),
  })
  .strict()
  .refine(
    (t) => !t.id || (t.parentId === undefined && t.chapterId === undefined),
    {
      message: "编辑已有蓝图节点不能同时指定新节点的归属。",
    },
  );
export const requestSchema = z
  .discriminatedUnion("kind", [
    base.extend({ kind: z.literal("brainstorm") }).strict(),
    base
      .extend({
        kind: z.literal("settings"),
        cardId: z.string().uuid().optional(),
      })
      .strict(),
    base
      .extend({ kind: z.literal("blueprint"), target: blueprintTargetSchema })
      .strict(),
    ...(["opening", "continue", "notes", "title"] as const).map((kind) =>
      base
        .extend({ kind: z.literal(kind), chapterId: z.string().uuid() })
        .strict(),
    ),
    base
      .extend({
        kind: z.literal("polish"),
        chapterId: z.string().uuid(),
        selection: selectionSchema,
        aspect: z.enum(["expression", "scene", "dialogue"]),
      })
      .strict(),
    base
      .extend({
        kind: z.literal("check"),
        aspect: z.enum(["continuity", "pacing", "arc"]),
        character: z.string().max(500).optional(),
        scope: z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("current"),
              chapterId: z.string().uuid(),
            })
            .strict(),
          z
            .object({
              type: z.literal("chapters"),
              chapterIds: z.array(z.string().uuid()).min(1),
            })
            .strict(),
          z.object({ type: z.literal("book") }).strict(),
        ]),
      })
      .strict(),
    base
      .extend({
        kind: z.literal("prompt"),
        chapterId: z.string().uuid().optional(),
        selection: selectionSchema.optional(),
      })
      .strict(),
  ])
  .refine((r) => !r.parentTurnId || !!r.conversationId, {
    message: "继续历史版本必须指定所属对话。",
  });
export function requestKey(r: import("./types").TaskRequest) {
  const {
    requestId,
    instruction,
    model,
    conversationId,
    parentTurnId,
    ...target
  } = r;
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(canonical(target));
}
