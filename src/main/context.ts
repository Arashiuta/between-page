import { createHash } from "node:crypto";
import type { StoryRepository } from "./database";
import type {
  ChatMessage,
  ModelCapabilities,
  ProjectDetail,
  TaskRequest,
  TaskPreview,
} from "../shared/types";
import { orderedBlueprint, blueprintLabels } from "../shared/blueprint";
import { modeTools } from "../shared/tools";
import { creationPolicy } from "../shared/creation";
import { referenceImageLimits } from "../shared/materials";
import { rolePrompt } from "../shared/roles";
import { roleSettings } from "./roles";
export const fingerprint = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function applicableMemories(
  d: ProjectDetail,
  chapterId?: string,
  includeCurrent = false,
) {
  const chapter = d.chapters.find((c) => c.id === chapterId);
  return d.memories.filter((m) => {
    if (!m.active) return false;
    if (m.manual && !m.chapterId) return true;
    const source = d.chapters.find((c) => c.id === m.chapterId);
    if (
      !source ||
      source.needsReview ||
      !source.acceptedRevisionId ||
      source.acceptedRevisionId !== m.revisionId
    )
      return false;
    return (
      !chapter ||
      source.position < chapter.position ||
      (includeCurrent && source.id === chapter.id)
    );
  });
}
export function basis(repo: StoryRepository, id: string) {
  const d = repo.getDetail(id),
    p = d.project;
  return fingerprint({
    title: p.title,
    premise: p.premise,
    genre: p.genre,
    mode: p.mode,
    freedom: p.creativeFreedom,
    world: p.world,
    style: p.style,
    blueprint: {
      nodes: p.blueprint.nodes.filter(
        (n) => p.mode === "novel" || n.level === "section",
      ),
    },
    cards: d.cards
      .map(({ updatedAt, ...c }) => c)
      .sort((a, b) => a.id.localeCompare(b.id)),
    images: referenceImages(repo, d).map((i) => ({
      id: i.id,
      filename: i.filename,
      notes: i.notes,
    })),
    memories: applicableMemories(d),
  });
}
export function explorationBasis(
  repo: StoryRepository,
  projectId: string,
  chapterId: string,
) {
  const d = repo.getDetail(projectId),
    source = d.chapters.find((c) => c.id === chapterId);
  if (!source) throw new Error("来源章节不存在。");
  return fingerprint({
    basis: basis(repo, projectId),
    chapters: d.chapters
      .filter((c) => c.position <= source.position)
      .map((c) => ({
        id: c.id,
        position: c.position,
        title: c.title,
        document: c.document,
        acceptedRevisionId: c.acceptedRevisionId,
        needsReview: c.needsReview,
      })),
  });
}
export function referenceImages(repo: StoryRepository, d: ProjectDetail) {
  const ids = new Set(d.cards.flatMap((c) => c.referenceIds));
  return [...ids]
    .map((id) => repo.getImage(id))
    .filter((i) => i.kind !== "cover");
}
export const messageText = (m: ChatMessage) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
export const estimatedTokens = (messages: ChatMessage[]) =>
  messages.reduce(
    (n, m) =>
      n +
      16 +
      (typeof m.content === "string"
        ? Buffer.byteLength(m.content, "utf8")
        : m.content.reduce(
            (v, p) =>
              v +
              (p.type === "text" ? Buffer.byteLength(p.text, "utf8") : 4096),
            0,
          )),
    0,
  );
export function ensureBudget(messages: ChatMessage[], cap: ModelCapabilities) {
  const cost = estimatedTokens(messages);
  if (cost + cap.outputTokens > cap.contextTokens)
    throw new Error(
      `完整参考资料与本次内容超出模型上下文预算（保守估计 ${cost}，预留输出 ${cap.outputTokens}）。请调整模型容量或整理资料；未截断基础资料。`,
    );
  return cost;
}
export interface ContextOptions {
  model: string;
  capabilities: ModelCapabilities;
  readImage: (id: string, maxBytes: number) => Promise<string>;
}
export async function buildContext(
  repo: StoryRepository,
  r: TaskRequest,
  opts: ContextOptions,
  extra = "",
  history: ChatMessage[] = [],
): Promise<TaskPreview> {
  const d = repo.getDetail(r.projectId),
    p = d.project;
  if (r.mode !== p.mode)
    throw new Error("创作模式已变化，请切换到当前模式的对话。");
  const sources: TaskPreview["sources"] = [],
    blocks: string[] = [];
  const add = (title: string, priority: string, text: string) => {
    if (!text.trim()) return;
    sources.push({ title, priority, characters: text.length });
    blocks.push(`【${title}】\n${text}`);
  };
  add(
    "作品信息",
    "基础资料",
    JSON.stringify({
      title: p.title,
      premise: p.premise,
      genre: p.genre,
      mode: p.mode,
      creativeFreedom: p.creativeFreedom,
    }),
  );
  for (const n of orderedBlueprint(
    p.blueprint.nodes.filter(
      (n) => p.mode === "novel" || n.level === "section",
    ),
  )) {
    const parent = p.blueprint.nodes.find((x) => x.id === n.parentId);
    const linked = d.chapters.find((c) => c.id === n.chapterId);
    add(
      `${n.level === "section" ? "额外设定" : "大纲"}/${blueprintLabels[n.level]}/${n.title} [${n.id}]`,
      n.level === "section" ? "1 额外设定约束" : "2 大纲（未来计划）",
      [
        n.level === "section"
          ? "作者自定义的特殊要求与故事约束，创作时持续参考"
          : parent
            ? `上级规划：${parent.title} [${parent.id}]`
            : "全局规划节点",
        linked
          ? `关联正文章节：第 ${linked.position} 章 ${linked.title} [${linked.id}]`
          : "",
        n.content || "（内容尚未填写，允许保留空白）",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  add("世界规则", "2 世界与人物", p.world);
  add("叙事偏好", "2 世界与人物", p.style);
  for (const c of d.cards) {
    add(`资料/${c.name} [${c.id}] 概述`, "2 世界与人物", c.description);
    add(`资料/${c.name} 固定规则`, "2 世界与人物", c.constraints);
    for (const s of c.sections)
      add(`资料/${c.name}/${s.title} [${s.id}]`, "2 世界与人物", s.content);
    for (const doc of c.documents.filter((x) => x.enabled))
      add(`原始文档/${c.name}/${doc.name}`, "2 启用的资料原文", doc.content);
  }
  const chapter =
    "chapterId" in r && r.chapterId
      ? d.chapters.find((c) => c.id === r.chapterId)
      : undefined;
  if ("chapterId" in r && r.chapterId && !chapter)
    throw new Error("目标章节不属于当前故事。");
  if (p.mode === "novel" && chapter) {
    const plan = p.blueprint.nodes.find(
      (n) => n.level === "chapter" && n.chapterId === chapter.id,
    );
    const related = plan
      ? p.blueprint.nodes.filter(
          (n) =>
            n.id === plan.id ||
            n.id === plan.parentId ||
            n.parentId === plan.id ||
            n.level === "synopsis",
        )
      : [];
    add(
      "当前章关联大纲与推进阶段",
      "本次写作目标",
      plan
        ? JSON.stringify(related) +
            "\n按本章阶段推进，不提前兑现后续章纲和伏笔。"
        : "本章尚未关联章纲，可基于已有故事依据正常写作。",
    );
  }
  if (
    p.mode === "explore" &&
    chapter?.explorationSource &&
    r.kind === "opening"
  ) {
    const source = chapter.explorationSource;
    const previous = d.chapters.find((c) => c.id === source.chapterId);
    if (
      !previous ||
      fingerprint(previous.document) !== source.sourceFingerprint ||
      source.basis !== explorationBasis(repo, p.id, previous.id)
    )
      throw new Error("上一章正文或故事依据已变化，请返回上一章更新走向。");
    add(
      `下一章来源全文/${previous.title} [${previous.id}]`,
      "3 来源正文草稿",
      previous.content,
    );
    add(
      "作者选定的本章走向（写作要求，尚未发生）",
      "本次写作目标",
      source.instruction,
    );
  }
  const memories = applicableMemories(d, chapter?.id, r.kind === "directions");
  add(
    "有效记忆（已发生事实）",
    "3 事实",
    memories
      .map(
        (m) =>
          `[${m.chapterId ?? "手动"} / ${m.kind} / ${m.revisionId ?? "手工记录"}] ${m.content}`,
      )
      .join("\n"),
  );
  if (r.kind === "brainstorm") {
    const sets = repo.db
      .prepare("SELECT payload FROM change_sets WHERE project_id = ?")
      .all(p.id) as { payload: string }[];
    const candidates = sets
      .map((x) => JSON.parse(x.payload))
      .filter(
        (x) =>
          [
            "settings",
            "blueprint",
            ...(p.mode === "novel" ? ["outline"] : []),
          ].includes(x.kind) &&
          x.status !== "applied" &&
          x.changes.some(
            (c: any) =>
              !c.applied &&
              (p.mode === "novel" ||
                c.target.type !== "blueprint" ||
                c.target.node.level === "section"),
          ),
      );
    add(
      "未采用候选（仅供讨论，不是正式设定）",
      "4 候选",
      JSON.stringify(
        candidates.map((c) => ({
          title: c.title,
          changes: c.changes
            .filter(
              (x: any) =>
                !x.applied &&
                (p.mode === "novel" ||
                  x.target.type !== "blueprint" ||
                  x.target.node.level === "section"),
            )
            .map((x: any) => ({ target: x.target, content: x.after })),
        })),
      ),
    );
  } else if (r.kind !== "check") {
    if (chapter)
      add(
        `当前章全文/${chapter.title} [${chapter.id}]`,
        "3 正文草稿",
        r.kind === "notes" ? "" : chapter.content,
      );
    if (r.kind === "notes") {
      if (!chapter?.acceptedRevisionId || chapter.needsReview)
        throw new Error("请先采用或复核当前章，再整理记忆。");
      add(
        "唯一记忆来源（已采用版本）",
        "3 事实",
        repo.getRevision(chapter.acceptedRevisionId).content,
      );
    }
  }
  if (r.kind === "polish")
    add(
      `唯一允许替换的选区 [${r.selection.from},${r.selection.to}]`,
      "任务目标",
      r.selection.text,
    );
  if (r.kind === "prompt" && r.selection)
    add("指定插画场景", "任务目标", r.selection.text);
  add("本次任务补充", "任务目标", extra);
  const images: TaskPreview["images"] = [];
  const refs = referenceImages(repo, d);
  if (refs.length && !opts.capabilities.vision)
    throw new Error(
      "世界与人物有关联参考图，请切换到支持图片输入的模型，并在模型设置中启用看图能力。",
    );
  for (const img of refs) {
    let url: string;
    try {
      url = await opts.readImage(
        img.id,
        Math.min(
          referenceImageLimits.perImageBytes,
          Math.floor(referenceImageLimits.totalBytes / refs.length),
        ),
      );
    } catch {
      throw new Error(`参考图「${img.name}」无法读取，请修复图片后重试。`);
    }
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(url))
      throw new Error(`参考图「${img.name}」无法读取。`);
    images.push({
      id: img.id,
      name: img.name,
      owners: d.cards
        .filter((c) => c.referenceIds.includes(img.id))
        .map((c) => c.name),
      url,
    });
  }
  const system =
    rolePrompt(roleSettings(repo), r.kind) +
    "\n\n" +
    modeTools[p.mode].description +
    "\n" +
    modeTools[p.mode].prompts[r.kind] +
    "\n" +
    creationPolicy(p);
  const referenceMessage: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: blocks.join("\n\n") },
      ...images.flatMap((i) => [
        {
          type: "text" as const,
          text: `参考图：${i.name}，所属：${i.owners.join("、")}`,
        },
        {
          type: "image_url" as const,
          image_url: { url: i.url, detail: "high" as const },
        },
      ]),
    ],
  };
  const omitted: string[] = d.cards.flatMap((c) =>
    c.documents
      .filter((doc) => !doc.enabled)
      .map((doc) => `作者停用的原文：${c.name}/${doc.name}`),
  );
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    referenceMessage,
    ...history,
    { role: "user", content: r.instruction || "请根据现有资料完成当前任务。" },
  ];
  ensureBudget(messages, opts.capabilities);
  // Previous prose is optional continuity context; keep the nearest chapters that fit, preserving complete current text.
  if (!["brainstorm", "check", "notes"].includes(r.kind)) {
    const earlier = d.chapters.filter(
      (c) =>
        (!chapter || c.position < chapter.position) &&
        !(
          p.mode === "explore" &&
          r.kind === "opening" &&
          chapter?.explorationSource?.chapterId === c.id
        ),
    );
    for (const c of earlier.slice(0, -2))
      omitted.push(`较早章节正文：${c.title} [${c.id}]`);
    for (const c of earlier.slice(-2).reverse()) {
      const text = c.content.slice(-6000),
        item = {
          role: "user" as const,
          content: `【前章衔接，${c.dirty ? "草稿" : "已采用"}：${c.title} [${c.id}]，实际范围：末 ${text.length}/${c.content.length} 字符】\n${text}`,
        };
      const trial = [...messages.slice(0, 2), item, ...messages.slice(2)];
      if (
        estimatedTokens(trial) + opts.capabilities.outputTokens <=
        opts.capabilities.contextTokens
      ) {
        messages.splice(2, 0, item);
        sources.push({
          title: `前章衔接/${c.title}，末 ${text.length}/${c.content.length} 字符`,
          priority: "3 普通前文",
          characters: text.length,
        });
        if (text.length < c.content.length)
          omitted.push(
            `前章 ${c.title} 的较早 ${c.content.length - text.length} 字符`,
          );
      } else omitted.push(`前章衔接：${c.title} [${c.id}]`);
    }
  }
  return {
    model: opts.model,
    messages,
    sources,
    images,
    omitted,
    estimatedTokens: ensureBudget(messages, opts.capabilities),
  };
}
