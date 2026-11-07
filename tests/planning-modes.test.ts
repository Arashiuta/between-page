import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  fixture,
  node,
  request,
  options,
  allText,
  proposal,
  run,
} from "./workbench-fixture";
import { applyChangeSet, saveChangeSet } from "../src/main/changes";
import { prepareTaskPreview } from "../src/main/conversations";
import { textToDocument } from "../src/shared/document";
import { applicableMemories } from "../src/main/context";

describe("独立额外设定、大纲与事实依据", () => {
  it("两个页面不能跨领域保存、删除或移动节点，探索不能修改大纲", () => {
    const f = fixture(),
      section = node(f),
      volume = node(f, "volume");
    for (const [domain, n] of [
      ["blueprint", volume],
      ["outline", section],
    ] as const) {
      expect(() =>
        f.api[domain + ":save"]({ projectId: f.project.id, node: n, base: n }),
      ).toThrow("不属于");
      expect(() =>
        f.api[domain + ":remove"]({ projectId: f.project.id, id: n.id }),
      ).toThrow("不属于");
      expect(() =>
        f.api[domain + ":move"]({ projectId: f.project.id, id: n.id, step: 1 }),
      ).toThrow("不属于");
    }
    f.repo.updateProject(f.project.id, { mode: "explore" });
    expect(() =>
      f.api["outline:save"]({
        projectId: f.project.id,
        node: volume,
        base: volume,
      }),
    ).toThrow("长篇");
  });
  it("额外设定恢复不改变大纲，大纲恢复不改变额外设定，包括旧的混合历史", () => {
    const f = fixture(),
      section = node(f, "section", "额外设定原稿"),
      volume = node(f, "volume", "大纲原稿");
    const oldVersion = randomUUID();
    f.repo.setSetting("blueprint.history." + f.project.id, [
      {
        id: oldVersion,
        createdAt: "旧时间",
        blueprint: { nodes: [section, volume] },
      },
    ]);
    f.api["blueprint:save"]({
      projectId: f.project.id,
      node: { ...section, content: "额外设定新稿" },
      base: section,
    });
    f.api["outline:save"]({
      projectId: f.project.id,
      node: { ...volume, content: "大纲新稿" },
      base: volume,
    });
    f.api["blueprint:restore"]({ projectId: f.project.id, id: oldVersion });
    let nodes = f.repo.getProject(f.project.id).blueprint.nodes;
    expect(nodes.find((n) => n.id === section.id)?.content).toBe("额外设定原稿");
    expect(nodes.find((n) => n.id === volume.id)?.content).toBe("大纲新稿");
    const old = nodes.find((n) => n.id === section.id)!;
    f.api["blueprint:save"]({
      projectId: f.project.id,
      node: { ...old, content: "额外设定独立修改" },
      base: old,
    });
    f.api["outline:restore"]({ projectId: f.project.id, id: oldVersion });
    nodes = f.repo.getProject(f.project.id).blueprint.nodes;
    expect(nodes.find((n) => n.id === section.id)?.content).toBe(
      "额外设定独立修改",
    );
    expect(nodes.find((n) => n.id === volume.id)?.content).toBe("大纲原稿");
  });
  it("章纲创建正文并唯一关联，重复点击返回同一章，改归属保留内容", () => {
    const f = fixture(),
      v1 = node(f, "volume"),
      v2 = node(f, "volume"),
      plan = node(f, "chapter", "本章先调查失踪案", { parentId: v1.id });
    const c = f.api["outline:create-chapter"]({
      projectId: f.project.id,
      id: plan.id,
    }) as typeof f.chapter;
    expect(
      f.api["outline:create-chapter"]({ projectId: f.project.id, id: plan.id }),
    ).toEqual(c);
    const saved = f.repo
      .getProject(f.project.id)
      .blueprint.nodes.find((n) => n.id === plan.id)!;
    f.api["outline:save"]({
      projectId: f.project.id,
      node: { ...saved, parentId: v2.id },
      base: saved,
    });
    expect(
      f.repo
        .getProject(f.project.id)
        .blueprint.nodes.find((n) => n.id === plan.id),
    ).toMatchObject({
      parentId: v2.id,
      chapterId: c.id,
      content: plan.content,
    });
    expect(() => node(f, "chapter", "重复关联", { chapterId: c.id })).toThrow(
      "一个章纲",
    );
  });
  it("树的同级排序不影响其他领域与下级归属", () => {
    const f = fixture(),
      section = node(f),
      v1 = node(f, "volume"),
      c1 = node(f, "chapter", "一", { parentId: v1.id }),
      v2 = node(f, "volume"),
      c2 = node(f, "chapter", "二", { parentId: v1.id });
    f.api["outline:move"]({ projectId: f.project.id, id: c2.id, step: -1 });
    const nodes = f.repo.getProject(f.project.id).blueprint.nodes;
    expect(nodes.filter((n) => n.parentId === v1.id).map((n) => n.id)).toEqual([
      c2.id,
      c1.id,
    ]);
    expect(nodes.find((n) => n.id === section.id)).toEqual(section);
    expect(nodes.find((n) => n.id === v2.id)).toEqual(v2);
  });
  it("AI 生成大纲先审核，不能修改额外设定；旧分层规划候选可查但不能采用", async () => {
    const f = fixture(),
      section = node(f);
    const set = await proposal(
      f,
      request(f, "outline", { target: { level: "volume", count: 2 } }),
      '{"items":[{"title":"第一卷","content":"调查"},{"title":"第二卷","content":"解谜"}]}',
    );
    expect(f.repo.getProject(f.project.id).blueprint.nodes).toEqual([section]);
    applyChangeSet(
      f.repo,
      f.project.id,
      set.id,
      set.changes.map((c) => ({ id: c.id, after: c.after })),
    );
    expect(
      f.repo
        .getProject(f.project.id)
        .blueprint.nodes.filter((n) => n.level === "volume"),
    ).toHaveLength(2);
    expect(f.api["outline:history"](f.project.id)).toHaveLength(1);
    const pending = await proposal(
      f,
      request(f, "outline", { target: { level: "chapter", count: 1 } }),
      '{"items":[{"title":"旧章纲","content":"历史建议"}]}',
    );
    pending.kind = "blueprint";
    saveChangeSet(f.repo, pending);
    expect(() =>
      applyChangeSet(f.repo, f.project.id, pending.id, [
        { id: pending.changes[0].id, after: "历史建议" },
      ]),
    ).toThrow("旧版");
    expect(
      f.api["changes:get"]({ projectId: f.project.id, id: pending.id }),
    ).toMatchObject({ kind: "blueprint" });
  });
  it("切到探索后排除已保存大纲及大纲候选，额外设定、资料和记忆继续完整参考", async () => {
    const f = fixture();
    node(f, "section", "所有模式的硬性约束");
    node(f, "synopsis", "隐藏的全书结局");
    const pending = await proposal(
      f,
      request(f, "outline", { target: { level: "volume", count: 1 } }),
      '{"items":[{"title":"未来候选","content":"隐藏的大纲候选内容"}]}',
    );
    f.repo.updateProject(f.project.id, {
      world: "全程保留的世界资料",
      mode: "explore",
    });
    f.repo.addMemory(f.project.id, "fact", "全程保留的故事事实");
    for (const kind of ["brainstorm", "blueprint", "opening"] as const) {
      const p = await prepareTaskPreview(f.repo, request(f, kind), options),
        text = allText(p);
      expect(text).toContain("所有模式的硬性约束");
      expect(text).toContain("全程保留的世界资料");
      expect(text).toContain("全程保留的故事事实");
      expect(text).not.toContain("隐藏的全书结局");
      expect(text).not.toContain("隐藏的大纲候选内容");
    }
    pending.kind = "blueprint";
    saveChangeSet(f.repo, pending);
    expect(
      allText(await prepareTaskPreview(f.repo, request(f), options)),
    ).not.toContain("隐藏的大纲候选内容");
    f.repo.updateProject(f.project.id, { mode: "novel" });
    expect(
      allText(await prepareTaskPreview(f.repo, request(f, "opening"), options)),
    ).toContain("隐藏的全书结局");
  });
  it("写作记忆按章节时间过滤，走向额外使用当前章记忆，全局规划参考全部有效记忆", async () => {
    const f = fixture(),
      chapters = [
        f.chapter,
        f.repo.createChapter(f.project.id),
        f.repo.createChapter(f.project.id),
      ];
    for (const [i, c] of chapters.entries()) {
      f.repo.updateChapter(c.id, {
        document: textToDocument(`第${i + 1}章正文`),
      });
      f.repo.adoptChapter(c.id);
    }
    // Add source-backed facts through the normal review path after all chapter adoptions.
    for (const [i, c] of chapters.entries()) {
      f.api["chapter:acknowledge"](c.id);
      const set = await proposal(
        f,
        request(f, "notes", { chapterId: c.id }),
        JSON.stringify({
          records: [{ kind: "knowledge", content: `来源第${i + 1}章的秘密` }],
        }),
      );
      applyChangeSet(
        f.repo,
        f.project.id,
        set.id,
        set.changes.map((x) => ({ id: x.id, after: x.after })),
      );
    }
    const current = chapters[1];
    let text = allText(
      await prepareTaskPreview(
        f.repo,
        request(f, "continue", { chapterId: current.id }),
        options,
      ),
    );
    expect(text).toContain("来源第1章的秘密");
    expect(text).not.toContain("来源第2章的秘密");
    expect(text).not.toContain("来源第3章的秘密");
    text = allText(
      await prepareTaskPreview(f.repo, request(f, "outline"), options),
    );
    for (const i of [1, 2, 3]) expect(text).toContain(`来源第${i}章的秘密`);
    f.repo.updateProject(f.project.id, { mode: "explore" });
    text = allText(
      await prepareTaskPreview(
        f.repo,
        request(f, "directions", { chapterId: current.id }),
        options,
      ),
    );
    expect(text).toContain("来源第1章的秘密");
    expect(text).toContain("来源第2章的秘密");
    expect(text).not.toContain("来源第3章的秘密");
    const firstMemory = f.repo
      .getDetail(f.project.id)
      .memories.find((m) => m.chapterId === chapters[0].id)!;
    f.repo.setMemoryActive(firstMemory.id, false);
    expect(
      applicableMemories(f.repo.getDetail(f.project.id)).map((m) => m.content),
    ).not.toContain("来源第1章的秘密");
    f.repo.updateChapter(current.id, {
      document: textToDocument("改写当前章"),
    });
    f.repo.adoptChapter(current.id);
    expect(
      applicableMemories(f.repo.getDetail(f.project.id)).map((m) => m.content),
    ).not.toContain("来源第2章的秘密");
  });
});
