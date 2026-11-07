import { z } from "zod";
import type { DevelopmentChange, StoryDevelopmentDraft } from "./types";

export const developmentContentSchema = z.object({
  target: z.enum(["blueprint", "character", "world"]),
  targetId: z.string().max(80).default(""),
  sectionId: z.string().max(80).default(""),
  name: z.string().trim().max(200).default(""),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(12000),
  mode: z.enum(["append", "replace"]).default("append"),
  basis: z.enum(["established", "proposal"]).default("proposal"),
  sources: z
    .array(
      z.object({
        revisionId: z.string().uuid(),
        quote: z.string().trim().min(1).max(500),
      }),
    )
    .max(8)
    .default([]),
});
export const developmentDraftSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  summary: z.string().max(4000),
  changes: z
    .array(
      developmentContentSchema.extend({
        id: z.string().uuid(),
        base: z.string().max(100).nullable(),
      }),
    )
    .min(0)
    .max(30),
  warnings: z.array(z.string().max(2000)).max(20),
  appliedIds: z.array(z.string().uuid()).max(30),
});

export const developmentContract =
  '仅输出 JSON：{"summary":"本次构思或整理的概述","changes":[{"target":"blueprint|character|world","targetId":"已有蓝图分区或资料卡 ID，新增留空","sectionId":"资料卡的已有分区 ID，新增分区或蓝图留空","name":"资料卡名称，蓝图留空","title":"分区名称","content":"此分区完整可用的内容","mode":"append|replace","basis":"established|proposal","sources":[{"revisionId":"已采用章节版本 ID","quote":"该版本中逐字引用的短句"}]}],"warnings":["与已有内容的冲突或仍需留意的事项"]}。changes 为 1—30 项，每项只处理一个分区；同一目标分区只能出现一次。优先使用提供的 ID 更新已有条目，只有确实新增的内容才留空；新增资料卡使用相同 kind 和 name 归组。target=blueprint 时 targetId 是蓝图分区 ID；target=character/world 时 targetId 是资料卡 ID，name 必填。replace 的 content 必须包含该分区仍需保留的内容。basis=established 只用于有已采用正文证据的提炼，必须提供可核对的 sources；从草稿、作者新要求或 AI 补充形成的内容统一标为 proposal，不冒充正文事实。不输出 Markdown 或解释。';

export function developmentLabel(change: DevelopmentChange): string {
  return change.target === "blueprint"
    ? `蓝图 · ${change.title}`
    : `${change.target === "character" ? "人物" : "世界"} · ${change.name} / ${change.title}`;
}

export function developmentText(draft: StoryDevelopmentDraft): string {
  return [
    draft.summary,
    ...draft.changes.map(
      (change) => `## ${developmentLabel(change)}\n${change.content}`,
    ),
    ...draft.warnings.map((item) => `注意：${item}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
