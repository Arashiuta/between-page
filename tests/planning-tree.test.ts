import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoryRepository } from "../src/main/database";
import {
  applyPlanning,
  movePlanning,
  removePlanning,
  organizePlanning,
  planningBase,
  planningHistory,
  previewPlanningMove,
  restorePlanning,
  savePlanning,
  snapshotPlanning,
} from "../src/main/planning";
import {
  createFragment,
  exportStory,
  reorderChapters,
} from "../src/main/writing";
import { buildTask } from "../src/main/prompts";
import { textToDocument } from "../src/shared/document";
import { validPlanningDrop } from "../src/shared/planning-tree";
import type { PlanningMove, PlanningTreeRef } from "../src/shared/types";

const repos: StoryRepository[] = [];
const directories: string[] = [];
afterEach(async () => {
  repos.splice(0).forEach((r) => r.close());
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const ref = (
  level: PlanningTreeRef["level"],
  id?: string,
  parentId?: string,
): PlanningTreeRef => ({ level, id, parentId });
function setup(filename = ":memory:") {
  const repo = new StoryRepository(filename);
  repos.push(repo);
  const p = repo.createProject({ title: "规划树", premise: "", mode: "novel" });
  const volume = (title: string) =>
    savePlanning(
      repo,
      p.id,
      { level: "volume" },
      { title, content: title, confirm: true },
    ).target.id!;
  const a = volume("卷甲"),
    b = volume("卷乙"),
    empty = volume("空卷");
  const c = [
    repo.getDetail(p.id).chapters[0],
    ...Array.from({ length: 3 }, () => repo.createChapter(p.id)),
  ];
  for (const [i, chapter] of c.entries()) {
    savePlanning(
      repo,
      p.id,
      { level: "chapter", id: chapter.id },
      { title: `章${i}`, content: `章纲${i}`, confirm: true },
    );
    repo.updateChapter(chapter.id, {
      document: textToDocument(`独有事实${i}`),
    });
    const adopted = repo.adoptChapter(chapter.id);
    repo.saveGeneratedMemories(chapter.id, adopted.acceptedRevisionId!, [
      { kind: "fact", content: `事实${i}` },
    ]);
  }
  // Canonical order: default first volume c0, volume A c1/c2, volume B c3.
  for (const [i, chapter] of c.entries()) {
    const value = repo.getChapter(chapter.id);
    value.volumeId = i === 0 ? null : i === 3 ? b : a;
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify(value), chapter.id);
  }
  repo.addMemory(p.id, "fact", "作者记录");
  const f = createFragment(repo, p.id);
  repo.updateChapter(f.id, { document: textToDocument("未来片段") });
  const move = (
    source: PlanningTreeRef,
    target: PlanningTreeRef,
    placement: PlanningMove["placement"],
    confirm = false,
  ) => {
    const request = { source, target, placement };
    const preview = previewPlanningMove(repo, p.id, request);
    return movePlanning(repo, p.id, request, preview.base, confirm);
  };
  return { repo, p, a, b, empty, c, f, move };
}
describe("规划树结构移动", () => {
  it("长篇默认第一卷可留空，新增章节继承默认卷或明确选择的卷", () => {
    const repo = new StoryRepository(":memory:");
    repos.push(repo);
    const p = repo.createProject({
      title: "默认第一卷",
      premise: "",
      mode: "novel",
    });
    const first = p.novelPlan!.volumes[0];
    expect(p.novelPlan!.volumes).toHaveLength(1);
    expect(first).toMatchObject({ title: "第一卷", plan: { content: "" } });
    const c = repo.getDetail(p.id).chapters[0];
    expect(c.volumeId).toBe(first.id);
    expect(repo.createChapter(p.id).volumeId).toBe(first.id);
    const another = savePlanning(
      repo,
      p.id,
      { level: "volume" },
      { title: "第二卷", content: "" },
    ).target;
    const next = savePlanning(
      repo,
      p.id,
      { level: "chapter", parentId: another.id },
      { title: "指定卷的新章", content: "" },
    ).target;
    expect(repo.getChapter(next.id!).volumeId).toBe(another.id);
    expect(
      buildTask(repo, {
        projectId: p.id,
        chapterId: c.id,
        kind: "chapter",
        instruction: "",
        requestId: crypto.randomUUID(),
      }).messages[1].content,
    ).not.toContain("本卷大纲");
    expect(createFragment(repo, p.id).volumeId).toBeNull();
    expect(exportStory(repo, p.id)).toContain("## 第一卷");
  });
  it("旧未分卷章节显示于第一卷，读取不改动正文、正式顺序和原始记录", () => {
    const { repo, p, c } = setup();
    const rawProject = repo.getProject(p.id);
    rawProject.novelPlan = { synopsis: { content: "旧总纲" }, volumes: [] };
    repo.db
      .prepare("UPDATE projects SET payload = ? WHERE id = ?")
      .run(JSON.stringify(rawProject), p.id);
    const history = planningHistory(repo, p.id);
    const before = repo.db
      .prepare(
        "SELECT payload FROM chapters WHERE project_id = ? ORDER BY position",
      )
      .all(p.id);
    const projectBefore = repo.db
      .prepare("SELECT payload FROM projects WHERE id = ?")
      .get(p.id);
    const result = repo.getDetail(p.id);
    expect(result.project.novelPlan!.volumes).toHaveLength(1);
    expect(
      result.chapters.every(
        (chapter) =>
          chapter.volumeId === result.project.novelPlan!.volumes[0].id,
      ),
    ).toBe(true);
    expect(result.chapters.map((chapter) => chapter.id)).toEqual(
      c.map((chapter) => chapter.id),
    );
    expect(result.chapters.map((chapter) => chapter.content)).toEqual(
      c.map((_, i) => `独有事实${i}`),
    );
    expect(result.memories.every((memory) => memory.active)).toBe(true);
    expect(
      repo.db
        .prepare(
          "SELECT payload FROM chapters WHERE project_id = ? ORDER BY position",
        )
        .all(p.id),
    ).toEqual(before);
    expect(
      repo.db.prepare("SELECT payload FROM projects WHERE id = ?").get(p.id),
    ).toEqual(projectBefore);
    expect(planningHistory(repo, p.id)).toEqual(history);
  });
  it("删除最后一卷仍有空白第一卷，正文与记忆保留且可恢复卷纲", () => {
    const repo = new StoryRepository(":memory:");
    repos.push(repo);
    const p = repo.createProject({
      title: "删除末卷",
      premise: "",
      mode: "novel",
    });
    const first = p.novelPlan!.volumes[0];
    savePlanning(
      repo,
      p.id,
      { level: "volume", id: first.id },
      { title: "起程卷", content: "原卷纲", confirm: true },
    );
    const c = repo.getDetail(p.id).chapters[0];
    repo.updateChapter(c.id, { document: textToDocument("保留的正文") });
    const adopted = repo.adoptChapter(c.id);
    repo.saveGeneratedMemories(c.id, adopted.acceptedRevisionId!, [
      { kind: "fact", content: "保留的事实" },
    ]);
    const result = removePlanning(repo, p.id, {
      level: "volume",
      id: first.id,
    });
    expect(result.project.novelPlan!.volumes[0]).toMatchObject({
      title: "第一卷",
      plan: { content: "" },
    });
    expect(result.chapters[0]).toMatchObject({
      volumeId: result.project.novelPlan!.volumes[0].id,
      content: "保留的正文",
      acceptedRevisionId: adopted.acceptedRevisionId,
    });
    expect(result.memories[0].active).toBe(true);
    const restored = restorePlanning(
      repo,
      p.id,
      planningHistory(repo, p.id)[0].id,
    );
    expect(restored.project.novelPlan!.volumes[0]).toMatchObject({
      title: "起程卷",
      plan: { content: "原卷纲" },
    });
    expect(restored.chapters[0].content).toBe("保留的正文");
  });
  it("分卷整体移动同步正文、导出和前文参考，保留前缀记忆及片段", () => {
    const { repo, p, a, b, c, f, move } = setup();
    const before = repo.getDetail(p.id);
    const result = move(ref("volume", b), ref("volume", a), "before");
    expect(result.chapters.map((c) => c.id)).toEqual([
      c[0].id,
      c[3].id,
      c[1].id,
      c[2].id,
    ]);
    expect(result.chapters.map((c) => c.position)).toEqual([1, 2, 3, 4]);
    expect(result.chapters.map((c) => c.needsReview)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(
      result.memories
        .filter((m) => m.active)
        .map((m) => m.content)
        .sort(),
    ).toEqual(["作者记录", "事实0"].sort());
    for (const chapter of result.chapters) {
      const old = before.chapters.find((v) => v.id === chapter.id)!;
      expect(chapter.content).toBe(old.content);
      expect(chapter.acceptedRevisionId).toBe(old.acceptedRevisionId);
    }
    expect(repo.getChapter(f.id).content).toBe("未来片段");
    const exported = exportStory(repo, p.id);
    expect(exported.indexOf("卷乙")).toBeLessThan(exported.indexOf("卷甲"));
    // Re-adopt in the new order before testing which facts precede the target.
    for (const chapter of result.chapters) repo.adoptChapter(chapter.id);
    const request = buildTask(repo, {
      projectId: p.id,
      chapterId: c[1].id,
      kind: "chapter",
      instruction: "",
      requestId: crypto.randomUUID(),
    });
    expect(request.messages[1].content).toContain("独有事实3");
    expect(request.messages[1].content).not.toContain("独有事实2");
  });
  it("章节卷内排序、跨卷插入、空卷接收及旧未分卷落点兼容第一卷", () => {
    const { repo, p, a, b, empty, c, move } = setup();
    move(ref("chapter", c[2].id), ref("chapter", c[1].id), "before");
    expect(repo.getDetail(p.id).chapters.map((c) => c.id)).toEqual([
      c[0].id,
      c[2].id,
      c[1].id,
      c[3].id,
    ]);
    move(ref("chapter", c[2].id), ref("chapter", c[3].id), "after");
    expect(repo.getChapter(c[2].id).volumeId).toBe(b);
    expect(repo.getChapter(c[2].id).planningReview).toBeTruthy();
    move(ref("chapter", c[1].id), ref("volume", empty), "inside");
    expect(repo.getChapter(c[1].id).volumeId).toBe(empty);
    move(ref("chapter", c[1].id), ref("unassigned"), "inside");
    expect(repo.getChapter(c[1].id).volumeId).toBe(
      repo.getProject(p.id).novelPlan!.volumes[0].id,
    );
    expect(
      repo.getDetail(p.id).project.novelPlan!.volumes.find((v) => v.id === a),
    ).toBeTruthy();
    expect(repo.getDetail(p.id).chapters.map((c) => c.id)).toEqual([
      c[0].id,
      c[1].id,
      c[3].id,
      c[2].id,
    ]);
  });
  it("只改变卷归属、未改变正式顺序时不使正式记忆失效", () => {
    const { repo, p, c, a, move } = setup();
    const result = move(
      ref("chapter", c[0].id),
      ref("chapter", c[1].id),
      "before",
    );
    expect(result.chapters.map((c) => c.needsReview)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(result.memories.every((m) => m.active)).toBe(true);
    expect(repo.getChapter(c[0].id).volumeId).toBe(a);
  });
  it("场景仅在同章内重排，不改变正文、章节顺序和正式记忆", () => {
    const { repo, p, c, a, move } = setup();
    const scenes = ["场景甲", "场景乙"].map(
      (content) =>
        savePlanning(
          repo,
          p.id,
          { level: "scene", parentId: c[1].id },
          { content, confirm: true },
        ).target.id!,
    );
    const before = repo.getDetail(p.id);
    move(
      ref("scene", scenes[1], c[1].id),
      ref("scene", scenes[0], c[1].id),
      "before",
    );
    expect(repo.getChapter(c[1].id).scenes!.map((s) => s.id)).toEqual(
      scenes.toReversed(),
    );
    expect(repo.getChapter(c[1].id).content).toBe(before.chapters[1].content);
    expect(repo.getDetail(p.id).memories).toEqual(before.memories);
    expect(() =>
      organizePlanning(repo, p.id, c[1].id, a, [scenes[0], scenes[0]]),
    ).toThrow("场景顺序");
  });
  it("历史交错顺序先预览且未经确认不写入，场景排序不强制整理章节", () => {
    const { repo, p, a, b, c, move } = setup();
    reorderChapters(repo, p.id, [c[0].id, c[1].id, c[3].id, c[2].id]);
    const before = repo.getDetail(p.id),
      history = planningHistory(repo, p.id);
    const request: PlanningMove = {
      source: ref("volume", b),
      target: ref("volume", a),
      placement: "before",
    };
    const preview = previewPlanningMove(repo, p.id, request);
    expect(preview.requiresNormalization).toBe(true);
    expect(preview.afterOrder).toEqual([c[0].id, c[3].id, c[1].id, c[2].id]);
    expect(() => movePlanning(repo, p.id, request, preview.base)).toThrow(
      "预览并确认",
    );
    expect(repo.getDetail(p.id)).toEqual(before);
    expect(planningHistory(repo, p.id)).toEqual(history);
    movePlanning(repo, p.id, request, preview.base, true);
    expect(repo.getDetail(p.id).chapters.map((c) => c.id)).toEqual(
      preview.afterOrder,
    );
    const scenes = ["相遇", "分别"].map(
      (content) =>
        savePlanning(
          repo,
          p.id,
          { level: "scene", parentId: c[1].id },
          { content, confirm: true },
        ).target.id!,
    );
    const interleaved = [c[0].id, c[1].id, c[3].id, c[2].id];
    reorderChapters(repo, p.id, interleaved);
    const memories = repo.getDetail(p.id).memories;
    const sceneMove: PlanningMove = {
      source: ref("scene", scenes[1], c[1].id),
      target: ref("scene", scenes[0], c[1].id),
      placement: "before",
    };
    const scenePreview = previewPlanningMove(repo, p.id, sceneMove);
    expect(scenePreview.requiresNormalization).toBe(false);
    expect(scenePreview.afterOrder).toEqual(interleaved);
    movePlanning(repo, p.id, sceneMove, scenePreview.base);
    expect(repo.getDetail(p.id).chapters.map((c) => c.id)).toEqual(interleaved);
    expect(repo.getDetail(p.id).memories).toEqual(memories);
    expect(
      repo.getChapter(c[1].id).scenes!.every((s) => s.plan.reviewReason),
    ).toBe(true);
  });
  it("拒绝跨故事、片段、错误父级、非法落点及过期基准", () => {
    const { repo, p, a, b, c, f, move } = setup();
    const other = repo.createProject({
      title: "其他",
      premise: "",
      mode: "novel",
    });
    expect(() =>
      move(
        ref("chapter", repo.getDetail(other.id).chapters[0].id),
        ref("volume", a),
        "inside",
      ),
    ).toThrow("当前故事");
    expect(() =>
      move(ref("chapter", f.id), ref("volume", a), "inside"),
    ).toThrow("当前故事");
    expect(() =>
      move(ref("volume", a), ref("chapter", c[0].id), "inside"),
    ).toThrow("层级关系");
    expect(
      validPlanningDrop({
        source: ref("scene", "a", c[0].id),
        target: ref("scene", "b", c[1].id),
        placement: "before",
      }),
    ).toBe(false);
    const request: PlanningMove = {
      source: ref("volume", b),
      target: ref("volume", a),
      placement: "before",
    };
    const preview = previewPlanningMove(repo, p.id, request);
    savePlanning(repo, p.id, { level: "synopsis" }, { content: "后来的编辑" });
    expect(() => movePlanning(repo, p.id, request, preview.base)).toThrow(
      "已变化",
    );
  });
  it("重复落点不保存快照，数据库失败回滚结构和快照", () => {
    const { repo, p, a, b, move } = setup();
    const history = planningHistory(repo, p.id);
    move(ref("volume", a), ref("volume", b), "before");
    expect(planningHistory(repo, p.id)).toEqual(history);
    const before = repo.getDetail(p.id);
    repo.db.exec(
      "CREATE TRIGGER fail_move BEFORE UPDATE ON chapters BEGIN SELECT RAISE(ABORT, 'move failed'); END;",
    );
    expect(() => move(ref("volume", b), ref("volume", a), "before")).toThrow(
      "move failed",
    );
    expect(repo.getDetail(p.id)).toEqual(before);
    expect(planningHistory(repo, p.id)).toEqual(history);
  });
  it("新快照恢复顺序不复活删章，旧快照不恢复章节顺序", () => {
    const { repo, p, a, b, c, move } = setup();
    const version = snapshotPlanning(repo, p.id, "原顺序");
    const legacy = { ...version, id: crypto.randomUUID() };
    delete legacy.chapterOrder;
    repo.setSetting(`planning.history.${p.id}`, [
      ...planningHistory(repo, p.id),
      legacy,
    ]);
    move(ref("volume", b), ref("volume", a), "before");
    restorePlanning(repo, p.id, legacy.id);
    expect(repo.getDetail(p.id).chapters.map((c) => c.id)).toEqual([
      c[0].id,
      c[3].id,
      c[1].id,
      c[2].id,
    ]);
    repo.deleteChapter(c[2].id);
    restorePlanning(repo, p.id, version.id);
    expect(repo.getDetail(p.id).chapters.map((c) => c.id)).toEqual([
      c[0].id,
      c[1].id,
      c[3].id,
    ]);
    expect(repo.getDetail(p.id).chapters.some((v) => v.id === c[2].id)).toBe(
      false,
    );
  });
  it("结构变化使旧 AI 候选失效", () => {
    const { repo, p, a, b, move } = setup();
    const draft = {
      projectId: p.id,
      target: { level: "synopsis" as const },
      base: planningBase(repo, p.id),
      items: [{ id: crypto.randomUUID(), title: "旧总纲", content: "旧候选" }],
    };
    move(ref("volume", b), ref("volume", a), "before");
    expect(() => applyPlanning(repo, draft, [draft.items[0].id])).toThrow(
      "规划已变化",
    );
  });
  it("重启后保留规划树顺序、归属、场景和移动前快照", async () => {
    const directory = await mkdtemp(join(tmpdir(), "story-planning-tree-"));
    directories.push(directory);
    const file = join(directory, "story.sqlite");
    const { repo, p, b, c, move } = setup(file);
    const scenes = ["先行场景", "后续场景"].map(
      (content) =>
        savePlanning(
          repo,
          p.id,
          { level: "scene", parentId: c[1].id },
          { content, confirm: true },
        ).target.id!,
    );
    const original = snapshotPlanning(repo, p.id, "调整前");
    move(ref("chapter", c[2].id), ref("volume", b), "inside");
    move(
      ref("scene", scenes[1], c[1].id),
      ref("scene", scenes[0], c[1].id),
      "before",
    );
    const saved = repo.getDetail(p.id),
      history = planningHistory(repo, p.id);
    repo.close();
    repos.splice(repos.indexOf(repo), 1);
    const reopened = new StoryRepository(file);
    repos.push(reopened);
    expect(reopened.getDetail(p.id)).toEqual(saved);
    expect(planningHistory(reopened, p.id)).toEqual(history);
    const restored = restorePlanning(reopened, p.id, original.id);
    expect(restored.chapters.map((chapter) => chapter.id)).toEqual(
      c.map((chapter) => chapter.id),
    );
    expect(reopened.getChapter(c[2].id).volumeId).toBe(
      original.chapters.find((chapter) => chapter.id === c[2].id)!.volumeId,
    );
    expect(
      reopened.getChapter(c[1].id).scenes!.map((scene) => scene.id),
    ).toEqual(scenes);
    expect(restored.chapters.map((chapter) => chapter.content)).toEqual(
      c.map((_, i) => `独有事实${i}`),
    );
  });
});
