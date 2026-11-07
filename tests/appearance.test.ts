import { describe, it, expect, vi } from "vitest";
import { StoryRepository } from "../src/main/database";
import {
  activeColors,
  appearanceTokens,
  defaultAppearance,
  normalizeSoftware,
  themePresets,
} from "../src/shared/appearance";
import { naiveTheme } from "../src/renderer/theme";
import { helpCategories, searchHelp } from "../src/shared/help";
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "test" },
  safeStorage: {},
  dialog: {},
}));
import {
  saveSoftwareSettings,
  softwareSettings,
  saveSettings,
  settings,
} from "../src/main/storage";

describe("外观设置", () => {
  it("剧情走向数量默认3，可保存1至5，拒绝越界或非整数且保留原设置", () => {
    const repo = new StoryRepository(":memory:");
    try {
      expect(softwareSettings(repo).directionCount).toBe(3);
      for (const directionCount of [1, 3, 5]) {
        saveSoftwareSettings(repo, { directionCount });
        expect(softwareSettings(repo).directionCount).toBe(directionCount);
      }
      for (const directionCount of [0, 6, 2.5])
        expect(() => saveSoftwareSettings(repo, { directionCount })).toThrow();
      expect(softwareSettings(repo).directionCount).toBe(5);
      expect(normalizeSoftware({ directionCount: 99 }).directionCount).toBe(3);
    } finally {
      repo.close();
    }
  });
  it("旧设置与损坏字段逐项补默认，不影响有效的关闭偏好", () => {
    expect(
      normalizeSoftware({
        closeAction: "quit",
        appearance: { uiFontSize: 999, editorFontSize: 22, theme: "broken" },
      }),
    ).toEqual({
      closeAction: "quit",
      directionCount: 3,
      appearance: { ...defaultAppearance(), editorFontSize: 22 },
    });
    expect(normalizeSoftware(null).appearance).toEqual(defaultAppearance());
  });
  it("局部保存、模型更新与恢复默认保留各自配置，自定义颜色可跨主题保留", () => {
    const repo = new StoryRepository(":memory:");
    try {
      const customColors = { ...themePresets[1].colors, primary: "#126789" };
      saveSoftwareSettings(repo, { closeAction: "minimize" });
      saveSoftwareSettings(repo, {
        appearance: {
          uiFontSize: 20,
          theme: "custom",
          customBase: "sage",
          customColors,
        },
      });
      saveSoftwareSettings(repo, { appearance: { editorFontSize: 32 } });
      saveSettings(repo, "test", settings(repo, "test"));
      expect(softwareSettings(repo)).toMatchObject({
        closeAction: "minimize",
        appearance: { uiFontSize: 20, editorFontSize: 32, customColors },
      });
      saveSoftwareSettings(repo, { appearance: { theme: "night" } });
      expect(softwareSettings(repo).appearance.customColors).toEqual(
        customColors,
      );
      saveSoftwareSettings(repo, { appearance: { theme: "custom" } });
      expect(activeColors(softwareSettings(repo).appearance)).toEqual(
        customColors,
      );
      saveSoftwareSettings(repo, { appearance: defaultAppearance() });
      expect(softwareSettings(repo)).toEqual({
        closeAction: "minimize",
        directionCount: 3,
        appearance: defaultAppearance(),
      });
    } finally {
      repo.close();
    }
  });
  it("拒绝非法字号与颜色，原设置保持可用", () => {
    const repo = new StoryRepository(":memory:");
    try {
      for (const appearance of [
        { uiFontSize: 21 },
        { editorFontSize: 13 },
        { uiFontSize: 14.5 },
        { customColors: { ...themePresets[0].colors, ink: "invalid" } },
      ])
        expect(() => saveSoftwareSettings(repo, { appearance })).toThrow();
      expect(softwareSettings(repo).appearance).toEqual(defaultAppearance());
    } finally {
      repo.close();
    }
  });
  it("四款主题和自定义的应用样式与控件共享颜色，字号分别生效", () => {
    for (const preset of themePresets) {
      const appearance = {
        ...defaultAppearance(),
        theme: preset.id,
        uiFontSize: 20,
        editorFontSize: 32,
      };
      const tokens = appearanceTokens(appearance),
        naive = naiveTheme(appearance);
      expect(naive.common?.primaryColor).toBe(tokens.primary);
      expect(naive.common?.cardColor).toBe(tokens.surface);
      expect(tokens["ui-font-size"]).toBe("20px");
      expect(tokens["story-font-size"]).toBe("32px");
      expect(tokens["on-primary"]).not.toBe(tokens.primary);
    }
  });
});
describe("帮助检索与导航", () => {
  it("可搜索操作步骤、问答与分类，空白恢复完整目录，无匹配时返回空", () => {
    expect(
      searchHelp(" 2:1 ")
        .flatMap((c) => c.articles)
        .map((a) => a.id),
    ).toContain("story-cover");
    expect(
      searchHelp("GET /models")
        .flatMap((c) => c.articles)
        .map((a) => a.id),
    ).toContain("faq-models");
    expect(searchHelp("快速开始")[0].articles).toEqual(
      helpCategories.find((category) => category.id === "start")!.articles,
    );
    expect(searchHelp(" ")).toEqual(helpCategories);
    expect(searchHelp("不存在的帮助词9876")).toEqual([]);
  });
  it("锚点唯一且页面链接能命中现有路由及设置页签", () => {
    const ids = helpCategories.flatMap((c) => [
      c.id,
      ...c.articles.map((a) => a.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of helpCategories)
      for (const article of category.articles)
        for (const link of article.links ?? [])
          expect([
            "/",
            "/cards",
            "/gallery",
            "/roles",
            "/settings?tab=models",
            "/settings?tab=software",
          ]).toContain(link.to);
  });
});
