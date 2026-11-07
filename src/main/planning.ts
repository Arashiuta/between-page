import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  Chapter,
  NovelPlan,
  PlanBlock,
  PlanningDraft,
  PlanningTarget,
  PlanningVersion,
  PlanningMove,
  ProjectDetail,
} from "../shared/types";
import {
  planningChapterOrder,
  proposePlanningMove,
} from "../shared/planning-tree";
import { reorderChapters } from "./writing";
import {
  chapterPlan,
  emptyNovelPlan,
  planText,
  planningHints,
  planningLabels,
  planningTargetSchema,
  planningDraftSchema,
  planningItemSchema as itemSchema,
} from "../shared/planning";
export { planningTargetSchema, planningDraftSchema } from "../shared/planning";
const treeNodeSchema = z.object({
  level: z.enum(["synopsis", "unassigned", "volume", "chapter", "scene"]),
  id: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
});
export const planningMoveSchema = z.object({
  projectId: z.string().uuid(),
  source: treeNodeSchema,
  target: treeNodeSchema,
  placement: z.enum(["before", "inside", "after"]),
});
const writeChapter = (repo: StoryRepository, chapter: Chapter) =>
  repo.db
    .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
    .run(JSON.stringify(chapter), chapter.id);
function state(repo: StoryRepository, projectId: string) {
  const detail = repo.getDetail(projectId);
  return {
    novelPlan: detail.project.novelPlan ?? emptyNovelPlan(),
    chapters: detail.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      plan: c.plan,
      planMeta: c.planMeta,
      volumeId: c.volumeId,
      scenes: c.scenes,
    })),
  };
}
export function planningBase(repo: StoryRepository, projectId: string) {
  return createHash("sha256")
    .update(JSON.stringify(state(repo, projectId)))
    .digest("hex");
}
export function planningHistory(
  repo: StoryRepository,
  projectId: string,
): PlanningVersion[] {
  repo.getProject(projectId);
  return repo.getSetting(`planning.history.${projectId}`, []);
}
export function snapshotPlanning(
  repo: StoryRepository,
  projectId: string,
  label: string,
) {
  const version: PlanningVersion = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    ...state(repo, projectId),
    chapterOrder: repo.getDetail(projectId).chapters.map((c) => c.id),
  };
  repo.setSetting(`planning.history.${projectId}`, [
    version,
    ...planningHistory(repo, projectId),
  ]);
  return version;
}
export function getPlanningBlock(
  repo: StoryRepository,
  projectId: string,
  target: PlanningTarget,
): PlanBlock {
  const detail = repo.getDetail(projectId),
    plan = detail.project.novelPlan ?? emptyNovelPlan();
  if (target.level === "synopsis") return plan.synopsis;
  if (target.level === "volume") {
    const volume = plan.volumes.find((v) => v.id === target.id);
    if (target.id && !volume) throw new Error("分卷不存在或不属于当前故事。");
    return volume?.plan ?? { content: "" };
  }
  const chapter = detail.chapters.find(
    (c) => c.id === (target.level === "chapter" ? target.id : target.parentId),
  );
  if ((target.id || target.level === "scene") && !chapter)
    throw new Error("规划章节不存在或不属于当前故事。");
  if (target.level === "chapter") {
    if (target.parentId && !plan.volumes.some((v) => v.id === target.parentId))
      throw new Error("分卷不存在。");
    return chapter ? chapterPlan(chapter) : { content: "" };
  }
  const scene = chapter?.scenes?.find((s) => s.id === target.id);
  if (target.id && !scene) throw new Error("场景不存在。");
  return scene?.plan ?? { content: "" };
}
function markImpact(
  repo: StoryRepository,
  projectId: string,
  target: PlanningTarget,
  plan: NovelPlan,
) {
  const reason = `${planningLabels[target.level]}已调整，请核对是否仍然适用。`;
  if (target.level === "synopsis")
    for (const volume of plan.volumes)
      if (volume.plan.content.trim() || volume.plan.confirmed?.trim())
        volume.plan.reviewReason = reason;
  for (const chapter of repo.getDetail(projectId).chapters) {
    const affected =
      target.level === "synopsis" ||
      (target.level === "volume" && chapter.volumeId === target.id) ||
      ((target.level === "chapter" || target.level === "scene") &&
        chapter.id ===
          (target.level === "chapter" ? target.id : target.parentId));
    if (!affected) continue;
    if (
      (target.level === "synopsis" || target.level === "volume") &&
      (chapter.plan.trim() || chapter.planMeta?.confirmed?.trim())
    )
      chapter.planMeta = {
        confirmed: chapterPlan(chapter).confirmed,
        ...chapter.planMeta,
        reviewReason: reason,
      };
    if (target.level !== "scene")
      for (const scene of chapter.scenes ?? [])
        if (scene.plan.content.trim() || scene.plan.confirmed?.trim())
          scene.plan.reviewReason = reason;
    if (chapter.content.trim()) chapter.planningReview = reason;
    writeChapter(repo, chapter);
  }
}
export function savePlanning(
  repo: StoryRepository,
  projectId: string,
  target: PlanningTarget,
  value: { content: string; title?: string; confirm?: boolean },
  keepSnapshot = true,
) {
  return repo.db.transaction(() => {
    const before = getPlanningBlock(repo, projectId, target);
    if (value.confirm && !value.content.trim())
      throw new Error("请先填写规划内容。");
    if (value.confirm && keepSnapshot)
      snapshotPlanning(repo, projectId, "确认规划前");
    const block: PlanBlock = {
      ...before,
      content: value.content,
      ...(value.confirm
        ? { confirmed: value.content, reviewReason: undefined }
        : {}),
    };
    const plan = repo.getProject(projectId).novelPlan ?? emptyNovelPlan();
    let resolved = { ...target };
    if (target.level === "synopsis") plan.synopsis = block;
    else if (target.level === "volume") {
      const volume = plan.volumes.find((v) => v.id === target.id);
      if (volume) {
        volume.plan = block;
        if (value.title) volume.title = value.title;
      } else {
        resolved.id = randomUUID();
        plan.volumes.push({
          id: resolved.id,
          title: value.title || `第${plan.volumes.length + 1}卷`,
          plan: block,
        });
      }
    } else if (target.level === "chapter") {
      const chapter = target.id
        ? repo.getChapter(target.id)
        : repo.createChapter(projectId);
      resolved.id = chapter.id;
      chapter.plan = value.content;
      chapter.planMeta = {
        confirmed: block.confirmed,
        reviewReason: block.reviewReason,
      };
      if (!target.id)
        chapter.volumeId = target.parentId ?? chapter.volumeId ?? null;
      if (value.title && chapter.title !== value.title)
        Object.assign(
          chapter,
          repo.updateChapter(chapter.id, { title: value.title }),
        );
      if (!target.id && target.parentId) chapter.volumeId = target.parentId;
      chapter.plan = value.content;
      chapter.planMeta = {
        confirmed: block.confirmed,
        reviewReason: block.reviewReason,
      };
      writeChapter(repo, chapter);
    } else {
      const chapter = repo.getChapter(target.parentId!);
      chapter.scenes ??= [];
      const scene = chapter.scenes.find((s) => s.id === target.id);
      if (scene) {
        scene.plan = block;
        if (value.title) scene.title = value.title;
      } else {
        resolved.id = randomUUID();
        chapter.scenes.push({
          id: resolved.id,
          title: value.title || `场景 ${chapter.scenes.length + 1}`,
          plan: block,
        });
      }
      writeChapter(repo, chapter);
    }
    if (value.confirm && before.confirmed !== value.content)
      markImpact(repo, projectId, resolved, plan);
    repo.updateProject(projectId, { novelPlan: plan });
    return { detail: repo.getDetail(projectId), target: resolved };
  })();
}
export function removePlanning(
  repo: StoryRepository,
  projectId: string,
  target: PlanningTarget,
) {
  return repo.db.transaction(() => {
    if (target.level !== "synopsis" && !target.id)
      throw new Error("请选择要清空或删除的规划。");
    const before = getPlanningBlock(repo, projectId, target);
    snapshotPlanning(repo, projectId, "清空或删除规划前");
    const plan = repo.getProject(projectId).novelPlan ?? emptyNovelPlan();
    if (planText(before).trim()) markImpact(repo, projectId, target, plan);
    if (target.level === "synopsis") plan.synopsis = { content: "" };
    else if (target.level === "volume") {
      plan.volumes = plan.volumes.filter((v) => v.id !== target.id);
      for (const c of repo.getDetail(projectId).chapters) {
        if (c.volumeId === target.id) {
          c.volumeId = null;
          writeChapter(repo, c);
        }
      }
    } else {
      const c = repo.getChapter(
        target.level === "chapter" ? target.id! : target.parentId!,
      );
      if (target.level === "chapter") {
        c.plan = "";
        c.planMeta = {};
      } else c.scenes = (c.scenes ?? []).filter((s) => s.id !== target.id);
      writeChapter(repo, c);
    }
    repo.updateProject(projectId, { novelPlan: plan });
    return repo.getDetail(projectId);
  })();
}

export function managePlanningVersion(
  repo: StoryRepository,
  projectId: string,
  versionId: string,
  label?: string,
) {
  return repo.db.transaction(() => {
    const versions = planningHistory(repo, projectId);
    if (!versions.some((v) => v.id === versionId))
      throw new Error("规划版本不存在或不属于当前故事。");
    if (label !== undefined && (!label.trim() || label.length > 500))
      throw new Error("版本标签需为 1—500 字。");
    const next =
      label === undefined
        ? versions.filter((v) => v.id !== versionId)
        : versions.map((v) =>
            v.id === versionId ? { ...v, label: label.trim() } : v,
          );
    repo.setSetting(`planning.history.${projectId}`, next);
    return next;
  })();
}

export function planningInstructions(target: PlanningTarget) {
  return `【分层规划任务】仅处理${planningLabels[target.level]}，${planningHints[target.level]} 生成 ${target.id || target.level === "synopsis" ? 1 : (target.count ?? 1)} 项，保留作者已确认内容。只输出 JSON：{"items":[{"title":"名称","content":"完整规划内容"}]}。结果都是未来计划，不是已发生事实。不要同时生成其他层级或正文。`;
}
export function parsePlanning(
  repo: StoryRepository,
  projectId: string,
  target: PlanningTarget,
  base: string,
  text: string,
): PlanningDraft {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = z
    .object({
      items: z
        .array(itemSchema.omit({ id: true }))
        .min(1)
        .max(
          target.id || target.level === "synopsis" ? 1 : (target.count ?? 1),
        ),
    })
    .parse(JSON.parse(clean));
  getPlanningBlock(repo, projectId, target);
  return {
    projectId,
    target,
    base,
    items: parsed.items.map((item) => ({ ...item, id: randomUUID() })),
  };
}
export function applyPlanning(
  repo: StoryRepository,
  draft: PlanningDraft,
  selectedIds: string[],
) {
  return repo.db.transaction(() => {
    if (planningBase(repo, draft.projectId) !== draft.base)
      throw new Error("规划已变化，请重新生成建议，避免覆盖后来的编辑。");
    const selected = draft.items.filter((i) => selectedIds.includes(i.id));
    if (!selected.length || selected.length !== new Set(selectedIds).size)
      throw new Error("请选择有效的规划建议。");
    snapshotPlanning(repo, draft.projectId, "采用 AI 规划前");
    for (const item of selected)
      savePlanning(
        repo,
        draft.projectId,
        draft.target,
        { title: item.title, content: item.content, confirm: true },
        false,
      );
    return repo.getDetail(draft.projectId);
  })();
}
export function restorePlanning(
  repo: StoryRepository,
  projectId: string,
  versionId: string,
) {
  return repo.db.transaction(() => {
    const version = planningHistory(repo, projectId).find(
      (v) => v.id === versionId,
    );
    if (!version) throw new Error("规划版本不存在。");
    snapshotPlanning(repo, projectId, "恢复规划前");
    const previous = repo.getDetail(projectId);
    const plan: NovelPlan = JSON.parse(JSON.stringify(version.novelPlan));
    const changes: PlanningTarget[] = [];
    if (
      planText(previous.project.novelPlan!.synopsis) !== planText(plan.synopsis)
    )
      changes.push({ level: "synopsis" });
    for (const volume of previous.project.novelPlan!.volumes) {
      const saved = plan.volumes.find((v) => v.id === volume.id);
      if (
        !saved ||
        planText(volume.plan) !== planText(saved.plan) ||
        volume.title !== saved.title
      )
        changes.push({ level: "volume", id: volume.id });
    }
    for (const volume of plan.volumes)
      if (!previous.project.novelPlan!.volumes.some((v) => v.id === volume.id))
        changes.push({ level: "volume", id: volume.id });
    for (const chapter of previous.chapters) {
      const before = JSON.parse(JSON.stringify(chapter)) as Chapter;
      const saved = version.chapters.find((c) => c.id === chapter.id);
      if (saved)
        Object.assign(chapter, {
          title: saved.title ?? chapter.title,
          plan: saved.plan,
          planMeta: saved.planMeta,
          volumeId: saved.volumeId,
          scenes: saved.scenes,
        });
      if (
        chapter.volumeId &&
        !plan.volumes.some((v) => v.id === chapter.volumeId)
      )
        chapter.volumeId = null;
      if (
        planText(chapterPlan(before)) !== planText(chapterPlan(chapter)) ||
        before.title !== chapter.title ||
        before.volumeId !== chapter.volumeId ||
        JSON.stringify(
          (before.scenes ?? []).map((s) => [s.id, planText(s.plan)]),
        ) !==
          JSON.stringify(
            (chapter.scenes ?? []).map((s) => [s.id, planText(s.plan)]),
          )
      )
        changes.push({ level: "chapter", id: chapter.id });
      if (before.title !== chapter.title) {
        const renamed = repo.updateChapter(chapter.id, {
          title: chapter.title,
        });
        chapter.dirty = renamed.dirty;
        chapter.updatedAt = renamed.updatedAt;
      }
      writeChapter(repo, chapter);
    }
    for (const target of changes) markImpact(repo, projectId, target, plan);
    repo.updateProject(projectId, { novelPlan: plan });
    if (version.chapterOrder) {
      const current = repo.getDetail(projectId).chapters.map((c) => c.id);
      const order = [
        ...new Set(version.chapterOrder.filter((id) => current.includes(id))),
      ];
      order.push(...current.filter((id) => !order.includes(id)));
      if (order.some((id, i) => id !== current[i]))
        reorderChapters(repo, projectId, order);
    }
    return repo.getDetail(projectId);
  })();
}

export function organizePlanning(
  repo: StoryRepository,
  projectId: string,
  chapterId: string,
  volumeId: string | null,
  sceneIds?: string[],
) {
  return repo.db.transaction(() => {
    const detail = repo.getDetail(projectId),
      chapter = detail.chapters.find((c) => c.id === chapterId);
    if (volumeId === null && detail.project.mode === "novel")
      volumeId = detail.project.novelPlan?.volumes[0]?.id ?? null;
    if (
      !chapter ||
      (volumeId &&
        !detail.project.novelPlan?.volumes.some((v) => v.id === volumeId))
    )
      throw new Error("规划关联不属于当前故事。");
    if (
      sceneIds &&
      (new Set(sceneIds).size !== chapter.scenes?.length ||
        sceneIds.length !== chapter.scenes?.length ||
        sceneIds.some((id) => !chapter.scenes?.some((s) => s.id === id)))
    )
      throw new Error("场景顺序无效。");
    const changedVolume = (chapter.volumeId ?? null) !== volumeId;
    const changedScenes =
      sceneIds && sceneIds.some((id, i) => chapter.scenes?.[i]?.id !== id);
    if (!changedVolume && !changedScenes) return detail;
    const next = JSON.parse(JSON.stringify(detail)) as ProjectDetail;
    const updated = next.chapters.find((c) => c.id === chapterId)!;
    updated.volumeId = volumeId;
    if (sceneIds)
      updated.scenes = sceneIds.map((id) =>
        chapter.scenes!.find((s) => s.id === id)!,
      );
    if (changedVolume) {
      const canonical = planningChapterOrder(
        detail.project.novelPlan!,
        detail.chapters,
      );
      if (canonical.some((id, i) => id !== detail.chapters[i].id))
        throw new Error(
          "当前章节跨卷交错，请通过规划树移动并确认章节顺序整理。",
        );
      const order = planningChapterOrder(
        next.project.novelPlan!,
        next.chapters,
      );
      next.chapters = order.map((id) =>
        next.chapters.find((c) => c.id === id)!,
      );
    }
    return commitStructure(repo, detail, next);
  })();
}

function commitStructure(
  repo: StoryRepository,
  before: ProjectDetail,
  next: ProjectDetail,
) {
  const projectId = before.project.id;
  snapshotPlanning(repo, projectId, "调整规划树前");
  for (const c of next.chapters) {
    const previous = before.chapters.find((item) => item.id === c.id)!;
    const moved = (previous.volumeId ?? null) !== (c.volumeId ?? null);
    const scenesChanged =
      JSON.stringify(previous.scenes?.map((s) => s.id) ?? []) !==
      JSON.stringify(c.scenes?.map((s) => s.id) ?? []);
    if (moved || scenesChanged) {
      if (c.plan.trim() || c.planMeta?.confirmed?.trim())
        c.planMeta = {
          confirmed: chapterPlan(c).confirmed,
          ...c.planMeta,
          reviewReason: moved
            ? "章节所属分卷已调整，请核对章纲与所属卷是否一致。"
            : "场景顺序已调整，请核对章纲与场景衔接。",
        };
      for (const [i, scene] of (c.scenes ?? []).entries())
        if (
          (moved || previous.scenes?.[i]?.id !== scene.id) &&
          (scene.plan.content.trim() || scene.plan.confirmed?.trim())
        )
          scene.plan.reviewReason = moved
            ? "章节所属分卷已调整，请核对场景细纲。"
            : "场景位置已调整，请核对前后场景的衔接。";
    }
    if ((moved || scenesChanged) && c.content.trim())
      c.planningReview = moved
        ? "章节所属分卷已调整，请核对正文。"
        : "场景顺序已调整，请核对正文。";
    // Preserve the current physical order until reorderChapters computes fact impact.
    c.position = previous.position;
    writeChapter(repo, c);
  }
  repo.updateProject(projectId, { novelPlan: next.project.novelPlan });
  const order = next.chapters.map((c) => c.id);
  if (order.some((id, i) => id !== before.chapters[i].id))
    reorderChapters(repo, projectId, order);
  return repo.getDetail(projectId);
}
export function previewPlanningMove(
  repo: StoryRepository,
  projectId: string,
  move: PlanningMove,
) {
  const { changed, requiresNormalization, beforeOrder, afterOrder } =
    proposePlanningMove(repo.getDetail(projectId), move);
  return {
    base: planningBase(repo, projectId),
    changed,
    requiresNormalization,
    beforeOrder,
    afterOrder,
  };
}
export function movePlanning(
  repo: StoryRepository,
  projectId: string,
  move: PlanningMove,
  base: string,
  confirmNormalization = false,
) {
  return repo.db.transaction(() => {
    if (planningBase(repo, projectId) !== base)
      throw new Error("规划或章节顺序已变化，请重新拖动，避免覆盖后来的编辑。");
    const before = repo.getDetail(projectId);
    const proposal = proposePlanningMove(before, move);
    if (!proposal.changed) return before;
    if (proposal.requiresNormalization && !confirmNormalization)
      throw new Error("此操作需要整理历史章节顺序，请先预览并确认。");
    return commitStructure(repo, before, proposal.next);
  })();
}
