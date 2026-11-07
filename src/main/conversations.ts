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
import { modeTools, toolNames } from "../shared/tools";
import {
  buildContext,
  basis,
  estimatedTokens,
  fingerprint,
  type ContextOptions,
} from "./context";
import { buildChangeSet, saveChangeSet, listChangeSets } from "./changes";
import { selectionText } from "./document-edit";
import { validateBlueprint } from "../shared/blueprint";
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
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
  if (r.kind === "blueprint") {
    const t = r.target,
      existing = d.project.blueprint.nodes.find((n) => n.id === t.id);
    if (!modeTools[r.mode].blueprintLevels.includes(t.level))
      throw new Error("当前模式不支持这个规划层级。");
    if (t.id && (!existing || existing.level !== t.level))
      throw new Error("蓝图目标不存在或层级不匹配。");
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
  if (
    r.kind === "notes" &&
    (!chapter?.acceptedRevisionId || chapter.needsReview)
  )
    throw new Error("请先采用或复核本章。");
  return d;
}
export function getConversation(
  repo: StoryRepository,
  pid: string,
  id: string,
): CreationConversation {
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
  repo.db
    .prepare(
      "INSERT INTO creation_conversations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    )
    .run(c.id, c.projectId, JSON.stringify(c));
}
function writeTurn(repo: StoryRepository, t: CreationTurn) {
  repo.db
    .prepare(
      "INSERT INTO creation_turns VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    )
    .run(t.id, t.conversationId, t.projectId, JSON.stringify(t));
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
    createdAt: new Date().toISOString(),
  };
  delete c.request.conversationId;
  delete c.request.parentTurnId;
  writeConversation(repo, c);
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
  ).map((r) => JSON.parse(r.payload) as CreationConversation);
}
function contract(r: TaskRequest) {
  if (r.kind === "settings")
    return (
      '只输出JSON：{"changes":[{"type":"card","cardId":"已有资料ID，新增则省略","kind":"character|world|inspiration","name":"资料名","field":"description|constraints|section","sectionId":"已有分区ID，新增则省略","title":"分区标题","content":"该目标的完整新内容"}]}。也可使用{"type":"project","field":"world|style","content":"完整内容"}修改世界规则或叙事偏好。禁止蓝图修改。不得返回未知字段。同一目标只出现一次。' +
      (r.cardId ? "只修改资料：" + r.cardId : "")
    );
  if (r.kind === "blueprint")
    return `仅处理指定蓝图目标 ${JSON.stringify(r.target)}。返回 ${r.target.id ? 1 : r.target.count} 项。只输出JSON：{"items":[{"title":"名称","content":"该节点完整新内容"}]}。不创建正文、不修改设定。`;
  if (r.kind === "notes")
    return '只输出JSON：{"records":[{"kind":"summary|fact|state|relationship|knowledge|foreshadow","content":"自足事实记录"}]}。最多24条。';
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
  const c = r.conversationId
    ? getConversation(repo, r.projectId, r.conversationId)
    : createConversation(repo, r);
  if (c.key !== requestKey(r)) throw new Error("对话目标不匹配。");
  r.conversationId = c.id;
  const initialBasis = basis(repo, r.projectId),
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
    const preview = await prepareTaskPreview(repo, r, opts);
    if (basis(repo, r.projectId) !== initialBasis)
      throw new Error("构建请求时基础资料发生变化，请重新生成。");
    t.sourceSnapshot = [preview];
    writeTurn(repo, t);
    if (r.kind === "check")
      result = await checkStory(d, r, preview, opts, delta);
    else {
      const raw = await opts.generate(preview.messages, delta);
      if (opts.signal.aborted) throw new Error("生成已停止。");
      if (!raw.trim()) throw new Error("模型没有返回内容。");
      if (r.kind === "brainstorm") result = { type: "chat", text: raw };
      else if (r.kind === "prompt")
        result = { type: "illustration", text: raw };
      else {
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
      repo.db.transaction(() => {
        const c = getConversation(repo, p.projectId, p.id);
        if (
          conversationDetail(repo, c.projectId, c.id).turns.some(
            (t) => t.status === "generating",
          )
        )
          throw new Error("对话仍在生成，请先停止生成。");
        repo.db
          .prepare("DELETE FROM creation_turns WHERE conversation_id = ?")
          .run(c.id);
        repo.db
          .prepare("DELETE FROM creation_conversations WHERE id = ?")
          .run(c.id);
        return true;
      })(),
  };
}
