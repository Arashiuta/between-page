import { z } from "zod";
import { taskKinds, type TaskRequest, type TaskResult } from "./types";
import { developmentDraftSchema, developmentText } from "./development";
import { planningDraftSchema, planningTargetSchema } from "./planning";

export const textSelectionSchema = z.object({
  text: z.string().max(500_000),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});
export const conversationTargetSchema = z.object({
  kind: z.enum(taskKinds),
  chapterId: z.string().uuid().optional(),
  planningTarget: planningTargetSchema.optional(),
  writingScope: z.enum(["selection", "document"]).optional(),
  outputMode: z.enum(["rewrite", "analysis"]).optional(),
  selectionRange: textSelectionSchema.optional(),
});
export type ConversationTarget = z.infer<typeof conversationTargetSchema>;
export const turnReviewSchema = z.object({
  text: z.string().max(1_000_000),
  resultType: z.enum(["prose", "rewrite", "analysis", "planning"]).optional(),
  memoryRecords: z
    .array(
      z.object({
        kind: z.enum([
          "fact",
          "state",
          "relationship",
          "knowledge",
          "foreshadow",
          "summary",
        ]),
        content: z.string().max(3000),
      }),
    )
    .max(24)
    .nullable()
    .optional(),
  memoryRevisionId: z.string().uuid().optional(),
  developmentDraft: developmentDraftSchema.nullable().optional(),
  planningDraft: planningDraftSchema.nullable().optional(),
});
export type TurnReview = z.infer<typeof turnReviewSchema>;
export interface CreationConversation {
  id: string;
  projectId: string;
  title: string;
  target: ConversationTarget;
  selectedTurnId: string | null;
  draftInstruction: string;
  createdAt: string;
  updatedAt: string;
  legacy?: boolean;
  autoTitle?: boolean;
  workflowContext?: string;
  source?: {
    content: string;
    selection?: z.infer<typeof textSelectionSchema>;
    memoryRevisionId?: string;
  };
}
export interface CreationTurn {
  id: string;
  conversationId: string;
  projectId: string;
  number: number;
  parentTurnId: string | null;
  instruction: string;
  status: "generating" | "complete" | "stopped" | "error" | "interrupted";
  rawResponse: string;
  result: TurnReview;
  review: TurnReview;
  sourceContent: string;
  selection?: z.infer<typeof textSelectionSchema>;
  // These are the messages actually used; later parent edits never alter them.
  history: { role: "user" | "assistant"; content: string }[];
  applied: string[];
  error: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  invalidReason?: string;
  undoId?: string;
}
export interface ConversationDetail {
  conversation: CreationConversation;
  turns: CreationTurn[];
  invalidReason?: string;
}
export function conversationTarget(request: TaskRequest): ConversationTarget {
  return {
    kind: request.kind,
    ...(request.chapterId ? { chapterId: request.chapterId } : {}),
    ...(request.planningTarget
      ? { planningTarget: request.planningTarget }
      : {}),
    ...(request.writingScope ? { writingScope: request.writingScope } : {}),
    ...(request.outputMode ? { outputMode: request.outputMode } : {}),
    ...(request.selectionRange
      ? { selectionRange: request.selectionRange }
      : {}),
  };
}
export function targetKey(target: ConversationTarget): string {
  return JSON.stringify([
    target.kind,
    target.chapterId ?? "",
    target.planningTarget?.level ?? "",
    target.planningTarget?.id ?? "",
    target.planningTarget?.parentId ?? "",
    target.planningTarget?.count ?? 1,
    target.writingScope ?? "",
    target.outputMode ?? "",
    target.selectionRange ?? null,
  ]);
}
export function reviewText(review: TurnReview): string {
  if (review.planningDraft)
    return JSON.stringify({
      items: review.planningDraft.items.map(({ title, content }) => ({
        title,
        content,
      })),
    });
  if (review.developmentDraft) {
    const draft = review.developmentDraft;
    return JSON.stringify({
      summary: draft.summary,
      changes: draft.changes,
      warnings: draft.warnings,
    });
  }
  if (review.memoryRecords)
    return JSON.stringify({ records: review.memoryRecords });
  return review.text;
}
export function resultReview(result: TaskResult): TurnReview {
  return {
    text: result.text,
    ...(result.resultType ? { resultType: result.resultType } : {}),
    ...(result.memoryRecords ? { memoryRecords: result.memoryRecords } : {}),
    ...(result.memoryRevisionId
      ? { memoryRevisionId: result.memoryRevisionId }
      : {}),
    ...(result.developmentDraft
      ? { developmentDraft: result.developmentDraft }
      : {}),
    ...(result.planningDraft ? { planningDraft: result.planningDraft } : {}),
  };
}
export function displayReview(review: TurnReview): string {
  return review.developmentDraft
    ? developmentText(review.developmentDraft)
    : review.text;
}
