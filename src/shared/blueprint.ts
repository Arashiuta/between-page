import type {
  Blueprint,
  BlueprintLevel,
  BlueprintNode,
  Project,
} from "./types";
export const blueprintLabels: Record<BlueprintLevel, string> = {
  section: "额外设定条目",
  synopsis: "总纲",
  volume: "卷纲",
  chapter: "章纲",
  scene: "场景细纲",
};
export const emptyBlueprint = (): Blueprint => ({ nodes: [] });
export type PlanningDomain = "blueprint" | "outline";
export const inPlanningDomain = (
  node: BlueprintNode,
  domain: PlanningDomain,
) =>
  domain === "blueprint" ? node.level === "section" : node.level !== "section";
export const outlineLevels: BlueprintLevel[] = [
  "synopsis",
  "volume",
  "chapter",
  "scene",
];
export type OutlineDropPosition = "before" | "inside" | "after";

// Only sibling order and the moved node's parent change. Descendants retain
// their IDs, contents and links, regardless of their physical array positions.
export function relocateOutline(
  nodes: BlueprintNode[],
  id: string,
  targetId: string,
  position: OutlineDropPosition,
): BlueprintNode[] {
  const moving = nodes.find((n) => n.id === id);
  const target = nodes.find((n) => n.id === targetId);
  if (!moving || !target)
    throw new Error("移动节点或目标节点不存在，请刷新后重试。");
  if (
    !inPlanningDomain(moving, "outline") ||
    !inPlanningDomain(target, "outline")
  )
    throw new Error("只能移动大纲节点，不能跨领域拖动。");
  if (id === targetId) return nodes;
  let ancestor: BlueprintNode | undefined = target;
  const visited = new Set<string>();
  while (ancestor) {
    if (ancestor.id === id || visited.has(ancestor.id))
      throw new Error("不能将节点拖入自身的下级。");
    visited.add(ancestor.id);
    const parentId: string | null = ancestor.parentId;
    ancestor = nodes.find((n) => n.id === parentId);
  }
  const parentId = position === "inside" ? targetId : target.parentId;
  const parent = nodes.find((n) => n.id === parentId);
  const valid =
    moving.level === "chapter"
      ? parentId === null || parent?.level === "volume"
      : moving.level === "scene"
        ? parent?.level === "chapter"
        : parentId === null;
  if (!valid)
    throw new Error(
      "拖动位置不符合层级规则：章纲只能归入卷纲或顶层，场景只能归入章纲，总纲和卷纲只能位于顶层。",
    );
  const siblings = nodes.filter(
    (n) =>
      n.parentId === parentId && inPlanningDomain(n, "outline") && n.id !== id,
  );
  const index =
    position === "inside"
      ? siblings.length
      : siblings.findIndex((n) => n.id === targetId) +
        Number(position === "after");
  const nextSiblings = siblings.map((n) => n.id);
  nextSiblings.splice(index, 0, id);
  if (
    moving.parentId === parentId &&
    JSON.stringify(nextSiblings) ===
      JSON.stringify(
        nodes
          .filter(
            (n) => n.parentId === parentId && inPlanningDomain(n, "outline"),
          )
          .map((n) => n.id),
      )
  )
    return nodes;
  const result = nodes.filter((n) => n.id !== id);
  const anchor = siblings[index];
  const insertion = anchor
    ? result.findIndex((n) => n.id === anchor.id)
    : siblings.length
      ? result.findIndex((n) => n.id === siblings[siblings.length - 1].id) + 1
      : result.findIndex((n) => n.id === targetId) + 1;
  result.splice(insertion, 0, { ...moving, parentId });
  return result;
}
export const isLegacyPlanning = (set: {
  kind: string;
  changes: { target: { type: string; node?: BlueprintNode } }[];
}) =>
  set.kind === "blueprint" &&
  set.changes.some(
    (c) => c.target.type === "blueprint" && c.target.node?.level !== "section",
  );
export const normalizeProject = (project: Project): Project => project;
export function orderedBlueprint(nodes: BlueprintNode[]): BlueprintNode[] {
  const result: BlueprintNode[] = [];
  const visit = (id: string) => {
    for (const n of nodes.filter((n) => n.parentId === id)) {
      result.push(n);
      visit(n.id);
    }
  };
  for (const n of nodes
    .filter((n) => !n.parentId)
    .sort(
      (a, b) => Number(b.level === "section") - Number(a.level === "section"),
    )) {
    result.push(n);
    visit(n.id);
  }
  return result;
}
export function validateBlueprint(blueprint: Blueprint, chapterIds: string[]) {
  if (new Set(blueprint.nodes.map((n) => n.id)).size !== blueprint.nodes.length)
    throw new Error("额外设定条目或大纲节点标识重复。");
  const links = new Set<string>();
  for (const n of blueprint.nodes) {
    const parent = blueprint.nodes.find((p) => p.id === n.parentId);
    if (n.chapterId && !chapterIds.includes(n.chapterId))
      throw new Error("大纲关联的章节不存在。");
    if (n.level === "chapter" && n.chapterId) {
      if (links.has(n.chapterId)) throw new Error("每章只能关联一个章纲。");
      links.add(n.chapterId);
    }
    if (["section", "synopsis", "volume"].includes(n.level)) {
      if (n.parentId) throw new Error("额外设定条目、总纲和卷纲必须位于顶层。");
    } else if (n.level === "chapter") {
      if (n.parentId && parent?.level !== "volume")
        throw new Error("章纲只能归入卷纲。");
    } else if (!parent || parent.level !== "chapter")
      throw new Error("场景细纲必须归入章纲。");
    if (n.level !== "chapter" && n.chapterId)
      throw new Error("只有章纲能关联正文章节。");
  }
  if (blueprint.nodes.filter((n) => n.level === "synopsis").length > 1)
    throw new Error("只保留一份全书总纲。");
}
