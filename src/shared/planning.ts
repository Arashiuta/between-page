import type { Chapter, NovelPlan, PlanBlock, Project } from "./types";

export const emptyNovelPlan = (): NovelPlan => ({
  synopsis: { content: "" },
  volumes: [],
});
export function normalizeChapterVolume(
  chapter: Chapter,
  project: Project,
): Chapter {
  if (
    project.mode !== "novel" ||
    chapter.kind === "fragment" ||
    project.novelPlan?.volumes.some((v) => v.id === chapter.volumeId)
  )
    return chapter;
  return { ...chapter, volumeId: project.novelPlan?.volumes[0]?.id ?? null };
}
export const planStatus = (block: PlanBlock) =>
  block.reviewReason
    ? "待核对"
    : block.confirmed === block.content && !!block.content.trim()
      ? "已确认"
      : !block.content.trim() && !block.confirmed?.trim()
        ? "按需添加"
        : "草拟";
export const chapterPlan = (chapter: Chapter): PlanBlock => ({
  content: chapter.plan,
  ...(chapter.planMeta ?? { confirmed: chapter.plan }),
});
export const planText = (block: PlanBlock, draft = false) =>
  draft ? block.content : (block.confirmed ?? "");
export const planningLabels = {
  synopsis: "总纲",
  volume: "分卷大纲",
  chapter: "章纲",
  scene: "场景细纲",
};
export const planningHints = {
  synopsis:
    "主题与阅读体验、核心冲突、贯穿全书的主线、主要人物变化、结局方向。",
  volume: "本卷目标、主要事件、阶段转折、人物变化、高潮及下一卷的衔接。",
  chapter:
    "本章目标、视角、时间地点、冲突、关键行动、转折、结束位置与预期篇幅。",
  scene: "场景目标、出场人物、行动与阻力、对白重点、信息释放、伏笔及离场变化。",
};
