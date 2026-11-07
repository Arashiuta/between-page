import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixture,
  request,
  run,
  proposal,
  options,
  settingResponse,
  allText,
} from "./workbench-fixture";
import {
  prepareTaskPreview,
  conversationDetail,
  listConversations,
  runCreationTask,
  validateRequest,
} from "../src/main/conversations";
import { getChangeSet, listChangeSets } from "../src/main/changes";
import { textToDocument } from "../src/shared/document";
import { StoryRepository } from "../src/main/database";
describe("对话、只读工具与来源", () => {
  it("生成中的对话不能从主进程删除，停止后可删除", async () => {
    const f = fixture(),
      controller = new AbortController();
    await expect(
      run(f, request(f), "", {
        signal: controller.signal,
        generate: async () => {
          const conversation = listConversations(f.repo, f.project.id)[0];
          expect(() =>
            f.api["conversation:delete"]({
              projectId: f.project.id,
              id: conversation.id,
            }),
          ).toThrow("先停止");
          controller.abort();
          throw Error("停止");
        },
      }),
    ).rejects.toThrow();
    const conversation = listConversations(f.repo, f.project.id)[0];
    expect(
      f.api["conversation:delete"]({
        projectId: f.project.id,
        id: conversation.id,
      }),
    ).toBe(true);
    expect(listConversations(f.repo, f.project.id)).toEqual([]);
  });
  it.each(["explore", "novel"] as const)(
    "%s 脑暴自然多轮问答，只保存聊天",
    async (mode) => {
      const f = fixture(mode),
        before = f.repo.getDetail(f.project.id);
      const first = await run(f, request(f), "你想让谁先发现这封信？");
      let actual = "";
      await run(
        f,
        request(f, "brainstorm", {
          instruction: "让阿禾发现",
          conversationId: first.conversationId,
          parentTurnId: first.turnId,
        }),
        "可以让他在修理时找到。",
        {
          generate: async (m) => {
            actual = JSON.stringify(m);
            return "可以让他在修理时找到。";
          },
        },
      );
      expect(actual).toContain("你想让谁先发现");
      expect(actual).not.toContain("输出目标的完整新稿");
      expect(listChangeSets(f.repo, f.project.id)).toEqual([]);
      expect(f.repo.getDetail(f.project.id)).toEqual(before);
      expect(
        conversationDetail(f.repo, f.project.id, first.conversationId).turns,
      ).toHaveLength(2);
    },
  );
  it("分支只携带选择的祖先，不携带兄弟版本", async () => {
    const f = fixture();
    const a = await run(f, request(f), "祖先答案");
    const b = await run(
      f,
      request(f, "brainstorm", {
        conversationId: a.conversationId,
        parentTurnId: a.turnId,
      }),
      "兄弟答案",
    );
    let messages = "";
    await run(
      f,
      request(f, "brainstorm", {
        conversationId: a.conversationId,
        parentTurnId: a.turnId,
      }),
      "另一个分支",
      {
        generate: async (m) => {
          messages = JSON.stringify(m);
          return "另一个分支";
        },
      },
    );
    expect(messages).toContain("祖先答案");
    expect(messages).not.toContain("兄弟答案");
    expect(
      conversationDetail(f.repo, f.project.id, b.conversationId).turns,
    ).toHaveLength(3);
  });
  it.each(["mode", "tool", "target", "cross"] as const)(
    "禁止 %s 串用对话结果",
    async (type) => {
      const f = fixture();
      const a = await run(f, request(f, "opening"), "开篇正文");
      let next = request(f, "opening", {
        conversationId: a.conversationId,
        parentTurnId: a.turnId,
      });
      if (type === "mode") {
        f.repo.updateProject(f.project.id, { mode: "explore" });
        next = { ...next, mode: "explore" };
      }
      if (type === "tool")
        next = request(f, "title", {
          conversationId: a.conversationId,
          parentTurnId: a.turnId,
        });
      if (type === "target")
        next = {
          ...next,
          chapterId: f.repo.createChapter(f.project.id).id,
        } as typeof next;
      if (type === "cross")
        next = {
          ...next,
          projectId: f.repo.createProject({
            title: "别书",
            premise: "",
            mode: "novel",
          }).id,
        } as typeof next;
      await expect(run(f, next, "不应运行")).rejects.toThrow();
    },
  );
  it("生成中断和模型错误只保留不可采用的内容", async () => {
    const f = fixture(),
      controller = new AbortController();
    await expect(
      run(f, request(f, "opening"), "", {
        signal: controller.signal,
        generate: async (_m, delta) => {
          delta("部分正文");
          controller.abort();
          return "部分正文";
        },
      }),
    ).rejects.toThrow("停止");
    const c = listConversations(f.repo, f.project.id)[0],
      t = conversationDetail(f.repo, f.project.id, c.id).turns[0];
    expect(t.status).toBe("stopped");
    expect(t.rawResponse).toBe("部分正文");
    expect(t.result).toBeNull();
    expect(t.sourceSnapshot).toHaveLength(1);
    expect(listChangeSets(f.repo, f.project.id)).toEqual([]);
  });
  it("生成时资料改变，返回结果也不能覆盖新资料", async () => {
    const f = fixture();
    const v = await run(f, request(f, "settings"), settingResponse(), {
      generate: async () => {
        f.repo.updateProject(f.project.id, { world: "后来的编辑" });
        return settingResponse();
      },
    });
    expect(v.result.type).toBe("changes");
    if (v.result.type !== "changes") return;
    const s = getChangeSet(f.repo, f.project.id, v.result.changeSetId);
    expect(() =>
      f.api["changes:apply"]({
        projectId: f.project.id,
        id: s.id,
        changes: s.changes.map((c) => ({ id: c.id, after: c.after })),
      }),
    ).toThrow("基础资料已变化");
  });
  it("候选不裁掉第 101 项，并可按 ID 独立删除", async () => {
    const f = fixture();
    for (let i = 0; i < 101; i++)
      await proposal(f, request(f, "settings"), settingResponse("候选" + i));
    expect(listChangeSets(f.repo, f.project.id)).toHaveLength(101);
    const first = listChangeSets(f.repo, f.project.id).at(-1)!;
    f.api["changes:delete"]({ projectId: f.project.id, id: first.id });
    expect(listChangeSets(f.repo, f.project.id)).toHaveLength(100);
  });
  it("重启保留结果、来源、模式隔离；生成中的轮次转为中断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-rebuild-"));
    const file = join(dir, "story.sqlite");
    const f = fixture("novel", file);
    try {
      const v = await run(f, request(f), "长篇聊天");
      f.repo.updateProject(f.project.id, { mode: "explore" });
      await run(f, request(f), "自由聊天");
      const turn = conversationDetail(f.repo, f.project.id, v.conversationId)
        .turns[0];
      turn.status = "generating";
      f.repo.db
        .prepare("UPDATE creation_turns SET payload = ? WHERE id = ?")
        .run(JSON.stringify(turn), turn.id);
      f.repo.close();
      const reopened = new StoryRepository(file);
      try {
        expect(
          listConversations(reopened, f.project.id)
            .map((c) => c.mode)
            .sort(),
        ).toEqual(["explore", "novel"]);
        const t = conversationDetail(reopened, f.project.id, v.conversationId)
          .turns[0];
        expect(t.status).toBe("interrupted");
        expect(t.sourceSnapshot[0].messages.length).toBeGreaterThan(0);
      } finally {
        reopened.close();
      }
    } finally {
      if (f.repo.db.open) f.repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("分批故事检查", () => {
  function setup() {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("阿禾将信藏进抽屉。"),
    });
    for (const text of ["乙找到了信。", "阿禾说自己没见过信。"]) {
      const c = f.repo.createChapter(f.project.id);
      f.repo.updateChapter(c.id, { document: textToDocument(text) });
    }
    return f;
  }
  it.each(["explore", "novel"] as const)(
    "%s 全书覆盖每一章，跨章对照并只保存报告",
    async (mode) => {
      const f = setup();
      f.repo.updateProject(f.project.id, { mode });
      const r = request(f, "check", {
          scope: { type: "book" },
          aspect: "continuity",
        }),
        before = f.repo.getDetail(f.project.id),
        preview = await prepareTaskPreview(f.repo, r, options),
        calls: string[] = [];
      const result = await run(f, r, "", {
        generate: async (messages) => {
          calls.push(JSON.stringify(messages));
          return '{"findings":[]}';
        },
      });
      expect(calls).toHaveLength(6);
      expect(preview.batches).toHaveLength(6);
      expect(calls).toEqual(
        preview.batches!.map((b) => JSON.stringify(b.preview!.messages)),
      );
      expect(result.result.type).toBe("report");
      if (result.result.type !== "report") return;
      expect(result.result.report.batches).toHaveLength(3);
      expect(result.result.report.comparisons).toHaveLength(3);
      expect(result.result.report.complete).toBe(true);
      expect(f.repo.getDetail(f.project.id)).toEqual(before);
      expect(listChangeSets(f.repo, f.project.id)).toEqual([]);
    },
  );
  it("指定章节和节奏方向只检查所选章节，保留准确位置与依据", async () => {
    const f = setup(),
      c = f.repo.getDetail(f.project.id).chapters[1];
    const out = await run(
      f,
      request(f, "check", {
        scope: { type: "chapters", chapterIds: [c.id] },
        aspect: "pacing",
      }),
      "",
      {
        generate: async () =>
          JSON.stringify({
            findings: [
              {
                category: "suggestion",
                chapterId: c.id,
                quote: "乙找到了信。",
                reference: "当前章场景推进",
                impact: "发现过程较突然",
                suggestion: "补充发现动作",
              },
            ],
          }),
      },
    );
    if (out.result.type !== "report") throw Error();
    expect(out.result.report.batches.map((b) => b.chapterId)).toEqual([c.id]);
    expect(out.result.report.comparisons).toEqual([]);
    expect(out.result.text).toContain("发现过程较突然");
  });
  it("单批失败和跨章失败明确标为部分完成", async () => {
    const f = setup();
    let n = 0;
    const out = await run(
      f,
      request(f, "check", { scope: { type: "book" } }),
      "",
      {
        generate: async () => {
          n++;
          if (n === 2 || n === 5) throw Error("模拟超时");
          return '{"findings":[]}';
        },
      },
    );
    if (out.result.type !== "report") throw Error();
    expect(out.result.report.complete).toBe(false);
    expect(out.result.report.batches[1].status).toBe("failed");
    expect(
      out.result.report.comparisons.filter((c) => c.status === "failed"),
    ).toHaveLength(1);
    expect(out.result.text).toContain("部分完成");
    expect(out.result.text).toContain("跨章检查未完成");
  });
  it("基础资料或参考图不满足能力要求时，所有检查都不调用模型", async () => {
    const f = setup();
    f.repo.updateProject(f.project.id, { world: "很长规则".repeat(30000) });
    const generate = vi.fn(async () => '{"findings":[]}');
    await expect(
      run(f, request(f, "check", { scope: { type: "book" } }), "", {
        generate,
        capabilities: {
          vision: false,
          contextTokens: 16000,
          outputTokens: 1000,
        },
      }),
    ).rejects.toThrow("上下文预算");
    expect(generate).not.toHaveBeenCalled();
  });
  it("超限章节保留失败覆盖，其他可处理章节照常检查", async () => {
    const f = setup();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("正文超限".repeat(20000)),
    });
    let calls = 0;
    const result = await run(
      f,
      request(f, "check", { scope: { type: "book" }, aspect: "pacing" }),
      "",
      {
        capabilities: {
          vision: true,
          contextTokens: 16000,
          outputTokens: 1000,
        },
        generate: async () => {
          calls++;
          return '{"findings":[]}';
        },
      },
    );
    if (result.result.type !== "report") throw Error();
    expect(calls).toBe(2);
    expect(result.result.report.complete).toBe(false);
    expect(result.result.report.batches[0].error).toContain("上下文预算");
  });
  it("伪造原文引用不能成为成功检查报告", async () => {
    const f = setup();
    const out = await run(f, request(f, "check"), "", {
      generate: async () =>
        JSON.stringify({
          findings: [
            {
              category: "conflict",
              chapterId: f.chapter.id,
              quote: "原文不存在",
              reference: "假依据",
              impact: "影响",
              suggestion: "建议",
            },
          ],
        }),
    });
    if (out.result.type !== "report") throw Error();
    expect(out.result.report.complete).toBe(false);
    expect(out.result.report.batches[0].findings).toEqual([]);
  });
});
