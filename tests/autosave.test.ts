import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";
import { reactive } from "vue";
import { defaultAppearance } from "../src/shared/appearance";
import type {
  ProgressEvent,
  Settings,
  SettingsInput,
} from "../src/shared/types";
const invoke = vi.fn();
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal("window", {
    storybook: {
      invoke,
      onProgress: () => () => {},
      onClosing: () => () => {},
    },
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const store = useWorkspace();
  store.detail = {
    project: {
      id: "story",
      title: "测试",
      premise: "",
      mode: "explore",
      genre: "",
      world: "",
      style: "",
      outline: "",
      blueprintSections: [],
      blueprintCandidates: [],
      color: "sage",
      createdAt: "",
      updatedAt: "",
      archived: false,
    },
    chapters: [
      {
        id: "chapter",
        projectId: "story",
        title: "第一章",
        position: 1,
        plan: "",
        document: textToDocument(""),
        content: "",
        acceptedRevisionId: null,
        dirty: true,
        needsReview: false,
        updatedAt: "",
      },
    ],
    cards: [],
    memories: [],
    images: [],
  };
  store.chapterId = "chapter";
  return store;
}
describe("自动保存队列", () => {
  it("全文改写保存生成时原文和范围，重新打开后继续保护后续编辑", async () => {
    const store = setup();
    store.editChapter({ document: textToDocument("生成时原文") });
    store.writingScope = "document";
    store.outputMode = "rewrite";
    store.usePlanDraft = true;
    let saved: unknown;
    invoke.mockImplementation((action, payload) => {
      if (action === "ai:run")
        return Promise.resolve({ text: "改写稿", resultType: "rewrite" });
      if (action === "scratch:save") saved = structuredClone(payload);
      return Promise.resolve(payload);
    });
    await store.runTask("revise");
    store.editChapter({ document: textToDocument("作者后来修改的原文") });
    await store.flush();
    const detail = structuredClone(JSON.parse(JSON.stringify(store.detail)));
    invoke.mockImplementation((action) =>
      Promise.resolve(
        action === "project:get"
          ? detail
          : action === "scratch:get"
            ? saved
            : true,
      ),
    );
    await store.openProject("story");
    expect(store.sourceContent).toBe("生成时原文");
    expect(store.chapter!.content).toBe("作者后来修改的原文");
    expect(store.outputScope).toBe("document");
    expect(store.resultType).toBe("rewrite");
    expect(store.usePlanDraft).toBe(true);
    expect(store.output).toBe("改写稿");
  });
  it("选中文段时优先按选区改写，保留生成时的原文范围", async () => {
    const store = setup();
    store.writingScope = "document";
    store.selection = { text: "选中文段", from: 1, to: 5 };
    invoke.mockImplementation((action, payload) =>
      Promise.resolve(
        action === "ai:run"
          ? { text: "局部改写", resultType: "rewrite" }
          : payload,
      ),
    );
    await store.runTask("revise");
    expect(invoke).toHaveBeenCalledWith(
      "ai:run",
      expect.objectContaining({
        writingScope: "selection",
        selection: "选中文段",
      }),
    );
    expect(store.outputScope).toBe("selection");
    expect(store.outputSelection).toEqual({ text: "选中文段", from: 1, to: 5 });
    await store.flush();
  });
  function settingsForm(): SettingsInput {
    const provider = {
      baseUrl: "http://localhost/v1",
      key: "qa-local-key",
      model: "model-a",
      selectedModels: ["model-a", "model-b"],
      availableModels: ["model-a", "model-b"],
    };
    return {
      text: { ...provider },
      image: { ...provider },
      imageSize: "1024x1024",
      imageQuality: "auto",
    };
  }
  function savedSettings(input: SettingsInput): Settings {
    return {
      ...structuredClone(input),
      software: { closeAction: "ask", appearance: defaultAppearance() },
      text: { ...input.text, hasKey: !!input.text.key },
      image: { ...input.image, hasKey: !!input.image.key },
      dataDir: "test",
      version: "test",
    };
  }
  it("关闭请求默认仅显示提示，重复请求不执行动作，取消不保存偏好", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    await store.requestClose();
    await store.requestClose();
    expect(store.closePrompt).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    store.closePrompt = false;
    expect(store.settings.software.closeAction).toBe("ask");
    await store.requestClose();
    expect(store.closePrompt).toBe(true);
  });
  it("最小化保留生成任务，不勾选记住时下次仍然询问", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    store.busy = true;
    invoke.mockResolvedValue(true);
    await store.requestClose();
    await store.confirmClose("minimize");
    expect(store.busy).toBe(true);
    expect(invoke).toHaveBeenCalledWith("window:hide", undefined);
    expect(
      invoke.mock.calls.some(
        ([action]) =>
          action === "ai:cancel" ||
          action === "window:close" ||
          action === "settings:software",
      ),
    ).toBe(false);
    expect(store.closePrompt).toBe(false);
    await store.requestClose();
    expect(store.closePrompt).toBe(true);
  });
  it("记住最小化后后续直接执行，可在软件设置恢复每次询问", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    invoke.mockImplementation((action, payload) =>
      Promise.resolve(action === "settings:software" ? payload : true),
    );
    await store.requestClose();
    await store.confirmClose("minimize", true);
    expect(store.settings.software.closeAction).toBe("minimize");
    expect(
      invoke.mock.calls.findIndex(([action]) => action === "settings:software"),
    ).toBeLessThan(
      invoke.mock.calls.findIndex(([action]) => action === "window:hide"),
    );
    await store.requestClose();
    expect(store.closePrompt).toBe(false);
    expect(
      invoke.mock.calls.filter(([action]) => action === "window:hide"),
    ).toHaveLength(2);
    store.editSoftwareSettings({ closeAction: "ask" });
    await store.flush();
    await store.requestClose();
    expect(store.closePrompt).toBe(true);
  });
  it("系统关闭事件遵循已记住的退出动作，先保存正文再退出", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    store.settings.software.closeAction = "quit";
    let closing = () => {};
    window.storybook.onClosing = (callback) => {
      closing = callback;
      return () => {};
    };
    store.initializeListeners();
    invoke.mockResolvedValue({ dirty: true, updatedAt: "saved" });
    store.editChapter({ document: textToDocument("退出前的正文") });
    closing();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("window:close", undefined),
    );
    const actions = invoke.mock.calls.map(([action]) => action);
    expect(actions.indexOf("chapter:update")).toBeLessThan(
      actions.indexOf("window:close"),
    );
    expect(actions.indexOf("scratch:save")).toBeLessThan(
      actions.indexOf("window:close"),
    );
    expect(store.closePrompt).toBe(false);
  });
  it("退出等待生成任务停止并保存最终草稿，重复点击只退出一次", async () => {
    const store = setup();
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation((action) => {
      if (action === "ai:run")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Promise.resolve(true);
    });
    const running = store.runTask();
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([action]) => action === "ai:run")).toBe(
        true,
      ),
    );
    const closing = store.confirmClose("quit");
    await store.confirmClose("quit");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([action]) => action === "ai:cancel")).toBe(
        true,
      ),
    );
    expect(
      invoke.mock.calls.some(([action]) => action === "window:close"),
    ).toBe(false);
    finish({ text: "任务结束时收到的最后一段" });
    await running;
    await closing;
    const saved = invoke.mock.calls
      .filter(([action]) => action === "scratch:save")
      .at(-1)![1];
    expect(saved.output).toBe("任务结束时收到的最后一段");
    expect(
      invoke.mock.calls.filter(([action]) => action === "window:close"),
    ).toHaveLength(1);
  });
  it("托盘菜单退出忽略记住的最小化偏好，先保存再真正退出", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    store.settings.software.closeAction = "minimize";
    let closing: (action?: "quit") => void = () => {};
    window.storybook.onClosing = (callback) => {
      closing = callback;
      return () => {};
    };
    store.initializeListeners();
    invoke.mockResolvedValue({ dirty: true, updatedAt: "saved" });
    store.editChapter({ document: textToDocument("托盘退出前保存") });
    closing("quit");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("window:close", undefined),
    );
    const actions = invoke.mock.calls.map(([action]) => action);
    expect(actions.indexOf("chapter:update")).toBeLessThan(
      actions.indexOf("window:close"),
    );
    expect(actions).not.toContain("window:hide");
    expect(store.settings.software.closeAction).toBe("minimize");
  });
  it("关闭前保存失败时保留窗口与提示，重试成功后才退出", async () => {
    const store = setup();
    invoke
      .mockRejectedValueOnce(new Error("磁盘不可写"))
      .mockResolvedValue(true);
    await store.requestClose();
    await expect(store.confirmClose("quit")).rejects.toThrow("不可写");
    expect(store.closePrompt).toBe(true);
    expect(store.closingWindow).toBe(false);
    expect(
      invoke.mock.calls.some(([action]) => action === "window:close"),
    ).toBe(false);
    await store.confirmClose("quit");
    expect(invoke).toHaveBeenCalledWith("window:close", undefined);
  });
  it("模型配置保存中修改软件设置，两个保存队列不会相互覆盖", async () => {
    const store = setup(),
      form = settingsForm();
    store.settings = savedSettings(form);
    let release: (value: unknown) => void = () => {};
    invoke
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation((_action, payload) => Promise.resolve(payload));
    store.editSettings(form);
    const saving = store.flush();
    store.editSoftwareSettings({ closeAction: "minimize" });
    release(savedSettings(form));
    await saving;
    expect(store.settings.software.closeAction).toBe("minimize");
    expect(store.settings.text.key).toBe(form.text.key);
    expect(invoke.mock.calls.map(([action]) => action)).toEqual([
      "settings:save",
      "settings:software",
    ]);
  });
  it("外观保存中连续修改字号与关闭动作，重试和恢复默认不丢其他字段", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    let release: (value: unknown) => void = () => {};
    invoke
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      )
      .mockRejectedValueOnce(new Error("保存失败"))
      .mockImplementation((_action, payload) => Promise.resolve(payload));
    store.editSoftwareSettings({ appearance: { theme: "night" } });
    const saving = store.flush();
    const old = structuredClone(invoke.mock.calls[0][1]);
    store.editSoftwareSettings({ appearance: { uiFontSize: 20 } });
    store.editSoftwareSettings({ closeAction: "minimize" });
    release(old);
    await expect(saving).rejects.toThrow("保存失败");
    expect(store.settings.software).toMatchObject({
      closeAction: "minimize",
      appearance: { theme: "night", uiFontSize: 20 },
    });
    await store.flush();
    store.editSoftwareSettings({ appearance: defaultAppearance() });
    await store.flush();
    expect(store.settings.software).toEqual({
      closeAction: "minimize",
      appearance: defaultAppearance(),
    });
  });
  it("全量刷新返回旧设置时保留刷新期间已保存的新外观", async () => {
    const store = setup();
    store.settings = savedSettings(settingsForm());
    let release: (value: unknown) => void = () => {};
    invoke.mockImplementation((action, payload) =>
      action === "bootstrap"
        ? new Promise((resolve) => (release = resolve))
        : Promise.resolve(payload),
    );
    const refreshing = store.bootstrap();
    store.editSoftwareSettings({ appearance: { theme: "night" } });
    await store.flush();
    release({
      projects: [],
      cards: [],
      images: [],
      settings: savedSettings(settingsForm()),
    });
    await refreshing;
    expect(store.settings.software.appearance.theme).toBe("night");
  });
  it("设置连续输入后自动合并保存，并保留当前 Key 与模型", async () => {
    vi.useFakeTimers();
    const store = setup(),
      form = settingsForm();
    store.settings = savedSettings(form);
    invoke.mockImplementation((_action, payload) =>
      Promise.resolve(savedSettings(payload)),
    );
    store.editSettings(form);
    form.text.key = "qa-replaced-key";
    form.text.model = "model-b";
    store.editSettings(form);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(650);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("settings:save");
    expect(invoke.mock.calls[0][1].text.key).toBe("qa-replaced-key");
    expect(store.settings?.text.model).toBe("model-b");
    expect(store.settings?.text.key).toBe("qa-replaced-key");
  });
  it("保存中继续改设置时保留新输入，立即离开可强制完成保存", async () => {
    const store = setup(),
      form = settingsForm();
    store.settings = savedSettings(form);
    let release: (value: unknown) => void = () => {};
    invoke
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      )
      .mockImplementation((_action, payload) =>
        Promise.resolve(savedSettings(payload)),
      );
    store.editSettings(form);
    const flushing = store.flush();
    form.text.key = "";
    form.text.model = "model-b";
    store.editSettings(form);
    form.text.key = "not-yet-enqueued";
    release(savedSettings(settingsForm()));
    await flushing;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].text.key).toBe("");
    expect(store.settings?.text.key).toBe("");
    expect(store.settings?.text.model).toBe("model-b");
    expect(store.settings?.text.hasKey).toBe(false);
  });
  it("设置保存失败后保留最新值，重试仍保存当前输入", async () => {
    const store = setup(),
      form = settingsForm();
    store.settings = savedSettings(form);
    invoke
      .mockRejectedValueOnce(new Error("磁盘暂不可写"))
      .mockImplementation((_action, payload) =>
        Promise.resolve(savedSettings(payload)),
      );
    store.editSettings(form);
    await expect(store.flush()).rejects.toThrow("不可写");
    form.text.key = "qa-retry-key";
    store.editSettings(form);
    await store.flush();
    expect(store.settings?.text.key).toBe("qa-retry-key");
    expect(store.saveFailed).toBe(false);
  });
  it("生成结束后到达的进度事件不会重复追加正文", async () => {
    const store = setup();
    let progress: (event: ProgressEvent) => void = () => {};
    window.storybook.onProgress = (callback) => {
      progress = callback;
      return () => {};
    };
    store.initializeListeners();
    let finished: (value: unknown) => void = () => {};
    let activeRequest = "";
    invoke.mockImplementation((action, payload) => {
      if (action === "ai:run") {
        activeRequest = payload.requestId;
        return new Promise((resolve) => (finished = resolve));
      }
      return Promise.resolve();
    });
    const running = store.runTask();
    await vi.waitFor(() => expect(activeRequest).not.toBe(""));
    progress({ requestId: activeRequest, delta: "本地测试正文" });
    expect(store.output).toBe("本地测试正文");
    finished({ text: "本地测试正文" });
    await running;
    progress({ requestId: activeRequest, delta: "本地测试正文" });
    expect(store.output).toBe("本地测试正文");
    await store.flush();
  });
  it("连续触发创作只启动一个任务，切换故事后迟到的结果不会污染新故事", async () => {
    const store = setup();
    let progress: (event: ProgressEvent) => void = () => {};
    window.storybook.onProgress = (callback) => {
      progress = callback;
      return () => {};
    };
    store.initializeListeners();
    let finish: (value: unknown) => void = () => {};
    let activeRequest = "";
    invoke.mockImplementation((action, payload) => {
      if (action === "ai:run") {
        activeRequest = payload.requestId;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const running = store.runTask("develop");
    await store.runTask("opening");
    await vi.waitFor(() => expect(activeRequest).not.toBe(""));
    expect(
      invoke.mock.calls.filter(([action]) => action === "ai:run"),
    ).toHaveLength(1);
    store.detail = {
      ...store.detail!,
      project: { ...store.detail!.project, id: "other-story" },
    };
    store.output = "新故事已有草稿";
    progress({ requestId: activeRequest, delta: "旧故事结果" });
    finish({ text: "旧故事设定" });
    await running;
    expect(store.output).toBe("新故事已有草稿");
    expect(store.detail.project.blueprintCandidates).toEqual([]);
    expect(store.busy).toBe(false);
    await store.flush();
  });
  it("结构化设定建议进入可恢复候选，审核编辑和撤销入口随草稿保存", async () => {
    const store = setup();
    const plan = {
      id: crypto.randomUUID(),
      projectId: "story",
      summary: "完善废土冒险",
      changes: [
        {
          id: crypto.randomUUID(),
          target: "blueprint" as const,
          targetId: "",
          sectionId: "",
          name: "",
          title: "下一站",
          content: "到盐湖寻找燃料。",
          mode: "append" as const,
          basis: "proposal" as const,
          sources: [],
          base: null,
        },
      ],
      warnings: [],
      appliedIds: [],
    };
    invoke.mockImplementation((action) =>
      Promise.resolve(
        action === "ai:run"
          ? { text: "完善废土冒险", developmentDraft: plan }
          : true,
      ),
    );
    await store.runTask("develop");
    await store.flush();
    expect(store.detail!.project.blueprintCandidates[0].development).toEqual(
      plan,
    );
    store.outputKind = "chapter";
    store.output = "之后生成的另一份正文";
    store.reviewDevelopment(plan);
    expect(store.outputKind).toBe("develop");
    expect(store.output).toContain("到盐湖寻找燃料");
    expect(store.output).not.toContain("另一份正文");
    const edited = structuredClone(plan);
    edited.changes[0].content = "先到盐湖，但不要揭示身世。";
    store.editDevelopment(edited);
    store.developmentUndoId = crypto.randomUUID();
    store.scratch();
    await store.flush();
    const saved = invoke.mock.calls
      .filter(([action]) => action === "scratch:save")
      .at(-1)![1];
    expect(saved.developmentDraft.changes[0].content).toContain("不要揭示身世");
    expect(saved.developmentUndoId).toBe(store.developmentUndoId);
    expect(saved.selectedTool).toBe("develop");
    expect(
      store.detail!.project.blueprintCandidates[0].development!.changes[0]
        .content,
    ).toContain("不要揭示身世");
  });
  it("连续点击下一章只创建一章，并将生成结果绑定到新章节", async () => {
    const store = setup();
    const next = {
      ...store.chapter!,
      id: "next-chapter",
      position: 2,
      title: "第二章",
    };
    let release: (value: unknown) => void = () => {};
    invoke.mockImplementation((action) => {
      if (action === "chapter:create")
        return new Promise((resolve) => {
          release = resolve;
        });
      return Promise.resolve(action === "ai:run" ? { text: "新的冒险" } : true);
    });
    const writing = store.runTask("chapter", { newChapter: true });
    await store.runTask("chapter", { newChapter: true });
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.filter(([action]) => action === "chapter:create"),
      ).toHaveLength(1),
    );
    release(next);
    await writing;
    expect(store.detail!.chapters).toHaveLength(2);
    expect(store.outputChapterId).toBe(next.id);
    expect(
      invoke.mock.calls.find(([action]) => action === "ai:run")?.[1].chapterId,
    ).toBe(next.id);
    await store.flush();
  });
  it("建章期间切换故事，迟到的章节不会混入新故事或启动续写", async () => {
    const store = setup();
    const next = {
      ...store.chapter!,
      id: "next-chapter",
      position: 2,
      title: "第二章",
    };
    let release: (value: unknown) => void = () => {};
    invoke.mockImplementation((action) =>
      action === "chapter:create"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(true),
    );
    const writing = store.runTask("chapter", { newChapter: true });
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.some(([action]) => action === "chapter:create"),
      ).toBe(true),
    );
    store.detail = {
      ...store.detail!,
      project: { ...store.detail!.project, id: "other-story" },
    };
    release(next);
    await writing;
    expect(store.detail.chapters).toHaveLength(1);
    expect(invoke.mock.calls.some(([action]) => action === "ai:run")).toBe(
      false,
    );
    await store.flush();
  });
  it("传给桌面桥的是可克隆的普通数据，包含嵌套资料与设置", async () => {
    const store = setup();
    invoke.mockImplementation((_action, payload) =>
      Promise.resolve(structuredClone(payload)),
    );
    const form = reactive({
      text: { key: "local-test" },
      referenceIds: ["one"],
      document: textToDocument("正文"),
    });
    await expect(store.api("test", form)).resolves.toEqual(form);
  });
  it("初次空队列保存后，后续编辑仍然正常保存", async () => {
    const store = setup();
    await store.flush();
    invoke.mockResolvedValue({ dirty: true, updatedAt: "saved" });
    store.editChapter({ document: textToDocument("不会丢失的文字") });
    await store.flush();
    expect(invoke).toHaveBeenCalledWith(
      "chapter:update",
      expect.objectContaining({
        id: "chapter",
        document: textToDocument("不会丢失的文字"),
      }),
    );
  });
  it("没有记忆来源时保存草稿不会发送空的版本 ID", async () => {
    const store = setup();
    invoke.mockResolvedValue(true);
    store.scratch();
    await store.flush();
    expect(invoke).toHaveBeenCalledWith("scratch:save", expect.any(Object));
    expect(invoke.mock.calls[0][1]).not.toHaveProperty("memoryRevisionId");
  });
  it("请求进行中继续编辑，新内容会排队保存且不会被旧响应覆盖", async () => {
    const store = setup();
    let release: (value: unknown) => void = () => {};
    invoke
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve)),
      )
      .mockResolvedValue({ dirty: true, updatedAt: "second" });
    store.editChapter({ document: textToDocument("第一份") });
    const flushing = store.flush();
    store.editChapter({ document: textToDocument("第二份") });
    release({ dirty: true, updatedAt: "first" });
    await flushing;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(store.chapter?.content).toBe("第二份");
    expect(invoke.mock.calls[1][1].document).toEqual(textToDocument("第二份"));
  });
  it("磁盘保存失败时保留待保存内容，允许重试", async () => {
    const store = setup();
    invoke
      .mockRejectedValueOnce(new Error("磁盘暂不可写"))
      .mockResolvedValue({ dirty: true, updatedAt: "saved" });
    store.editChapter({ document: textToDocument("重试后应保留") });
    await expect(store.flush()).rejects.toThrow("不可写");
    expect(store.saveFailed).toBe(true);
    await store.flush();
    expect(store.saveFailed).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
