import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { importTextDocument, refineMaterial } from "../src/main/materials";
import { fixture, request, proposal, options } from "./workbench-fixture";
import { prepareTaskPreview } from "../src/main/conversations";
import { defaultRoleSettings, rolePrompt } from "../src/shared/roles";
describe("资料上传与 AI 提炼", () => {
  it("导入 UTF8、UTF16、GBK，不改原文", () => {
    const text = "# 人物资料\r\n\r\n例外与边界。\r\n";
    expect(importTextDocument("a.txt", Buffer.from(text)).content).toBe(text);
    expect(
      importTextDocument(
        "a.md",
        Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")]),
      ).content,
    ).toBe(text);
    expect(
      importTextDocument("a.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
        .content,
    ).toBe("你好");
  });
  it.each([
    ["empty.txt", "  "],
    ["bad.pdf", "text"],
    ["binary.txt", "\0\x01\x02"],
  ])("拒绝无效文件 %s", (name, text) =>
    expect(() => importTextDocument(name, Buffer.from(text))).toThrow(),
  );
  it("独立资料未保存时也能提炼完整启用原文，保存只保留分区与要点", async () => {
    const f = fixture();
    const doc = importTextDocument(
      "能力.txt",
      Buffer.from("不能复活他人。".repeat(3000)),
    );
    const draft = {
      requestId: randomUUID(),
      kind: "character",
      name: "阿禾",
      description: "旧概述",
      constraints: "旧规则",
      sections: [],
      documents: [
        doc,
        {
          ...doc,
          id: randomUUID(),
          content: "未勾选文档不能发送",
          enabled: false,
        },
      ],
    };
    const generate = vi.fn(async (messages) => {
      const actual = JSON.stringify(messages);
      expect(actual).toContain(doc.content);
      expect(actual).not.toContain("未勾选文档不能发送");
      expect(actual).toContain("旧规则");
      return JSON.stringify({
        description: "旧概述",
        constraints: "旧规则；不能复活他人。",
        sections: [{ title: "能力边界", content: "- 无法复活他人。" }],
      });
    });
    const value = await refineMaterial(draft, {
      prompt: rolePrompt(defaultRoleSettings(), "settings"),
      capabilities: options.capabilities,
      generate,
    });
    expect(f.repo.listCards()).toEqual([]);
    expect(
      f.repo.db.prepare("SELECT count(*) AS n FROM creation_turns").get(),
    ).toEqual({ n: 0 });
    const card = f.api["card:save"]({
      projectId: null,
      kind: draft.kind,
      name: draft.name,
      ...value,
      documents: [doc],
      referenceIds: [],
    }) as ReturnType<typeof f.repo.getCard>;
    expect(card.sections[0]).toMatchObject({
      title: "能力边界",
      content: "- 无法复活他人。",
      sourceIds: [],
    });
    expect(card.constraints).toContain("不能复活他人");
    expect(card.documents).toEqual([]);
    expect(
      JSON.stringify(f.repo.db.prepare("SELECT payload FROM cards").all()),
    ).not.toContain(doc.content);
    const copy = f.repo.copyCard(card.id, f.project.id);
    const preview = await prepareTaskPreview(f.repo, request(f), options);
    expect(JSON.stringify(preview.messages)).toContain("无法复活他人");
    expect(JSON.stringify(preview.messages)).not.toContain(doc.content);
    expect(copy.sourceCardId).toBe(card.id);
  });
  it("指定一份资料不能修改另一份资料或全书设定", async () => {
    const f = fixture();
    const card = f.repo.saveCard({
      projectId: f.project.id,
      kind: "character",
      name: "阿禾",
      description: "",
      constraints: "",
      referenceIds: [],
    });
    await expect(
      proposal(
        f,
        request(f, "settings", { cardId: card.id }),
        '{"changes":[{"type":"project","field":"world","content":"越界"}]}',
      ),
    ).rejects.toThrow("只允许修改");
  });
  it("复制模板保留独立只读分区，资料库修改和删除不影响故事副本", () => {
    const f = fixture(),
      doc = importTextDocument("原文.txt", Buffer.from("原始文字"));
    const card = f.repo.saveCard({
      projectId: null,
      kind: "world",
      name: "模板",
      description: "概述",
      constraints: "约束",
      sections: [
        {
          id: randomUUID(),
          title: "规则",
          content: "资料",
          sourceIds: [doc.id],
        },
      ],
      documents: [doc],
      referenceIds: [],
    });
    const copy = f.repo.copyCard(card.id, f.project.id);
    f.repo.saveCard({ ...card, description: "后来编辑", documents: [] });
    expect(f.repo.getCard(copy.id).description).toBe("概述");
    expect(f.repo.getCard(copy.id).documents).toEqual([]);
    expect(copy.sections[0].sourceIds).toEqual([]);
    expect(copy.sourceCardId).toBe(card.id);
    expect(() => f.repo.saveCard({ ...copy, description: "越权修改" })).toThrow(
      "只读",
    );
    f.repo.deleteCard(card.id);
    expect(f.repo.getCard(copy.id).description).toBe("概述");
    expect(() =>
      f.repo.saveCard({ ...copy, description: "删除来源后修改" }),
    ).toThrow("只读");
  });
  it("新建故事时引入的资料也只读，本书手工创建的资料仍能编辑", () => {
    const f = fixture();
    const source = f.repo.saveCard({
      projectId: null,
      kind: "world",
      name: "海港",
      description: "规则",
      constraints: "",
      referenceIds: [],
    });
    const project = f.repo.createProject({
      title: "故事",
      premise: "",
      mode: "explore",
      cardIds: [source.id],
    });
    const copy = f.repo.getDetail(project.id).cards[0];
    expect(copy.sourceCardId).toBe(source.id);
    expect(() =>
      f.repo.saveCard({ ...copy, sourceCardId: null } as any),
    ).toThrow("只读");
    const local = f.repo.saveCard({
      ...source,
      id: undefined,
      projectId: project.id,
    });
    expect(
      f.repo.saveCard({ ...local, description: "本书新设定" }).description,
    ).toBe("本书新设定");
  });
  it("AI 建议不能改写从资料库引入的内容", async () => {
    const f = fixture();
    const source = f.repo.saveCard({
      projectId: null,
      kind: "character",
      name: "阿禾",
      description: "原设定",
      constraints: "",
      referenceIds: [],
    });
    const copy = f.repo.copyCard(source.id, f.project.id);
    await expect(
      proposal(
        f,
        request(f, "settings", { cardId: copy.id }),
        JSON.stringify({
          changes: [
            {
              type: "card",
              cardId: copy.id,
              kind: copy.kind,
              name: copy.name,
              field: "description",
              title: "",
              content: "修改",
            },
          ],
        }),
      ),
    ).rejects.toThrow("只读");
    expect(f.repo.getCard(copy.id).description).toBe("原设定");
  });
  const draft = () => ({
    requestId: randomUUID(),
    kind: "world",
    name: "海港",
    description: "",
    constraints: "",
    sections: [],
    documents: [importTextDocument("世界.md", Buffer.from("只能在雾夜出航。"))],
  });
  it.each([
    "不是 JSON",
    '{"description":"","constraints":"","sections":[]}',
    '{"description":"概述","constraints":"","sections":[{"title":"","content":"内容"}]}',
  ])("无效提炼结果不写入资料：%s", async (response) => {
    await expect(
      refineMaterial(draft(), {
        prompt: "提炼",
        capabilities: options.capabilities,
        generate: async () => response,
      }),
    ).rejects.toThrow("资料未修改");
  });
  it("失败保留输入；超出上下文或没有启用文档时不调用模型", async () => {
    const input = draft(),
      original = structuredClone(input),
      generate = vi.fn(async () => {
        throw Error("服务离线");
      });
    await expect(
      refineMaterial(input, {
        prompt: "提炼",
        capabilities: options.capabilities,
        generate,
      }),
    ).rejects.toThrow("服务离线");
    expect(input).toEqual(original);
    generate.mockClear();
    await expect(
      refineMaterial(input, {
        prompt: "提炼",
        capabilities: { ...options.capabilities, contextTokens: 1 },
        generate,
      }),
    ).rejects.toThrow("上下文预算");
    input.documents[0].enabled = false;
    await expect(
      refineMaterial(input, {
        prompt: "提炼",
        capabilities: options.capabilities,
        generate,
      }),
    ).rejects.toThrow("勾选");
    expect(generate).not.toHaveBeenCalled();
  });
});
