import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  ChatMessage,
  CheckBatch,
  CreationConversation,
  CreationTurn,
  TaskRequest,
  TaskResult,
  ProgressEvent,
  TaskPreview,
  ProjectDetail,
} from "../shared/types";
import { requestKey, requestSchema } from "../shared/requests";
import { toolNames } from "../shared/tools";
import {
  buildContext,
  basis,
  estimatedTokens,
  fingerprint,
  explorationBasis,
  type ContextOptions,
} from "./context";
import { buildChangeSet, saveChangeSet, listChangeSets } from "./changes";
import { selectionText } from "./document-edit";
import { outlineLevels, validateBlueprint } from "../shared/blueprint";
import { automaticDirectionKey, saveDirections } from "./exploration";
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
type ConversationDraft = {
  conversation: CreationConversation;
  turns: CreationTurn[];
};
const drafts = new WeakMap<StoryRepository, Map<string, ConversationDraft>>();
function draftMap(repo: StoryRepository) {
  let map = drafts.get(repo);
  if (!map) drafts.set(repo, (map = new Map()));
  return map;
}
const json = (s: string) =>
  JSON.parse(
    s
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/i, "")
      .replace(/\s*\x60\x60\x60$/, ""),
  );
export function validateRequest(repo: StoryRepository, r: TaskRequest) {
  const d = repo.getDetail(r.projectId);
  if (d.project.mode !== r.mode)
    throw new Error("作品模式已变化，请切换到当前模式。");
  const chapter =
    "chapterId" in r && r.chapterId
      ? d.chapters.find((c) => c.id === r.chapterId)
      : undefined;
  if ("chapterId" in r && r.chapterId && !chapter)
    throw new Error("目标章节不存在或不属于当前作品。");
  if (r.kind === "opening" && chapter?.content.trim())
    throw new Error("当前章已有正文，请新建空章开篇，或使用续写、选区打磨。");
  if (r.kind === "continue" && !chapter?.content.trim())
    throw new Error("当前章为空，请先使用开篇。");
  if (r.kind === "expand" && !chapter?.content.trim())
    throw new Error("当前章为空，暂时无法扩写。");
  if (r.kind === "notes") {
    const ids = r.chapterIds ?? (r.chapterId ? [r.chapterId] : []);
    if (
      !ids.length ||
      ids.some((chapterId) => {
        const selected = d.chapters.find((item) => item.id === chapterId);
        return !selected?.acceptedRevisionId || selected.needsReview;
      })
    )
      throw new Error("请选择已采用且已复核的章节整理记忆。");
  }
  if (
    r.kind === "polish" &&
    (!chapter ||
      selectionText(chapter.document, r.selection) !== r.selection.text)
  )
    throw new Error("请重新选择需要打磨的正文。");
  if (
    r.kind === "prompt" &&
    r.selection &&
    (!chapter ||
      selectionText(chapter.document, r.selection) !== r.selection.text)
  )
    throw new Error("插画选区已变化，请重新选择。");
  if (
    r.kind === "settings" &&
    r.cardId &&
    !d.cards.some((c) => c.id === r.cardId)
  )
    throw new Error("目标资料不属于当前作品。");
  if (r.kind === "directions") {
    if (r.mode !== "explore" || !chapter?.content.trim())
      throw new Error("自由探索需先写入当前章正文，再生成走向。");
    if (r.parentTurnId) throw new Error("剧情走向每次根据当前正文重新生成。");
    if (r.triggerChangeSetId) {
      const set = listChangeSets(repo, r.projectId).find(
        (s) => s.id === r.triggerChangeSetId,
      );
      if (
        !set ||
        set.kind !== "opening" ||
        !set.changes.some(
          (c) =>
            c.applied &&
            c.target.type === "prose" &&
            c.target.chapterId === r.chapterId,
        )
      )
        throw new Error("自动走向必须来源于已审核写入的开篇。");
    }
  }
  if (r.kind === "blueprint" || r.kind === "outline") {
    const t = r.target,
      existing = d.project.blueprint.nodes.find((n) => n.id === t.id);
    const levels =
      r.kind === "blueprint"
        ? ["section"]
        : r.mode === "novel"
          ? outlineLevels
          : [];
    if (!levels.includes(t.level))
      throw new Error("当前模式不支持这个规划层级。");
    if (t.id && (!existing || existing.level !== t.level))
      throw new Error(
        `${r.kind === "outline" ? "大纲" : "额外设定"}目标不存在或层级不匹配。`,
      );
    if (t.id && t.count !== 1) throw new Error("编辑现有节点只能生成一项。");
    if (!t.id) {
      const node = {
        id: randomUUID(),
        level: t.level,
        parentId: t.parentId ?? null,
        chapterId: t.chapterId ?? null,
        title: "待生成",
        content: "",
      };
      validateBlueprint(
        { nodes: [...d.project.blueprint.nodes, node] },
        d.chapters.map((c) => c.id),
      );
      if (t.chapterId && t.count > 1)
        throw new Error("同一正文只能关联一个章纲。");
      if (t.level === "synopsis" && t.count > 1)
        throw new Error("只保留一个总纲。");
    }
  }
  if (r.kind === "check") {
    const ids =
      r.scope.type === "book"
        ? d.chapters.map((c) => c.id)
        : r.scope.type === "current"
          ? [r.scope.chapterId]
          : r.scope.chapterIds;
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !d.chapters.some((c) => c.id === id))
    )
      throw new Error("检查范围为空、重复或包含其他作品的章节。");
  }
  return d;
}
export function getConversation(
  repo: StoryRepository,
  pid: string,
  id: string,
): CreationConversation {
  const draft = draftMap(repo).get(id);
  if (draft) {
    if (draft.conversation.projectId !== pid)
      throw new Error("对话不存在或不属于当前故事。");
    return draft.conversation;
  }
  const row = repo.db
    .prepare(
      "SELECT payload FROM creation_conversations WHERE id = ? AND project_id = ?",
    )
    .get(id, pid) as { payload: string } | undefined;
  if (!row) throw new Error("对话不存在或不属于当前故事。");
  return JSON.parse(row.payload);
}
export function getTurn(
  repo: StoryRepository,
  pid: string,
  id: string,
): CreationTurn {
  for (const draft of draftMap(repo).values()) {
    const turn = draft.turns.find((item) => item.id === id);
    if (turn) {
      if (turn.projectId !== pid)
        throw new Error("结果不存在或不属于当前故事。");
      return turn;
    }
  }
  const row = repo.db
    .prepare(
      "SELECT payload FROM creation_turns WHERE id = ? AND project_id = ?",
    )
    .get(id, pid) as { payload: string } | undefined;
  if (!row) throw new Error("结果不存在或不属于当前故事。");
  return JSON.parse(row.payload);
}
export function conversationDetail(
  repo: StoryRepository,
  pid: string,
  id: string,
) {
  const conversation = getConversation(repo, pid, id);
  const draft = draftMap(repo).get(id);
  if (draft) return { conversation, turns: draft.turns };
  const turns = (
    repo.db
      .prepare(
        "SELECT payload FROM creation_turns WHERE conversation_id = ? ORDER BY rowid",
      )
      .all(id) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as CreationTurn);
  return { conversation, turns };
}
function writeConversation(repo: StoryRepository, c: CreationConversation) {
  if (draftMap(repo).has(c.id)) return;
  repo.db
    .prepare(
      "INSERT INTO creation_conversations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    )
    .run(c.id, c.projectId, JSON.stringify(c));
}
function writeTurn(repo: StoryRepository, t: CreationTurn) {
  const draft = draftMap(repo).get(t.conversationId);
  if (draft) {
    const index = draft.turns.findIndex((item) => item.id === t.id);
    if (index < 0) draft.turns.push(t);
    else draft.turns[index] = t;
    return;
  }
  repo.db
    .prepare(
      "INSERT INTO creation_turns VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    )
    .run(t.id, t.conversationId, t.projectId, JSON.stringify(t));
}
function isDraft(repo: StoryRepository, id: string) {
  return draftMap(repo).has(id);
}
export function createConversation(
  repo: StoryRepository,
  r: TaskRequest,
): CreationConversation {
  validateRequest(repo, r);
  const c: CreationConversation = {
    id: randomUUID(),
    projectId: r.projectId,
    mode: r.mode,
    kind: r.kind,
    key: requestKey(r),
    title: toolNames[r.kind] + " · " + (r.instruction.slice(0, 30) || "新对话"),
    request: copy(r),
    selectedTurnId: null,
    archived: false,
    saved: false,
    createdAt: new Date().toISOString(),
  };
  delete c.request.conversationId;
  delete c.request.parentTurnId;
  draftMap(repo).set(c.id, { conversation: c, turns: [] });
  return c;
}
export function listConversations(repo: StoryRepository, pid: string) {
  repo.getProject(pid);
  return (
    repo.db
      .prepare(
        "SELECT payload FROM creation_conversations WHERE project_id = ? ORDER BY rowid DESC",
      )
      .all(pid) as { payload: string }[]
  ).map((r) => ({
    ...(JSON.parse(r.payload) as CreationConversation),
    saved: true,
  }));
}
export function listConversationDrafts(repo: StoryRepository, pid: string) {
  repo.getProject(pid);
  return [...draftMap(repo).values()]
    .map((draft) => draft.conversation)
    .filter((conversation) => conversation.projectId === pid)
    .reverse();
}
function contract(r: TaskRequest) {
  if (r.kind === "settings")
    return (
      '只输出JSON：{"changes":[{"type":"card","cardId":"已有资料ID，新增则省略","kind":"character|world|inspiration","name":"资料名","field":"description|constraints|section","sectionId":"已有分区ID，新增则省略","title":"分区标题","content":"该目标的完整新内容"}]}。也可使用{"type":"project","field":"style","content":"叙事偏好的完整内容"}修改叙事偏好。世界规则请放入世界资料，不修改旧世界规则字段。禁止额外设定修改。不得返回未知字段。同一目标只出现一次。' +
      (r.cardId ? "只修改资料：" + r.cardId : "")
    );
  if (r.kind === "blueprint")
    return `仅处理指定额外设定目标 ${JSON.stringify(r.target)}。返回 ${r.target.id ? 1 : r.target.count} 项。额外设定保存作者自定义的文章特殊要求和故事约束，条目名称与内容自由定义，例如视角限制、能力代价、感情线边界；示例不是固定分类。已有大纲仅作背景参考，不能作为输出模板。不得自行生成“第一章……”式章纲、剧情梗概或逐章安排。只输出JSON：{"items":[{"title":"自定义约束条目名称","content":"该条目的完整特殊要求或约束内容，供创作时持续参考"}]}。修改已有条目时保留作者的主题与未受影响内容。不创建正文，不修改大纲、世界与人物或其他资料。`;
  if (r.kind === "outline")
    return `仅处理指定大纲目标 ${JSON.stringify(r.target)}。返回 ${r.target.id ? 1 : r.target.count} 项。按指定层级输出剧情规划。只输出JSON：{"items":[{"title":"名称","content":"该节点完整新内容"}]}。不创建正文、不修改额外设定或资料。`;
  if (r.kind === "directions")
    return `生成恰好 ${r.count} 个不同的下一章剧情走向。只输出JSON：{"options":[{"title":"简短标题","content":"具体的剧情说明"}]}。每项都须遵守全部额外设定、资料和有效记忆，衔接当前正文，不输出正文，不将走向写成已发生事实。`;
  if (r.kind === "notes")
    return '只输出JSON：{"records":[{"kind":"summary","content":"自足、精炼的章节摘要"}]}。只根据本次指定的已采用章节提取已发生事实。';
  if (r.kind === "memory_tune")
    return '只输出JSON：{"changes":[{"type":"add","chapterId":"来源章节ID","revisionId":"采用版本ID","kind":"fact|state|relationship|knowledge|foreshadow|summary","content":"新记忆内容","reason":"调整原因"},{"type":"replace","memoryIds":["需替换的较早章节记忆ID"],"chapterId":"较新章节ID","revisionId":"该章采用版本ID","kind":"fact|state|relationship|knowledge|foreshadow|summary","content":"替换后内容","reason":"较新事实或闭环原因"},{"type":"disable","memoryIds":["不再需要的章节记忆ID"],"reason":"停用原因"}],"manualConflicts":[{"memoryIds":["冲突的手工记忆ID"],"reason":"冲突说明"}]}。章节记忆按章节顺序处理；手工记忆只能出现在 manualConflicts 中，不得替换或停用。';
  if (r.kind === "polish") return "本次打磨方向：" + r.aspect;
  return "";
}
export async function prepareConversationTask(
  repo: StoryRepository,
  r: TaskRequest,
  opts: ContextOptions,
  extra = "",
) {
  validateRequest(repo, r);
  let history: ChatMessage[] = [],
    omitted: string[] = [];
  if (r.conversationId) {
    const c = getConversation(repo, r.projectId, r.conversationId);
    if (c.key !== requestKey(r))
      throw new Error("模式、工具或目标已变化，请使用对应对话。");
    if (r.parentTurnId) {
      let t = getTurn(repo, r.projectId, r.parentTurnId),
        visited = new Set<string>();
      while (t) {
        if (t.conversationId !== c.id || visited.has(t.id))
          throw new Error("对话分支无效。");
        if (t.status !== "complete" || !t.result)
          throw new Error("只能从已完成的版本继续对话。");
        visited.add(t.id);
        let answer = t.result?.text || t.rawResponse;
        if (t.result?.type === "changes") {
          const result = t.result;
          const set = listChangeSets(repo, r.projectId).find(
            (s) => s.id === result.changeSetId,
          );
          if (set)
            answer = JSON.stringify(
              set.changes.map((x) => ({ target: x.target, content: x.after })),
            );
        }
        history.unshift(
          { role: "user", content: t.instruction || "请完成当前任务。" },
          { role: "assistant", content: answer },
        );
        if (!t.parentTurnId) break;
        t = getTurn(repo, r.projectId, t.parentTurnId);
      }
    }
  }
  // Preserve complete recent pairs; remove oldest whole pairs only.
  while (
    history.length &&
    estimatedTokens(history) > Math.floor(opts.capabilities.contextTokens / 3)
  ) {
    history.splice(0, 2);
    omitted.push("较早的一轮对话");
  }
  const instruction =
    r.kind === "brainstorm"
      ? ""
      : history.length
        ? "\n基于所选结果和本轮要求继续；有修改时输出目标的完整新稿。"
        : "";
  const req = { ...r, instruction: r.instruction + instruction };
  let preview;
  for (;;) {
    try {
      preview = await buildContext(
        repo,
        req,
        opts,
        [contract(r), extra].filter(Boolean).join("\n\n"),
        history,
      );
      break;
    } catch (e) {
      if (history.length && (e as Error).message.includes("上下文预算")) {
        history.splice(0, 2);
        omitted.push("较早的一轮对话");
      } else throw e;
    }
  }
  preview.omitted.push(...omitted);
  return preview;
}
interface CheckJob {
  title: string;
  chapterIds: string[];
  extra: string;
}
function checkJobs(
  d: ProjectDetail,
  r: Extract<TaskRequest, { kind: "check" }>,
): CheckJob[] {
  const ids =
    r.scope.type === "book"
      ? d.chapters.map((c) => c.id)
      : r.scope.type === "current"
        ? [r.scope.chapterId]
        : r.scope.chapterIds;
  const chapters = d.chapters.filter((c) => ids.includes(c.id));
  const output =
    '只输出JSON：{"findings":[{"category":"conflict|question|suggestion","chapterId":"引用所属章节ID","quote":"准确原文引用","reference":"依据来源及位置","impact":"影响","suggestion":"建议"}]}。没有发现时返回空数组。';
  const body = (c: ProjectDetail["chapters"][number]) =>
    `【完整正文 ${c.title} [${c.id}]；来源版本 ${fingerprint(c.document)}】\n${c.content}`;
  const jobs: CheckJob[] = chapters.map((c) => ({
    title: "本章检查：" + c.title,
    chapterIds: [c.id],
    extra: `方向：${r.aspect}；关注人物：${r.character || "未指定"}\n${body(c)}\n${output}`,
  }));
  if (r.aspect !== "pacing")
    for (let i = 0; i < chapters.length; i++)
      for (let j = i + 1; j < chapters.length; j++) {
        const a = chapters[i],
          b = chapters[j];
        jobs.push({
          title: `跨章检查：${a.title} / ${b.title}`,
          chapterIds: [a.id, b.id],
          extra: `只检查跨章${r.aspect}问题；关注人物：${r.character || "未指定"}。对照完整两章，不重复本章问题。\n${body(a)}\n${body(b)}\n${output}`,
        });
      }
  return jobs;
}
export async function prepareTaskPreview(
  repo: StoryRepository,
  r: TaskRequest,
  opts: ContextOptions,
): Promise<TaskPreview> {
  const d = validateRequest(repo, r),
    foundation = await prepareConversationTask(repo, r, opts);
  if (r.kind !== "check") return foundation;
  const batches: NonNullable<TaskPreview["batches"]> = [];
  for (const job of checkJobs(d, r)) {
    try {
      batches.push({
        title: job.title,
        preview: await prepareConversationTask(repo, r, opts, job.extra),
      });
    } catch (e) {
      batches.push({ title: job.title, error: (e as Error).message });
    }
  }
  return {
    ...foundation,
    messages: [],
    estimatedTokens: Math.max(
      foundation.estimatedTokens,
      ...batches.map((b) => b.preview?.estimatedTokens ?? 0),
    ),
    batches,
  };
}
const findingSchema = z
  .object({
    category: z.enum(["conflict", "question", "suggestion"]),
    chapterId: z.string(),
    quote: z.string().min(1),
    reference: z.string().min(1),
    impact: z.string().min(1),
    suggestion: z.string().min(1),
  })
  .strict();
async function checkStory(
  d: ProjectDetail,
  r: Extract<TaskRequest, { kind: "check" }>,
  preview: TaskPreview,
  opts: RunOptions,
  onDelta: (s: string) => void,
): Promise<TaskResult> {
  const jobs = checkJobs(d, r),
    batches: CheckBatch[] = [],
    comparisons: import("../shared/types").CheckReport["comparisons"] = [];
  for (const [i, job] of jobs.entries()) {
    if (opts.signal.aborted) throw new Error("已停止检查。");
    const cross = job.chapterIds.length === 2,
      c = d.chapters.find((c) => c.id === job.chapterIds[0])!;
    try {
      const p = preview.batches![i];
      if (!p.preview) throw new Error(p.error || "请求构建失败。");
      const raw = await opts.generate(p.preview.messages, () => {});
      if (opts.signal.aborted) throw new Error("已停止检查。");
      const findings = z
        .object({ findings: z.array(findingSchema).max(100) })
        .strict()
        .parse(json(raw)).findings;
      for (const f of findings) {
        const source = d.chapters.find((c) => c.id === f.chapterId);
        if (
          !source ||
          !job.chapterIds.includes(f.chapterId) ||
          !source.content.includes(f.quote)
        )
          throw new Error("检查引用无法在来源正文中核对。");
      }
      if (cross) {
        comparisons.push({ chapterIds: job.chapterIds, status: "complete" });
        for (const f of findings)
          batches.find((b) => b.chapterId === f.chapterId)!.findings.push(f);
      } else
        batches.push({
          chapterId: c.id,
          title: c.title,
          sourceVersion: fingerprint(c.document),
          status: "complete",
          findings,
        });
      onDelta(`完成 ${i + 1}/${jobs.length}：${job.title}\n`);
    } catch (e) {
      if (opts.signal.aborted) throw e;
      const error = (e as Error).message;
      if (cross)
        comparisons.push({
          chapterIds: job.chapterIds,
          status: "failed",
          error,
        });
      else
        batches.push({
          chapterId: c.id,
          title: c.title,
          sourceVersion: fingerprint(c.document),
          status: "failed",
          error,
          findings: [],
        });
      onDelta(`失败 ${i + 1}/${jobs.length}：${job.title}（${error}）\n`);
    }
  }
  const complete =
    batches.every((b) => b.status === "complete") &&
    comparisons.every((c) => c.status === "complete");
  const failed = comparisons
    .filter((c) => c.status === "failed")
    .map(
      (c) =>
        `跨章检查未完成：${c.chapterIds.map((id) => d.chapters.find((c) => c.id === id)!.title).join(" / ")}（${c.error}）`,
    )
    .join("\n");
  const summary = `${complete ? "检查完成" : "检查部分完成"}：${batches.filter((b) => b.status === "complete").length}/${batches.length}章；跨章 ${comparisons.filter((c) => c.status === "complete").length}/${comparisons.length}组；${batches.reduce((n, b) => n + b.findings.length, 0)}条发现。\n${failed}`;
  const text =
    summary +
    "\n" +
    batches
      .map(
        (b) =>
          `## ${b.title} [${b.chapterId}]\n${b.status === "failed" ? b.error + "\n" : ""}${b.findings.map((f) => `- [${f.category}]「${f.quote}」\n依据：${f.reference}\n影响：${f.impact}\n建议：${f.suggestion}`).join("\n") || (b.status === "complete" ? "未发现具体问题。" : "本章未完成检查。")}`,
      )
      .join("\n\n");
  return {
    type: "report",
    text,
    report: { aspect: r.aspect, batches, comparisons, summary, complete },
  };
}
export interface RunOptions extends ContextOptions {
  signal: AbortSignal;
  generate: (
    messages: ChatMessage[],
    delta: (s: string) => void,
  ) => Promise<string>;
  progress: (e: ProgressEvent) => void;
}
export async function runCreationTask(
  repo: StoryRepository,
  input: TaskRequest,
  opts: RunOptions,
) {
  const r = requestSchema.parse(input) as TaskRequest,
    d = validateRequest(repo, r);
  const automaticKey =
    r.kind === "directions" ? automaticDirectionKey(r) : null;
  if (automaticKey) {
    const previousId = repo.getSetting<string | null>(automaticKey, null);
    if (previousId) {
      const previous = getTurn(repo, r.projectId, previousId);
      if (previous.status === "complete" && previous.result)
        return {
          conversationId: previous.conversationId,
          turnId: previous.id,
          result: previous.result,
        };
      if (previous.status === "generating")
        throw new Error("本次正文的走向正在生成。");
    }
  }
  const c = r.conversationId
    ? getConversation(repo, r.projectId, r.conversationId)
    : createConversation(repo, r);
  if (c.key !== requestKey(r)) throw new Error("对话目标不匹配。");
  r.conversationId = c.id;
  const initialBasis = basis(repo, r.projectId),
    initialExplorationBasis =
      r.kind === "directions"
        ? explorationBasis(repo, r.projectId, r.chapterId)
        : "",
    turns = conversationDetail(repo, r.projectId, c.id).turns;
  const t: CreationTurn = {
    id: randomUUID(),
    projectId: r.projectId,
    conversationId: c.id,
    number: turns.length + 1,
    parentTurnId: r.parentTurnId ?? null,
    instruction: r.instruction,
    status: "generating",
    rawResponse: "",
    result: null,
    sourceSnapshot: [],
    error: "",
    model: opts.model,
    createdAt: new Date().toISOString(),
  };
  writeTurn(repo, t);
  if (automaticKey) repo.setSetting(automaticKey, t.id);
  c.selectedTurnId = t.id;
  writeConversation(repo, c);
  const delta = (s: string) => {
    t.rawResponse += s;
    writeTurn(repo, t);
    opts.progress({
      requestId: r.requestId,
      delta: s,
      conversationId: c.id,
      turnId: t.id,
    });
  };
  try {
    let result: TaskResult;
    let preview: TaskPreview | undefined;
    let raw: string;
    if (r.kind === "notes" && r.chapterIds) {
      const records: {
        chapterId: string;
        revisionId: string;
        kind: "summary";
        content: string;
      }[] = [];
      t.sourceSnapshot = [];
      for (const chapterId of r.chapterIds) {
        if (opts.signal.aborted) throw new Error("生成已停止。");
        const chapter = d.chapters.find((item) => item.id === chapterId)!;
        const singleRequest: TaskRequest = {
          ...r,
          chapterId,
          instruction:
            r.instruction + "\n只返回一条本章摘要，不要提取其他类型的记忆。",
        };
        delete (singleRequest as { chapterIds?: string[] }).chapterIds;
        preview = await buildContext(
          repo,
          singleRequest,
          opts,
          contract(singleRequest),
        );
        if (basis(repo, r.projectId) !== initialBasis)
          throw new Error("构建请求时基础资料发生变化，请重新生成。");
        t.sourceSnapshot.push(preview);
        writeTurn(repo, t);
        const response = await opts.generate(preview.messages, delta);
        if (opts.signal.aborted) throw new Error("生成已停止。");
        const parsed = z
          .object({
            records: z
              .array(
                z
                  .object({
                    kind: z.literal("summary"),
                    content: z.string().trim().min(1).max(3000),
                  })
                  .strict(),
              )
              .length(1),
          })
          .strict()
          .parse(json(response));
        records.push({
          chapterId,
          revisionId: chapter.acceptedRevisionId!,
          kind: "summary",
          content: parsed.records[0].content,
        });
      }
      raw = JSON.stringify({ records });
    } else {
      preview = await prepareTaskPreview(repo, r, opts);
      if (basis(repo, r.projectId) !== initialBasis)
        throw new Error("构建请求时基础资料发生变化，请重新生成。");
      t.sourceSnapshot = [preview];
      writeTurn(repo, t);
      if (r.kind === "check") {
        result = await checkStory(d, r, preview, opts, delta);
        if (opts.signal.aborted) throw new Error("生成已停止。");
        t.result = result;
        t.status = "complete";
        writeTurn(repo, t);
        return { conversationId: c.id, turnId: t.id, result };
      }
      raw = await opts.generate(preview.messages, delta);
    }
    if (r.kind !== "notes" || !r.chapterIds) {
      if (opts.signal.aborted) throw new Error("生成已停止。");
      if (!raw.trim()) throw new Error("模型没有返回内容。");
    }
    {
      if (!raw.trim()) throw new Error("模型没有返回内容。");
      if (r.kind === "brainstorm") result = { type: "chat", text: raw };
      else if (r.kind === "prompt")
        result = { type: "illustration", text: raw };
      else if (r.kind === "directions") {
        const parsed = z
          .object({
            options: z
              .array(
                z
                  .object({
                    title: z.string().trim().min(1).max(200),
                    content: z.string().trim().min(1).max(10000),
                  })
                  .strict(),
              )
              .length(r.count),
          })
          .strict()
          .parse(json(raw));
        if (
          new Set(parsed.options.map((o) => o.title + "\n" + o.content))
            .size !== r.count
        )
          throw new Error("剧情走向重复，请重新生成。");
        const options = parsed.options.map((o) => ({ ...o, id: randomUUID() }));
        result = { type: "directions", text: raw, options };
        t.result = result;
        t.status = "complete";
        repo.db.transaction(() => {
          saveDirections(repo, r, options, {
            sourceFingerprint: fingerprint(
              d.chapters.find((c) => c.id === r.chapterId)!.document,
            ),
            basis: initialExplorationBasis,
            model: opts.model,
            turnId: t.id,
            preview: preview!,
          });
          writeTurn(repo, t);
        })();
        return { conversationId: c.id, turnId: t.id, result };
      } else {
        const set = buildChangeSet(
          d,
          r,
          raw,
          { conversationId: c.id, turnId: t.id },
          initialBasis,
        );
        result = { type: "changes", text: raw, changeSetId: set.id };
        // Complete result and candidate persist together.
        t.result = result;
        t.status = "complete";
        repo.db.transaction(() => {
          saveChangeSet(repo, set);
          writeTurn(repo, t);
        })();
        return { conversationId: c.id, turnId: t.id, result };
      }
    }
    if (opts.signal.aborted) throw new Error("生成已停止。");
    t.result = result;
    t.status = "complete";
    writeTurn(repo, t);
    return { conversationId: c.id, turnId: t.id, result };
  } catch (e) {
    t.status = opts.signal.aborted ? "stopped" : "error";
    t.error = (e as Error).message;
    writeTurn(repo, t);
    throw e;
  }
}
export function conversationHandlers(
  repo: StoryRepository,
): Record<string, (p: any) => unknown> {
  return {
    "conversation:list": (p) =>
      listConversations(repo, z.string().uuid().parse(p)),
    "conversation:drafts:list": (p) =>
      listConversationDrafts(repo, z.string().uuid().parse(p)),
    "conversation:save": (p) => {
      const input = z
        .object({
          projectId: z.string().uuid(),
          id: z.string().uuid(),
        })
        .strict()
        .parse(p);
      const c = getConversation(repo, input.projectId, input.id);
      const detail = conversationDetail(repo, c.projectId, c.id);
      if (detail.turns.some((turn) => turn.status === "generating"))
        throw new Error("对话仍在生成，请完成或停止后再保存。");
      if (isDraft(repo, c.id)) {
        const saved = { ...c, saved: true, archived: false };
        repo.db.transaction(() => {
          repo.db
            .prepare("INSERT INTO creation_conversations VALUES (?, ?, ?)")
            .run(saved.id, saved.projectId, JSON.stringify(saved));
          const insertTurn = repo.db.prepare(
            "INSERT INTO creation_turns VALUES (?, ?, ?, ?)",
          );
          for (const turn of detail.turns)
            insertTurn.run(
              turn.id,
              turn.conversationId,
              turn.projectId,
              JSON.stringify(turn),
            );
        })();
        draftMap(repo).delete(c.id);
        return saved;
      }
      return c;
    },
    "conversation:get": (p) =>
      conversationDetail(
        repo,
        z.string().uuid().parse(p.projectId),
        z.string().uuid().parse(p.id),
      ),
    "conversation:create": (p) =>
      createConversation(repo, requestSchema.parse(p) as TaskRequest),
    "conversation:select": (p) => {
      const c = getConversation(repo, p.projectId, p.id),
        t = getTurn(repo, p.projectId, p.turnId);
      if (t.conversationId !== c.id) throw new Error("版本不属于此对话。");
      c.selectedTurnId = t.id;
      writeConversation(repo, c);
      return conversationDetail(repo, c.projectId, c.id);
    },
    "conversation:rename": (p) => {
      const c = getConversation(repo, p.projectId, p.id);
      c.title = z.string().trim().min(1).max(200).parse(p.title);
      writeConversation(repo, c);
      return c;
    },
    "conversation:delete": (p) =>
      (() => {
        const input = z
          .object({ projectId: z.string().uuid(), id: z.string().uuid() })
          .strict()
          .parse(p);
        const c = getConversation(repo, input.projectId, input.id);
        if (
          conversationDetail(repo, c.projectId, c.id).turns.some(
            (t) => t.status === "generating",
          )
        )
          throw new Error("对话仍在生成，请先停止生成。");
        if (isDraft(repo, c.id)) {
          draftMap(repo).delete(c.id);
          return true;
        }
        return repo.db.transaction(() => {
          repo.db
            .prepare("DELETE FROM creation_turns WHERE conversation_id = ?")
            .run(c.id);
          repo.db
            .prepare("DELETE FROM creation_conversations WHERE id = ?")
            .run(c.id);
          return true;
        })();
      })(),
  };
}
