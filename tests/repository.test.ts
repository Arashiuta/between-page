import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fixture, request, proposal, node } from "./workbench-fixture";
import { textToDocument } from "../src/shared/document";
import { applyChangeSet } from "../src/main/changes";
import { reorderChapters, exportStory } from "../src/main/writing";
import { StoryRepository } from "../src/main/database";
import type { MemoryKind } from "../src/shared/types";
async function remember(
  f: ReturnType<typeof fixture>,
  chapterId: string,
  kind: MemoryKind,
  content: string,
) {
  const set = await proposal(
    f,
    request(f, "notes", { chapterId }),
    JSON.stringify({ records: [{ kind, content }] }),
  );
  applyChangeSet(
    f.repo,
    f.project.id,
    set.id,
    set.changes.map((c) => ({ id: c.id, after: c.after })),
  );
}
describe("版本与关联数据", () => {
  it("早期版本重新采用停用旧事实，后续采用章节需复核", async () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("信在抽屉"),
    });
    const a = f.repo.adoptChapter(f.chapter.id);
    await remember(f, f.chapter.id, "fact", "信在抽屉");
    const later = f.repo.createChapter(f.project.id);
    f.repo.updateChapter(later.id, { document: textToDocument("乙找到信") });
    const b = f.repo.adoptChapter(later.id);
    await remember(f, later.id, "knowledge", "乙看过信");
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("信被烧毁"),
    });
    f.repo.adoptChapter(f.chapter.id);
    expect(
      f.repo.getDetail(f.project.id).memories.every((m) => !m.active),
    ).toBe(true);
    expect(f.repo.getChapter(later.id).needsReview).toBe(true);
    expect(() =>
      f.repo.setMemoryActive(
        f.repo.getDetail(f.project.id).memories[0].id,
        true,
      ),
    ).toThrow("失效");
  });
  it("恢复只修改草稿，保留采用正文和恢复前快照", () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("原文") });
    const a = f.repo.adoptChapter(f.chapter.id);
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("新草稿") });
    f.repo.restoreRevision(a.acceptedRevisionId!);
    expect(f.repo.getChapter(f.chapter.id).acceptedRevisionId).toBe(
      a.acceptedRevisionId,
    );
    expect(f.repo.listRevisions(f.chapter.id)[0].content).toBe("新草稿");
  });
  it("删除章节清理本章版本与记忆，解除章纲关联，保留独立蓝图", async () => {
    const f = fixture();
    node(f, "chapter", "本章安排", { chapterId: f.chapter.id });
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("正文") });
    const c = f.repo.adoptChapter(f.chapter.id);
    await remember(f, c.id, "fact", "已发生");
    f.repo.deleteChapter(c.id);
    const d = f.repo.getDetail(f.project.id);
    expect(d.chapters).toEqual([]);
    expect(d.memories).toEqual([]);
    expect(d.project.blueprint.nodes[0].chapterId).toBeNull();
    expect(f.repo.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("删除早期采用章节使后续事实停用", async () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("第一章") });
    f.repo.adoptChapter(f.chapter.id);
    const c = f.repo.createChapter(f.project.id);
    f.repo.updateChapter(c.id, { document: textToDocument("第二章") });
    const a = f.repo.adoptChapter(c.id);
    await remember(f, c.id, "fact", "事实");
    f.repo.deleteChapter(f.chapter.id);
    expect(f.repo.getChapter(c.id).needsReview).toBe(true);
    expect(f.repo.getDetail(f.project.id).memories[0].active).toBe(false);
  });
  it("章节删除事务失败不丢内容", () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("正文") });
    vi.spyOn(f.repo, "updateProject").mockImplementation(() => {
      throw Error("模拟故障");
    });
    expect(() => f.repo.deleteChapter(f.chapter.id)).toThrow("故障");
    expect(f.repo.getChapter(f.chapter.id).content).toBe("正文");
  });
  it("调整正式章序停用受影响记忆，导出遵循章序", async () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("前章") });
    const a = f.repo.adoptChapter(f.chapter.id),
      c = f.repo.createChapter(f.project.id);
    f.repo.updateChapter(c.id, { document: textToDocument("后章") });
    const b = f.repo.adoptChapter(c.id);
    for (const ch of [a, b]) await remember(f, ch.id, "fact", ch.content);
    reorderChapters(f.repo, f.project.id, [c.id, a.id]);
    expect(
      f.repo.getDetail(f.project.id).memories.every((m) => !m.active),
    ).toBe(true);
    expect(exportStory(f.repo, f.project.id).indexOf("后章")).toBeLessThan(
      exportStory(f.repo, f.project.id).indexOf("前章"),
    );
    expect(() => reorderChapters(f.repo, f.project.id, [c.id, c.id])).toThrow();
  });
  it("归档删除清理审核记录、候选、聊天和界面状态，不影响其他故事", async () => {
    const f = fixture();
    await proposal(f, request(f, "opening"), "候选");
    f.api["ui:save"]({
      projectId: f.project.id,
      key: "workbench.novel",
      value: {},
    });
    const other = f.repo.createProject({
      title: "别书",
      premise: "",
      mode: "explore",
    });
    expect(() => f.repo.deleteArchivedProject(f.project.id)).toThrow("归档");
    f.repo.updateProject(f.project.id, { archived: true });
    f.repo.deleteArchivedProject(f.project.id);
    expect(f.repo.getProject(other.id).title).toBe("别书");
    for (const table of [
      "creation_turns",
      "creation_conversations",
      "change_sets",
    ])
      expect(
        f.repo.db
          .prepare("SELECT id FROM " + table + " WHERE project_id = ?")
          .all(f.project.id),
      ).toEqual([]);
    expect(
      f.repo.getSetting("ui." + f.project.id + ".workbench.novel", null),
    ).toBeNull();
  });
  it("旧数据库格式明确拒绝，原文件保持不变，不做迁移", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-schema-"));
    try {
      const file = join(dir, "old.sqlite"),
        db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE projects(id TEXT PRIMARY KEY,payload TEXT);INSERT INTO projects VALUES ('old','{}');PRAGMA user_version=1;",
      );
      db.close();
      expect(() => new StoryRepository(file)).toThrow("不迁移旧开发数据");
      const verify = new DatabaseSync(file);
      expect(
        (verify.prepare("PRAGMA user_version").get() as any).user_version,
      ).toBe(1);
      expect(verify.prepare("SELECT id FROM projects").all()).toHaveLength(1);
      verify.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
