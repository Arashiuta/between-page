import { z } from "zod";
import type { StoryRepository } from "./database";
import type { ChatMessage } from "./provider";
import type { TaskRequest, Memory } from "../shared/types";
import { memoryLabels } from "../shared/types";

const clip = (value: string, length: number) =>
  value.length > length
    ? value.slice(0, length) + "\n[资料过长，已截取]"
    : value;
const instructions: Record<TaskRequest["kind"], string> = {
  chapter:
    "你负责正文写作。遵守本章计划与作者要求，延续角色行为逻辑，写出有场景、行动、对白和变化的章节。不要替作者确立尚未决定的秘密。只输出可直接采用的中文正文，不加说明、不重复章节标题。篇幅遵循作者要求，未指定时约 1500—2500 字。",
  outline:
    "你负责剧情规划。基于作者灵感、OC 与世界观，提出可编辑的中文故事蓝图。包含核心冲突、角色变化、阶段推进、重要伏笔、近期三章计划。自由探索模式允许开放结局；长篇模式给出整体方向。未确认的补充设定明确标注为建议。用清晰简洁的 Markdown。",
  adjust:
    "你负责修订后续走向。遵循作者新的创作意图，保留仍有效的已有经历，输出修订后的大纲，并列出受影响的后续安排、可继续使用的伏笔、需要回看之处。没有作者明确要求时，不重写已经发生的事实。不要突然改变角色核心特质来迁就事件。",
  check:
    "你负责连续性检查。检查当前章节与有效资料的时间、地点、能力、物品、角色认知和行为是否相容。只报告有具体依据的问题，指出涉及的原文或记忆出处，区分确定矛盾、可能问题和仍待揭晓的悬念。给出可操作的修改建议。没有发现时明确说明，不为了检查而编造问题。",
  notes:
    '你负责为已采用章节记录事实。只依据“本次记忆来源”的已采用正文，不把大纲、猜想、谎言、草稿、插画内容写成事实。区分客观事件、角色认知与未揭晓悬念。仅输出 JSON：{"records":[{"kind":"summary|fact|state|relationship|knowledge|foreshadow","content":"明确且自足的记录"}]}。summary 一条，其余只记录重要新增信息，总计不超过 16 条。秘密记录中明确谁知道、谁不知道；角色声称的事情写成“某人声称”，不擅自确认。',
  prompt:
    "你负责把故事场景整理成插画提示词。选择一个可以在单张插画呈现的瞬间，描述人物外观、当时服装与伤势、动作、环境、构图、光线、情绪和风格。使用角色参考图时明确保持人物身份特征。尊重本章的状态，避免把过往或未来状态混入。只输出可编辑的中文绘图提示词，不补充剧情，不添加未出现的人物。",
  revise:
    "你负责局部改写。根据作者要求改写选中文段，保持与上下文相容，保留未被要求修改的事实与人物身份。只输出替换用正文，不加解释、不加标题。",
  organize:
    "你负责整理作者的零碎灵感。清楚区分已明确的设定、作者偏好、仍待决定的空白和你的建议。整理世界观、主要角色、关系与可能冲突；不擅自补成正式背景。输出简洁可编辑的 Markdown。",
};

export function buildTask(
  repo: StoryRepository,
  request: TaskRequest,
): { messages: ChatMessage[]; revisionId?: string; chapterId?: string } {
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
  const cards = detail.cards
    .map(
      (card) =>
        `【${card.kind === "character" ? "角色" : card.kind === "world" ? "世界观" : "灵感"}：${card.name}】\n${clip(card.description, 3500)}\n不可随意改变的设定：${clip(card.constraints, 1500)}`,
    )
    .join("\n\n");
  const project = detail.project;
  const context = [
    `故事：${project.title}\n模式：${project.mode === "explore" ? "自由探索" : "长篇创作"}\n类型：${project.genre}`,
    `【作者的故事想法】\n${clip(project.premise, 6000)}`,
    `【世界观】\n${clip(project.world, 8000)}\n【文风偏好】\n${clip(project.style, 3000)}`,
    `【角色与资料】\n${clip(cards, 16000)}`,
    `【计划，仅为未来意图，并非已经发生的事实】\n${clip(project.outline, 10000)}`,
    `【有效记忆，有来源】\n${memoryText || "尚无有效记录。"}`,
    `【近期已采用正文】\n${recent || "这是故事的开始。"}`,
    chapter
      ? `【当前章节】${chapter.title}\n本章计划：${clip(chapter.plan, 4000)}\n【当前草稿，尚未自动计入正式记忆】\n${request.kind === "notes" ? "记忆提取仅使用下方采用版本。" : clip(chapter.content, 18000)}`
      : "",
    request.selection
      ? `【作者选中的片段】\n${clip(request.selection, 12000)}`
      : "",
    source,
    `【本次作者要求】\n${request.instruction.trim() || "请按当前资料完成任务。"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    messages: [
      {
        role: "system",
        content:
          "你是作者的中文 OC 故事创作伙伴。作者明确设定优先；未确认建议不视为事实。每个故事互相独立。保持人物在不同关系中的行为差异。不要让角色知道自己尚未得知的秘密。文风避免空泛抒情、重复解释和机械总结。\n" +
          instructions[request.kind],
      },
      { role: "user", content: context },
    ],
    revisionId,
    chapterId: chapter?.id,
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
