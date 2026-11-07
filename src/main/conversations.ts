import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  TaskRequest,
  TaskResult,
  ProgressEvent,
  BlueprintCandidate,
} from "../shared/types";
import {
  conversationTargetSchema,
  conversationTarget,
  targetKey,
  turnReviewSchema,
  reviewText,
  resultReview,
  type ConversationTarget,
  type CreationConversation,
  type CreationTurn,
  type ConversationDetail,
  type TurnReview,
} from "../shared/conversations";
import { buildTask, parseMemories } from "./prompts";
import {
  parseDevelopment,
  applyDevelopment,
  undoDevelopment,
} from "./development";
import { developmentText } from "../shared/development";
import {
  getPlanningBlock,
  parsePlanning,
  planningBase,
  applyPlanning,
} from "./planning";
import { toolInfo } from "../shared/tools";
import { roleDefinitions } from "../shared/roles";
import type { ChatMessage } from "./provider";

const now = () => new Date().toISOString();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identity = z.object({
  projectId: z.string().uuid(),
  id: z.string().uuid(),
});
function writeConversation(repo: StoryRepository, c: CreationConversation) {
  repo.db
    .prepare("UPDATE creation_conversations SET payload = ? WHERE id = ?")
    .run(JSON.stringify(c), c.id);
}
function writeTurn(repo: StoryRepository, turn: CreationTurn) {
  turn.updatedAt = now();
  repo.db
    .prepare("UPDATE creation_turns SET payload = ? WHERE id = ?")
    .run(JSON.stringify(turn), turn.id);
}
export function getConversation(
  repo: StoryRepository,
  projectId: string,
  id: string,
): CreationConversation {
  repo.getProject(projectId);
  const row = repo.db
    .prepare(
      "SELECT payload FROM creation_conversations WHERE id = ? AND project_id = ?",
    )
    .get(id, projectId) as { payload: string } | undefined;
  if (!row) throw new Error("创作对话不存在或不属于当前故事。");
  return JSON.parse(row.payload);
}
export function getTurn(
  repo: StoryRepository,
  projectId: string,
  id: string,
): CreationTurn {
  const row = repo.db
    .prepare(
      "SELECT payload FROM creation_turns WHERE id = ? AND project_id = ?",
    )
    .get(id, projectId) as { payload: string } | undefined;
  if (!row) throw new Error("创作版本不存在或不属于当前故事。");
  return JSON.parse(row.payload);
}
function validateTarget(
  repo: StoryRepository,
  projectId: string,
  target: ConversationTarget,
) {
  repo.getProject(projectId);
  if (
    target.chapterId &&
    repo.getChapter(target.chapterId).projectId !== projectId
  )
    throw new Error("目标章节不属于当前故事。");
  if (target.planningTarget)
    getPlanningBlock(repo, projectId, target.planningTarget);
}
export function createConversation(
  repo: StoryRepository,
  projectId: string,
  input: ConversationTarget,
  title?: string,
  legacy = false,
): CreationConversation {
  const target = conversationTargetSchema.parse(input);
  if (!legacy) validateTarget(repo, projectId, target);
  const c: CreationConversation = {
    id: randomUUID(),
    projectId,
    target,
    title:
      title?.trim() ||
      `${roleDefinitions.find((r) => r.id === target.kind)?.name ?? "创作"} · 新对话`,
    selectedTurnId: null,
    draftInstruction: "",
    autoTitle: !title,
    createdAt: now(),
    updatedAt: now(),
  };
  repo.db
    .prepare("INSERT INTO creation_conversations VALUES (?, ?, ?)")
    .run(c.id, projectId, JSON.stringify(c));
  return c;
}
export function conversationDetail(
  repo: StoryRepository,
  projectId: string,
  id: string,
): ConversationDetail {
  const conversation = getConversation(repo, projectId, id);
  const turns = (
    repo.db
      .prepare(
        "SELECT payload FROM creation_turns WHERE conversation_id = ? ORDER BY rowid",
      )
      .all(id) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as CreationTurn);
  for (const turn of turns) {
    try {
      if (turn.review.memoryRevisionId) {
        const source = repo.getRevision(turn.review.memoryRevisionId);
        if (repo.getChapter(source.chapterId).acceptedRevisionId !== source.id)
          turn.invalidReason = "来源采用版本已变化，此记忆版本不能直接写入。";
      }
      for (const change of turn.review.developmentDraft?.changes ?? [])
        for (const source of change.sources)
          repo.getRevision(source.revisionId);
    } catch {
      turn.invalidReason =
        "来源章节或版本已删除，此结果仅供查看、复制或作为候选重新生成。";
    }
  }
  let invalidReason: string | undefined;
  try {
    validateTarget(repo, projectId, conversation.target);
  } catch {
    invalidReason =
      "原目标已删除，此对话仅供查看和复制。请为其他目标新建对话。";
  }
  return { conversation, turns, invalidReason };
}

function importLegacy(repo: StoryRepository, projectId: string) {
  const key = `creation.imported.${projectId}`;
  if (repo.getSetting(key, false)) return;
  repo.db.transaction(() => {
    const saved = repo.getSetting<Record<string, any> | null>(
      `scratch.${projectId}`,
      null,
    );
    if (saved?.output?.trim()) {
      const c = createConversation(
        repo,
        projectId,
        {
          kind: saved.kind || "chapter",
          chapterId: saved.chapterId || undefined,
          planningTarget: ["outline", "adjust"].includes(saved.kind)
            ? (saved.planningDraft?.target ?? saved.planningTarget)
            : undefined,
          writingScope: saved.outputScope ?? undefined,
          outputMode: ["revise", "scene", "dialogue"].includes(saved.kind)
            ? saved.outputMode
            : undefined,
          selectionRange: saved.outputSelection ?? undefined,
        },
        "旧工作台草稿",
        true,
      );
      c.legacy = true;
      c.source = {
        content: saved.sourceContent ?? "",
        selection: saved.outputSelection ?? undefined,
        memoryRevisionId: saved.memoryRevisionId || undefined,
      };
      const review = resultReview({
        ...saved,
        text: saved.output,
      } as TaskResult);
      review.text = saved.output;
      const turn: CreationTurn = {
        id: randomUUID(),
        conversationId: c.id,
        projectId,
        number: 1,
        parentTurnId: null,
        instruction: saved.instruction ?? "",
        status: "complete",
        rawResponse: reviewText(review),
        result: copy(review),
        review,
        sourceContent: c.source.content,
        selection: c.source.selection,
        history: [],
        applied: [],
        error: "",
        model: "旧草稿",
        createdAt: now(),
        updatedAt: now(),
        undoId: saved.developmentUndoId || undefined,
      };
      repo.db
        .prepare("INSERT INTO creation_turns VALUES (?, ?, ?, ?)")
        .run(turn.id, c.id, projectId, JSON.stringify(turn));
      c.selectedTurnId = turn.id;
      writeConversation(repo, c);
    }
    repo.setSetting(key, true);
  })();
}
export function listConversations(repo: StoryRepository, projectId: string) {
  repo.getProject(projectId);
  importLegacy(repo, projectId);
  return (
    repo.db
      .prepare(
        "SELECT payload FROM creation_conversations WHERE project_id = ? ORDER BY rowid DESC",
      )
      .all(projectId) as { payload: string }[]
  )
    .map((r) => JSON.parse(r.payload) as CreationConversation)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function syncCandidate(repo: StoryRepository, turn: CreationTurn) {
  const project = repo.getProject(turn.projectId);
  const candidates = project.blueprintCandidates.map((candidate) =>
    candidate.turnId === turn.id
      ? {
          ...candidate,
          content: turn.review.text,
          development: turn.review.developmentDraft ?? undefined,
        }
      : candidate,
  );
  if (project.blueprintCandidates.some((c) => c.turnId === turn.id))
    repo.updateProject(turn.projectId, { blueprintCandidates: candidates });
}
export function saveTurnReview(
  repo: StoryRepository,
  projectId: string,
  id: string,
  value: TurnReview,
) {
  const turn = getTurn(repo, projectId, id);
  if (turn.status === "generating") throw new Error("生成期间不能修改版本。");
  const review = turnReviewSchema.parse(value);
  if (
    (review.planningDraft && review.planningDraft.projectId !== projectId) ||
    (review.developmentDraft && review.developmentDraft.projectId !== projectId)
  )
    throw new Error("审核稿不属于当前故事。");
  // Generation provenance belongs to the version, never to the editable draft.
  if (
    review.resultType !== turn.review.resultType ||
    review.memoryRevisionId !== turn.review.memoryRevisionId
  )
    throw new Error("不能修改版本的结果类型或来源。");
  if (
    review.planningDraft &&
    (!turn.review.planningDraft ||
      review.planningDraft.base !== turn.review.planningDraft.base ||
      JSON.stringify(review.planningDraft.target) !==
        JSON.stringify(turn.review.planningDraft.target))
  )
    throw new Error("不能修改规划版本的来源指纹或目标。");
  if (
    review.planningDraft &&
    JSON.stringify(review.planningDraft.appliedIds ?? []) !==
      JSON.stringify(turn.review.planningDraft?.appliedIds ?? [])
  )
    throw new Error("不能修改规划版本的采用进度。");
  if (
    review.developmentDraft &&
    (!turn.review.developmentDraft ||
      review.developmentDraft.id !== turn.review.developmentDraft.id)
  )
    throw new Error("不能替换版本的设定提案。");
  if (review.developmentDraft) {
    for (const change of review.developmentDraft.changes) {
      const original = turn.review.developmentDraft!.changes.find(
        (c) => c.id === change.id,
      );
      if (
        !original ||
        original.base !== change.base ||
        JSON.stringify(original.sources) !== JSON.stringify(change.sources)
      )
        throw new Error("不能修改设定建议的来源与指纹。");
    }
  }
  turn.review = copy(review);
  repo.db.transaction(() => {
    writeTurn(repo, turn);
    syncCandidate(repo, turn);
  })();
  return turn;
}
export function synchronizeCandidateEdits(
  repo: StoryRepository,
  projectId: string,
  candidates: BlueprintCandidate[],
) {
  return repo.db.transaction(() =>
    candidates.map((candidate) => {
      if (!candidate.turnId || !candidate.conversationId) return candidate;
      const turn = getTurn(repo, projectId, candidate.turnId);
      if (turn.conversationId !== candidate.conversationId)
        throw new Error("候选版本不属于指定对话。");
      const review = { ...turn.review, text: candidate.content };
      if (candidate.development && turn.review.developmentDraft)
        review.developmentDraft = {
          ...candidate.development,
          appliedIds: turn.review.developmentDraft.appliedIds,
        };
      saveTurnReview(repo, projectId, turn.id, review);
      return {
        ...candidate,
        development: review.developmentDraft ?? undefined,
      };
    }),
  )();
}
export function recordTurnApplication(
  repo: StoryRepository,
  projectId: string,
  id: string,
  label: string,
  review?: TurnReview,
) {
  const turn = applicationTurn(repo, projectId, id);
  if (review) turn.review = copy(review);
  turn.applied = [...new Set([...turn.applied, label])];
  writeTurn(repo, turn);
  syncCandidate(repo, turn);
  return turn;
}
export function applicationTurn(
  repo: StoryRepository,
  projectId: string,
  id: string,
) {
  const turn = getTurn(repo, projectId, id);
  if (turn.status !== "complete") throw new Error("未完成的版本不能直接采用。");
  if (turn.review.resultType === "analysis")
    throw new Error("分析结果仅供查看、复制或继续迭代，不能直接写入。");
  const c = getConversation(repo, projectId, turn.conversationId);
  validateTarget(repo, projectId, c.target);
  const invalid = conversationDetail(repo, projectId, c.id).turns.find(
    (t) => t.id === id,
  )?.invalidReason;
  if (invalid) throw new Error(invalid);
  return turn;
}
export function applyConversationPlanning(
  repo: StoryRepository,
  projectId: string,
  id: string,
  selectedIds: string[],
) {
  return repo.db.transaction(() => {
    const turn = applicationTurn(repo, projectId, id);
    if (!turn.review.planningDraft) throw new Error("此版本没有待采用规划。");
    if (
      selectedIds.some((id) =>
        turn.review.planningDraft!.appliedIds?.includes(id),
      )
    )
      throw new Error("所选规划已采用，请勿重复写入。");
    const detail = applyPlanning(repo, turn.review.planningDraft, selectedIds);
    const base = planningBase(repo, projectId);
    turn.review.planningDraft = {
      ...turn.review.planningDraft,
      base,
      appliedIds: [
        ...(turn.review.planningDraft.appliedIds ?? []),
        ...selectedIds,
      ],
    };
    turn.review.text = reviewText(turn.review);
    recordTurnApplication(repo, projectId, id, "已采用所选规划", turn.review);
    return { detail, base };
  })();
}
export function applyConversationDevelopment(
  repo: StoryRepository,
  projectId: string,
  id: string,
  selectedIds: string[],
) {
  return repo.db.transaction(() => {
    const turn = applicationTurn(repo, projectId, id);
    if (!turn.review.developmentDraft) throw new Error("此版本没有设定提案。");
    const result = applyDevelopment(
      repo,
      projectId,
      turn.review.developmentDraft,
      selectedIds,
    );
    turn.review.developmentDraft = result.draft;
    turn.review.text = developmentText(result.draft);
    turn.undoId = result.undoId;
    writeTurn(repo, turn);
    recordTurnApplication(repo, projectId, id, "已更新设定与蓝图", turn.review);
    return result;
  })();
}
export function undoConversationDevelopment(
  repo: StoryRepository,
  projectId: string,
  undoId: string,
) {
  return repo.db.transaction(() => {
    const result = undoDevelopment(repo, projectId, undoId);
    for (const row of repo.db
      .prepare("SELECT payload FROM creation_turns WHERE project_id = ?")
      .all(projectId) as { payload: string }[]) {
      const turn = JSON.parse(row.payload) as CreationTurn;
      if (turn.review.developmentDraft?.id !== result.draft.id) continue;
      turn.review.developmentDraft = result.draft;
      turn.review.text = developmentText(result.draft);
      turn.applied = turn.applied.filter(
        (label) => label !== "已更新设定与蓝图",
      );
      if (result.draft.appliedIds.length) turn.applied.push("已更新设定与蓝图");
      delete turn.undoId;
      writeTurn(repo, turn);
      syncCandidate(repo, turn);
    }
    return { ...result, detail: repo.getDetail(projectId) };
  })();
}
export function applyConversationMemory(
  repo: StoryRepository,
  projectId: string,
  id: string,
) {
  return repo.db.transaction(() => {
    const turn = applicationTurn(repo, projectId, id);
    const c = getConversation(repo, projectId, turn.conversationId);
    if (turn.applied.includes("已写入故事记忆"))
      throw new Error("此版本的记忆已经写入，请勿重复采用。");
    if (
      !c.target.chapterId ||
      !turn.review.memoryRecords?.length ||
      !turn.review.memoryRevisionId
    )
      throw new Error("此版本没有待审核记忆。");
    const count = repo.saveGeneratedMemories(
      c.target.chapterId,
      turn.review.memoryRevisionId,
      turn.review.memoryRecords,
    );
    recordTurnApplication(repo, projectId, id, "已写入故事记忆", turn.review);
    return count;
  })();
}
export function conversationHandlers(
  repo: StoryRepository,
): Record<string, (p: unknown) => unknown> {
  return {
    "conversation:list": (p) =>
      listConversations(repo, z.string().uuid().parse(p)),
    "conversation:get": (p) => {
      const v = identity.parse(p);
      return conversationDetail(repo, v.projectId, v.id);
    },
    "conversation:create": (p) => {
      const v = z
        .object({
          projectId: z.string().uuid(),
          target: conversationTargetSchema,
          title: z.string().trim().min(1).max(200).optional(),
        })
        .parse(p);
      return createConversation(repo, v.projectId, v.target, v.title);
    },
    "conversation:update": (p) => {
      const v = identity
        .extend({
          title: z.string().trim().min(1).max(200).optional(),
          selectedTurnId: z.string().uuid().nullable().optional(),
          draftInstruction: z.string().max(200_000).optional(),
        })
        .parse(p);
      const c = getConversation(repo, v.projectId, v.id);
      if (
        v.selectedTurnId &&
        getTurn(repo, v.projectId, v.selectedTurnId).conversationId !== c.id
      )
        throw new Error("版本不属于此对话。");
      if (v.title !== undefined) {
        c.title = v.title;
        c.autoTitle = false;
      }
      if (v.selectedTurnId !== undefined) c.selectedTurnId = v.selectedTurnId;
      if (v.draftInstruction !== undefined)
        c.draftInstruction = v.draftInstruction;
      c.updatedAt = now();
      writeConversation(repo, c);
      return c;
    },
    "conversation:delete": (p) => {
      const v = identity.parse(p);
      const c = getConversation(repo, v.projectId, v.id);
      if (
        conversationDetail(repo, v.projectId, v.id).turns.some(
          (t) => t.status === "generating",
        )
      )
        throw new Error("请先停止当前对话的生成。");
      repo.db.transaction(() => {
        const project = repo.getProject(v.projectId);
        repo.updateProject(v.projectId, {
          blueprintCandidates: project.blueprintCandidates.map((candidate) =>
            candidate.conversationId === c.id
              ? { ...candidate, conversationId: undefined, turnId: undefined }
              : candidate,
          ),
        });
        repo.db
          .prepare("DELETE FROM creation_turns WHERE conversation_id = ?")
          .run(c.id);
        repo.db
          .prepare("DELETE FROM creation_conversations WHERE id = ?")
          .run(c.id);
      })();
      return true;
    },
    "conversation:save-turn": (p) => {
      const v = identity.extend({ review: turnReviewSchema }).parse(p);
      return saveTurnReview(repo, v.projectId, v.id, v.review);
    },
    "conversation:applied": (p) => {
      const v = identity.extend({ label: z.string().max(200) }).parse(p);
      return recordTurnApplication(repo, v.projectId, v.id, v.label);
    },
    "conversation:check-application": (p) => {
      const v = identity.parse(p);
      applicationTurn(repo, v.projectId, v.id);
      return true;
    },
  };
}

export function prepareConversationTask(
  repo: StoryRepository,
  input: TaskRequest,
) {
  const request = copy(input);
  let conversation: CreationConversation | undefined;
  let parent: CreationTurn | undefined;
  if (request.conversationId) {
    conversation = getConversation(
      repo,
      request.projectId,
      request.conversationId,
    );
    if (
      targetKey(conversation.target) !== targetKey(conversationTarget(request))
    )
      throw new Error("工具或目标已变化，请切换到对应对话。");
    validateTarget(repo, request.projectId, conversation.target);
    if (!conversation.workflowContext && request.workflowContext)
      conversation.workflowContext = request.workflowContext;
    request.workflowContext = conversation.workflowContext;
    if (request.parentTurnId) {
      parent = getTurn(repo, request.projectId, request.parentTurnId);
      if (parent.conversationId !== conversation.id)
        throw new Error("父版本不属于当前对话。");
      if (parent.status === "generating")
        throw new Error("请等待父版本生成结束。");
    }
    if (!conversation.source) {
      const chapter = request.chapterId
        ? repo.getChapter(request.chapterId)
        : undefined;
      conversation.source = {
        content: chapter?.content ?? "",
        selection: request.selectionRange,
        memoryRevisionId:
          request.kind === "notes"
            ? (chapter?.acceptedRevisionId ?? undefined)
            : undefined,
      };
    }
    if (conversation.source.selection)
      request.selection = conversation.source.selection.text;
  } else if (request.parentTurnId) throw new Error("继续生成需要指定对话。");
  const polish = ["revise", "scene", "dialogue"].includes(request.kind);
  const built = buildTask(
    repo,
    request,
    conversation
      ? {
          content: polish ? conversation.source!.content : undefined,
          memoryRevisionId:
            request.kind === "notes"
              ? conversation.source!.memoryRevisionId
              : undefined,
        }
      : undefined,
  );
  let history: { role: "user" | "assistant"; content: string }[] = [];
  let omittedTurns = 0;
  if (parent) {
    // The parent stores the exact branch context used for its own generation.
    // Reuse those messages as immutable snapshots, then use the parent's
    // current editable review as the selected complete version.
    const full = [
      ...copy(parent.history),
      {
        role: "user" as const,
        content: parent.instruction || "请按当前资料完成任务。",
      },
      { role: "assistant" as const, content: reviewText(parent.review) },
    ];
    const root = full[0];
    const lastPair = full.slice(-2);
    let size =
      (root === lastPair[0] ? 0 : root.content.length) +
      lastPair.reduce((n, m) => n + m.content.length, 0) +
      request.instruction.length;
    if (size > 60_000)
      throw new Error(
        "所选完整稿与必需要求超过 60,000 字符，请精简版本或要求后继续。",
      );
    const previous: typeof full = [];
    for (let i = full.length - 3; i >= 1;) {
      const start =
        full[i].role === "assistant" && i > 1 && full[i - 1].role === "user"
          ? i - 1
          : i;
      const group = full.slice(start, i + 1);
      const length = group.reduce((n, m) => n + m.content.length, 0);
      i = start - 1;
      if (size + length > 60_000) {
        omittedTurns++;
        continue;
      }
      previous.unshift(...group);
      size += length;
    }
    // Keep the first requirement even when old answer pairs no longer fit.
    history = full.length === 2 ? full : [root, ...previous, ...lastPair];
    const marker = "【本次作者要求】";
    const context = built.messages[1].content;
    built.messages = [
      built.messages[0],
      {
        role: "user",
        content:
          context.slice(0, context.lastIndexOf(marker)).trim() +
          "\n\n【以下对话均为待审核候选，不能视为正式设定、规划或已发生事实】",
      },
      ...history,
      {
        role: "user",
        content: `【本轮修改要求】\n${request.instruction.trim() || "请完善所选版本。"}\n基于所选版本输出一份完整新版，保留仍适用的内容；不输出差异补丁。`,
      },
    ];
  }
  return { request, conversation, parent, built, history, omittedTurns };
}

export function parseTaskResult(
  repo: StoryRepository,
  request: TaskRequest,
  built: ReturnType<typeof buildTask>,
  text: string,
  base: string,
): TaskResult {
  if (request.planningTarget)
    return {
      text,
      planningDraft: parsePlanning(
        repo,
        request.projectId,
        request.planningTarget,
        base,
        text,
      ),
      resultType: "planning",
    };
  if (request.kind === "notes") {
    const records = parseMemories(text);
    return {
      text: records.map((r) => `- [${r.kind}] ${r.content}`).join("\n\n"),
      memoryRecords: records,
      memoryRevisionId: built.revisionId,
    };
  }
  if (request.kind === "develop") {
    const draft = parseDevelopment(text, built.developmentSnapshot!);
    return { text: developmentText(draft), developmentDraft: draft };
  }
  return {
    text,
    resultType:
      request.outputMode === "analysis" ||
      ["check", "pacing", "arc"].includes(request.kind)
        ? "analysis"
        : ["revise", "scene", "dialogue"].includes(request.kind) &&
            request.outputMode === "rewrite"
          ? "rewrite"
          : toolInfo[request.kind].output === "prose"
            ? "prose"
            : undefined,
  };
}

export async function runCreationTask(
  repo: StoryRepository,
  request: TaskRequest,
  options: {
    model: string;
    signal: AbortSignal;
    generate: (
      messages: ChatMessage[],
      delta: (text: string) => void,
    ) => Promise<string>;
    progress: (event: ProgressEvent) => void;
  },
): Promise<TaskResult> {
  const prepared = prepareConversationTask(repo, request);
  const { conversation, built } = prepared;
  const base = request.planningTarget
    ? planningBase(repo, request.projectId)
    : "";
  let turn: CreationTurn | undefined;
  if (conversation) {
    if (
      conversationDetail(repo, request.projectId, conversation.id).turns.some(
        (t) => t.status === "generating",
      )
    )
      throw new Error("此对话已有正在生成的版本。");
    const number =
      conversationDetail(repo, request.projectId, conversation.id).turns
        .length + 1;
    turn = {
      id: randomUUID(),
      conversationId: conversation.id,
      projectId: request.projectId,
      number,
      parentTurnId: prepared.parent?.id ?? null,
      instruction: request.instruction,
      status: "generating",
      rawResponse: "",
      result: { text: "" },
      review: { text: "" },
      sourceContent: ["revise", "scene", "dialogue"].includes(request.kind)
        ? conversation.source!.content
        : request.kind === "notes"
          ? conversation.source!.content
          : prepared.parent
            ? reviewText(prepared.parent.review)
            : request.chapterId
              ? repo.getChapter(request.chapterId).content
              : "",
      selection: conversation.source!.selection,
      history: prepared.history,
      applied: [],
      error: "",
      model: options.model,
      createdAt: now(),
      updatedAt: now(),
    };
    repo.db.transaction(() => {
      repo.db
        .prepare("INSERT INTO creation_turns VALUES (?, ?, ?, ?)")
        .run(
          turn!.id,
          conversation.id,
          request.projectId,
          JSON.stringify(turn),
        );
      conversation.selectedTurnId = turn!.id;
      conversation.draftInstruction = "";
      conversation.updatedAt = now();
      if (number === 1 && conversation.autoTitle && request.instruction.trim())
        conversation.title = request.instruction.trim().slice(0, 40);
      conversation.autoTitle = false;
      writeConversation(repo, conversation);
    })();
  }
  let received = "",
    lastSaved = Date.now(),
    timer: ReturnType<typeof setTimeout> | undefined,
    persistenceError: unknown;
  const savePartial = () => {
    if (turn) {
      turn.rawResponse = received;
      turn.review.text = received;
      writeTurn(repo, turn);
      lastSaved = Date.now();
    }
  };
  try {
    const text = await options.generate(built.messages, (delta) => {
      received += delta;
      if (turn) {
        if (persistenceError) throw persistenceError;
        if (Date.now() - lastSaved >= 650) {
          clearTimeout(timer);
          timer = undefined;
          savePartial();
        } else if (!timer)
          timer = setTimeout(() => {
            timer = undefined;
            try {
              savePartial();
            } catch (error) {
              persistenceError = error;
            }
          }, 650);
      }
      options.progress({
        requestId: request.requestId,
        delta,
        ...(turn
          ? { conversationId: turn.conversationId, turnId: turn.id }
          : {}),
      });
    });
    received = text;
    if (persistenceError) throw persistenceError;
    if (options.signal.aborted)
      throw new Error("生成已停止，收到的内容已保留。");
    const result = parseTaskResult(repo, prepared.request, built, text, base);
    if (turn) {
      clearTimeout(timer);
      turn.status = "complete";
      turn.rawResponse = text;
      turn.result = resultReview(result);
      turn.review = copy(turn.result);
      repo.db.transaction(() => {
        writeTurn(repo, turn!);
        if (toolInfo[request.kind].candidate && !result.planningDraft) {
          const project = repo.getProject(request.projectId);
          repo.updateProject(request.projectId, {
            blueprintCandidates: [
              {
                id: randomUUID(),
                title: `版本 ${turn!.number} · ${conversation!.title}`,
                content: result.text,
                source: request.kind,
                createdAt: now(),
                development: result.developmentDraft,
                conversationId: turn!.conversationId,
                turnId: turn!.id,
              },
              ...project.blueprintCandidates,
            ].slice(0, 100),
          });
        }
      })();
      return {
        ...result,
        conversationId: turn.conversationId,
        turnId: turn.id,
      };
    }
    return result;
  } catch (error) {
    clearTimeout(timer);
    if (turn) {
      turn.status = options.signal.aborted ? "stopped" : "error";
      turn.error = error instanceof Error ? error.message : String(error);
      turn.rawResponse = received;
      turn.review.text = received;
      turn.result = copy(turn.review);
      try {
        writeTurn(repo, turn);
      } catch {
        /* Keep prior committed versions and propagate the save failure. */
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
