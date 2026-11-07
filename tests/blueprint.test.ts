import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, node, request, options, run } from "./workbench-fixture";
import { prepareTaskPreview, validateRequest } from "../src/main/conversations";
import { validateBlueprint, orderedBlueprint } from "../src/shared/blueprint";
import { textToDocument } from "../src/shared/document";
import { proposal } from "./workbench-fixture";
import { applyChangeSet } from "../src/main/changes";
describe("单一蓝图与职责边界", () => {
  it("保存后立即参考，章纲场景只归属蓝图，正文记录不保存规划", async () => {
    const f = fixture();
    const root = node(f, "synopsis", "总纲立即生效"),
      volume = node(f, "volume", "卷纲"),
      chapter = node(f, "chapter", "章纲", {
        parentId: volume.id,
        chapterId: f.chapter.id,
      }),
      scene = node(f, "scene", "细纲", { parentId: chapter.id });
    const p = await prepareTaskPreview(f.repo, request(f, "opening"), options),
      text = JSON.stringify(p.messages);
    for (const n of [root, volume, chapter, scene])
      expect(text).toContain(n.content);
    expect(text).toContain(`上级规划：${volume.title} [${volume.id}]`);
    expect(text).toContain(`上级规划：${chapter.title} [${chapter.id}]`);
    expect(text).toContain(
      `关联正文章节：第 1 章 ${f.chapter.title} [${f.chapter.id}]`,
    );
    expect(f.repo.getChapter(f.chapter.id)).not.toHaveProperty("plan");
    expect(f.repo.getChapter(f.chapter.id)).not.toHaveProperty("scenes");
  });
  it("已有蓝图修改要求准确基准，保存会记录可恢复的历史", () => {
    const f = fixture(),
      n = node(f);
    f.api["blueprint:save"]({
      projectId: f.project.id,
      node: { ...n, content: "手工新稿" },
      base: n,
    });
    expect(() =>
      f.api["blueprint:save"]({
        projectId: f.project.id,
        node: { ...n, content: "过期稿" },
        base: n,
      }),
    ).toThrow("其他操作修改");
    const versions = f.api["blueprint:history"](f.project.id) as any[];
    expect(versions).toHaveLength(2);
    f.api["blueprint:restore"]({ projectId: f.project.id, id: versions[0].id });
    expect(f.repo.getProject(f.project.id).blueprint.nodes[0].content).toBe(
      n.content,
    );
  });
  it("同一批 AI 蓝图采用只记录一次可恢复快照", async () => {
    const f = fixture("explore");
    const n = node(f);
    const set = await proposal(
      f,
      request(f, "blueprint", { target: { level: "section", count: 2 } }),
      '{"items":[{"title":"第一项","content":"第一项安排"},{"title":"第二项","content":"第二项安排"}]}',
    );
    applyChangeSet(
      f.repo,
      f.project.id,
      set.id,
      set.changes.map((c) => ({ id: c.id, after: c.after })),
    );
    const versions = f.api["blueprint:history"](f.project.id) as any[];
    expect(versions).toHaveLength(2);
    expect(versions[0].blueprint.nodes).toEqual([n]);
    f.api["blueprint:restore"]({ projectId: f.project.id, id: versions[0].id });
    expect(f.repo.getProject(f.project.id).blueprint.nodes).toEqual([n]);
  });
  it.each([
    "self",
    "wrongParent",
    "foreignChapter",
    "duplicateLink",
    "duplicateSynopsis",
  ] as const)("拒绝蓝图结构 %s", (problem) => {
    const f = fixture();
    const chapter = node(f, "chapter", "", { chapterId: f.chapter.id }),
      nodes = f.repo.getProject(f.project.id).blueprint.nodes;
    let bad: any = {
      id: randomUUID(),
      title: "错误",
      level: "chapter",
      parentId: null,
      chapterId: null,
      content: "",
    };
    if (problem === "self") bad = { ...bad, parentId: bad.id };
    if (problem === "wrongParent")
      bad = { ...bad, level: "scene", parentId: randomUUID() };
    if (problem === "foreignChapter") bad = { ...bad, chapterId: randomUUID() };
    if (problem === "duplicateLink") bad = { ...bad, chapterId: f.chapter.id };
    if (problem === "duplicateSynopsis") {
      nodes.push({ ...bad, level: "synopsis" });
      bad = { ...bad, id: randomUUID(), level: "synopsis" };
    }
    expect(() =>
      validateBlueprint({ nodes: [...nodes, bad] }, [f.chapter.id]),
    ).toThrow();
  });
  it("移除卷纲仅移除归属规划，正文保留；恢复不复活已删除章节", () => {
    const f = fixture(),
      v = node(f, "volume"),
      c = node(f, "chapter", "本章安排", {
        parentId: v.id,
        chapterId: f.chapter.id,
      });
    node(f, "scene", "场景", { parentId: c.id });
    const before = f.repo.getChapter(f.chapter.id);
    f.api["blueprint:remove"]({ projectId: f.project.id, id: v.id });
    expect(f.repo.getProject(f.project.id).blueprint.nodes).toEqual([]);
    expect(f.repo.getChapter(f.chapter.id)).toEqual(before);
    const versions = f.api["blueprint:history"](f.project.id) as any[];
    f.repo.deleteChapter(f.chapter.id);
    f.api["blueprint:restore"]({ projectId: f.project.id, id: versions[0].id });
    expect(f.repo.getDetail(f.project.id).chapters).toEqual([]);
    expect(
      f.repo.getProject(f.project.id).blueprint.nodes.find((n) => n.id === c.id)
        ?.chapterId,
    ).toBeNull();
  });
  it("模式切换保留所有层级，探索模式仅生成自由分区，长篇可空规划写作", async () => {
    const f = fixture();
    node(f, "synopsis");
    node(f, "volume");
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("正文保留"),
    });
    const blueprint = f.repo.getProject(f.project.id).blueprint;
    f.repo.updateProject(f.project.id, { mode: "explore" });
    expect(f.repo.getProject(f.project.id).blueprint).toEqual(blueprint);
    expect(() =>
      validateRequest(
        f.repo,
        request(f, "blueprint", { target: { level: "chapter", count: 1 } }),
      ),
    ).toThrow("模式不支持");
    await run(f, request(f, "brainstorm"), "探索回答");
    f.repo.updateProject(f.project.id, { mode: "novel" });
    const empty = f.repo.createChapter(f.project.id);
    expect(() =>
      validateRequest(f.repo, request(f, "opening", { chapterId: empty.id })),
    ).not.toThrow();
  });
  it("蓝图和设定写入端点互相隔离，旧工作流与片段端点已删除", () => {
    const f = fixture();
    expect(() =>
      f.api["project:update"]({ id: f.project.id, blueprint: { nodes: [] } }),
    ).toThrow();
    for (const key of [
      "workflow:list",
      "fragment:create",
      "planning:apply",
      "story:apply-development",
    ])
      expect(f.api).not.toHaveProperty(key);
  });
});
