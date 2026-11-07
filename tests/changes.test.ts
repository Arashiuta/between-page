import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  fixture,
  request,
  proposal,
  settingResponse,
  node,
  run,
} from "./workbench-fixture";
import {
  applyChangeSet,
  getChangeSet,
  listChangeSets,
  saveChangeSet,
} from "../src/main/changes";
import { textToDocument, documentToText } from "../src/shared/document";
import { replaceSelection, appendDocument } from "../src/main/document-edit";
import { storySchema } from "../src/shared/editor-schema";
import type { ChangeSet, DocumentNode } from "../src/shared/types";
const adopt = (
  f: ReturnType<typeof fixture>,
  s: ChangeSet,
  ids = s.changes.map((c) => c.id),
) =>
  applyChangeSet(
    f.repo,
    f.project.id,
    s.id,
    s.changes
      .filter((c) => ids.includes(c.id))
      .map((c) => ({ id: c.id, after: c.after })),
  );
describe("唯一审核写入入口", () => {
  it.each(["explore", "novel"] as const)(
    "%s 完成设定、蓝图、开篇、续写、打磨、命名与记忆审核",
    async (mode) => {
      const f = fixture(mode);
      const initial = f.repo.getDetail(f.project.id);
      const settings = await proposal(
        f,
        request(f, "settings"),
        settingResponse("没有魔法"),
      );
      expect(f.repo.getProject(f.project.id).world).toBe("");
      adopt(f, settings);
      const blueprint = await proposal(
        f,
        request(f, "blueprint"),
        JSON.stringify({ items: [{ title: "方向", content: "跨过沙海" }] }),
      );
      adopt(f, blueprint);
      const opening = await proposal(f, request(f, "opening"), "阿禾推开门。");
      expect(f.repo.getChapter(f.chapter.id).content).toBe("");
      adopt(f, opening);
      const continuation = await proposal(
        f,
        request(f, "continue"),
        "门外是沙海。",
      );
      adopt(f, continuation);
      expect(f.repo.getChapter(f.chapter.id).content).toBe(
        "阿禾推开门。\n门外是沙海。",
      );
      const polish = await proposal(
        f,
        request(f, "polish", {
          selection: { from: 1, to: 3, text: "阿禾" },
          aspect: "expression",
        }),
        "少年",
      );
      adopt(f, polish);
      expect(f.repo.getChapter(f.chapter.id).content).toBe(
        "少年推开门。\n门外是沙海。",
      );
      const title = await proposal(f, request(f, "title"), '{"title":"门外"}');
      adopt(f, title);
      expect(f.repo.getChapter(f.chapter.id).title).toBe("门外");
      const accepted = f.repo.adoptChapter(f.chapter.id);
      const notes = await proposal(
        f,
        request(f, "notes"),
        '{"records":[{"kind":"fact","content":"门外是沙海。"}]}',
      );
      expect(f.repo.getDetail(f.project.id).memories).toHaveLength(0);
      adopt(f, notes);
      const memory = f.repo.getDetail(f.project.id).memories[0];
      expect(memory.revisionId).toBe(accepted.acceptedRevisionId);
      expect(memory.chapterId).toBe(f.chapter.id);
      expect(memory.manual).toBe(false);
      expect(f.repo.listRevisions(f.chapter.id).length).toBeGreaterThanOrEqual(
        5,
      );
      expect(
        f.repo.db
          .prepare(
            "SELECT key FROM settings WHERE key LIKE 'review.snapshot.%'",
          )
          .all(),
      ).toHaveLength(7);
      expect(initial.project.blueprint.nodes).toHaveLength(0);
    },
  );
  it("分项采用持久化，保留其他建议；已采用项不能再次采用", async () => {
    const f = fixture();
    const set = await proposal(
      f,
      request(f, "settings"),
      '{"changes":[{"type":"project","field":"world","content":"世界新规则"},{"type":"project","field":"style","content":"克制叙事"}]}',
    );
    adopt(f, set, [set.changes[0].id]);
    expect(getChangeSet(f.repo, f.project.id, set.id).status).toBe("partial");
    expect(() => adopt(f, set, [set.changes[0].id])).toThrow("已采用");
    adopt(f, set, [set.changes[1].id]);
    expect(getChangeSet(f.repo, f.project.id, set.id).status).toBe("applied");
  });
  it("新人物的多个分区可分项采用，不伪造既有资料", async () => {
    const f = fixture();
    const raw = JSON.stringify({
      changes: [
        {
          type: "card",
          kind: "character",
          name: "阿禾",
          field: "description",
          title: "",
          content: "修理师",
        },
        {
          type: "card",
          kind: "character",
          name: "阿禾",
          field: "section",
          title: "经历",
          content: "经历沙暴",
        },
      ],
    });
    const set = await proposal(f, request(f, "settings"), raw);
    adopt(f, set, [set.changes[0].id]);
    adopt(f, set, [set.changes[1].id]);
    const cards = f.repo.getDetail(f.project.id).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].sections[0].content).toBe("经历沙暴");
  });
  it("分项采用不能重新授权已被外部修改的剩余目标", async () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, { document: textToDocument("正文") });
    f.repo.adoptChapter(f.chapter.id);
    const set = await proposal(
      f,
      request(f, "notes"),
      '{"records":[{"kind":"fact","content":"事实一"},{"kind":"state","content":"状态二"}]}',
    );
    adopt(f, set, [set.changes[0].id]);
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("外部修改"),
    });
    expect(() => adopt(f, set, [set.changes[1].id])).toThrow("原目标已变化");
    expect(f.repo.getDetail(f.project.id).memories).toHaveLength(1);
  });
  it.each([
    "foundation",
    "target",
    "mode",
    "cross",
    "unfinished",
    "tampered",
  ] as const)("禁止 %s 建议写入", async (issue) => {
    const f = fixture();
    const set = await proposal(f, request(f, "opening"), "候选正文");
    if (issue === "foundation")
      f.repo.updateProject(f.project.id, { world: "规则变化" });
    if (issue === "target")
      f.repo.updateChapter(f.chapter.id, { title: "外部改名" });
    if (issue === "mode")
      f.repo.updateProject(f.project.id, { mode: "explore" });
    if (issue === "unfinished") {
      set.generationStatus = "stopped" as never;
      saveChangeSet(f.repo, set);
    }
    if (issue === "tampered") {
      set.kind = "brainstorm";
      saveChangeSet(f.repo, set);
    }
    const pid =
      issue === "cross"
        ? f.repo.createProject({ title: "别书", premise: "", mode: "novel" }).id
        : f.project.id;
    expect(() =>
      applyChangeSet(f.repo, pid, set.id, [
        { id: set.changes[0].id, after: "替换" },
      ]),
    ).toThrow();
    expect(f.repo.getChapter(f.chapter.id).content).toBe("");
  });
  it("不采用或关闭差异审核不修改故事；可编辑建议后采用", async () => {
    const f = fixture();
    const before = f.repo.getDetail(f.project.id);
    const set = await proposal(f, request(f, "opening"), "生成稿");
    expect(f.repo.getDetail(f.project.id)).toEqual(before);
    applyChangeSet(f.repo, f.project.id, set.id, [
      { id: set.changes[0].id, after: "作者编辑稿" },
    ]);
    expect(f.repo.getChapter(f.chapter.id).content).toBe("作者编辑稿");
  });
  it("目标节点的名称和正文都进入差异，可一并编辑采用", async () => {
    const f = fixture();
    const n = node(f, "synopsis", "原总纲");
    const set = await proposal(
      f,
      request(f, "blueprint", {
        target: { level: "synopsis", id: n.id, count: 1 },
      }),
      '{"items":[{"title":"新标题","content":"新总纲"}]}',
    );
    expect(set.changes[0].beforeTitle).toBe(n.title);
    applyChangeSet(f.repo, f.project.id, set.id, [
      { id: set.changes[0].id, after: "编辑后的总纲", title: "编辑后的标题" },
    ]);
    expect(f.repo.getProject(f.project.id).blueprint.nodes[0]).toMatchObject({
      title: "编辑后的标题",
      content: "编辑后的总纲",
    });
  });
  it("事务失败回滚目标、快照和采用状态", async () => {
    const f = fixture();
    const set = await proposal(f, request(f, "opening"), "生成稿");
    vi.spyOn(f.repo, "updateChapter").mockImplementation(() => {
      throw Error("磁盘失败");
    });
    expect(() => adopt(f, set)).toThrow("磁盘失败");
    expect(f.repo.getChapter(f.chapter.id).content).toBe("");
    expect(f.repo.listRevisions(f.chapter.id)).toHaveLength(0);
    expect(getChangeSet(f.repo, f.project.id, set.id).status).toBe("pending");
    expect(
      f.repo.db
        .prepare("SELECT key FROM settings WHERE key LIKE 'review.snapshot.%'")
        .all(),
    ).toHaveLength(0);
  });
  it("删除聊天后独立候选仍可审核采用", async () => {
    const f = fixture();
    const set = await proposal(f, request(f, "settings"), settingResponse());
    f.api["conversation:delete"]({
      projectId: f.project.id,
      id: set.conversationId,
    });
    adopt(f, set);
    expect(f.repo.getProject(f.project.id).world).toBe("新世界规则");
  });
  it("工具不能越界生成其他领域目标", async () => {
    const f = fixture();
    await expect(
      proposal(
        f,
        request(f, "settings"),
        '{"items":[{"title":"蓝图","content":"越界"}]}',
      ),
    ).rejects.toThrow();
    await expect(
      proposal(f, request(f, "blueprint"), settingResponse()),
    ).rejects.toThrow();
    expect(listChangeSets(f.repo, f.project.id)).toHaveLength(0);
  });
  it("记忆仅基于采用版本，后来的草稿不会混入事实", async () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("信在抽屉里。"),
    });
    const adopted = f.repo.adoptChapter(f.chapter.id);
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("尚未采用：信被烧毁。"),
    });
    const set = await proposal(
      f,
      request(f, "notes"),
      '{"records":[{"kind":"fact","content":"信在抽屉里。"}]}',
    );
    const turn = JSON.parse(
      (
        f.repo.db
          .prepare("SELECT payload FROM creation_turns WHERE id = ?")
          .get(set.turnId) as { payload: string }
      ).payload,
    );
    expect(JSON.stringify(turn.sourceSnapshot)).toContain("信在抽屉里");
    expect(JSON.stringify(turn.sourceSnapshot)).not.toContain("尚未采用");
    f.repo.adoptChapter(f.chapter.id);
    expect(() => adopt(f, set)).toThrow();
    expect(adopted.acceptedRevisionId).toBeTruthy();
  });
});
describe("按编辑器位置变更文段", () => {
  const document: DocumentNode = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "保留标题" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "相同文段，" },
          { type: "text", text: "粗体保留", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "相同文段，结尾。",
            marks: [{ type: "italic" }],
          },
        ],
      },
    ],
  };
  it("重复文本只替换明确选中的第二处，保留范围外格式", () => {
    const pm = storySchema.nodeFromJSON(document);
    let from = 0;
    pm.descendants((n, pos) => {
      if (n.isText && n.text?.startsWith("相同文段，结尾")) from = pos;
    });
    const s = { from, to: from + 4, text: "相同文段" };
    const next = replaceSelection(document, s, "指定改稿");
    expect(next.content![0]).toEqual(pm.toJSON().content[0]);
    expect(next.content![1]).toEqual(pm.toJSON().content[1]);
    expect(documentToText(next)).toContain("指定改稿，结尾。");
    expect(documentToText(next)).toContain("相同文段，粗体保留");
  });
  it("跨多个段落的选区支持中文标点，范围外节点不变", () => {
    const doc = textToDocument("首段，保留。\n中段，替换。\n尾段，保留。"),
      pm = storySchema.nodeFromJSON(doc);
    const s = {
      from: 5,
      to: pm.child(0).nodeSize + 1 + 3,
      text: pm.textBetween(5, pm.child(0).nodeSize + 1 + 3, "\n"),
    };
    const next = replaceSelection(doc, s, "新句。\n另一句！");
    expect(documentToText(next)).toBe(
      "首段，保新句。\n另一句！替换。\n尾段，保留。",
    );
    expect(next.content!.at(-1)).toEqual(pm.toJSON().content.at(-1));
  });
  it("选区文字不匹配或位置越界时拒绝", () => {
    expect(() =>
      replaceSelection(document, { from: 1, to: 4, text: "错误" }, "新"),
    ).toThrow("已变化");
    expect(() =>
      replaceSelection(document, { from: 1, to: 9999, text: "错误" }, "新"),
    ).toThrow("位置无效");
  });
  it("追加不会替换已有文本与格式", () => {
    const next = appendDocument(document, "新增末段。");
    expect(next.content!.slice(0, -1)).toEqual(
      storySchema.nodeFromJSON(document).toJSON().content,
    );
    expect(documentToText(next)).toContain("新增末段。");
  });
});
