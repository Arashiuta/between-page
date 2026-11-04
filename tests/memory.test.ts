import { describe, it, expect, afterEach } from "vitest";
import { StoryRepository } from "../src/main/database";
import { buildTask, parseMemories } from "../src/main/prompts";
import { textToDocument } from "../src/shared/document";
import { randomUUID } from "node:crypto";
const repositories: StoryRepository[] = [];
function repository() {
  const repo = new StoryRepository(":memory:");
  repositories.push(repo);
  return repo;
}
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});
function setup(repo: StoryRepository, title = "测试故事") {
  const project = repo.createProject({
    title,
    mode: "novel",
    premise: "人物发现一封信。",
  });
  const chapter = repo.getDetail(project.id).chapters[0];
  repo.updateChapter(chapter.id, {
    document: textToDocument("甲把信藏进了蓝色抽屉。乙没有看到。"),
  });
  return { project, chapter };
}
describe("正式记忆与版本", () => {
  it("未采用的章节不能提取正式记忆", () => {
    const repo = repository(),
      { project, chapter } = setup(repo);
    expect(() =>
      buildTask(repo, {
        requestId: randomUUID(),
        kind: "notes",
        projectId: project.id,
        chapterId: chapter.id,
        instruction: "",
      }),
    ).toThrow("采用");
    expect(repo.getDetail(project.id).memories).toHaveLength(0);
  });
  it("新的草稿不改变采用版本，提取仍然使用采用正文", () => {
    const repo = repository(),
      { project, chapter } = setup(repo);
    const accepted = repo.adoptChapter(chapter.id);
    repo.updateChapter(chapter.id, {
      document: textToDocument("甲把信烧掉了，这是尚未采用的修改。"),
    });
    const task = buildTask(repo, {
      requestId: randomUUID(),
      kind: "notes",
      projectId: project.id,
      chapterId: chapter.id,
      instruction: "",
    });
    expect(task.revisionId).toBe(accepted.acceptedRevisionId);
    expect(task.messages[1].content).toContain("蓝色抽屉");
    expect(task.messages[1].content).not.toContain("甲把信烧掉了");
  });
  it("重新采用早期章节，旧记忆停用，后续采用章节需复核", () => {
    const repo = repository(),
      { project, chapter } = setup(repo);
    const original = repo.adoptChapter(chapter.id);
    repo.saveGeneratedMemories(chapter.id, original.acceptedRevisionId!, [
      { kind: "fact", content: "信在蓝色抽屉。" },
    ]);
    const later = repo.createChapter(project.id);
    repo.updateChapter(later.id, {
      document: textToDocument("乙在抽屉里找到了信。"),
    });
    const acceptedLater = repo.adoptChapter(later.id);
    repo.saveGeneratedMemories(later.id, acceptedLater.acceptedRevisionId!, [
      { kind: "knowledge", content: "乙知道信的内容。" },
    ]);
    repo.addMemory(project.id, "fact", "作者指定的事实仍然有效。");
    repo.updateChapter(chapter.id, {
      document: textToDocument("甲把信烧掉了。"),
    });
    repo.adoptChapter(chapter.id);
    const detail = repo.getDetail(project.id);
    expect(
      detail.memories.filter((m) => !m.manual).every((m) => !m.active),
    ).toBe(true);
    expect(detail.memories.find((m) => m.manual)?.active).toBe(true);
    expect(detail.chapters.find((c) => c.id === later.id)?.needsReview).toBe(
      true,
    );
    expect(() =>
      repo.setMemoryActive(
        detail.memories.find((m) => m.chapterId === later.id)!.id,
        true,
      ),
    ).toThrow("失效");
  });
  it("拒绝写入异步任务返回的旧版本记忆", () => {
    const repo = repository(),
      { chapter } = setup(repo);
    const first = repo.adoptChapter(chapter.id);
    repo.updateChapter(chapter.id, {
      document: textToDocument("故事已经改写。"),
    });
    repo.adoptChapter(chapter.id);
    expect(() =>
      repo.saveGeneratedMemories(chapter.id, first.acceptedRevisionId!, [
        { kind: "fact", content: "旧事实" },
      ]),
    ).toThrow("版本已变化");
  });
  it("上下文隔离故事，并排除当前章节以后的记忆", () => {
    const repo = repository(),
      { project, chapter } = setup(repo);
    const other = setup(repo, "另一个宇宙");
    repo.addMemory(other.project.id, "fact", "绝不能串入的异世界秘密");
    repo.adoptChapter(chapter.id);
    const future = repo.createChapter(project.id);
    repo.updateChapter(future.id, {
      document: textToDocument("未来才发生的独特事件"),
    });
    const accepted = repo.adoptChapter(future.id);
    repo.saveGeneratedMemories(future.id, accepted.acceptedRevisionId!, [
      { kind: "fact", content: "未来才知道的唯一口令 ZEBRA" },
    ]);
    const task = buildTask(repo, {
      requestId: randomUUID(),
      kind: "chapter",
      projectId: project.id,
      chapterId: chapter.id,
      instruction: "",
    });
    expect(task.messages[1].content).not.toContain("ZEBRA");
    expect(task.messages[1].content).not.toContain("绝不能串入");
    expect(task.messages[1].content).not.toContain("未来才发生的独特事件");
  });
  it("复制 OC 时建立独立快照，模板修改不影响故事副本", () => {
    const repo = repository();
    const template = repo.saveCard({
      projectId: null,
      kind: "character",
      name: "小林",
      description: "长发",
      constraints: "不轻易许诺",
      referenceIds: [],
    });
    const project = repo.createProject({
      title: "独立世界",
      mode: "explore",
      premise: "",
      cardIds: [template.id],
    });
    repo.saveCard({ ...template, description: "短发" });
    const snapshot = repo.getDetail(project.id).cards[0];
    expect(snapshot.description).toBe("长发");
    expect(snapshot.id).not.toBe(template.id);
  });
  it("恢复版本只改变草稿，保留采用正文及恢复前快照", () => {
    const repo = repository(),
      { chapter } = setup(repo);
    const original = repo.checkpoint(chapter.id);
    repo.updateChapter(chapter.id, { document: textToDocument("新正文") });
    const accepted = repo.adoptChapter(chapter.id);
    const restored = repo.restoreRevision(original.id);
    expect(restored.content).toContain("蓝色抽屉");
    expect(restored.acceptedRevisionId).toBe(accepted.acceptedRevisionId);
    expect(restored.dirty).toBe(true);
    expect(
      repo.listRevisions(chapter.id).some((r) => r.label === "恢复前的草稿"),
    ).toBe(true);
  });
  it("模型记忆必须通过结构校验", () => {
    expect(
      parseMemories(
        '```json\n{"records":[{"kind":"knowledge","content":"甲以为乙已经离开，尚未证实。"}]}\n```',
      ),
    ).toHaveLength(1);
    expect(() =>
      parseMemories('{"records":[{"kind":"made-up","content":"错误"}]}'),
    ).toThrow("格式");
  });
});
