import type { StoryRepository } from "./database";
import type { Chapter } from "../shared/types";

const write = (repo: StoryRepository, c: Chapter) =>
  repo.db
    .prepare("UPDATE chapters SET position = ?, payload = ? WHERE id = ?")
    .run(c.position, JSON.stringify(c), c.id);
export function createFragment(repo: StoryRepository, projectId: string) {
  return repo.db.transaction(() => {
    const c = repo.createChapter(projectId);
    Object.assign(c, {
      kind: "fragment",
      volumeId: null,
      position: 0,
      title: "未命名片段",
      fragmentContext: { time: "", place: "", viewpoint: "", connection: "" },
    });
    write(repo, c);
    return c;
  })();
}
export function reorderChapters(
  repo: StoryRepository,
  projectId: string,
  ids: string[],
) {
  return repo.db.transaction(() => {
    const detail = repo.getDetail(projectId),
      original = detail.chapters;
    if (
      ids.length !== original.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !original.some((c) => c.id === id))
    )
      throw new Error("章节顺序与当前故事不匹配，请刷新后重试。");
    const accepted = original
      .filter((c) => c.acceptedRevisionId)
      .map((c) => c.id);
    const nextAccepted = ids.filter((id) => accepted.includes(id));
    const first = accepted.findIndex((id, i) => nextAccepted[i] !== id);
    const affected = new Set(
      first < 0 ? [] : [...accepted.slice(first), ...nextAccepted.slice(first)],
    );
    for (const [i, id] of ids.entries()) {
      const c = original.find((c) => c.id === id)!;
      c.position = i + 1;
      if (affected.has(id)) c.needsReview = true;
      write(repo, c);
    }
    for (const m of detail.memories)
      if (!m.manual && m.chapterId && affected.has(m.chapterId)) {
        m.active = false;
        repo.db
          .prepare("UPDATE memories SET active = 0, payload = ? WHERE id = ?")
          .run(JSON.stringify(m), m.id);
      }
    repo.updateProject(projectId, {});
    return repo.getDetail(projectId);
  })();
}
export function incorporateFragment(
  repo: StoryRepository,
  projectId: string,
  fragmentId: string,
  target: { chapterId?: string; beforeId?: string; allowRepeat?: boolean },
) {
  return repo.db.transaction(() => {
    const detail = repo.getDetail(projectId),
      fragment = detail.fragments?.find((c) => c.id === fragmentId);
    if (!fragment) throw new Error("片段不存在或不属于当前故事。");
    if (!fragment.content.trim()) throw new Error("先写下一些片段正文。");
    if (fragment.incorporatedInto?.length && !target.allowRepeat)
      throw new Error("这个片段已经编入过故事，请确认是否再次编入。");
    if (target.chapterId) {
      const c = detail.chapters.find((c) => c.id === target.chapterId);
      if (!c) throw new Error("目标章节不属于当前故事。");
      repo.checkpoint(c.id, "编入片段前");
      repo.updateChapter(c.id, {
        document: {
          ...c.document,
          content: [
            ...(c.document.content ?? []),
            ...(fragment.document.content ?? []),
          ],
        },
      });
      fragment.incorporatedInto = [...(fragment.incorporatedInto ?? []), c.id];
      write(repo, fragment);
    } else {
      if (
        target.beforeId &&
        !detail.chapters.some((c) => c.id === target.beforeId)
      )
        throw new Error("插入位置不存在。");
      fragment.kind = "chapter";
      fragment.position = detail.chapters.length + 1;
      write(repo, fragment);
      const ids = detail.chapters.map((c) => c.id);
      ids.splice(
        target.beforeId ? ids.indexOf(target.beforeId) : ids.length,
        0,
        fragment.id,
      );
      reorderChapters(repo, projectId, ids);
    }
    repo.updateProject(projectId, {});
    return repo.getDetail(projectId);
  })();
}
export function exportStory(
  repo: StoryRepository,
  projectId: string,
  fragments = false,
) {
  const detail = repo.getDetail(projectId);
  if (fragments)
    return `# ${detail.project.title} · 独立片段\n\n${(detail.fragments ?? []).map((c) => `## ${c.title}\n\n${c.content}`).join("\n\n---\n\n")}`;
  const chapterText = (c: Chapter, inVolume = false) =>
    `${inVolume ? "###" : "##"} ${c.title}\n\n${c.content}`;
  const volumes =
    detail.project.mode === "novel"
      ? (detail.project.novelPlan?.volumes ?? [])
      : [];
  const unassigned = detail.chapters.filter(
    (c) => !volumes.some((v) => v.id === c.volumeId),
  );
  const sections = [
    ...unassigned.map((c) => chapterText(c)),
    ...volumes.flatMap((v) => {
      const chapters = detail.chapters.filter((c) => c.volumeId === v.id);
      return chapters.length
        ? [
            `## ${v.title}\n\n${chapters.map((c) => chapterText(c, true)).join("\n\n---\n\n")}`,
          ]
        : [];
    }),
  ];
  return `# ${detail.project.title}\n\n${sections.join("\n\n---\n\n")}`;
}
