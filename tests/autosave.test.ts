import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";
import { reactive } from "vue";
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
      text: { ...input.text, hasKey: !!input.text.key },
      image: { ...input.image, hasKey: !!input.image.key },
      dataDir: "test",
      version: "test",
    };
  }
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
