import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { fixture, options, request, run } from "./workbench-fixture";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";
import { normalizeSoftware } from "../src/shared/appearance";
import { defaultRoleSettings } from "../src/shared/roles";
import type {
  Settings,
  SettingsInput,
  DesktopAPI,
  ProgressEvent,
  Mode,
} from "../src/shared/types";
import { runCreationTask } from "../src/main/conversations";
beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function setup(mode: Mode = "novel") {
  const f = fixture(mode);
  let progress: (e: ProgressEvent) => void = () => {};
  const settings: Settings = {
    software: normalizeSoftware({}),
    text: {
      baseUrl: "http://mock.invalid",
      key: "test",
      hasKey: true,
      model: "mock",
      selectedModels: ["mock"],
      availableModels: ["mock"],
      capabilities: { mock: options.capabilities },
    },
    image: {
      baseUrl: "http://mock.invalid",
      key: "test",
      hasKey: true,
      model: "image",
      selectedModels: ["image"],
      availableModels: ["image"],
      capabilities: {},
    },
    imageSize: "1024x1024",
    imageQuality: "auto",
    dataDir: "isolated",
    version: "test",
  };
  const controllers = new Map<string, AbortController>(),
    actions: string[] = [];
  let response = "模拟回答";
  const invoke = vi.fn(async (action: string, p: any) => {
    actions.push(action);
    if (action === "bootstrap")
      return {
        projects: f.repo.listProjects(),
        cards: f.repo.listCards(),
        images: f.repo.listImages(),
        settings: structuredClone(settings),
        roles: defaultRoleSettings(),
      };
    if (action === "settings:save") {
      Object.assign(settings, p);
      return structuredClone(settings);
    }
    if (action === "settings:software") {
      settings.software = {
        ...settings.software,
        ...p,
        appearance: { ...settings.software.appearance, ...p.appearance },
      };
      return settings.software;
    }
    if (action === "ai:run") {
      const controller = new AbortController();
      controllers.set(p.requestId, controller);
      return runCreationTask(f.repo, p, {
        ...options,
        signal: controller.signal,
        progress: (e) => progress(e),
        generate: async (_m, d) => {
          d(response);
          return response;
        },
      });
    }
    if (action === "ai:cancel") {
      controllers.get(p)?.abort();
      return true;
    }
    if (action.startsWith("window:")) return true;
    const handler = f.api[action];
    if (!handler) throw Error("Unknown: " + action);
    return handler(p);
  });
  vi.stubGlobal("window", {
    storybook: {
      invoke,
      onProgress: (fn: any) => {
        progress = fn;
        return () => {};
      },
      onClosing: () => () => {},
    } as DesktopAPI,
  });
  const store = useWorkspace();
  store.detail = f.repo.getDetail(f.project.id);
  store.chapterId = f.chapter.id;
  store.settings = structuredClone(settings);
  store.projects = f.repo.listProjects();
  store.initializeListeners();
  return {
    ...f,
    store,
    invoke,
    actions,
    setResponse: (v: string) => (response = v),
  };
}
describe("工作台自动保存与目标恢复", () => {
  it("探索正文未采用时不生成走向，审核写入最终编辑稿后只自动调用一次", async () => {
    const f = setup("explore");
    await f.store.openProject(f.project.id);
    f.setResponse("待审核的原始候选");
    await f.store.runTask("opening");
    expect(
      f.invoke.mock.calls.filter(
        ([a, p]) => a === "ai:run" && p.kind === "directions",
      ),
    ).toHaveLength(0);
    const set = f.store.changeSets[0];
    f.setResponse(
      '{"options":[{"title":"调查","content":"查看水印"},{"title":"询问","content":"询问老人"},{"title":"等待","content":"等待来信"}]}',
    );
    await f.store.applyChanges(set.id, [
      { id: set.changes[0].id, after: "作者审核后真正写入的正文" },
    ]);
    await vi.waitFor(() => expect(f.store.directionsBusy).toBe(false));
    expect(f.repo.getChapter(f.chapter.id).content).toBe(
      "作者审核后真正写入的正文",
    );
    expect(
      f.invoke.mock.calls.filter(
        ([a, p]) => a === "ai:run" && p.kind === "directions",
      ),
    ).toHaveLength(1);
    expect(f.store.directionsError).toBe("");
    const view = f.api["directions:get"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
    }) as any;
    expect(view.state.options).toHaveLength(3);
    expect(f.repo.getDetail(f.project.id).memories).toHaveLength(0);
    expect(f.repo.getChapter(f.chapter.id).acceptedRevisionId).toBeNull();
    await expect(
      f.store.applyChanges(set.id, [
        { id: set.changes[0].id, after: "重复写入" },
      ]),
    ).rejects.toThrow("已采用");
    expect(
      f.invoke.mock.calls.filter(
        ([a, p]) => a === "ai:run" && p.kind === "directions",
      ),
    ).toHaveLength(1);
  });
  it("探索自动走向失败不会把成功的正文审核显示为失败，并可单独重试", async () => {
    const f = setup("explore");
    await f.store.openProject(f.project.id);
    f.setResponse("正文候选");
    await f.store.runTask("opening");
    const set = f.store.changeSets[0];
    f.setResponse("无法解析的走向结果");
    await expect(
      f.store.applyChanges(set.id, [
        { id: set.changes[0].id, after: "已写入正文" },
      ]),
    ).resolves.toMatchObject({ status: "applied" });
    await vi.waitFor(() => expect(f.store.directionsBusy).toBe(false));
    expect(f.store.directionsError).not.toBe("");
    expect(f.repo.getChapter(f.chapter.id).content).toBe("已写入正文");
    f.store.settings!.software.directionCount = 1;
    f.setResponse('{"options":[{"title":"新方向","content":"沿河寻找线索"}]}');
    await f.store.generateDirections(f.chapter.id);
    expect(f.store.directionsError).toBe("");
    expect(
      (
        f.api["directions:get"]({
          projectId: f.project.id,
          chapterId: f.chapter.id,
        }) as any
      ).state.options,
    ).toHaveLength(1);
  });
  it("双击生成下一章仅创建一个空章，生成失败后在同一章重试", async () => {
    const f = setup("explore");
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("来源正文"),
    });
    await f.store.openProject(f.project.id);
    const view = f.api["directions:get"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
    }) as any;
    const chosen = f.api["directions:choose"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
      sourceFingerprint: view.sourceFingerprint,
      basis: view.basis,
      selectedId: null,
      instruction: "先查水印",
    }) as any;
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "ai:run") throw Error("生成失败");
      return original(a, p);
    });
    await Promise.all([
      f.store.createExplorationChapter(f.chapter.id, chosen),
      f.store.createExplorationChapter(f.chapter.id, chosen),
    ]);
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
    expect(f.store.chapter?.explorationSource?.instruction).toBe("先查水印");
    const id = f.store.chapterId;
    expect(f.store.taskError).toBe("生成失败");
    f.invoke.mockImplementation(original);
    f.setResponse("根据水印展开的下一章正文");
    await f.store.runTask("opening");
    expect(f.store.chapterId).toBe(id);
    expect(f.store.result?.type).toBe("changes");
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
  });
  it("切换作品时取消未完成走向，迟到的结果不写入任何章节", async () => {
    const f = setup("explore"),
      started = deferred<void>(),
      released = deferred<void>();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("来源正文"),
    });
    await f.store.openProject(f.project.id);
    const other = f.repo.createProject({
      title: "另一部作品",
      premise: "",
      mode: "explore",
    });
    const original = f.invoke.getMockImplementation()!,
      controller = new AbortController();
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "ai:run" && p.kind === "directions")
        return runCreationTask(f.repo, p, {
          ...options,
          signal: controller.signal,
          progress: () => {},
          generate: async () => {
            started.resolve();
            await released.promise;
            return '{"options":[{"title":"一","content":"查证一"},{"title":"二","content":"查证二"},{"title":"三","content":"查证三"}]}';
          },
        });
      if (a === "ai:cancel") {
        controller.abort();
        released.resolve();
        return true;
      }
      return original(a, p);
    });
    const generating = f.store.generateDirections(f.chapter.id);
    await started.promise;
    await f.store.openProject(other.id);
    await generating;
    expect(f.store.detail?.project.id).toBe(other.id);
    expect(f.store.directionsBusy).toBe(false);
    expect(
      (
        f.api["directions:get"]({
          projectId: f.project.id,
          chapterId: f.chapter.id,
        }) as any
      ).state,
    ).toBeNull();
    expect(
      (
        f.api["directions:get"]({
          projectId: other.id,
          chapterId: f.store.chapterId,
        }) as any
      ).state,
    ).toBeNull();
    expect(f.repo.getChapter(f.chapter.id).content).toBe("来源正文");
  });
  it("建章后刷新期间切换作品，不跳转或向新作品发起旧章写作", async () => {
    const f = setup("explore"),
      started = deferred<void>(),
      released = deferred<void>();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("来源正文"),
    });
    await f.store.openProject(f.project.id);
    const view = f.api["directions:get"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
    }) as any;
    const chosen = f.api["directions:choose"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
      sourceFingerprint: view.sourceFingerprint,
      basis: view.basis,
      selectedId: null,
      instruction: "调查线索",
    }) as any;
    const other = f.repo.createProject({
      title: "新作品",
      premise: "",
      mode: "explore",
    });
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "project:get" && p === f.project.id) {
        started.resolve();
        await released.promise;
      }
      return original(a, p);
    });
    const creating = f.store.createExplorationChapter(f.chapter.id, chosen);
    await started.promise;
    await f.store.openProject(other.id);
    const currentChapter = f.store.chapterId;
    released.resolve();
    await creating;
    expect(f.store.detail?.project.id).toBe(other.id);
    expect(f.store.chapterId).toBe(currentChapter);
    expect(f.invoke.mock.calls.filter(([a]) => a === "ai:run")).toHaveLength(0);
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
    expect(f.repo.getDetail(other.id).chapters).toHaveLength(1);
  });
  it("切换模型保持同一对话，并将选择用于新请求及重开作品", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    await f.store.runTask();
    const conversationId = f.store.conversationId;
    f.store.taskModel = "另一个模型";
    expect(f.store.currentTaskRequest()).toMatchObject({
      model: "另一个模型",
      conversationId,
    });
    f.store.scratch();
    await f.store.flush();
    await f.store.openProject(f.project.id);
    expect(f.store.taskModel).toBe("另一个模型");
    expect(f.store.conversationId).toBe(conversationId);
    await f.store.runTask();
    expect(
      f.invoke.mock.calls.filter(([a]) => a === "ai:run").at(-1)?.[1].model,
    ).toBe("另一个模型");
    expect(f.store.conversationId).toBe(conversationId);
    f.store.taskModel = "";
    expect(f.store.currentTaskRequest().model).toBeUndefined();
  });
  it("已保存的完善设定工具状态回退到脑暴，不能再次选择旧工具", async () => {
    const f = setup();
    f.api["ui:save"]({
      projectId: f.project.id,
      key: "workbench.novel",
      value: { taskKind: "settings" },
    });
    await f.store.openProject(f.project.id);
    expect(f.store.taskKind).toBe("brainstorm");
    await expect(f.store.chooseTool("settings")).rejects.toThrow("资料编辑");
  });
  it("选区目标经过 IPC 校验后仍恢复可审核结果", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    f.store.editChapter({ document: textToDocument("阿禾推开门。") });
    await f.store.flush();
    f.store.selection = { from: 1, to: 3, text: "阿禾" };
    await f.store.chooseTool("polish");
    f.setResponse("少年");
    await f.store.runTask();
    expect(f.store.result?.type).toBe("changes");
    expect(f.store.selectedTurn?.sourceSnapshot).toHaveLength(1);
  });
  it("现有额外设定目标经过 IPC 校验后仍恢复可审核结果", async () => {
    const f = setup();
    const n = {
      id: crypto.randomUUID(),
      level: "section",
      parentId: null,
      chapterId: null,
      title: "方向",
      content: "旧内容",
    };
    f.api["blueprint:save"]({ projectId: f.project.id, node: n, base: null });
    await f.store.openProject(f.project.id);
    f.store.blueprintTarget = { level: "section", count: 1, id: n.id };
    await f.store.chooseTool("blueprint");
    f.setResponse('{"items":[{"title":"方向","content":"新内容"}]}');
    await f.store.runTask();
    expect(f.store.result?.type).toBe("changes");
  });
  it("合并章节正文和名称，失败保留最新输入并可重试", async () => {
    const f = setup();
    f.store.editChapter({ document: textToDocument("新正文") });
    f.store.renameChapter(f.chapter.id, "新章名");
    const original = f.invoke.getMockImplementation()!;
    let fail = true;
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "chapter:update" && fail) throw Error("磁盘失败");
      return original(a, p);
    });
    await expect(f.store.flush()).rejects.toThrow("磁盘失败");
    expect(f.store.saveFailed).toBe(true);
    f.store.editChapter({ document: textToDocument("失败后继续编辑") });
    fail = false;
    await f.store.flush();
    expect(f.repo.getChapter(f.chapter.id)).toMatchObject({
      title: "新章名",
      content: "失败后继续编辑",
    });
    expect(f.store.saveFailed).toBe(false);
  });
  it("保存过程中继续输入，旧响应不能覆盖新正文", async () => {
    const f = setup(),
      gate = deferred<void>(),
      original = f.invoke.getMockImplementation()!;
    let first = true;
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "chapter:update" && first) {
        first = false;
        await gate.promise;
      }
      return original(a, p);
    });
    f.store.editChapter({ document: textToDocument("第一稿") });
    const pending = f.store.flush();
    await Promise.resolve();
    f.store.editChapter({ document: textToDocument("第二稿") });
    gate.resolve();
    await pending;
    expect(f.store.chapter?.content).toBe("第二稿");
    expect(f.repo.getChapter(f.chapter.id).content).toBe("第二稿");
  });
  it("保存资料会先保存待保存正文，刷新不丢编辑", async () => {
    const f = setup();
    f.store.editChapter({ document: textToDocument("不能被刷新覆盖") });
    await f.store.saveCard({
      projectId: f.project.id,
      kind: "character",
      name: "阿禾",
      description: "修理师",
      constraints: "",
      referenceIds: [],
    });
    expect(f.store.chapter?.content).toBe("不能被刷新覆盖");
    expect(f.repo.getChapter(f.chapter.id).content).toBe("不能被刷新覆盖");
  });
  it("全量配置刷新期间继续修改外观，旧刷新不覆盖新设置", async () => {
    const f = setup(),
      gate = deferred<any>(),
      original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (a, p) =>
      a === "bootstrap" ? gate.promise : original(a, p),
    );
    const refreshing = f.store.bootstrap();
    f.store.editSoftwareSettings({ appearance: { editorFontSize: 28 } });
    gate.resolve({
      projects: f.repo.listProjects(),
      cards: [],
      images: [],
      settings: { ...f.store.settings, software: normalizeSoftware({}) },
      roles: defaultRoleSettings(),
    });
    await refreshing;
    expect(f.store.settings?.software.appearance.editorFontSize).toBe(28);
    await f.store.flush();
  });
  it("设置和外观分别排队，不互相覆盖", async () => {
    const f = setup(),
      input = JSON.parse(JSON.stringify(f.store.settings!)) as SettingsInput;
    input.text.model = "mock";
    f.store.editSettings(input);
    f.store.editSoftwareSettings({
      closeAction: "quit",
      appearance: { editorFontSize: 25 },
    });
    await f.store.flush();
    expect(f.actions).toContain("settings:save");
    expect(f.actions).toContain("settings:software");
    expect(f.store.settings?.software.appearance.editorFontSize).toBe(25);
  });
  it("连续点击新章只创建一个，返回后不会混入其他故事", async () => {
    const f = setup(),
      gate = deferred<void>(),
      original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "chapter:create") await gate.promise;
      return original(a, p);
    });
    const a = f.store.newChapter(),
      b = f.store.newChapter();
    await Promise.resolve();
    const other = f.repo.createProject({
      title: "别书",
      mode: "explore",
      premise: "",
    });
    f.store.detail = f.repo.getDetail(other.id);
    gate.resolve();
    await Promise.all([a, b]);
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
    expect(f.store.detail?.project.id).toBe(other.id);
    expect(f.store.detail?.chapters).toHaveLength(1);
  });
  it("切换章节和工具清除不匹配的结果，恢复对应对话", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    f.store.taskKind = "brainstorm";
    await f.store.runTask();
    const chat = f.store.conversationId;
    await f.store.chooseTool("opening");
    expect(f.store.result).toBeNull();
    expect(f.store.conversationId).toBe("");
    await f.store.chooseTool("brainstorm");
    expect(f.store.conversationId).toBe(chat);
    const c = f.repo.createChapter(f.project.id);
    await f.store.refreshProject();
    await f.store.switchChapter(c.id);
    expect(f.store.conversationId).toBe(chat);
    await f.store.chooseTool("title");
    expect(f.store.result).toBeNull();
  });
  it("模式各自恢复聊天、输入和工具，内容一直保留", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    f.store.instruction = "长篇问题";
    await f.store.runTask();
    const novel = f.store.conversationId;
    f.store.scratch();
    await f.store.flush();
    f.repo.updateProject(f.project.id, { mode: "explore" });
    await f.store.openProject(f.project.id);
    expect(f.store.result).toBeNull();
    expect(f.store.taskKind).toBe("brainstorm");
    f.store.instruction = "探索问题";
    await f.store.runTask();
    expect(f.store.conversationId).not.toBe(novel);
    f.store.scratch();
    await f.store.flush();
    f.repo.updateProject(f.project.id, { mode: "novel" });
    await f.store.openProject(f.project.id);
    expect(f.store.conversationId).toBe(novel);
    expect(f.store.instruction).toBe("长篇问题");
  });
  it("较早的对话读取响应不能污染新目标", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    await f.store.runTask();
    const id = f.store.conversationId,
      old = f.invoke.getMockImplementation()!,
      gate = deferred<any>();
    f.invoke.mockImplementation(async (a, p) =>
      a === "conversation:get" ? gate.promise : old(a, p),
    );
    const reading = f.store.openConversation(id, false);
    f.store.taskKind = "title";
    await f.store.restoreConversation();
    gate.resolve(f.api["conversation:get"]({ projectId: f.project.id, id }));
    await reading;
    expect(f.store.result).toBeNull();
    expect(f.store.conversationId).toBe("");
  });
  it("未完成版本不会作为新请求的父结果", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    await f.store.runTask();
    f.store.turns[0].status = "error";
    expect(f.store.currentTaskRequest().parentTurnId).toBeUndefined();
  });
  it("审核前刷新本地自动保存，过期建议不能覆盖编辑", async () => {
    const f = setup();
    await f.store.openProject(f.project.id);
    f.store.taskKind = "opening";
    f.setResponse("AI 生成正文");
    await f.store.runTask();
    if (f.store.result?.type !== "changes") throw Error();
    const id = f.store.result.changeSetId,
      s = f.store.changeSets.find((s) => s.id === id)!;
    f.store.editChapter({ document: textToDocument("作者后来的正文") });
    await expect(
      f.store.applyChanges(
        id,
        s.changes.map((c) => ({ id: c.id, after: c.after })),
      ),
    ).rejects.toThrow();
    expect(f.repo.getChapter(f.chapter.id).content).toBe("作者后来的正文");
  });
  it("删除非当前章保留当前选区；生成时不能删除", async () => {
    const f = setup(),
      c = f.repo.createChapter(f.project.id);
    await f.store.refreshProject();
    f.store.selection = { from: 1, to: 2, text: "字" };
    await f.store.deleteChapter(c.id);
    expect(f.store.chapterId).toBe(f.chapter.id);
    expect(f.store.selection?.text).toBe("字");
    f.store.busy = true;
    await f.store.deleteChapter(f.chapter.id);
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(1);
  });
  it("退出前保存，磁盘失败不执行关闭，重试后仅关闭一次", async () => {
    const f = setup(),
      original = f.invoke.getMockImplementation()!;
    let fail = true;
    f.invoke.mockImplementation(async (a, p) => {
      if (a === "chapter:update" && fail) throw Error("写入失败");
      return original(a, p);
    });
    f.store.editChapter({ document: textToDocument("退出前草稿") });
    await expect(f.store.confirmClose("quit")).rejects.toThrow("写入失败");
    expect(f.actions).not.toContain("window:close");
    fail = false;
    await f.store.confirmClose("quit");
    expect(f.actions.filter((a) => a === "window:close")).toHaveLength(1);
    expect(f.repo.getChapter(f.chapter.id).content).toBe("退出前草稿");
  });
  it("保存折叠状态不会写故事资料或自动清理候选", async () => {
    const f = setup(),
      before = f.repo.getDetail(f.project.id);
    await f.store.api("ui:save", {
      projectId: f.project.id,
      key: "settings.candidates",
      value: ["all", "one"],
    });
    expect(
      await f.store.api("ui:get", {
        projectId: f.project.id,
        key: "settings.candidates",
      }),
    ).toEqual(["all", "one"]);
    expect(f.repo.getDetail(f.project.id)).toEqual(before);
  });
});
