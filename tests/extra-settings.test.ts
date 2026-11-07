import { describe, it, expect } from "vitest";
import { fixture, node, request, options, allText } from "./workbench-fixture";
import { prepareTaskPreview } from "../src/main/conversations";
import { roleSettings } from "../src/main/roles";

describe("额外设定生成规则", () => {
  it.each(["explore", "novel"] as const)(
    "%s 实际请求区分自定义约束与剧情规划，兼容已有自定义职责",
    async (mode) => {
      const f = fixture(mode);
      const section = node(f, "section", "不得直接读取其他角色内心", {
        title: "作者自定义名称",
      });
      if (mode === "novel")
        node(f, "volume", "追查寄信者", { title: "第一卷剧情计划" });
      const saved = {
        commonPrompt: "保留作者通用要求",
        roles: [
          {
            id: "blueprint",
            prompt: "保留旧版自定义职责",
            model: "作者专用模型",
          },
        ],
      };
      f.repo.setSetting("ai.roles", saved);
      for (const target of [
        { level: "section", count: 2 },
        { level: "section", count: 1, id: section.id },
      ]) {
        const preview = await prepareTaskPreview(
          f.repo,
          request(f, "blueprint", { target }),
          options,
        );
        const text = allText(preview);
        for (const expected of [
          "保留作者通用要求",
          "保留旧版自定义职责",
          "文章特殊要求和故事约束",
          "视角限制",
          "能力代价",
          "感情线边界",
          "示例不是固定分类",
          "不得自行生成",
          "剧情梗概或逐章安排",
          "已有大纲仅作背景参考，不能作为输出模板",
          "作者自定义名称",
        ])
          expect(text).toContain(expected);
        const source = preview.sources.find((s) =>
          s.title.includes(section.id),
        )!;
        expect(source.title).toContain("额外设定");
        const block = preview.messages.find((m) =>
          JSON.stringify(m.content).includes(section.id),
        );
        expect(JSON.stringify(block)).toContain(
          "作者自定义的特殊要求与故事约束",
        );
        if (mode === "explore") expect(text).not.toContain("第一卷剧情计划");
      }
      expect(f.repo.getSetting("ai.roles", {})).toEqual(saved);
      expect(
        roleSettings(f.repo).roles.find((r) => r.id === "blueprint")?.model,
      ).toBe("作者专用模型");
      expect(
        f.repo
          .getProject(f.project.id)
          .blueprint.nodes.find((n) => n.id === section.id),
      ).toEqual(section);
    },
  );

  it("大纲请求保留剧情规划输出，与额外设定任务分离", async () => {
    const f = fixture();
    const preview = await prepareTaskPreview(
      f.repo,
      request(f, "outline"),
      options,
    );
    const text = allText(preview);
    expect(text).toContain("按指定层级输出剧情规划");
    expect(text).not.toContain("不得自行生成“第一章……”式章纲");
  });
});
