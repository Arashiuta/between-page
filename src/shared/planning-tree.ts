import type {
  Chapter,
  NovelPlan,
  PlanningMove,
  PlanningTreeRef,
  ProjectDetail,
} from "./types";

export const planningNodeKey = (node: PlanningTreeRef) =>
  `${node.level}:${node.id ?? "root"}`;
export function planningChapterOrder(plan: NovelPlan, chapters: Chapter[]) {
  const groups = [null, ...plan.volumes.map((v) => v.id)];
  return groups.flatMap((id) =>
    chapters
      .filter((c) =>
        id === null
          ? !plan.volumes.some((v) => v.id === c.volumeId)
          : c.volumeId === id,
      )
      .map((c) => c.id),
  );
}
export function validPlanningDrop(move: PlanningMove): boolean {
  const { source: s, target: t, placement: p } = move;
  if (planningNodeKey(s) === planningNodeKey(t)) return false;
  if (s.level === "volume") return t.level === "volume" && p !== "inside";
  if (s.level === "chapter")
    return (
      (t.level === "chapter" && p !== "inside") ||
      (["volume", "unassigned"].includes(t.level) && p === "inside")
    );
  return (
    s.level === "scene" &&
    t.level === "scene" &&
    p !== "inside" &&
    !!s.parentId &&
    s.parentId === t.parentId
  );
}
function insert<T>(
  items: T[],
  source: T,
  target: T | undefined,
  after: boolean,
) {
  const remaining = items.filter((v) => v !== source);
  const index =
    target === undefined ? remaining.length : remaining.indexOf(target);
  remaining.splice(index + (target !== undefined && after ? 1 : 0), 0, source);
  return remaining;
}
function requireNode(detail: ProjectDetail, node: PlanningTreeRef) {
  if (node.level === "synopsis" || node.level === "unassigned") {
    if (node.id || node.parentId) throw new Error("固定分组无效。");
    return;
  }
  if (!node.id) throw new Error("请选择有效的规划节点。");
  if (node.level === "volume") {
    if (!detail.project.novelPlan?.volumes.some((v) => v.id === node.id))
      throw new Error("分卷不存在或不属于当前故事。");
  } else if (node.level === "chapter") {
    if (!detail.chapters.some((c) => c.id === node.id))
      throw new Error("章节不存在或不属于当前故事。");
  } else if (
    !detail.chapters
      .find((c) => c.id === node.parentId)
      ?.scenes?.some((s) => s.id === node.id)
  ) {
    throw new Error("场景不存在或不属于当前章节。");
  }
}
/** Pure proposal; neither the input nor any persistent records are changed. */
export function proposePlanningMove(detail: ProjectDetail, move: PlanningMove) {
  requireNode(detail, move.source);
  requireNode(detail, move.target);
  if (!validPlanningDrop(move))
    throw new Error("不能移动到这个位置，请保持分卷、章节和场景的层级关系。");
  const next = JSON.parse(JSON.stringify(detail)) as ProjectDetail;
  const plan = next.project.novelPlan!,
    { source, target, placement } = move;
  const beforeOrder = detail.chapters.map((c) => c.id);
  const canonicalBefore = planningChapterOrder(plan, next.chapters);
  let changed = false;
  if (source.level === "volume") {
    const ids = plan.volumes.map((v) => v.id);
    const order = insert(ids, source.id!, target.id, placement === "after");
    changed = ids.some((id, i) => id !== order[i]);
    plan.volumes = order.map((id) => plan.volumes.find((v) => v.id === id)!);
  } else if (source.level === "chapter") {
    const chapter = next.chapters.find((c) => c.id === source.id)!;
    const targetChapter = next.chapters.find((c) => c.id === target.id);
    const volumeId =
      target.level === "volume"
        ? target.id!
        : target.level === "unassigned"
          ? next.project.mode === "novel"
            ? (plan.volumes[0]?.id ?? null)
            : null
          : plan.volumes.some((v) => v.id === targetChapter?.volumeId)
            ? targetChapter!.volumeId!
            : null;
    const group = next.chapters
      .filter((c) =>
        volumeId === null
          ? !plan.volumes.some((v) => v.id === c.volumeId)
          : c.volumeId === volumeId,
      )
      .map((c) => c.id);
    const order = insert(
      group,
      chapter.id,
      target.level === "chapter" ? target.id : undefined,
      placement === "after",
    );
    changed =
      (chapter.volumeId ?? null) !== volumeId ||
      group.some((id, i) => id !== order[i]) ||
      group.length !== order.length;
    chapter.volumeId = volumeId;
    const byId = new Map(next.chapters.map((c) => [c.id, c]));
    const others = next.chapters.filter((c) => !order.includes(c.id));
    next.chapters = [...others, ...order.map((id) => byId.get(id)!)];
  } else {
    const chapter = next.chapters.find((c) => c.id === source.parentId)!;
    const ids = chapter.scenes!.map((s) => s.id);
    const order = insert(ids, source.id!, target.id, placement === "after");
    changed = ids.some((id, i) => id !== order[i]);
    chapter.scenes = order.map((id) =>
      chapter.scenes!.find((s) => s.id === id)!,
    );
  }
  const afterOrder =
    changed && source.level !== "scene"
      ? planningChapterOrder(plan, next.chapters)
      : beforeOrder;
  next.chapters = afterOrder.map((id) =>
    next.chapters.find((c) => c.id === id)!,
  );
  return {
    next,
    changed,
    beforeOrder,
    afterOrder,
    requiresNormalization:
      changed &&
      source.level !== "scene" &&
      canonicalBefore.some((id, i) => id !== beforeOrder[i]),
  };
}
