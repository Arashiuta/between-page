import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  fixture,
  request,
  options,
  node,
  allText,
  proposal,
  settingResponse,
} from "./workbench-fixture";
import { prepareTaskPreview } from "../src/main/conversations";
import { buildContext } from "../src/main/context";
import { taskKinds } from "../src/shared/types";
import { textToDocument } from "../src/shared/document";
import { requestSchema, requestKey } from "../src/shared/requests";
describe("完整统一的故事依据", () => {
  it.each(["polish", "blueprint"] as const)(
    "%s 的目标标识不受 IPC 字段排序影响",
    (kind) => {
      const f = fixture();
      const r =
        kind === "polish"
          ? request(f, kind, {
              selection: { from: 1, to: 3, text: "阿禾" },
              aspect: "expression",
            })
          : request(f, kind, {
              target: {
                level: "chapter",
                count: 1,
                parentId: "f317485a-68f3-4662-8da9-32c389eff634",
                chapterId: f.chapter.id,
              },
            });
      expect(requestKey(r)).toBe(requestKey(requestSchema.parse(r)));
      expect(
        requestKey({
          ...r,
          instruction: "新要求",
          requestId: crypto.randomUUID(),
        }),
      ).toBe(requestKey(r));
    },
  );
  it.each(taskKinds)(
    "%s 的实际消息含完整额外设定、全部设定和关联参考图",
    async (kind) => {
      const f = fixture(kind === "directions" ? "explore" : "novel");
      const outline = node(f, "section", "规划末尾标记".repeat(1500));
      f.repo.updateProject(f.project.id, {
        world: "世界末尾".repeat(3000),
        style: "叙事偏好完整保留",
      });
      const image = {
        id: randomUUID(),
        projectId: f.project.id,
        chapterId: null,
        revisionId: null,
        kind: "reference" as const,
        name: "阿禾的参考图",
        filename: "ref.png",
        prompt: "",
        referenceIds: [],
        model: "",
        createdAt: "",
      };
      f.repo.addImage(image);
      const card = f.repo.saveCard({
        projectId: f.project.id,
        kind: "character",
        name: "阿禾",
        description: "人物资料".repeat(10000),
        constraints: "最后的固定规则",
        sections: [
          {
            id: randomUUID(),
            title: "边界",
            content: "分区尾部",
            sourceIds: [],
          },
        ],
        documents: [
          {
            id: randomUUID(),
            name: "启用原文",
            content: "原始全部内容".repeat(1000),
            enabled: true,
          },
          {
            id: randomUUID(),
            name: "停用原文",
            content: "不能泄漏此原文",
            enabled: false,
          },
        ],
        referenceIds: [image.id],
      });
      f.repo.saveCard({ ...card, id: undefined, name: "世界资料" });
      f.repo.updateChapter(f.chapter.id, {
        document: textToDocument("当前章完整正文"),
      });
      f.repo.adoptChapter(f.chapter.id);
      const r = request(
        f,
        kind,
        kind === "opening"
          ? { chapterId: f.repo.createChapter(f.project.id).id }
          : kind === "polish"
            ? {
                selection: { from: 1, to: 4, text: "当前章" },
                aspect: "expression",
              }
            : {},
      );
      const p = await prepareTaskPreview(f.repo, r, options);
      const actual = p.batches?.[0].preview ?? p,
        text = allText(actual);
      expect(text).toContain(outline.content);
      expect(text).toContain(card.description);
      expect(text).toContain("最后的固定规则");
      expect(text).toContain("分区尾部");
      expect(text).not.toContain("原始全部内容");
      expect(text).not.toContain("不能泄漏此原文");
      expect(actual.images).toHaveLength(1);
      expect(actual.images[0].owners).toEqual(["阿禾", "世界资料"]);
      expect(text).toContain('"type":"image_url"');
      expect(text).toContain("data:image/png;base64");
      expect(card.documents).toEqual([]);
    },
  );
  it("脑暴包含全部非正文资料和未采用候选，不装入正文、快照或其他工具聊天", async () => {
    const f = fixture();
    node(f);
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("正文不能自动进入脑暴"),
    });
    f.repo.checkpoint(f.chapter.id);
    f.repo.addMemory(f.project.id, "fact", "有效作者记忆");
    await proposal(f, request(f, "settings"), settingResponse("候选尚未生效"));
    const p = await prepareTaskPreview(f.repo, request(f), options),
      text = allText(p);
    expect(text).toContain("有效作者记忆");
    expect(text).toContain("候选尚未生效");
    expect(text).toContain("未采用候选");
    expect(text).not.toContain("正文不能自动进入脑暴");
  });
  it("封面不自动作为设定图发送", async () => {
    const f = fixture();
    const id = randomUUID();
    f.repo.addImage({
      id,
      projectId: f.project.id,
      chapterId: null,
      revisionId: null,
      kind: "cover",
      name: "封面",
      filename: "cover.png",
      prompt: "",
      referenceIds: [],
      model: "",
      createdAt: "",
    });
    f.repo.updateProject(f.project.id, {
      cover: { imageId: id, crop: { x: 0, y: 0, width: 1, height: 1 } },
    });
    const readImage = vi.fn(options.readImage);
    const p = await prepareTaskPreview(f.repo, request(f), {
      ...options,
      readImage,
    });
    expect(readImage).not.toHaveBeenCalled();
    expect(p.images).toEqual([]);
  });
  it.each(["nonvision", "unreadable"] as const)(
    "参考图 %s 时阻止请求",
    async (issue) => {
      const f = fixture();
      const id = randomUUID();
      f.repo.addImage({
        id,
        projectId: null,
        chapterId: null,
        revisionId: null,
        kind: "reference",
        name: "必须参考",
        filename: "ref.png",
        prompt: "",
        referenceIds: [],
        model: "",
        createdAt: "",
      });
      f.repo.saveCard({
        projectId: f.project.id,
        kind: "world",
        name: "世界",
        description: "",
        constraints: "",
        referenceIds: [id],
      });
      await expect(
        prepareTaskPreview(f.repo, request(f), {
          ...options,
          capabilities: {
            ...options.capabilities,
            vision: issue !== "nonvision",
          },
          readImage: async () => {
            throw Error("missing");
          },
        }),
      ).rejects.toThrow(issue === "nonvision" ? "支持图片" : "必须参考");
    },
  );
  it("基础资料超预算明确阻止，不能悄悄摘要或截断", async () => {
    const f = fixture();
    f.repo.updateProject(f.project.id, { world: "规则".repeat(10000) });
    await expect(
      buildContext(f.repo, request(f), {
        ...options,
        capabilities: {
          vision: true,
          contextTokens: 16000,
          outputTokens: 1000,
        },
      }),
    ).rejects.toThrow("未截断基础资料");
  });
  it.each([1, 4])("%i 张参考图在读取时分配请求图片预算", async (count) => {
    const f = fixture();
    const ids = Array.from({ length: count }, () => {
      const id = randomUUID();
      f.repo.addImage({
        id,
        projectId: null,
        chapterId: null,
        revisionId: null,
        kind: "reference",
        name: "参考图",
        filename: `${id}.png`,
        prompt: "",
        referenceIds: [],
        model: "",
        createdAt: "",
      });
      return id;
    });
    for (const name of ["人物", "世界"])
      f.repo.saveCard({
        projectId: f.project.id,
        kind: "world",
        name,
        description: "",
        constraints: "",
        referenceIds: ids,
      });
    const readImage = vi.fn(options.readImage);
    const preview = await prepareTaskPreview(f.repo, request(f), {
      ...options,
      readImage,
    });
    expect(preview.images).toHaveLength(count);
    expect(readImage).toHaveBeenCalledTimes(count);
    for (const id of ids)
      expect(readImage).toHaveBeenCalledWith(
        id,
        count === 1 ? 1_000_000 : 750_000,
      );
    for (const image of preview.images) {
      expect(image.owners).toEqual(["人物", "世界"]);
      expect(JSON.stringify(preview.messages)).toContain(image.url);
    }
  });
  it("打磨注入完整长章的中间内容，超限即阻止", async () => {
    const f = fixture(),
      content = "开头".repeat(6000) + "中间重要事实" + "结尾".repeat(6000);
    f.repo.updateChapter(f.chapter.id, { document: textToDocument(content) });
    const r = request(f, "polish", {
      selection: { from: 1, to: 3, text: "开头" },
      aspect: "dialogue",
    });
    expect(allText(await prepareTaskPreview(f.repo, r, options))).toContain(
      content,
    );
    await expect(
      prepareTaskPreview(f.repo, r, {
        ...options,
        capabilities: {
          vision: true,
          contextTokens: 16000,
          outputTokens: 1000,
        },
      }),
    ).rejects.toThrow("上下文预算");
  });
  it("预览标出普通前文的实际截取范围", async () => {
    const f = fixture();
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("旧正文".repeat(5000)),
    });
    const second = f.repo.createChapter(f.project.id);
    const p = await prepareTaskPreview(
      f.repo,
      request(f, "opening", { chapterId: second.id }),
      options,
    );
    expect(p.omitted.join()).toContain("较早");
    expect(allText(p)).toContain("末 6000/15000");
  });
  it.each(["explore", "novel"] as const)(
    "%s 使用自己的工具提示，保存立即参考",
    async (mode) => {
      const f = fixture(mode);
      node(f);
      const p = await prepareTaskPreview(
        f.repo,
        request(f, "blueprint"),
        options,
      );
      expect(allText(p)).toContain(
        mode === "novel" ? "长篇创作额外设定" : "自由探索额外设定",
      );
      expect(allText(p)).toContain("额外设定的全部内容");
      expect(allText(p)).toContain("优先于世界与人物");
    },
  );
  it("请求类型拒绝混合目标、旧工具和未声明参数", () => {
    const f = fixture();
    for (const extra of [
      { kind: "fragment" },
      { kind: "workflow" },
      { kind: "brainstorm", chapterId: f.chapter.id },
      { kind: "polish", chapterId: f.chapter.id, aspect: "expression" },
      { kind: "brainstorm", parentTurnId: randomUUID() },
      {
        kind: "blueprint",
        target: {
          level: "section",
          id: randomUUID(),
          parentId: randomUUID(),
          count: 1,
        },
      },
      {
        kind: "blueprint",
        target: {
          level: "chapter",
          id: randomUUID(),
          chapterId: f.chapter.id,
          count: 1,
        },
      },
    ])
      expect(requestSchema.safeParse({ ...request(f), ...extra }).success).toBe(
        false,
      );
  });
});
