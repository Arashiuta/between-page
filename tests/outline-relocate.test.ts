import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, node } from "./workbench-fixture";
import { StoryRepository } from "../src/main/database";
import {
  orderedBlueprint,
  type OutlineDropPosition,
} from "../src/shared/blueprint";
import type { Project } from "../src/shared/types";

function setup(filename?: string) {
  const f = fixture("novel", filename);
  const section = node(f),
    v1 = node(f, "volume"),
    v2 = node(f, "volume");
  const c1 = node(f, "chapter", "原始内容", {
    parentId: v1.id,
    chapterId: f.chapter.id,
  });
  const s1 = node(f, "scene", "场景内容", { parentId: c1.id });
  const c2 = node(f, "chapter", "第二个章纲", { parentId: v1.id });
  const c3 = node(f, "chapter", "第三个章纲", { parentId: v2.id });
  const move = (id: string, targetId: string, position: OutlineDropPosition) =>
    f.api["outline:relocate"]({
      projectId: f.project.id,
      id,
      targetId,
      position,
    }) as Project;
  const nodes = () => f.repo.getProject(f.project.id).blueprint.nodes;
  const siblings = (parentId: string | null) =>
    nodes()
      .filter((n) => n.parentId === parentId && n.level !== "section")
      .map((n) => n.id);
  const history = () =>
    f.api["outline:history"](f.project.id) as { id: string }[];
  return {
    ...f,
    section,
    v1,
    v2,
    c1,
    c2,
    c3,
    s1,
    move,
    nodes,
    siblings,
    history,
  };
}

describe("大纲拖动", () => {
  it("前后插入按实际显示顺序排序，保留下级与其他领域", () => {
    const f = setup();
    f.move(f.c2.id, f.c1.id, "before");
    expect(f.siblings(f.v1.id)).toEqual([f.c2.id, f.c1.id]);
    f.move(f.c2.id, f.c1.id, "after");
    expect(f.siblings(f.v1.id)).toEqual([f.c1.id, f.c2.id]);
    f.move(f.v2.id, f.v1.id, "before");
    expect(orderedBlueprint(f.nodes()).map((n) => n.id)).toEqual([
      f.section.id,
      f.v2.id,
      f.c3.id,
      f.v1.id,
      f.c1.id,
      f.s1.id,
      f.c2.id,
    ]);
    expect(f.nodes().find((n) => n.id === f.section.id)).toEqual(f.section);
  });

  it("章纲跨卷追加、跨归属前后插入和移回顶层，保留子树及正文关联", () => {
    const f = setup();
    const chapters = f.repo.getDetail(f.project.id).chapters;
    f.move(f.c1.id, f.v2.id, "inside");
    expect(f.siblings(f.v2.id)).toEqual([f.c3.id, f.c1.id]);
    expect(f.nodes().find((n) => n.id === f.c1.id)).toEqual({
      ...f.c1,
      parentId: f.v2.id,
    });
    expect(f.nodes().find((n) => n.id === f.s1.id)).toEqual(f.s1);
    f.move(f.c1.id, f.c2.id, "before");
    expect(f.siblings(f.v1.id)).toEqual([f.c1.id, f.c2.id]);
    f.move(f.c1.id, f.c3.id, "after");
    expect(f.siblings(f.v2.id)).toEqual([f.c3.id, f.c1.id]);
    f.move(f.c1.id, f.v2.id, "after");
    expect(f.siblings(null)).toEqual([f.v1.id, f.v2.id, f.c1.id]);
    expect(f.nodes().find((n) => n.id === f.c1.id)?.chapterId).toBe(
      f.chapter.id,
    );
    expect(f.repo.getDetail(f.project.id).chapters).toEqual(chapters);
  });

  it("场景可拖入空章纲、跨章排序并追加到末尾", () => {
    const f = setup();
    const s2 = node(f, "scene", "另一个场景", { parentId: f.c2.id });
    f.move(f.s1.id, s2.id, "before");
    expect(f.siblings(f.c2.id)).toEqual([f.s1.id, s2.id]);
    f.move(f.s1.id, f.c2.id, "inside");
    expect(f.siblings(f.c2.id)).toEqual([s2.id, f.s1.id]);
    f.move(f.s1.id, f.c3.id, "inside");
    expect(f.siblings(f.c3.id)).toEqual([f.s1.id]);
  });

  it("拒绝非法层级、自身下级、跨领域及不存在的节点，不写快照", () => {
    const f = setup(),
      original = f.nodes(),
      count = f.history().length;
    for (const [id, targetId, position] of [
      [f.v1.id, f.v2.id, "inside"],
      [f.c1.id, f.c3.id, "inside"],
      [f.s1.id, f.v2.id, "inside"],
      [f.s1.id, f.v1.id, "after"],
      [f.c1.id, f.s1.id, "before"],
      [f.v1.id, f.c1.id, "inside"],
      [f.section.id, f.v1.id, "after"],
      [f.v1.id, f.section.id, "before"],
      [randomUUID(), f.v1.id, "before"],
      [f.v1.id, randomUUID(), "after"],
    ] as const)
      expect(() => f.move(id, targetId, position)).toThrow();
    expect(f.nodes()).toEqual(original);
    expect(f.history()).toHaveLength(count);
  });

  it("无变化不创建快照，移动可通过领域版本恢复", () => {
    const f = setup(),
      count = f.history().length,
      original = f.nodes();
    f.move(f.c1.id, f.c1.id, "inside");
    f.move(f.c1.id, f.c2.id, "before");
    f.move(f.c2.id, f.v1.id, "inside");
    expect(f.history()).toHaveLength(count);
    f.move(f.c1.id, f.v2.id, "inside");
    expect(f.history()).toHaveLength(count + 1);
    f.api["outline:restore"]({
      projectId: f.project.id,
      id: f.history()[0].id,
    });
    expect(orderedBlueprint(f.nodes())).toEqual(orderedBlueprint(original));
  });

  it("自由探索不能移动大纲；事务失败回滚顺序与快照", () => {
    const f = setup(),
      original = f.nodes(),
      count = f.history().length;
    f.repo.updateProject(f.project.id, { mode: "explore" });
    expect(() => f.move(f.c1.id, f.v2.id, "inside")).toThrow("长篇");
    f.repo.updateProject(f.project.id, { mode: "novel" });
    const spy = vi.spyOn(f.repo, "updateProject").mockImplementation(() => {
      throw Error("模拟写入失败");
    });
    expect(() => f.move(f.c1.id, f.v2.id, "inside")).toThrow("模拟写入失败");
    spy.mockRestore();
    expect(f.nodes()).toEqual(original);
    expect(f.history()).toHaveLength(count);
  });

  it("重启数据库后保留顺序和跨卷归属", () => {
    const dir = mkdtempSync(join(tmpdir(), "outline-drag-"));
    try {
      const filename = join(dir, "story.db"),
        f = setup(filename);
      f.move(f.c1.id, f.v2.id, "inside");
      const expected = f.nodes();
      f.repo.close();
      const reopened = new StoryRepository(filename);
      try {
        expect(reopened.getProject(f.project.id).blueprint.nodes).toEqual(
          expected,
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
