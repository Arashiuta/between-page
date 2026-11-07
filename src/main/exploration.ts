import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  CreationTurn,
  DirectionOption,
  DirectionState,
  DirectionView,
  TaskRequest,
  TaskPreview,
} from "../shared/types";
import { explorationBasis, fingerprint } from "./context";

const id = z.string().uuid();
const sourceSchema = z.object({ projectId: id, chapterId: id }).strict();
const key = (pid: string, cid: string) => `exploration.${pid}.${cid}`;
export const automaticDirectionKey = (
  r: Extract<TaskRequest, { kind: "directions" }>,
) =>
  r.triggerChangeSetId
    ? `exploration.auto.${r.projectId}.${r.triggerChangeSetId}.${r.chapterId}`
    : null;

export function directionView(
  repo: StoryRepository,
  pid: string,
  cid: string,
): DirectionView {
  const p = repo.getProject(pid),
    c = repo.getChapter(cid);
  if (c.projectId !== p.id) throw new Error("章节不属于当前故事。");
  const state = repo.getSetting<DirectionState | null>(key(pid, cid), null);
  const sourceFingerprint = fingerprint(c.document),
    currentBasis = explorationBasis(repo, pid, cid);
  return {
    state,
    sourceFingerprint,
    basis: currentBasis,
    stale:
      !!state &&
      (state.sourceFingerprint !== sourceFingerprint ||
        state.basis !== currentBasis),
  };
}

export function saveDirections(
  repo: StoryRepository,
  r: Extract<TaskRequest, { kind: "directions" }>,
  options: DirectionOption[],
  info: {
    sourceFingerprint: string;
    basis: string;
    model: string;
    turnId: string;
    preview: TaskPreview;
  },
) {
  const current = directionView(repo, r.projectId, r.chapterId);
  if (
    repo.getProject(r.projectId).mode !== "explore" ||
    current.basis !== info.basis ||
    current.sourceFingerprint !== info.sourceFingerprint
  )
    throw new Error("生成走向期间正文或故事依据已变化，请重新生成。");
  const state: DirectionState = {
    projectId: r.projectId,
    chapterId: r.chapterId,
    sourceFingerprint: info.sourceFingerprint,
    basis: info.basis,
    options,
    selectedId: null,
    instruction: "",
    model: info.model,
    turnId: info.turnId,
    createdAt: new Date().toISOString(),
  };
  repo.setSetting(key(r.projectId, r.chapterId), state);
  repo.setSetting(key(r.projectId, r.chapterId) + ".source", info.preview);
  return state;
}

export function explorationHandlers(
  repo: StoryRepository,
): Record<string, (p: any) => unknown> {
  const writable = (pid: string) => {
    if (repo.getProject(pid).mode !== "explore")
      throw new Error("请切换到自由探索模式。");
  };
  return {
    "directions:get": (input) => {
      const v = sourceSchema.parse(input);
      return directionView(repo, v.projectId, v.chapterId);
    },
    "directions:choose": (input) =>
      repo.db.transaction(() => {
        const v = sourceSchema
          .extend({
            sourceFingerprint: z.string(),
            basis: z.string(),
            selectedId: id.nullable(),
            instruction: z.string().trim().max(200000),
          })
          .strict()
          .parse(input);
        writable(v.projectId);
        const view = directionView(repo, v.projectId, v.chapterId);
        if (
          view.sourceFingerprint !== v.sourceFingerprint ||
          view.basis !== v.basis
        )
          throw new Error("正文或故事依据已变化，请刷新后再选择走向。");
        if (
          v.selectedId &&
          (view.stale ||
            !view.state?.options.some((o) => o.id === v.selectedId))
        )
          throw new Error("候选走向已过时或不存在，请重新生成。");
        const state: DirectionState = {
          projectId: v.projectId,
          chapterId: v.chapterId,
          sourceFingerprint: view.sourceFingerprint,
          basis: view.basis,
          options: view.stale ? [] : (view.state?.options ?? []),
          selectedId: v.selectedId,
          instruction: v.instruction,
          model: view.state?.model ?? "",
          turnId: view.state?.turnId ?? "",
          createdAt: view.state?.createdAt ?? new Date().toISOString(),
        };
        repo.setSetting(key(v.projectId, v.chapterId), state);
        return directionView(repo, v.projectId, v.chapterId);
      })(),
    "directions:preview": (input) => {
      const v = sourceSchema.parse(input),
        view = directionView(repo, v.projectId, v.chapterId);
      if (!view.state?.turnId) return null;
      const saved = repo.getSetting<TaskPreview | null>(
        key(v.projectId, v.chapterId) + ".source",
        null,
      );
      if (saved) return saved;
      const row = repo.db
        .prepare(
          "SELECT payload FROM creation_turns WHERE id = ? AND project_id = ?",
        )
        .get(view.state.turnId, v.projectId) as { payload: string } | undefined;
      return row
        ? ((JSON.parse(row.payload) as CreationTurn).sourceSnapshot[0] ?? null)
        : null;
    },
    "exploration:create-next": (input) =>
      repo.db.transaction(() => {
        const v = sourceSchema
          .extend({ sourceFingerprint: z.string(), basis: z.string() })
          .strict()
          .parse(input);
        writable(v.projectId);
        const view = directionView(repo, v.projectId, v.chapterId),
          state = view.state;
        if (!state?.instruction.trim())
          throw new Error("请选择或填写下一章走向。");
        if (
          view.stale ||
          view.sourceFingerprint !== v.sourceFingerprint ||
          view.basis !== v.basis
        )
          throw new Error("走向已过时，请根据当前故事更新走向。");
        const d = repo.getDetail(v.projectId),
          source = d.chapters.find((c) => c.id === v.chapterId)!;
        if (!source.content.trim())
          throw new Error("先完成当前章正文，再生成下一章。");
        const existing = d.chapters.find(
          (c) => c.explorationSource?.chapterId === source.id,
        );
        const last = d.chapters.at(-1);
        if (
          existing &&
          (existing.content.trim() ||
            existing.id !== last?.id ||
            existing.position !== source.position + 1)
        )
          throw new Error("下一章已存在，请进入已有章节继续写作。");
        if (!existing && last?.id !== source.id)
          throw new Error("请在作品最后一章生成下一章，避免覆盖已有后续剧情。");
        const chapter = existing ?? repo.createChapter(v.projectId);
        return repo.updateChapter(chapter.id, {
          explorationSource: {
            chapterId: source.id,
            sourceFingerprint: view.sourceFingerprint,
            basis: view.basis,
            instruction: state.instruction,
          },
        });
      })(),
  };
}
