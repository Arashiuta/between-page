import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { StoryRepository } from "../src/main/database";
import {
  buildChapterTitleMessages,
  parseChapterTitle,
} from "../src/main/chapter-title";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";

const repositories: StoryRepository[] = [];
function setup() {
  const repo = new StoryRepository(":memory:");
  repositories.push(repo);
  const project = repo.createProject({
    title: "公路旅途",
    premise: "未来秘密 SECRET_PREMISE",
    mode: "explore",
  });
  const current = repo.getDetail(project.id).chapters[0];
  repo.updateChapter(current.id, {
    document: textToDocument("其他章节 PRIVATE_OTHER_CHAPTER"),
  });
  const target = repo.createChapter(project.id);
  return { repo, project, current, target };
}
beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AI 章节命名", () => {
  it("只以右键目标章的正文命名，不引入未来计划或其他章节，也不直接改名", () => {
    const { repo, project, target } = setup();
    repo.updateChapter(target.id, {
      document: textToDocument("旅人在沙暴中修复车轴。"),
      plan: "未发生的背叛 SECRET_PLAN",
    });
    repo.adoptChapter(target.id);
    const before = repo.getDetail(project.id);
    const revisions = repo.listRevisions(target.id);
    const messages = buildChapterTitleMessages(repo, project.id, target.id);
    expect(messages[1].content).toContain("沙暴中修复车轴");
    expect(messages[1].content).not.toContain("PRIVATE_OTHER_CHAPTER");
    expect(messages[1].content).not.toContain("SECRET_PLAN");
    expect(messages[1].content).not.toContain("SECRET_PREMISE");
    expect(messages[0].content).toContain('"title"');
    expect(repo.getDetail(project.id)).toEqual(before);
    expect(repo.listRevisions(target.id)).toEqual(revisions);
  });
  it("空正文使用本章计划；正文和计划都空时明确提示", () => {
    const { repo, project, target } = setup();
    expect(() =>
      buildChapterTitleMessages(repo, project.id, target.id),
    ).toThrow("正文或章节计划");
    repo.updateChapter(target.id, { plan: "旅人在盐湖边找到驿站。" });
    const messages = buildChapterTitleMessages(repo, project.id, target.id);
    expect(messages[1].content).toContain("根据本章计划拟名");
    expect(messages[1].content).toContain("盐湖边找到驿站");
  });
  it("验证章节所属，长章仍保留开头与结尾", () => {
    const { repo, project, target } = setup();
    const other = repo.createProject({
      title: "另一故事",
      premise: "",
      mode: "explore",
    });
    repo.updateChapter(target.id, {
      document: textToDocument("开头沙暴" + "旅途".repeat(14000) + "结尾渡桥"),
    });
    expect(() => buildChapterTitleMessages(repo, other.id, target.id)).toThrow(
      "不属于",
    );
    const prompt = buildChapterTitleMessages(repo, project.id, target.id)[1]
      .content;
    expect(prompt).toContain("开头沙暴");
    expect(prompt).toContain("结尾渡桥");
    expect(prompt).toContain("中段省略");
    expect(prompt.length).toBeLessThan(25000);
  });
  it("兼容 JSON 代码围栏，拒绝空白、多行或超长名称及错误结构", () => {
    expect(
      parseChapterTitle('```json\n{"title":"  沙暴中的车轮  "}\n```'),
    ).toBe("沙暴中的车轮");
    for (const value of [
      '{"title":""}',
      '{"title":"一行\\n另一行"}',
      '{"title":123}',
      JSON.stringify({ title: "长".repeat(101) }),
      "名字：沙暴",
    ])
      expect(() => parseChapterTitle(value)).toThrow("原名称未修改");
  });
  it("旧职责设置自动补入命名职责，且共用和自定义命名要求仍生效", () => {
    const { repo, project, target } = setup();
    repo.updateChapter(target.id, { plan: "在驿站歇脚" });
    repo.setSetting("ai.roles", { commonPrompt: "用简洁中文。", roles: [] });
    expect(
      buildChapterTitleMessages(repo, project.id, target.id)[0].content,
    ).toContain("单个故事章节命名");
    repo.setSetting("ai.roles", {
      commonPrompt: "用简洁中文。",
      roles: [{ id: "title", prompt: "使用四字章名。", model: "" }],
    });
    const prompt = buildChapterTitleMessages(repo, project.id, target.id)[0]
      .content;
    expect(prompt).toContain("用简洁中文");
    expect(prompt).toContain("四字章名");
    expect(prompt).toContain('"title"');
  });
});

describe("按目标章节保存名称", () => {
  function setupStore() {
    const fixture = setup();
    const invoke = vi.fn(
      async (
        action: string,
        payload: {
          id: string;
          title?: string;
          document?: ReturnType<typeof textToDocument>;
        },
      ) => {
        if (action === "chapter:update") {
          const { id, ...patch } = payload;
          return fixture.repo.updateChapter(id, patch);
        }
        throw new Error("不支持的测试操作");
      },
    );
    vi.stubGlobal("window", { storybook: { invoke } });
    const store = useWorkspace();
    store.detail = fixture.repo.getDetail(fixture.project.id);
    store.chapterId = fixture.current.id;
    return { ...fixture, store, invoke };
  }
  it("编辑非当前章名称保留正在编辑的正文、当前章节、选区和工作台输出", async () => {
    const { repo, current, target, store } = setupStore();
    store.editChapter({ document: textToDocument("当前章尚未保存的正文") });
    store.output = "已有的 AI 正文草稿";
    store.selection = { text: "正文", from: 1, to: 3 };
    store.renameChapter(target.id, "  沙暴中的车轮  ");
    await store.flush();
    expect(store.chapterId).toBe(current.id);
    expect(store.output).toBe("已有的 AI 正文草稿");
    expect(store.selection?.text).toBe("正文");
    expect(repo.getChapter(target.id).title).toBe("沙暴中的车轮");
    expect(repo.getChapter(current.id).content).toBe("当前章尚未保存的正文");
  });
  it("改名合并到同一章待保存的正文，保存失败后可以重试", async () => {
    const { repo, current, store, invoke } = setupStore();
    store.editChapter({ document: textToDocument("保留的正文") });
    store.renameChapter(current.id, "新的章名");
    invoke.mockRejectedValueOnce(new Error("磁盘不可写"));
    await expect(store.flush()).rejects.toThrow("不可写");
    expect(store.chapter?.title).toBe("新的章名");
    await store.flush();
    expect(repo.getChapter(current.id)).toMatchObject({
      title: "新的章名",
      content: "保留的正文",
    });
  });
  it("空名称或其他故事章节不会进入保存队列", async () => {
    const { target, store, invoke } = setupStore();
    expect(() => store.renameChapter(target.id, "   ")).toThrow("名称");
    expect(() =>
      store.renameChapter("other-chapter", "不能改别本故事"),
    ).toThrow("不属于");
    await store.flush();
    expect(invoke).not.toHaveBeenCalled();
  });
});
