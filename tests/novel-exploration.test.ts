import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoryRepository } from "../src/main/database";
import {
  savePlanning,
  applyPlanning,
  parsePlanning,
  planningBase,
  planningHistory,
  restorePlanning,
  snapshotPlanning,
  organizePlanning,
} from "../src/main/planning";
import {
  createFragment,
  incorporateFragment,
  reorderChapters,
  exportStory,
} from "../src/main/writing";
import { buildTask } from "../src/main/prompts";
import { textToDocument } from "../src/shared/document";
import { normalizeProject } from "../src/shared/blueprint";
import { planStatus } from "../src/shared/planning";
import { toolGroups } from "../src/shared/tools";
import {
  taskKinds,
  type TaskKind,
  type TaskRequest,
} from "../src/shared/types";

const repos: StoryRepository[] = [],
  dirs: string[] = [];
const open = (file = ":memory:") => {
  const repo = new StoryRepository(file);
  repos.push(repo);
  return repo;
};
function setup(mode: "novel" | "explore" = "novel") {
  const repo = open();
  const project = repo.createProject({
    title: "金属旅人",
    premise: "金属旅人在沙漠寻找故乡。",
    mode,
  });
  return { repo, project, chapter: repo.getDetail(project.id).chapters[0] };
}
const request = (
  kind: TaskKind,
  projectId: string,
  chapterId: string,
  extra: Partial<TaskRequest> = {},
) => ({
  requestId: randomUUID(),
  kind,
  projectId,
  chapterId,
  instruction: "",
  ...extra,
});
afterEach(async () => {
  for (const r of repos.splice(0)) if (r.db.open) r.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("长篇规划与模式差异", () => {
  it("新建默认值不同，缺少规划仍可试写，旧自由度保留", () => {
    const { repo, project, chapter } = setup();
    expect(project.creativeFreedom).toBe("guided");
    expect(
      buildTask(repo, request("chapter", project.id, chapter.id)).messages[0]
        .content,
    ).toContain("长篇创作流程");
    const explore = repo.createProject({
      title: "探索",
      premise: "",
      mode: "explore",
    });
    expect(explore.creativeFreedom).toBe("free");
    expect(
      buildTask(
        repo,
        request(
          "opening",
          explore.id,
          repo.getDetail(explore.id).chapters[0].id,
        ),
      ).messages[0].content,
    ).toContain("自由探索流程");
    expect(
      normalizeProject({ ...project, creativeFreedom: undefined })
        .creativeFreedom,
    ).toBe("balanced");
  });
  it("新章可留空章纲或保存草稿，也可确认章纲后创建", () => {
    const { repo, project } = setup();
    const count = repo.getDetail(project.id).chapters.length;
    const draft = savePlanning(
      repo,
      project.id,
      { level: "chapter" },
      { content: "尚未确认" },
    );
    expect(
      repo.getChapter(draft.target.id!).planMeta?.confirmed,
    ).toBeUndefined();
    const empty = savePlanning(
      repo,
      project.id,
      { level: "chapter" },
      { content: "" },
    );
    expect(repo.getChapter(empty.target.id!).plan).toBe("");
    expect(repo.getDetail(project.id).chapters).toHaveLength(count + 2);
    const result = savePlanning(
      repo,
      project.id,
      { level: "chapter" },
      { content: "已确认章纲", confirm: true },
    );
    expect(result.detail.chapters).toHaveLength(count + 3);
    expect(repo.getChapter(result.target.id!).content).toBe("");
  });
  it("章纲只有一个来源；正文默认使用确认版本，可明确试写草稿", () => {
    const { repo, project, chapter } = setup();
    savePlanning(
      repo,
      project.id,
      { level: "synopsis" },
      { content: "结局重返故乡", confirm: true },
    );
    const volume = savePlanning(
      repo,
      project.id,
      { level: "volume" },
      { title: "沙海", content: "找到道路", confirm: true },
    ).target;
    const next = savePlanning(
      repo,
      project.id,
      { level: "chapter", parentId: volume.id },
      { title: "驿站", content: "CONFIRMED_CHAPTER", confirm: true },
    ).target;
    savePlanning(
      repo,
      project.id,
      { level: "scene", parentId: next.id },
      { title: "问路", content: "柜台前发生争执", confirm: true },
    );
    savePlanning(repo, project.id, next, { content: "DRAFT_CHAPTER" });
    const context = buildTask(repo, request("chapter", project.id, next.id!))
      .messages[1].content;
    expect(context).toContain("CONFIRMED_CHAPTER");
    expect(context).not.toContain("DRAFT_CHAPTER");
    expect(context).toContain("柜台前发生争执");
    const draft = buildTask(
      repo,
      request("chapter", project.id, next.id!, { usePlanDraft: true }),
    ).messages[1].content;
    expect(draft).toContain("DRAFT_CHAPTER");
    expect(repo.getChapter(next.id!).plan).toBe("DRAFT_CHAPTER");
    expect(repo.getChapter(chapter.id).content).toBe("");
  });
  it("确认上层修改只标记规划影响，不改变正文或正式记忆", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, {
      document: textToDocument("旅人来到驿站。"),
    });
    const adopted = repo.adoptChapter(chapter.id);
    repo.saveGeneratedMemories(chapter.id, adopted.acceptedRevisionId!, [
      { kind: "fact", content: "旅人来到驿站" },
    ]);
    savePlanning(
      repo,
      project.id,
      { level: "chapter", id: chapter.id },
      { content: "从驿站出发", confirm: true },
    );
    savePlanning(
      repo,
      project.id,
      { level: "synopsis" },
      { content: "改变结局方向", confirm: true },
    );
    const detail = repo.getDetail(project.id);
    expect(detail.chapters[0].planningReview).toContain("总纲");
    expect(detail.chapters[0].needsReview).toBe(false);
    expect(detail.chapters[0].content).toBe("旅人来到驿站。");
    expect(detail.memories[0].active).toBe(true);
  });
  it("新规划未确认时不会成为默认正文依据，旧章纲继续兼容", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, { plan: "NEW_CHAPTER_DRAFT" });
    expect(
      buildTask(repo, request("chapter", project.id, chapter.id)).messages[1]
        .content,
    ).not.toContain("NEW_CHAPTER_DRAFT");
    const legacy = {
      ...repo.getChapter(chapter.id),
      plan: "LEGACY_CHAPTER",
      planMeta: undefined,
      kind: undefined,
    };
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify(legacy), chapter.id);
    savePlanning(
      repo,
      project.id,
      { level: "synopsis" },
      { content: "UNCONFIRMED_SYNOPSIS" },
    );
    let context = buildTask(repo, request("chapter", project.id, chapter.id))
      .messages[1].content;
    expect(context).toContain("LEGACY_CHAPTER");
    expect(context).not.toContain("UNCONFIRMED_SYNOPSIS");
    context = buildTask(
      repo,
      request("chapter", project.id, chapter.id, { usePlanDraft: true }),
    ).messages[1].content;
    expect(context).toContain("UNCONFIRMED_SYNOPSIS");
    savePlanning(
      repo,
      project.id,
      { level: "synopsis" },
      { content: "已确认总纲", confirm: true },
    );
    expect(
      buildTask(repo, request("chapter", project.id, chapter.id)).messages[1]
        .content,
    ).toContain("LEGACY_CHAPTER");
    repo.updateChapter(chapter.id, { plan: "LEGACY_CHANGED_DRAFT" });
    const after = buildTask(repo, request("chapter", project.id, chapter.id))
      .messages[1].content;
    expect(after).toContain("LEGACY_CHAPTER");
    expect(after).not.toContain("LEGACY_CHANGED_DRAFT");
  });
  it("恢复卷纲仅标记关联范围，关联与细纲顺序调整不改变正式记忆", () => {
    const { repo, project, chapter } = setup();
    const volume = savePlanning(
      repo,
      project.id,
      { level: "volume" },
      { content: "原卷纲", confirm: true },
    ).target;
    const next = savePlanning(
      repo,
      project.id,
      { level: "chapter", parentId: volume.id },
      { content: "本卷章节", confirm: true },
    ).target;
    const version = snapshotPlanning(repo, project.id, "卷纲原版");
    repo.updateChapter(next.id!, { document: textToDocument("已采用正文") });
    const adopted = repo.adoptChapter(next.id!);
    repo.saveGeneratedMemories(next.id!, adopted.acceptedRevisionId!, [
      { kind: "fact", content: "不受规划修改影响" },
    ]);
    savePlanning(repo, project.id, volume, {
      content: "新卷纲",
      confirm: true,
    });
    restorePlanning(repo, project.id, version.id);
    expect(repo.getChapter(chapter.id).planMeta?.reviewReason).toBeUndefined();
    expect(repo.getChapter(next.id!).planningReview).toContain("分卷");
    const s1 = savePlanning(
      repo,
      project.id,
      { level: "scene", parentId: next.id },
      { content: "场景一", confirm: true },
    ).target;
    const s2 = savePlanning(
      repo,
      project.id,
      { level: "scene", parentId: next.id },
      { content: "场景二", confirm: true },
    ).target;
    organizePlanning(repo, project.id, next.id!, volume.id!, [s2.id!, s1.id!]);
    expect(repo.getChapter(next.id!).scenes?.map((s) => s.id)).toEqual([
      s2.id,
      s1.id,
    ]);
    expect(repo.getDetail(project.id).memories[0].active).toBe(true);
    expect(() =>
      organizePlanning(repo, project.id, next.id!, volume.id!, [
        s1.id!,
        s1.id!,
      ]),
    ).toThrow("顺序无效");
    const volumeTitle = repo
      .getProject(project.id)
      .novelPlan!.volumes.find((v) => v.id === volume.id)!.title;
    expect(
      exportStory(repo, project.id).split(`## ${volumeTitle}\n`),
    ).toHaveLength(2);
  });
  it("分卷修改只影响归属章节，恢复版本也不会改写正文", () => {
    const { repo, project, chapter } = setup();
    const volume = savePlanning(
      repo,
      project.id,
      { level: "volume" },
      { content: "旧卷纲", confirm: true },
    ).target;
    const next = savePlanning(
      repo,
      project.id,
      { level: "chapter", parentId: volume.id },
      { content: "下一章计划", confirm: true },
    ).target;
    const version = snapshotPlanning(repo, project.id, "保存");
    repo.updateChapter(next.id!, { title: "后来的章节名称" });
    repo.updateChapter(next.id!, {
      document: textToDocument("后来手写的正文"),
    });
    savePlanning(repo, project.id, volume, {
      content: "新卷纲",
      confirm: true,
    });
    expect(repo.getChapter(chapter.id).planMeta?.reviewReason).toBeUndefined();
    expect(repo.getChapter(next.id!).planMeta?.reviewReason).toContain("分卷");
    restorePlanning(repo, project.id, version.id);
    expect(
      repo
        .getProject(project.id)
        .novelPlan!.volumes.find((v) => v.id === volume.id)!.plan.content,
    ).toBe("旧卷纲");
    expect(repo.getChapter(next.id!).content).toBe("后来手写的正文");
    expect(repo.getChapter(next.id!).title).toBe(
      version.chapters.find((c) => c.id === next.id)!.title,
    );
    expect(planningHistory(repo, project.id).length).toBeGreaterThan(1);
  });
  it("模拟 AI 分层建议可多选采用，过时建议与跨故事目标会被拒绝", () => {
    const { repo, project } = setup();
    const target = { level: "chapter" as const, count: 2 };
    const response = JSON.stringify({
      items: [
        { title: "第一站", content: "找燃料" },
        { title: "第二站", content: "寻找道路" },
      ],
    });
    const draft = parsePlanning(
      repo,
      project.id,
      target,
      planningBase(repo, project.id),
      response,
    );
    applyPlanning(
      repo,
      draft,
      draft.items.map((i) => i.id),
    );
    expect(
      repo
        .getDetail(project.id)
        .chapters.slice(-2)
        .map((c) => c.plan),
    ).toEqual(["找燃料", "寻找道路"]);
    expect(() => applyPlanning(repo, draft, [draft.items[0].id])).toThrow(
      "规划已变化",
    );
    const other = repo.createProject({
      title: "另一本",
      premise: "",
      mode: "novel",
    });
    expect(() =>
      savePlanning(
        repo,
        other.id,
        { level: "chapter", id: repo.getDetail(project.id).chapters[0].id },
        { content: "跨故事" },
      ),
    ).toThrow("不属于");
    expect(planStatus({ content: "未确认" })).toBe("草拟");
  });
  it("双向切换保留规划、片段、旧蓝图和自由度", () => {
    const { repo, project } = setup("explore");
    createFragment(repo, project.id);
    repo.updateProject(project.id, { outline: "旧版大纲" });
    savePlanning(
      repo,
      project.id,
      { level: "synopsis" },
      { content: "全书方向", confirm: true },
    );
    repo.updateProject(project.id, { mode: "novel" });
    repo.updateProject(project.id, { mode: "explore" });
    expect(repo.getDetail(project.id).fragments).toHaveLength(1);
    expect(repo.getProject(project.id).creativeFreedom).toBe("free");
    expect(repo.getProject(project.id).novelPlan!.synopsis.content).toBe(
      "全书方向",
    );
    expect(
      repo
        .getProject(project.id)
        .blueprintSections.some((s) => s.content.includes("旧版大纲")),
    ).toBe(true);
  });
});

describe("探索跳写与正式事实边界", () => {
  it("独立片段隔离于正文导出、设定提炼与正式记忆", () => {
    const { repo, project, chapter } = setup("explore");
    const f = createFragment(repo, project.id);
    repo.updateChapter(f.id, { document: textToDocument("FUTURE_FRAGMENT") });
    expect(repo.getDetail(project.id).chapters).toHaveLength(1);
    expect(exportStory(repo, project.id)).not.toContain("FUTURE_FRAGMENT");
    expect(exportStory(repo, project.id, true)).toContain("FUTURE_FRAGMENT");
    expect(() => repo.adoptChapter(f.id)).toThrow("请先");
    expect(() => buildTask(repo, request("notes", project.id, f.id))).toThrow(
      "独立片段",
    );
    for (const kind of ["chapter", "develop"] as const)
      expect(
        buildTask(repo, request(kind, project.id, chapter.id)).messages[1]
          .content,
      ).not.toContain("FUTURE_FRAGMENT");
  });
  it("片段只参考锚点以内的事实，无锚点时不带入最新章节", () => {
    const { repo, project, chapter } = setup("explore");
    repo.updateChapter(chapter.id, { document: textToDocument("ANCHOR_FACT") });
    repo.adoptChapter(chapter.id);
    const later = repo.createChapter(project.id);
    repo.updateChapter(later.id, { document: textToDocument("FUTURE_SECRET") });
    repo.adoptChapter(later.id);
    const f = createFragment(repo, project.id);
    expect(
      buildTask(repo, request("opening", project.id, f.id)).messages[1].content,
    ).not.toContain("ANCHOR_FACT");
    repo.updateChapter(f.id, {
      fragmentContext: {
        time: "多年后",
        place: "故乡",
        viewpoint: "旅人",
        connection: "未来重逢",
        anchorId: chapter.id,
      },
    });
    const context = buildTask(repo, request("chapter", project.id, f.id))
      .messages[1].content;
    expect(context).toContain("ANCHOR_FACT");
    expect(context).not.toContain("FUTURE_SECRET");
  });
  it("片段编成新章时保留历史及指定位置，正式采用后才允许记忆", () => {
    const { repo, project, chapter } = setup("explore");
    const f = createFragment(repo, project.id);
    repo.updateChapter(f.id, { document: textToDocument("先写的未来场景") });
    const revision = repo.checkpoint(f.id);
    incorporateFragment(repo, project.id, f.id, { beforeId: chapter.id });
    expect(repo.getDetail(project.id).chapters[0].id).toBe(f.id);
    expect(repo.listRevisions(f.id).some((r) => r.id === revision.id)).toBe(
      true,
    );
    expect(repo.getChapter(f.id).acceptedRevisionId).toBeNull();
    repo.adoptChapter(f.id);
    expect(() =>
      buildTask(repo, request("notes", project.id, f.id)),
    ).not.toThrow();
  });
  it("片段并入已有章保留原稿与正文快照，防止意外重复及跨故事写入", () => {
    const { repo, project, chapter } = setup("explore");
    repo.updateChapter(chapter.id, { document: textToDocument("原章正文") });
    const f = createFragment(repo, project.id);
    repo.updateChapter(f.id, { document: textToDocument("追加片段") });
    incorporateFragment(repo, project.id, f.id, { chapterId: chapter.id });
    expect(repo.listRevisions(chapter.id)[0].content).toBe("原章正文");
    expect(repo.getChapter(chapter.id).content).toContain("追加片段");
    expect(repo.getChapter(f.id).content).toBe("追加片段");
    expect(() =>
      incorporateFragment(repo, project.id, f.id, { chapterId: chapter.id }),
    ).toThrow("已经编入");
    const other = repo.createProject({
      title: "另一本",
      mode: "explore",
      premise: "",
    });
    expect(() =>
      incorporateFragment(repo, project.id, f.id, {
        chapterId: repo.getDetail(other.id).chapters[0].id,
        allowRepeat: true,
      }),
    ).toThrow("不属于");
  });
  it("重排已采用章节仅使受影响事实失效，前缀和手动记录保留", () => {
    const { repo, project, chapter } = setup("explore");
    const chapters = [
      chapter,
      repo.createChapter(project.id),
      repo.createChapter(project.id),
    ];
    for (const c of chapters) {
      repo.updateChapter(c.id, { document: textToDocument(c.title) });
      const adopted = repo.adoptChapter(c.id);
      repo.saveGeneratedMemories(c.id, adopted.acceptedRevisionId!, [
        { kind: "fact", content: c.title },
      ]);
    }
    repo.addMemory(project.id, "fact", "手动事实");
    reorderChapters(repo, project.id, [
      chapter.id,
      chapters[2].id,
      chapters[1].id,
    ]);
    const detail = repo.getDetail(project.id);
    expect(detail.chapters.map((c) => c.needsReview)).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      detail.memories
        .filter((m) => m.active)
        .map((m) => m.content)
        .sort(),
    ).toEqual([chapter.title, "手动事实"].sort());
  });
  it("片段与规划在关闭数据库重新打开后完整保留", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storybook-modes-"));
    dirs.push(dir);
    const file = join(dir, "book.sqlite");
    let repo = open(file);
    const p = repo.createProject({
      title: "持久化",
      mode: "novel",
      premise: "",
    });
    const f = createFragment(repo, p.id);
    repo.updateChapter(f.id, { document: textToDocument("片段原稿") });
    savePlanning(
      repo,
      p.id,
      { level: "synopsis" },
      { content: "小说总纲", confirm: true },
    );
    repo.close();
    repo = open(file);
    expect(repo.getDetail(p.id).fragments![0].content).toBe("片段原稿");
    expect(repo.getProject(p.id).novelPlan!.synopsis.confirmed).toBe(
      "小说总纲",
    );
  });
});

describe("工具整合与润色", () => {
  it("八个主入口完整覆盖旧任务，保持标识兼容", () => {
    expect(toolGroups).toHaveLength(8);
    expect(toolGroups.flatMap((g) => g.kinds).sort()).toEqual(
      [...taskKinds].sort(),
    );
  });
  it("全文改写无需选区，局部改写需要选区，建议明确禁止正文输出", () => {
    const { repo, project, chapter } = setup();
    expect(() =>
      buildTask(repo, request("revise", project.id, chapter.id)),
    ).toThrow("选择");
    const full = buildTask(
      repo,
      request("revise", project.id, chapter.id, {
        writingScope: "document",
        outputMode: "rewrite",
      }),
    );
    expect(full.messages[0].content).toContain("完整改写稿");
    expect(
      buildTask(
        repo,
        request("dialogue", project.id, chapter.id, { outputMode: "analysis" }),
      ).messages[0].content,
    ).toContain("只输出修改建议");
    repo.updateChapter(chapter.id, {
      document: textToDocument("开头" + "中".repeat(20_000) + "结尾"),
    });
    const rewrite = buildTask(
      repo,
      request("revise", project.id, chapter.id, {
        writingScope: "document",
        outputMode: "rewrite",
      }),
    );
    expect(rewrite.messages[1].content).toContain(
      repo.getChapter(chapter.id).content,
    );
  });
});
