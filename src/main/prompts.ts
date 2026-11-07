import { z } from "zod";
import type { StoryRepository } from "./database";
import type { ChatMessage } from "./provider";
import type { TaskRequest, Memory } from "../shared/types";
import { memoryLabels, type MaterialCoverage } from "../shared/types";
import { rolePrompt } from "../shared/roles";
import { roleSettings } from "./roles";
import { buildMaterialContext } from "./materials";
import { creationPolicy } from "../shared/creation";
import {
  buildDevelopmentContext,
  type DevelopmentSnapshot,
} from "./development";
import { chapterPlan, planText } from "../shared/planning";
import { getPlanningBlock, planningInstructions } from "./planning";

const clip = (value: string, length: number) =>
  value.length > length
    ? value.slice(0, length) + "\n[资料过长，已截取]"
    : value;
const draftExcerpt = (value: string) =>
  value.length <= 18000
    ? value
    : `${value.slice(0, 2000)}\n[草稿中段省略，以下为最近正文，请从结尾衔接]\n${value.slice(-16000)}`;

export function buildTask(
  repo: StoryRepository,
  request: TaskRequest,
  sourceOverride?: { content?: string; memoryRevisionId?: string },
): {
  messages: ChatMessage[];
  revisionId?: string;
  chapterId?: string;
  coverage: MaterialCoverage[];
  omitted: number;
  developmentSnapshot?: DevelopmentSnapshot;
} {
  const detail = repo.getDetail(request.projectId);
  const storedChapter = request.chapterId
    ? [...detail.chapters, ...(detail.fragments ?? [])].find(
        (c) => c.id === request.chapterId,
      )
    : undefined;
  const chapter =
    storedChapter && sourceOverride?.content !== undefined
      ? { ...storedChapter, content: sourceOverride.content }
      : storedChapter;
  if (request.chapterId && !chapter)
    throw new Error("当前章节不属于这个故事。");
  if (
    ["opening", "chapter", "check", "notes", "revise"].includes(request.kind) &&
    !chapter
  )
    throw new Error("请先选择一个章节。");
  if (
    (request.kind === "revise" ||
      (["scene", "dialogue"].includes(request.kind) &&
        request.writingScope === "selection")) &&
    request.writingScope !== "document" &&
    !request.selection?.trim()
  )
    throw new Error("请先在正文中选择需要改写的文字。");
  const fullRewrite =
    request.outputMode === "rewrite" && request.writingScope === "document";
  if (fullRewrite && chapter && chapter.content.length > 60_000)
    throw new Error("全文改写支持六万字以内的章节或片段，请选择文段分段打磨。");
  if (
    request.outputMode === "rewrite" &&
    request.selection &&
    request.selection.length > 60_000
  )
    throw new Error("选区超过六万字，请分段打磨。");
  let revisionId: string | undefined;
  let source = "";
  if (request.kind === "notes") {
    if (
      sourceOverride?.memoryRevisionId &&
      chapter?.acceptedRevisionId !== sourceOverride.memoryRevisionId
    )
      throw new Error("来源采用版本已变化，请为最新版本新建记忆整理对话。");
    if (chapter?.kind === "fragment")
      throw new Error("独立片段不能整理正式记忆，请先编入并采用章节。");
    if (!chapter?.acceptedRevisionId || chapter.needsReview)
      throw new Error("请先采用或复核当前章节，再整理正式记忆。");
    const revision = repo.getRevision(chapter.acceptedRevisionId);
    revisionId = revision.id;
    source = `\n【本次记忆来源：${revision.title}，版本 ${revision.id}】\n${clip(revision.content, 40_000)}`;
  }
  const storyScope = [
    "develop",
    "outline",
    "adjust",
    "brainstorm",
    "organize",
    "arc",
  ].includes(request.kind);
  const fragment = chapter?.kind === "fragment";
  const anchor =
    fragment && chapter.fragmentContext?.anchorId
      ? detail.chapters.find((c) => c.id === chapter.fragmentContext?.anchorId)
      : undefined;
  if (fragment && chapter.fragmentContext?.anchorId && !anchor)
    throw new Error("片段参考锚点已不存在，请重新选择。");
  const cutoff = fragment
    ? anchor
      ? anchor.position + 1
      : 0
    : storyScope
      ? Number.MAX_SAFE_INTEGER
      : (chapter?.position ?? Number.MAX_SAFE_INTEGER);
  const validChapters = detail.chapters.filter(
    (c) => c.position < cutoff && c.acceptedRevisionId && !c.needsReview,
  );
  const validIds = new Map(
    validChapters.map((c) => [c.id, c.acceptedRevisionId]),
  );
  const active = detail.memories.filter(
    (m) =>
      m.active &&
      ((!fragment && m.manual) ||
        (m.chapterId && validIds.get(m.chapterId) === m.revisionId)),
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
  const draftContinuity =
    !fragment &&
    ["opening", "chapter", "scene"].includes(request.kind) &&
    chapter
      ? detail.chapters
          .filter(
            (item) =>
              item.position < chapter.position &&
              !item.acceptedRevisionId &&
              item.content.trim(),
          )
          .slice(-2)
          .map(
            (item) =>
              `【前章草稿：${item.title}，尚未采用，仅供续写衔接，不计正式记忆】\n${clip(item.content.slice(-6000), 6000)}`,
          )
          .join("\n\n")
      : "";
  const materials = buildMaterialContext(
    detail.cards,
    [
      request.instruction,
      chapter?.title,
      chapter?.plan,
      request.selection,
      chapter?.content.slice(-4000),
      ...detail.project.blueprintSections.map(
        (section) => `${section.title}\n${section.content}`,
      ),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const project = detail.project;
  const development =
    request.kind === "develop"
      ? buildDevelopmentContext(
          repo,
          fragment
            ? {
                ...detail,
                chapters: detail.chapters.filter((c) => c.position < cutoff),
                memories: active,
              }
            : detail,
        )
      : undefined;
  if (request.planningTarget) {
    if (!["outline", "adjust"].includes(request.kind))
      throw new Error("请使用剧情规划职责生成分层规划。");
    getPlanningBlock(repo, request.projectId, request.planningTarget);
  }
  const useNovel =
    !fragment && (project.mode === "novel" || request.referenceNovelPlan);
  const novel = project.novelPlan;
  const targetChapter = request.planningTarget
    ? request.planningTarget.level === "scene"
      ? detail.chapters.find((c) => c.id === request.planningTarget?.parentId)
      : request.planningTarget.level === "chapter" && request.planningTarget.id
        ? detail.chapters.find((c) => c.id === request.planningTarget?.id)
        : undefined
    : chapter;
  const volumeId =
    request.planningTarget?.level === "volume"
      ? request.planningTarget.id
      : request.planningTarget?.level === "chapter" &&
          !request.planningTarget.id
        ? request.planningTarget.parentId
        : targetChapter?.volumeId;
  const volume = novel?.volumes.find((v) => v.id === volumeId);
  const synopsisText = planText(
    novel?.synopsis ?? { content: "" },
    request.usePlanDraft,
  ).trim();
  const volumeText = volume
    ? planText(volume.plan, request.usePlanDraft).trim()
    : "";
  const chapterText = targetChapter
    ? planText(chapterPlan(targetChapter), request.usePlanDraft).trim()
    : "";
  const sceneText = (targetChapter?.scenes ?? [])
    .map((s) => ({
      title: s.title,
      content: planText(s.plan, request.usePlanDraft).trim(),
    }))
    .filter((s) => s.content)
    .map((s) => `${s.title}\n${s.content}`)
    .join("\n\n");
  const planningContext = useNovel
    ? [
        synopsisText
          ? `【全书总纲，属于未来计划】\n${clip(synopsisText, 6000)}`
          : "",
        volumeText
          ? `【所属分卷：${volume!.title}】\n${clip(volumeText, 5000)}`
          : "",
        chapterText ? `【当前章纲】\n${clip(chapterText, 5000)}` : "",
        sceneText
          ? `【场景细纲，按所列顺序参考】\n${clip(sceneText, 7000)}`
          : "",
        request.planningTarget?.id
          ? `【当前待调整规划】\n${clip(getPlanningBlock(repo, request.projectId, request.planningTarget).content, 6000)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const context = [
    `故事：${project.title}\n模式：${project.mode === "explore" ? "自由探索" : "长篇创作"}\n类型：${project.genre}`,
    planningContext,
    fragment
      ? `【独立探索片段，尚未编入正式剧情】\n${JSON.stringify(chapter.fragmentContext ?? {})}\n仅参考选定锚点以前的事实；不要自行把此片段或其他片段当成过去。`
      : "",
    `【作者的故事想法】\n${clip(project.premise, 6000)}`,
    `【世界观】\n${clip(project.world, 8000)}\n【文风偏好】\n${clip(project.style, 3000)}`,
    `【角色与资料】\n${materials.text || "尚无资料。"}`,
    !fragment
      ? `【蓝图，仅为未来意图，并非已经发生的事实】\n${clip(
          [
            ...project.blueprintSections.map(
              (section) => `## ${section.title}\n${section.content}`,
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
          useNovel ? 5000 : 16000,
        )}`
      : "",
    `【有效记忆，有来源】\n${memoryText || "尚无有效记录。"}`,
    `【近期已采用正文】\n${recent || "这是故事的开始。"}`,
    development?.text,
    draftContinuity,
    chapter
      ? `【当前章节】${chapter.title}\n${!useNovel && chapter.plan.trim() ? `本章计划：${clip(chapter.plan, 4000)}\n` : ""}【当前草稿，尚未自动计入正式记忆】\n${request.kind === "notes" ? "记忆提取仅使用下方采用版本。" : fullRewrite ? chapter.content : draftExcerpt(chapter.content)}`
      : "",
    request.selection
      ? `【作者选中的片段】\n${request.outputMode === "rewrite" ? request.selection : clip(request.selection, 12000)}`
      : "",
    source,
    request.workflowContext
      ? `【作者已确认供本工作流后续参考的步骤结果；这些内容仍是草稿，不能当成已写入故事的事实】\n${clip(request.workflowContext, 30000)}`
      : "",
    `【本次作者要求】\n${request.instruction.trim() || "请按当前资料完成任务。"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    messages: [
      {
        role: "system",
        content: [
          rolePrompt(roleSettings(repo), request.kind),
          creationPolicy(project, request.kind),
          project.mode === "novel" && !fragment
            ? "【长篇创作流程】围绕已确认设定和实际提供的规划推进，创作自由度只控制局部细节补充，不授权改动已确认主线。分卷、章纲与细纲均可省略；缺少某层规划时，根据已有设定、可用上层规划、有效记忆和前文正常创作，不要求补齐规划，不自行生成缺失的大纲。总纲结局和未来章节只是作者计划，不能提前兑现或成为角色已知事实。"
            : "【自由探索流程】聚焦眼前处境或作者指定的跳写片段，不强制建立全书结局和完整大纲。保留未探索空间，明确设定与已发生事实仍须遵守。",
          request.planningTarget
            ? planningInstructions(request.planningTarget)
            : "",
          request.outputMode === "analysis"
            ? "【本次结果类型】只输出修改建议与依据，不输出可替换正文。"
            : request.outputMode === "rewrite"
              ? `【本次结果类型】只输出${request.writingScope === "document" ? "当前章或片段全文" : "选中文段"}的完整改写稿，不输出分析、方案或解释。`
              : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      { role: "user", content: context },
    ],
    revisionId,
    chapterId: chapter?.id,
    coverage: materials.coverage,
    omitted: materials.omitted,
    developmentSnapshot: development?.snapshot,
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
