import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StoryRepository } from "../src/main/database";
import {
  createConversation,
  conversationDetail,
  conversationHandlers,
  listConversations,
  prepareConversationTask,
  runCreationTask,
  saveTurnReview,
  applyConversationPlanning,
  applyConversationMemory,
  applyConversationDevelopment,
  synchronizeCandidateEdits,
  undoConversationDevelopment,
} from "../src/main/conversations";
import {
  conversationTarget,
  type CreationConversation,
} from "../src/shared/conversations";
import { textToDocument } from "../src/shared/document";
import { savePlanning } from "../src/main/planning";
import type { TaskRequest, ProgressEvent } from "../src/shared/types";

const repos: StoryRepository[] = [],
  folders: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(mode: "explore" | "novel" = "explore", filename = ":memory:") {
  const repo = new StoryRepository(filename);
  repos.push(repo);
  const project = repo.createProject({
    title: "多轮测试",
    premise: "沿沙海寻找故乡",
    mode,
  });
  const chapter = repo.getDetail(project.id).chapters[0];
  const request: TaskRequest = {
    requestId: randomUUID(),
    projectId: project.id,
    chapterId: chapter.id,
    kind: "chapter",
    instruction: "首轮要求：保留秘密",
  };
  return { repo, project, chapter, request };
}
function conversation(repo: StoryRepository, request: TaskRequest) {
  const c = createConversation(
    repo,
    request.projectId,
    conversationTarget(request),
  );
  return { c, request: { ...request, conversationId: c.id } };
}
async function run(repo: StoryRepository, request: TaskRequest, text: string) {
  return runCreationTask(
    repo,
    { ...request, requestId: randomUUID() },
    {
      model: "mock",
      signal: new AbortController().signal,
      generate: async (_messages, delta) => {
        delta(text);
        return text;
      },
      progress: () => {},
    },
  );
}
describe("创作对话版本", () => {
  it("三轮后从第一版分支，历史仅含祖先，手改父稿不改变已生成子版本的依据", async () => {
    const f = setup(),
      { c, request } = conversation(f.repo, f.request);
    const first = await run(f.repo, request, "第一稿的风沙");
    const second = await run(
      f.repo,
      { ...request, instruction: "加入向导", parentTurnId: first.turnId },
      "第二稿向导",
    );
    await run(
      f.repo,
      { ...request, instruction: "加入驿站", parentTurnId: second.turnId },
      "第三稿驿站",
    );
    const original = conversationDetail(f.repo, f.project.id, c.id).turns[0];
    saveTurnReview(f.repo, f.project.id, original.id, {
      ...original.review,
      text: "作者手改第一稿",
    });
    const branch = {
      ...request,
      instruction: "换一个结尾",
      parentTurnId: first.turnId,
    };
    const built = prepareConversationTask(f.repo, branch);
    expect(built.built.messages.map((m) => m.content).join("\n")).toContain(
      "作者手改第一稿",
    );
    expect(built.built.messages.map((m) => m.content).join("\n")).not.toContain(
      "第二稿向导",
    );
    await run(f.repo, branch, "分支第四稿");
    const turns = conversationDetail(f.repo, f.project.id, c.id).turns;
    expect(turns.map((t) => t.number)).toEqual([1, 2, 3, 4]);
    expect(turns[3].parentTurnId).toBe(first.turnId);
    expect(turns[1].history.at(-1)?.content).toBe("第一稿的风沙");
    expect(turns[3].history.at(-1)?.content).toBe("作者手改第一稿");
  });
  it("跨故事、跨会话父版本及改变工具或范围均被拒绝", async () => {
    const f = setup(),
      a = conversation(f.repo, f.request),
      b = conversation(f.repo, f.request);
    const first = await run(f.repo, a.request, "草稿");
    expect(() =>
      prepareConversationTask(f.repo, {
        ...b.request,
        parentTurnId: first.turnId,
      }),
    ).toThrow("父版本");
    expect(() =>
      prepareConversationTask(f.repo, { ...a.request, kind: "opening" }),
    ).toThrow("工具或目标");
    const other = f.repo.createProject({
      title: "其他故事",
      premise: "",
      mode: "explore",
    });
    expect(() =>
      prepareConversationTask(f.repo, { ...a.request, projectId: other.id }),
    ).toThrow("不属于");
    expect(() =>
      createConversation(f.repo, other.id, conversationTarget(f.request)),
    ).toThrow("不属于");
  });
  it("历史预算保留首轮要求、完整所选稿与本轮要求，整轮省略旧答复", async () => {
    const f = setup(),
      { request } = conversation(f.repo, f.request);
    const first = await run(f.repo, request, "旧稿" + "甲".repeat(40_000));
    const second = await run(
      f.repo,
      { ...request, instruction: "第二轮要求", parentTurnId: first.turnId },
      "所选稿" + "乙".repeat(40_000),
    );
    const built = prepareConversationTask(f.repo, {
      ...request,
      parentTurnId: second.turnId,
      instruction: "本轮要求",
    });
    expect(built.omittedTurns).toBeGreaterThan(0);
    expect(built.history[0].content).toContain("首轮要求");
    expect(built.history.at(-1)?.content).toBe("所选稿" + "乙".repeat(40_000));
    expect(built.history.some((m) => m.content.includes("旧稿"))).toBe(false);
    const long = await run(f.repo, request, "丙".repeat(60_001));
    expect(() =>
      prepareConversationTask(f.repo, {
        ...request,
        parentTurnId: long.turnId,
      }),
    ).toThrow("60,000");
  });
  it("改写的多轮版本保留首轮全文和选区，即使正文后续已修改", async () => {
    const f = setup();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("原始全文"),
    });
    const range = { text: "原始", from: 1, to: 3 };
    const { c, request } = conversation(f.repo, {
      ...f.request,
      kind: "revise",
      writingScope: "selection",
      outputMode: "rewrite",
      selection: range.text,
      selectionRange: range,
    });
    const first = await run(f.repo, request, "首轮改写");
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("后续手改全文"),
    });
    const next = {
      ...request,
      parentTurnId: first.turnId,
      instruction: "更简练",
    };
    expect(
      prepareConversationTask(f.repo, next).built.messages[1].content,
    ).toContain("原始全文");
    await run(f.repo, next, "第二轮改写");
    expect(
      conversationDetail(f.repo, f.project.id, c.id).turns.every(
        (t) => t.sourceContent === "原始全文" && t.selection?.from === 1,
      ),
    ).toBe(true);
  });
  it("正文每轮记录当时的正文快照，历史超限省略后仍可重新纳入完整祖先问答", async () => {
    const f = setup(),
      { c, request } = conversation(f.repo, f.request);
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("初始正文"),
    });
    const first = await run(f.repo, request, "首稿" + "甲".repeat(20_000));
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("作者已更新正文"),
    });
    const second = await run(
      f.repo,
      { ...request, parentTurnId: first.turnId, instruction: "第二轮" },
      "二稿" + "乙".repeat(20_000),
    );
    const third = await run(
      f.repo,
      { ...request, parentTurnId: second.turnId, instruction: "第三轮" },
      "丙".repeat(50_000),
    );
    const turns = conversationDetail(f.repo, f.project.id, c.id).turns;
    expect(turns[0].sourceContent).toBe("初始正文");
    expect(turns[1].sourceContent).toContain("首稿");
    saveTurnReview(f.repo, f.project.id, second.turnId!, {
      ...turns[1].review,
      text: "后来编辑的二稿",
    });
    const fourth = await run(
      f.repo,
      { ...request, parentTurnId: third.turnId },
      "丁".repeat(15_000),
    );
    const fourthTurn = conversationDetail(f.repo, f.project.id, c.id).turns[3];
    expect(fourthTurn.history.some((m) => m.content.startsWith("首稿"))).toBe(
      false,
    );
    expect(fourthTurn.history.some((m) => m.content.startsWith("二稿"))).toBe(
      false,
    );
    const fifth = prepareConversationTask(f.repo, {
      ...request,
      parentTurnId: fourth.turnId,
    });
    expect(fifth.omittedTurns).toBeGreaterThan(0);
    expect(fifth.history.at(-1)?.content).toBe("丁".repeat(15_000));
    expect(fifth.history.some((m) => m.content.startsWith("首稿"))).toBe(false);
    expect(fifth.history.some((m) => m.content.startsWith("二稿"))).toBe(false);
    expect(
      fifth.history.some((m) => m.content.includes("后来编辑的二稿")),
    ).toBe(false);
  });
  it("停止与解析失败保留部分响应，进度包含版本标识，旧版可继续采用", async () => {
    const f = setup(),
      { c, request } = conversation(f.repo, f.request);
    await run(f.repo, request, "可采用旧稿");
    const controller = new AbortController(),
      events: ProgressEvent[] = [];
    await expect(
      runCreationTask(f.repo, request, {
        model: "mock",
        signal: controller.signal,
        progress: (e) => events.push(e),
        generate: async (_m, delta) => {
          delta("停止前收到");
          controller.abort();
          return "停止前收到";
        },
      }),
    ).rejects.toThrow("停止");
    const turns = conversationDetail(f.repo, f.project.id, c.id).turns;
    expect(turns[0].status).toBe("complete");
    expect(turns[0].review.text).toBe("可采用旧稿");
    expect(turns[1].status).toBe("stopped");
    expect(turns[1].rawResponse).toBe("停止前收到");
    expect(events[0].turnId).toBe(turns[1].id);
    expect(() =>
      conversationHandlers(f.repo)["conversation:applied"]({
        projectId: f.project.id,
        id: turns[1].id,
        label: "写入",
      }),
    ).toThrow("未完成");
    const plan = conversation(f.repo, {
      ...f.request,
      kind: "outline",
      planningTarget: { level: "synopsis" },
    });
    await expect(run(f.repo, plan.request, "错误 JSON")).rejects.toThrow();
    expect(
      conversationDetail(f.repo, f.project.id, plan.c.id).turns[0],
    ).toMatchObject({ status: "error", rawResponse: "错误 JSON" });
  });
  it("生成结果保存失败不损坏已经提交的版本", async () => {
    const f = setup(),
      { c, request } = conversation(f.repo, f.request);
    await run(f.repo, request, "旧稿");
    f.repo.db.exec(
      "CREATE TRIGGER fail_creation_save BEFORE UPDATE ON creation_turns WHEN json_extract(NEW.payload, '$.status') = 'complete' BEGIN SELECT RAISE(FAIL, '模拟磁盘写入失败'); END",
    );
    await expect(run(f.repo, request, "新稿")).rejects.toThrow("写入失败");
    expect(
      conversationDetail(f.repo, f.project.id, c.id).turns[0],
    ).toMatchObject({ status: "complete", review: { text: "旧稿" } });
  });
  it("规划可选择旧轮次逐项采用，其他轮次的过期指纹不可更新绕过", async () => {
    const f = setup("novel"),
      { c, request } = conversation(f.repo, {
        ...f.request,
        kind: "outline",
        planningTarget: { level: "chapter", count: 2 },
      });
    const first = await run(
      f.repo,
      request,
      JSON.stringify({
        items: [
          { title: "旧版一", content: "旧版章纲一" },
          { title: "旧版二", content: "旧版章纲二" },
        ],
      }),
    );
    const second = await run(
      f.repo,
      { ...request, parentTurnId: first.turnId },
      JSON.stringify({ items: [{ title: "新版", content: "新版章纲" }] }),
    );
    const turns = conversationDetail(f.repo, f.project.id, c.id).turns;
    const id = turns[0].review.planningDraft!.items[0].id;
    applyConversationPlanning(f.repo, f.project.id, first.turnId!, [id]);
    const remaining = conversationDetail(f.repo, f.project.id, c.id).turns[0];
    expect(remaining.review.planningDraft?.appliedIds).toHaveLength(1);
    applyConversationPlanning(f.repo, f.project.id, first.turnId!, [
      remaining.review.planningDraft!.items[1].id,
    ]);
    expect(() =>
      applyConversationPlanning(f.repo, f.project.id, second.turnId!, [
        turns[1].review.planningDraft!.items[0].id,
      ]),
    ).toThrow("规划已变化");
    expect(() =>
      saveTurnReview(f.repo, f.project.id, second.turnId!, {
        ...turns[1].review,
        planningDraft: {
          ...turns[1].review.planningDraft!,
          base: "a".repeat(64),
        },
      }),
    ).toThrow("指纹");
  });
  it("设定候选与轮次审核同步，采用所选轮次并保留审核进度", async () => {
    const f = setup(),
      { c, request } = conversation(f.repo, { ...f.request, kind: "develop" });
    const result = await run(
      f.repo,
      request,
      JSON.stringify({
        summary: "下一站",
        changes: [
          {
            target: "blueprint",
            title: "近期安排",
            content: "前往盐湖",
            basis: "proposal",
            mode: "append",
            sources: [],
          },
        ],
        warnings: [],
      }),
    );
    const turn = conversationDetail(f.repo, f.project.id, c.id).turns[0];
    turn.review.developmentDraft!.changes[0].content = "先去补给站";
    saveTurnReview(f.repo, f.project.id, turn.id, turn.review);
    expect(
      f.repo.getProject(f.project.id).blueprintCandidates[0].development
        ?.changes[0].content,
    ).toBe("先去补给站");
    const applied = applyConversationDevelopment(
      f.repo,
      f.project.id,
      result.turnId!,
      [turn.review.developmentDraft!.changes[0].id],
    );
    expect(
      conversationDetail(f.repo, f.project.id, c.id).turns[0].review
        .developmentDraft?.appliedIds,
    ).toHaveLength(1);
    expect(
      f.repo
        .getProject(f.project.id)
        .blueprintSections.some((s) => s.content.includes("补给站")),
    ).toBe(true);
    undoConversationDevelopment(f.repo, f.project.id, applied.undoId);
    expect(
      conversationDetail(f.repo, f.project.id, c.id).turns[0].review
        .developmentDraft?.appliedIds,
    ).toEqual([]);
    const candidates = f.repo.getProject(f.project.id).blueprintCandidates;
    candidates[0].development!.changes[0].content = "从蓝图候选中编辑的版本";
    synchronizeCandidateEdits(f.repo, f.project.id, candidates);
    expect(
      conversationDetail(f.repo, f.project.id, c.id).turns[0].review
        .developmentDraft?.changes[0].content,
    ).toBe("从蓝图候选中编辑的版本");
  });
  it("记忆多轮固定采用来源，重新采用章节后旧版不能写入", async () => {
    const f = setup();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("旅人抵达驿站"),
    });
    f.repo.adoptChapter(f.chapter.id);
    const { c, request } = conversation(f.repo, {
      ...f.request,
      kind: "notes",
    });
    const first = await run(
      f.repo,
      request,
      JSON.stringify({ records: [{ kind: "fact", content: "旅人抵达驿站" }] }),
    );
    await run(
      f.repo,
      { ...request, parentTurnId: first.turnId },
      JSON.stringify({ records: [{ kind: "state", content: "旅人在驿站" }] }),
    );
    expect(f.repo.getDetail(f.project.id).memories).toHaveLength(0);
    applyConversationMemory(f.repo, f.project.id, first.turnId!);
    expect(f.repo.getDetail(f.project.id).memories).toHaveLength(1);
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("旅人离开驿站"),
    });
    f.repo.adoptChapter(f.chapter.id);
    expect(() =>
      prepareConversationTask(f.repo, {
        ...request,
        parentTurnId: first.turnId,
      }),
    ).toThrow("来源采用版本已变化");
    expect(() =>
      applyConversationMemory(
        f.repo,
        f.project.id,
        conversationDetail(f.repo, f.project.id, c.id).turns[1].id,
      ),
    ).toThrow("来源采用版本已变化");
  });
  it("旧草稿只导入一次，删除目标后仍可查看并标记失效，删除故事清理全部对话", async () => {
    const f = setup();
    f.repo.setSetting(`scratch.${f.project.id}`, {
      kind: "chapter",
      chapterId: f.chapter.id,
      output: "旧工作台稿",
      instruction: "旧要求",
      outputMode: "rewrite",
    });
    expect(listConversations(f.repo, f.project.id)).toHaveLength(1);
    const c = listConversations(f.repo, f.project.id)[0];
    expect(c.target.outputMode).toBeUndefined();
    f.repo.deleteChapter(f.chapter.id);
    expect(conversationDetail(f.repo, f.project.id, c.id)).toMatchObject({
      invalidReason: expect.stringContaining("已删除"),
      turns: [{ review: { text: "旧工作台稿" } }],
    });
    f.repo.updateProject(f.project.id, { archived: true });
    f.repo.deleteArchivedProject(f.project.id);
    expect(
      f.repo.db.prepare("SELECT id FROM creation_conversations").all(),
    ).toEqual([]);
    expect(f.repo.db.prepare("SELECT id FROM creation_turns").all()).toEqual(
      [],
    );
  });
  it("重开数据库将未结束轮次标为中断，备份保留完整对话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "between-pages-conversations-"));
    folders.push(dir);
    const filename = join(dir, "test.sqlite"),
      f = setup("explore", filename),
      { c, request } = conversation(f.repo, f.request);
    await run(f.repo, request, "已保存");
    const detail = conversationDetail(f.repo, f.project.id, c.id),
      turn = detail.turns[0];
    turn.status = "generating";
    turn.review.text = "中断前收到";
    f.repo.db
      .prepare("UPDATE creation_turns SET payload = ? WHERE id = ?")
      .run(JSON.stringify(turn), turn.id);
    const backup = join(dir, "backup.sqlite");
    await f.repo.db.backup(backup);
    const restored = new StoryRepository(backup);
    repos.push(restored);
    expect(
      conversationDetail(restored, f.project.id, c.id).turns[0],
    ).toMatchObject({ status: "interrupted", review: { text: "中断前收到" } });
  });
});
