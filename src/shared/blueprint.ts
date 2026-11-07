import type {
  Blueprint,
  BlueprintLevel,
  BlueprintNode,
  Project,
} from "./types";
export const blueprintLabels: Record<BlueprintLevel, string> = {
  section: "全局约束 / 方向分区",
  synopsis: "总纲",
  volume: "卷纲",
  chapter: "章纲",
  scene: "场景细纲",
};
export const emptyBlueprint = (): Blueprint => ({ nodes: [] });
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
    throw new Error("蓝图节点标识重复。");
  const links = new Set<string>();
  for (const n of blueprint.nodes) {
    const parent = blueprint.nodes.find((p) => p.id === n.parentId);
    if (n.chapterId && !chapterIds.includes(n.chapterId))
      throw new Error("蓝图关联的章节不存在。");
    if (n.level === "chapter" && n.chapterId) {
      if (links.has(n.chapterId)) throw new Error("每章只能关联一个章纲。");
      links.add(n.chapterId);
    }
    if (["section", "synopsis", "volume"].includes(n.level)) {
      if (n.parentId) throw new Error("全局分区、总纲和卷纲必须位于顶层。");
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
