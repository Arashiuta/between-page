import type { StoryRepository } from "./database";
import type { Chapter } from "../shared/types";
const write = (repo: StoryRepository, c: Chapter) =>
  repo.db
    .prepare("UPDATE chapters SET position = ?, payload = ? WHERE id = ?")
    .run(c.position, JSON.stringify(c), c.id);
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
export function exportStory(repo: StoryRepository, projectId: string) {
  const d = repo.getDetail(projectId);
  return (
    "# " +
    d.project.title +
    "\n\n" +
    d.chapters
      .map((c) => "## " + c.title + "\n\n" + c.content)
      .join("\n\n---\n\n")
  );
}
