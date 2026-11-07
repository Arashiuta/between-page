import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { StoryRepository } from "../src/main/database";
import {
  conversationHandlers,
  runCreationTask,
  conversationDetail,
} from "../src/main/conversations";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";
import type { ProgressEvent, TaskRequest } from "../src/shared/types";

let repo: StoryRepository;
beforeEach(() => {
  repo = new StoryRepository(":memory:");
  setActivePinia(createPinia());
});
afterEach(() => {
  repo.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function setup() {
  const project = repo.createProject({
    title: "故事",
    premise: "旅行",
    mode: "explore",
  });
  const handlers = conversationHandlers(repo);
  let progress = (_event: ProgressEvent) => {};
  let count = 0;
  const invoke = vi.fn(async (action: string, p: any) => {
    if (handlers[action]) return handlers[action](p);
    if (action === "project:get") return repo.getDetail(p);
    if (action === "project:update") {
      const { id, ...patch } = p;
      return repo.updateProject(id, patch);
    }
    if (action === "scratch:get") return repo.getSetting(`scratch.${p}`, null);
    if (action === "scratch:save") {
      repo.setSetting(`scratch.${p.projectId}`, p);
      return true;
    }
    if (action === "chapter:update") {
      const { id, ...patch } = p;
      return repo.updateChapter(id, patch);
    }
    if (action === "chapter:create") return repo.createChapter(p);
    if (action === "chapter:delete") return repo.deleteChapter(p.id);
    if (action === "ai:run")
      return runCreationTask(repo, p as TaskRequest, {
        model: "模拟模型",
        signal: new AbortController().signal,
        progress: (e) => progress(e),
        generate: async (_messages, delta) => {
          const text = `完整稿${++count}：${p.instruction}`;
          delta(text);
          return text;
        },
      });
    throw new Error(`未模拟 ${action}`);
  });
  vi.stubGlobal("window", {
    storybook: {
      invoke,
      onProgress: (fn: typeof progress) => {
        progress = fn;
        return () => {};
      },
      onClosing: () => () => {},
    },
  });
  const store = useWorkspace();
  store.initializeListeners();
  await store.openProject(project.id);
  return { project, store, invoke };
}
describe("多轮工作台状态", () => {
  it("选择任意版本继续，编辑、来源与选中版本在重新打开后恢复", async () => {
    const { project, store } = await setup();
    store.instruction = "第一轮";
    await store.runTask("chapter");
    await store.flush();
    const firstId = store.selectedTurnId;
    store.instruction = "第二轮";
    await store.runTask("chapter");
    await store.flush();
    store.instruction = "第三轮";
    await store.runTask("chapter");
    await store.flush();
    await store.selectVersion(firstId);
    store.output = "手工编辑第一版";
    store.scratch();
    await store.flush();
    store.instruction = "从第一版另写结尾";
    await store.runTask("chapter");
    await store.flush();
    expect(store.turns).toHaveLength(4);
    expect(store.selectedTurn?.parentTurnId).toBe(firstId);
    expect(store.selectedTurn?.history.at(-1)?.content).toBe("手工编辑第一版");
    const selectedId = store.selectedTurnId;
    await store.openProject(project.id);
    expect(store.selectedTurnId).toBe(selectedId);
    expect(store.output).toContain("从第一版另写结尾");
    await store.selectVersion(firstId);
    expect(store.output).toBe("手工编辑第一版");
    await store.flush();
  });
  it("切换工具或章节恢复对应对话，新对话、重命名与删除互不清空其他版本", async () => {
    const { project, store } = await setup();
    await store.runTask("chapter");
    await store.flush();
    const original = store.conversationId;
    store.taskKind = "brainstorm";
    await store.restoreConversation();
    expect(store.output).toBe("");
    await store.runTask("brainstorm");
    await store.flush();
    expect(store.conversationId).not.toBe(original);
    store.taskKind = "chapter";
    await store.restoreConversation();
    expect(store.conversationId).toBe(original);
    await store.newConversation();
    const newId = store.conversationId;
    await store.renameConversation("另一个方向");
    expect(store.activeConversation?.title).toBe("另一个方向");
    await store.runTask();
    await store.flush();
    await store.deleteConversation();
    expect(store.conversationId).toBe(original);
    expect(store.conversations.some((c) => c.id === newId)).toBe(false);
    expect(conversationDetail(repo, project.id, original).turns).toHaveLength(
      1,
    );
    await store.flush();
  });
  it("全文改写从旧版继续仍使用最初源文，并恢复原文变化保护依据", async () => {
    const { project, store } = await setup();
    store.editChapter({ document: textToDocument("最初原文") });
    store.writingScope = "document";
    store.outputMode = "rewrite";
    await store.runTask("revise");
    await store.flush();
    store.editChapter({ document: textToDocument("作者后来修改") });
    await store.flush();
    store.instruction = "再简练";
    await store.runTask("revise");
    await store.flush();
    expect(store.sourceContent).toBe("最初原文");
    expect(store.chapter?.content).toBe("作者后来修改");
    await store.openProject(project.id);
    expect(store.sourceContent).toBe("最初原文");
    expect(store.outputScope).toBe("document");
    expect(store.resultType).toBe("rewrite");
    await store.flush();
  });
  it("跨工具的新对话保留原对话的要求与手工稿，切换目标时也不串写输入", async () => {
    const { project, store } = await setup();
    store.instruction = "原始正文要求";
    await store.runTask("chapter");
    await store.flush();
    const original = store.conversationId;
    store.instruction = "原始正文要求";
    store.output = "作者修订的正文候选";
    store.scratch();
    store.taskKind = "brainstorm";
    store.instruction = "根据正文提出新的构思";
    store.scratch();
    await store.runTask("brainstorm", {
      instruction: store.instruction,
      workflowContext: store.output,
      newConversation: true,
    });
    await store.flush();
    expect(store.conversationId).not.toBe(original);
    expect(
      conversationDetail(repo, project.id, original).conversation
        .draftInstruction,
    ).toBe("原始正文要求");
    store.taskKind = "chapter";
    await store.restoreConversation();
    expect(store.instruction).toBe("原始正文要求");
    expect(store.output).toBe("作者修订的正文候选");
    store.chapterId = repo.createChapter(project.id).id;
    store.instruction = "另一章的要求";
    store.scratch();
    await store.flush();
    expect(
      conversationDetail(repo, project.id, original).conversation
        .draftInstruction,
    ).toBe("原始正文要求");
    await store.openConversation(original);
    expect(store.instruction).toBe("原始正文要求");
    await store.flush();
  });
  it("删除目标不会把清空后的工作台状态覆盖到历史版本", async () => {
    const { project, store } = await setup();
    await store.runTask("chapter");
    await store.flush();
    const c = store.conversationId,
      original = store.output,
      chapterId = store.chapterId;
    await store.deleteChapter(chapterId);
    await store.flush();
    const history = conversationDetail(repo, project.id, c);
    expect(history.turns[0].review.text).toBe(original);
    expect(history.invalidReason).toContain("已删除");
    await store.openConversation(c);
    expect(store.output).toBe(original);
    expect(store.conversationInvalidReason).toContain("已删除");
    await store.flush();
  });
});
