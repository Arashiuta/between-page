import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { randomUUID } from "node:crypto";
import { StoryRepository } from "../src/main/database";
import { useWorkspace } from "../src/renderer/stores/workspace";
import { textToDocument } from "../src/shared/document";
import type { CardKind, ImageAsset } from "../src/shared/types";

const repositories: StoryRepository[] = [];
function setup(kind: CardKind = "character") {
  const repo = new StoryRepository(":memory:");
  repositories.push(repo);
  const image: ImageAsset = {
    id: randomUUID(),
    projectId: null,
    chapterId: null,
    revisionId: null,
    kind: "reference",
    name: "共享参考图",
    filename: "reference.png",
    prompt: "",
    referenceIds: [],
    model: "",
    createdAt: "",
  };
  repo.addImage(image);
  const documentId = randomUUID();
  const source = repo.saveCard({
    projectId: null,
    kind,
    name: "待删除资料",
    description: "完整资料内容",
    constraints: "固定规则",
    sections: [
      {
        id: randomUUID(),
        title: "资料分区",
        content: "分区正文",
        sourceIds: [documentId],
      },
    ],
    documents: [
      {
        id: documentId,
        name: "原始文档.txt",
        content: "必须完整保留的原文",
        enabled: true,
      },
    ],
    referenceIds: [image.id],
  });
  const sameName = repo.saveCard({ ...source, id: undefined });
  const project = repo.createProject({
    title: "使用资料的故事",
    premise: "",
    mode: "novel",
  });
  const copy = repo.copyCard(source.id, project.id);
  return { repo, source, sameName, project, copy, image };
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

describe("创作资料删除", () => {
  it.each(["character", "world", "inspiration"] as const)(
    "按 ID 删除 %s 条目和原文，保留故事副本、同名资料及共享图片",
    (kind) => {
      const { repo, source, sameName, project, copy, image } = setup(kind);
      expect(repo.deleteCard(source.id)).toEqual(source);
      expect(() => repo.getCard(source.id)).toThrow("不存在");
      expect(
        repo.db.prepare("SELECT id FROM cards WHERE id = ?").get(source.id),
      ).toBeUndefined();
      expect(repo.listCards()).toEqual([sameName]);
      expect(repo.getDetail(project.id).cards).toEqual([copy]);
      expect(repo.getImage(image.id)).toEqual(image);
      expect(repo.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => repo.saveCard(source)).toThrow("不存在");
    },
  );

  it("不存在的资料删除报错，不改变其他条目", () => {
    const { repo } = setup();
    const before = repo.listCards();
    expect(() => repo.deleteCard(randomUUID())).toThrow("不存在");
    expect(repo.listCards()).toEqual(before);
  });

  it.each(["character", "world"] as const)(
    "删除故事内 %s 副本时保留资料库、其他故事、正文、记忆和图片",
    (kind) => {
      const { repo, source, sameName, project, copy, image } = setup(kind);
      const other = repo.createProject({
        title: "另一个故事",
        premise: "",
        mode: "explore",
      });
      const otherCopy = repo.copyCard(source.id, other.id);
      const chapter = repo.getDetail(project.id).chapters[0];
      repo.updateChapter(chapter.id, {
        document: textToDocument("已经写下的角色经历。"),
      });
      repo.adoptChapter(chapter.id);
      repo.addMemory(project.id, "fact", "角色曾在此停留。");
      const before = repo.getDetail(project.id);
      repo.deleteCard(copy.id);
      expect(() => repo.getCard(copy.id)).toThrow("不存在");
      const after = repo.getDetail(project.id);
      expect(after.cards).toEqual([]);
      expect(after.chapters).toEqual(before.chapters);
      expect(after.memories).toEqual(before.memories);
      expect(repo.listCards()).toEqual(
        expect.arrayContaining([source, sameName]),
      );
      expect(repo.getDetail(other.id).cards).toEqual([otherCopy]);
      expect(repo.getImage(image.id)).toEqual(image);
    },
  );
});

function setupStore() {
  const fixture = setup();
  const { repo, project } = fixture;
  const invoke = vi.fn(async (action: string, payload: unknown) => {
    if (action === "card:delete") return repo.deleteCard(payload as string);
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
  store.cards = repo.listCards();
  store.images = repo.listImages();
  store.detail = repo.getDetail(project.id);
  store.chapterId = store.detail.chapters[0].id;
  return { ...fixture, store, invoke };
}

describe("资料删除与工作区状态", () => {
  it("删除故事资料后立即移除当前卡片，保留资料库与待保存正文", async () => {
    const { repo, source, sameName, copy, image, store } = setupStore();
    store.editChapter({ document: textToDocument("未保存的冒险") });
    await store.deleteCard(copy.id);
    expect(store.detail?.cards).toEqual([]);
    expect(store.cards).toEqual(expect.arrayContaining([source, sameName]));
    expect(store.images).toEqual([image]);
    expect(store.chapter?.content).toBe("未保存的冒险");
    await store.flush();
    expect(repo.getChapter(store.chapterId).content).toBe("未保存的冒险");
  });

  it("删除后立即更新资料列表，保留当前故事副本、参考图和待保存正文", async () => {
    const { repo, source, sameName, copy, image, store, invoke } = setupStore();
    store.editChapter({ document: textToDocument("尚未保存的正文") });
    const chapterId = store.chapterId;
    await store.deleteCard(source.id);
    expect(invoke).toHaveBeenCalledWith("card:delete", source.id);
    expect(store.cards).toEqual([sameName]);
    expect(store.detail?.cards).toEqual([copy]);
    expect(store.images).toEqual([image]);
    expect(store.chapterId).toBe(chapterId);
    expect(store.chapter?.content).toBe("尚未保存的正文");
    expect(store.toast?.message).toContain(source.name);
    await store.flush();
    expect(repo.getChapter(chapterId).content).toBe("尚未保存的正文");
  });

  it("数据库删除失败时保留资料列表与故事副本，并显示错误", async () => {
    const { repo, source, store } = setupStore();
    const cards = JSON.parse(JSON.stringify(store.cards));
    const detail = JSON.parse(JSON.stringify(store.detail));
    repo.db.exec(
      "CREATE TRIGGER reject_card_deletion BEFORE DELETE ON cards BEGIN SELECT RAISE(ABORT, '删除失败'); END",
    );
    await store.safe(() => store.deleteCard(source.id));
    expect(store.toast).toMatchObject({ type: "error", message: "删除失败" });
    expect(store.cards).toEqual(cards);
    expect(store.detail).toEqual(detail);
    expect(repo.getCard(source.id)).toEqual(source);
  });
});
