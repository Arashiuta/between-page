import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { StoryRepository } from "../src/main/database";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";
import { createFragment } from "../src/main/writing";
import {
  removePlanning,
  savePlanning,
  planningBase,
} from "../src/main/planning";
import type { ImageAsset, WorkflowRun } from "../src/shared/types";

const repositories: StoryRepository[] = [];
function setup() {
  const repo = new StoryRepository(":memory:");
  repositories.push(repo);
  const project = repo.createProject({
    title: "删除章节测试",
    premise: "",
    mode: "novel",
  });
  const first = repo.getDetail(project.id).chapters[0];
  const second = repo.createChapter(project.id);
  const third = repo.createChapter(project.id);
  return { repo, project, first, second, third };
}
function adopt(repo: StoryRepository, id: string, content: string) {
  repo.updateChapter(id, { document: textToDocument(content) });
  const chapter = repo.adoptChapter(id);
  repo.saveGeneratedMemories(id, chapter.acceptedRevisionId!, [
    { kind: "fact", content },
  ]);
  return chapter;
}
beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("章节删除与关联数据", () => {
  it("清理本章版本、记忆、创作草稿及运行记录，保留插画与其他章节和故事", () => {
    const { repo, project, first, second } = setup();
    const accepted = adopt(repo, first.id, "第一章的事实");
    const later = adopt(repo, second.id, "后续章节的事实");
    repo.checkpoint(first.id, "额外快照");
    const manual = repo.addMemory(project.id, "fact", "作者记录");
    const other = repo.createProject({
      title: "另一故事",
      premise: "",
      mode: "explore",
    });
    const otherChapter = adopt(
      repo,
      repo.getDetail(other.id).chapters[0].id,
      "另一故事的事实",
    );
    const image: ImageAsset = {
      id: "illustration",
      projectId: project.id,
      chapterId: first.id,
      revisionId: accepted.acceptedRevisionId,
      kind: "illustration",
      name: "保留插画",
      filename: "kept.png",
      prompt: "",
      referenceIds: [],
      model: "",
      createdAt: "",
    };
    repo.addImage(image);
    repo.addImage({
      ...image,
      id: "other-illustration",
      chapterId: second.id,
      revisionId: later.acceptedRevisionId,
    });
    const run: WorkflowRun = {
      id: "run",
      projectId: project.id,
      templateId: "flow",
      templateName: "流程",
      chapterId: first.id,
      steps: [],
      results: [],
      currentStep: 0,
      createdAt: "",
      updatedAt: "",
    };
    repo.saveWorkflowRun(run);
    repo.saveWorkflowRun({ ...run, id: "other-run", chapterId: second.id });
    repo.setSetting(`scratch.${project.id}`, {
      chapterId: first.id,
      output: "待写入草稿",
    });

    const detail = repo.deleteChapter(first.id);

    expect(() => repo.getChapter(first.id)).toThrow("不存在");
    expect(() => repo.getRevision(accepted.acceptedRevisionId!)).toThrow(
      "不存在",
    );
    expect(repo.listRevisions(first.id)).toEqual([]);
    expect(
      detail.memories.some((memory) => memory.chapterId === first.id),
    ).toBe(false);
    expect(
      detail.memories.find((memory) => memory.id === manual.id)?.active,
    ).toBe(true);
    expect(repo.getImage(image.id)).toEqual({
      ...image,
      chapterId: null,
      revisionId: null,
    });
    expect(repo.getImage("other-illustration").chapterId).toBe(second.id);
    expect(repo.getSetting(`scratch.${project.id}`, null)).toBeNull();
    expect(repo.listWorkflowRuns(project.id).map((item) => item.id)).toEqual([
      "other-run",
    ]);
    expect(repo.getDetail(other.id).chapters).toEqual([otherChapter]);
    expect(repo.getDetail(other.id).memories[0].active).toBe(true);
    expect(repo.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("删除已采用章节会停用后续自动记忆，并要求后续采用章节复核", () => {
    const { repo, first, second, third } = setup();
    adopt(repo, first.id, "早期事实");
    adopt(repo, second.id, "中间事实");
    adopt(repo, third.id, "后续事实");
    const detail = repo.deleteChapter(second.id);
    expect(
      detail.chapters.find((item) => item.id === first.id)?.needsReview,
    ).toBe(false);
    expect(
      detail.chapters.find((item) => item.id === third.id)?.needsReview,
    ).toBe(true);
    expect(
      detail.memories.find((item) => item.chapterId === first.id)?.active,
    ).toBe(true);
    const laterMemory = detail.memories.find(
      (item) => item.chapterId === third.id,
    )!;
    expect(laterMemory.active).toBe(false);
    expect(() => repo.setMemoryActive(laterMemory.id, true)).toThrow("失效");
    repo.adoptChapter(third.id);
    expect(repo.getChapter(third.id).needsReview).toBe(false);
  });

  it("删除未采用草稿会连续编号，保留原有标题及其他章节的草稿和记忆", () => {
    const { repo, project, first, second, third } = setup();
    repo.updateChapter(first.id, { title: "序章" });
    adopt(repo, third.id, "仍然有效");
    const scratch = { chapterId: third.id, output: "另一章草稿" };
    repo.setSetting(`scratch.${project.id}`, scratch);
    const detail = repo.deleteChapter(second.id);
    expect(detail.chapters.map((item) => [item.title, item.position])).toEqual([
      ["序章", 1],
      ["第3章", 2],
    ]);
    expect(repo.getChapter(third.id).needsReview).toBe(false);
    expect(detail.memories[0].active).toBe(true);
    expect(repo.getSetting(`scratch.${project.id}`, null)).toEqual(scratch);
    expect(repo.createChapter(project.id).position).toBe(3);
  });

  it("允许删除最后一章，重新创建时从第一章开始", () => {
    const { repo, project, first, second, third } = setup();
    repo.deleteChapter(second.id);
    repo.deleteChapter(third.id);
    expect(repo.deleteChapter(first.id).chapters).toEqual([]);
    expect(repo.getProject(project.id).id).toBe(project.id);
    expect(repo.createChapter(project.id)).toMatchObject({
      position: 1,
      title: "第1章",
    });
  });

  it("删除失败时整体回滚，保留正文、版本与记忆", () => {
    const { repo, project, first } = setup();
    adopt(repo, first.id, "不能丢失");
    const before = repo.getDetail(project.id);
    const revisions = repo.listRevisions(first.id);
    repo.db.exec(
      "CREATE TRIGGER reject_chapter_deletion BEFORE DELETE ON chapters BEGIN SELECT RAISE(ABORT, 'delete failed'); END",
    );
    expect(() => repo.deleteChapter(first.id)).toThrow("delete failed");
    expect(repo.getDetail(project.id)).toEqual(before);
    expect(repo.listRevisions(first.id)).toEqual(revisions);
  });
});

function setupStore() {
  const fixture = setup();
  const { repo, project, first } = fixture;
  const invoke = vi.fn(async (action: string, payload: unknown) => {
    if (action === "project:get") return repo.getDetail(payload as string);
    if (action === "scratch:get")
      return repo.getSetting(`scratch.${payload as string}`, null);
    if (action === "planning:remove") {
      const value = payload as {
        projectId: string;
        target: Parameters<typeof removePlanning>[2];
      };
      return removePlanning(repo, value.projectId, value.target);
    }
    if (action === "chapter:delete")
      return repo.deleteChapter(
        typeof payload === "string" ? payload : (payload as { id: string }).id,
      );
    if (action === "scratch:save") {
      const value = payload as { projectId: string };
      repo.setSetting(`scratch.${value.projectId}`, value);
      return true;
    }
    if (action === "chapter:update") {
      const { id, ...patch } = payload as { id: string } & Parameters<
        StoryRepository["updateChapter"]
      >[1];
      return repo.updateChapter(id, patch);
    }
    throw new Error("未知测试操作：" + action);
  });
  vi.stubGlobal("window", { storybook: { invoke } });
  const store = useWorkspace();
  store.detail = repo.getDetail(project.id);
  store.projects = repo.listProjects();
  store.chapterId = first.id;
  return { ...fixture, store, invoke };
}

describe("章节删除与编辑状态", () => {
  it("删除分卷清理已失效的生成目标和暂存草稿，保留章节与正文", async () => {
    const { repo, project, first, store } = setupStore();
    const volume = savePlanning(
      repo,
      project.id,
      { level: "volume" },
      {
        title: "第一卷",
        content: "卷纲",
        confirm: true,
      },
    ).target;
    store.detail = repo.getDetail(project.id);
    store.editChapter({ document: textToDocument("保留正文") });
    store.planningTarget = { level: "chapter", parentId: volume.id };
    store.planningDraft = {
      projectId: project.id,
      target: store.planningTarget,
      base: planningBase(repo, project.id),
      items: [],
    };
    store.resultType = "planning";
    store.output = "已删除卷的候选";
    store.scratch();
    await store.removePlanning(volume);
    await store.flush();
    expect(repo.getChapter(first.id).content).toBe("保留正文");
    expect(store.planningTarget).toBeUndefined();
    expect(store.planningDraft).toBeNull();
    await store.openProject(project.id);
    expect(store.planningTarget).toBeUndefined();
    expect(store.planningDraft).toBeNull();
    expect(store.output).toBe("");
  });
  it("保存进行中删除当前片段，等待保存完成且不复活片段，回到正式章节", async () => {
    const { repo, project, first, store, invoke } = setupStore();
    const fragment = createFragment(repo, project.id);
    store.detail = repo.getDetail(project.id);
    store.chapterId = fragment.id;
    const original = invoke.getMockImplementation()!;
    let release!: () => void;
    invoke.mockImplementation(async (action, payload) => {
      if (action === "chapter:update")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return original(action, payload);
    });
    store.editChapter({ document: textToDocument("待保存片段") });
    const saving = store.flush(),
      deleting = store.deleteChapter(fragment.id);
    expect(
      invoke.mock.calls.some(([action]) => action === "chapter:delete"),
    ).toBe(false);
    release();
    await saving;
    await deleting;
    await store.flush();
    expect(repo.getDetail(project.id).fragments).toEqual([]);
    expect(store.chapterId).toBe(first.id);
    expect(() => repo.getChapter(fragment.id)).toThrow();
    expect(
      invoke.mock.calls.filter(([action]) => action === "chapter:update"),
    ).toHaveLength(1);
  });
  it("删除非当前章节前保存待保存正文，保持当前章节及选区", async () => {
    const { repo, first, second, store, invoke } = setupStore();
    store.editChapter({ document: textToDocument("尚未自动保存的正文") });
    store.selection = { text: "正文", from: 1, to: 3 };
    await store.deleteChapter(second.id);
    expect(invoke.mock.calls.map(([action]) => action)).toEqual([
      "chapter:update",
      "chapter:delete",
    ]);
    expect(repo.getChapter(first.id).content).toBe("尚未自动保存的正文");
    expect(store.chapterId).toBe(first.id);
    expect(store.selection?.text).toBe("正文");
    await store.flush();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.at(-1)?.[0]).toBe("scratch:save");
  });

  it("删除当前章节后切到下一章，清空生成结果与重启后的暂存引用", async () => {
    const { repo, project, first, second, store } = setupStore();
    store.output = "旧生成结果";
    store.outputChapterId = first.id;
    store.outputSelection = store.selection = {
      text: "旧正文",
      from: 1,
      to: 4,
    };
    store.memoryRevisionId = "old-revision";
    store.memoryRecords = [{ kind: "fact", content: "旧事实" }];
    store.sourceContent = "旧正文";
    store.outputScope = "selection";
    store.resultType = "rewrite";
    store.scratch();
    await store.deleteChapter(first.id);
    expect(store.chapterId).toBe(second.id);
    expect(store.selection).toBeNull();
    expect(store.output).toBe("");
    expect(store.outputChapterId).toBe("");
    expect(store.outputSelection).toBeNull();
    expect(store.memoryRecords).toBeNull();
    expect(store.memoryRevisionId).toBe("");
    await store.flush();
    expect(repo.getSetting(`scratch.${project.id}`, null)).toMatchObject({
      output: "",
      chapterId: "",
      memoryRecords: null,
      sourceContent: "",
      outputScope: null,
      resultType: null,
    });
    expect(repo.getSetting(`scratch.${project.id}`, null)).not.toHaveProperty(
      "memoryRevisionId",
    );
    await store.openProject(project.id);
    expect(store.outputChapterId).toBe("");
    expect(store.output).toBe("");
    expect(store.memoryRevisionId).toBe("");
  });

  it("删除末章回到上一章，删除全部章节后清空当前章节", async () => {
    const { first, second, third, store } = setupStore();
    store.chapterId = third.id;
    await store.deleteChapter(third.id);
    expect(store.chapterId).toBe(second.id);
    await store.deleteChapter(second.id);
    expect(store.chapterId).toBe(first.id);
    await store.deleteChapter(first.id);
    expect(store.chapterId).toBe("");
    expect(store.chapter).toBeNull();
    expect(store.detail?.chapters).toEqual([]);
  });

  it("保存失败时不执行删除，待保存正文仍可重试", async () => {
    const { first, second, store, invoke } = setupStore();
    store.editChapter({ document: textToDocument("保留草稿") });
    invoke.mockRejectedValueOnce(new Error("磁盘不可写"));
    await expect(store.deleteChapter(second.id)).rejects.toThrow("不可写");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.detail?.chapters).toHaveLength(3);
    expect(store.chapterId).toBe(first.id);
    await store.flush();
    expect(store.saveFailed).toBe(false);
  });

  it("删除接口失败时保留当前章节与生成结果", async () => {
    const { first, store, invoke } = setupStore();
    store.output = "保留结果";
    store.outputChapterId = first.id;
    invoke.mockRejectedValueOnce(new Error("删除失败"));
    await expect(store.deleteChapter(first.id)).rejects.toThrow("删除失败");
    expect(store.chapterId).toBe(first.id);
    expect(store.output).toBe("保留结果");
    expect(store.detail?.chapters).toHaveLength(3);
  });

  it.each(["busy", "imageBusy"] as const)("%s 生成中禁止删除", async (key) => {
    const { first, store, invoke } = setupStore();
    store[key] = true;
    await expect(store.deleteChapter(first.id)).rejects.toThrow("生成任务");
    expect(invoke).not.toHaveBeenCalled();
    expect(store.detail?.chapters).toHaveLength(3);
  });
});
