import { z } from "zod";
import type { StoryRepository } from "./database";
import type { ChatMessage } from "./provider";
import type { TaskRequest, Memory } from "../shared/types";
import { memoryLabels, type MaterialCoverage } from "../shared/types";
import { rolePrompt } from "../shared/roles";
import { roleSettings } from "./roles";
import { buildMaterialContext } from "./materials";

const clip = (value: string, length: number) =>
  value.length > length
    ? value.slice(0, length) + "\n[资料过长，已截取]"
    : value;

export function buildTask(
  repo: StoryRepository,
  request: TaskRequest,
): {
  messages: ChatMessage[];
  revisionId?: string;
  chapterId?: string;
  coverage: MaterialCoverage[];
  omitted: number;
} {
  const detail = repo.getDetail(request.projectId);
  const chapter = request.chapterId
    ? detail.chapters.find((c) => c.id === request.chapterId)
    : undefined;
  if (request.chapterId && !chapter)
    throw new Error("当前章节不属于这个故事。");
  if (
    ["chapter", "check", "notes", "revise"].includes(request.kind) &&
    !chapter
  )
    throw new Error("请先选择一个章节。");
  if (request.kind === "revise" && !request.selection?.trim())
    throw new Error("请先在正文中选择需要改写的文字。");
  let revisionId: string | undefined;
  let source = "";
  if (request.kind === "notes") {
    if (!chapter?.acceptedRevisionId || chapter.needsReview)
      throw new Error("请先采用或复核当前章节，再整理正式记忆。");
    const revision = repo.getRevision(chapter.acceptedRevisionId);
    revisionId = revision.id;
    source = `\n【本次记忆来源：${revision.title}，版本 ${revision.id}】\n${clip(revision.content, 40_000)}`;
  }
  const cutoff = chapter?.position ?? Number.MAX_SAFE_INTEGER;
  const validChapters = detail.chapters.filter(
    (c) => c.position < cutoff && c.acceptedRevisionId && !c.needsReview,
  );
  const validIds = new Map(
    validChapters.map((c) => [c.id, c.acceptedRevisionId]),
  );
  const active = detail.memories.filter(
    (m) =>
      m.active &&
      (m.manual || (m.chapterId && validIds.get(m.chapterId) === m.revisionId)),
  );
  const keywords =
    `${request.instruction} ${chapter?.title || ""} ${chapter?.plan || ""} ${request.selection || ""}`.match(
      /[\p{L}\p{N}]{2,}/gu,
    ) ?? [];
  const score = (memory: Memory) =>
    (memory.manual ? 100 : 0) +
    keywords.reduce(
      (sum, word) => sum + (memory.content.includes(word) ? 5 : 0),
      0,
    );
  const recentIds = new Set(validChapters.slice(-4).map((c) => c.id));
  const selected = active.sort(
    (a, b) =>
      score(b) +
      (recentIds.has(b.chapterId || "") ? 20 : 0) -
      (score(a) + (recentIds.has(a.chapterId || "") ? 20 : 0)),
  );
  let memoryText = "";
  for (const memory of selected) {
    const title =
      detail.chapters.find((c) => c.id === memory.chapterId)?.title ||
      "作者记录";
    const item = `[${memoryLabels[memory.kind]}｜${title}｜${memory.revisionId?.slice(0, 8) || "手动"}] ${memory.content}\n`;
    if (memoryText.length + item.length <= 12_000) memoryText += item;
  }
  const recent = validChapters
    .slice(-2)
    .map((c) => {
      const revision = repo.getRevision(c.acceptedRevisionId!);
      return `【已采用：${revision.title}】\n${clip(revision.content.slice(-4_000), 4_000)}`;
    })
    .join("\n\n");
  const materials = buildMaterialContext(
    detail.cards,
    [
      request.instruction,
      chapter?.title,
      chapter?.plan,
      request.selection,
      chapter?.content.slice(-4000),
      ...detail.project.blueprintSections.map((section) => `${section.title}\n${section.content}`),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const project = detail.project;
  const context = [
    `故事：${project.title}\n模式：${project.mode === "explore" ? "自由探索" : "长篇创作"}\n类型：${project.genre}`,
    `【作者的故事想法】\n${clip(project.premise, 6000)}`,
    `【世界观】\n${clip(project.world, 8000)}\n【文风偏好】\n${clip(project.style, 3000)}`,
    `【角色与资料】\n${materials.text || "尚无资料。"}`,
    `【蓝图，仅为未来意图，并非已经发生的事实】\n${clip([
      ...project.blueprintSections.map((section) => `## ${section.title}\n${section.content}`),
    ].filter(Boolean).join("\n\n"), 16000)}`,
    `【有效记忆，有来源】\n${memoryText || "尚无有效记录。"}`,
    `【近期已采用正文】\n${recent || "这是故事的开始。"}`,
    chapter
      ? `【当前章节】${chapter.title}\n本章计划：${clip(chapter.plan, 4000)}\n【当前草稿，尚未自动计入正式记忆】\n${request.kind === "notes" ? "记忆提取仅使用下方采用版本。" : clip(chapter.content, 18000)}`
      : "",
    request.selection
      ? `【作者选中的片段】\n${clip(request.selection, 12000)}`
      : "",
    source,
    request.workflowContext ? `【作者已确认供本工作流后续参考的步骤结果；这些内容仍是草稿，不能当成已写入故事的事实】\n${clip(request.workflowContext, 30000)}` : "",
    `【本次作者要求】\n${request.instruction.trim() || "请按当前资料完成任务。"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    messages: [
      {
        role: "system",
        content: rolePrompt(roleSettings(repo), request.kind),
      },
      { role: "user", content: context },
    ],
    revisionId,
    chapterId: chapter?.id,
    coverage: materials.coverage,
    omitted: materials.omitted,
  };
}
export function parseMemories(text: string) {
  const schema = z.object({
    records: z
      .array(
        z.object({
          kind: z.enum([
            "summary",
            "fact",
            "state",
            "relationship",
            "knowledge",
            "foreshadow",
          ]),
          content: z.string().trim().min(1).max(3000),
        }),
      )
      .min(1)
      .max(24),
  });
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{"),
    end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new Error("模型没有返回有效的记忆数据，本次未修改正式记录。");
  try {
    return schema.parse(JSON.parse(trimmed.slice(start, end + 1))).records;
  } catch {
    throw new Error(
      "记忆数据格式不符合要求，本次未修改正式记录。可调整模型后重试。",
    );
  }
}
