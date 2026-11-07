import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixture,
  request,
  run,
  proposal,
  options,
  allText,
  node,
} from "./workbench-fixture";
import { applyChangeSet } from "../src/main/changes";
import { prepareTaskPreview } from "../src/main/conversations";
import { directionView } from "../src/main/exploration";
import { textToDocument } from "../src/shared/document";
import { requestSchema } from "../src/shared/requests";
import type { DirectionView, TaskPreview } from "../src/shared/types";

const response = (count = 3) =>
  JSON.stringify({
    options: Array.from({ length: count }, (_, i) => ({
      title: `方向${i + 1}`,
      content: `主角沿第${i + 1}条线索调查。`,
    })),
  });
function story(filename = ":memory:") {
  const f = fixture("explore", filename);
  f.repo.updateChapter(f.chapter.id, {
    document: textToDocument("阿禾在城门收到一封信，信封尚未打开。"),
  });
  return f;
}
function choose(
  f: ReturnType<typeof story>,
  instruction = "先拆开信封，再决定去向。",
  selectedId: string | null = null,
) {
  const view = directionView(f.repo, f.project.id, f.chapter.id);
  return f.api["directions:choose"]({
    projectId: f.project.id,
    chapterId: f.chapter.id,
    sourceFingerprint: view.sourceFingerprint,
    basis: view.basis,
    selectedId,
    instruction,
  }) as DirectionView;
}
function next(
  f: ReturnType<typeof story>,
  view = directionView(f.repo, f.project.id, f.chapter.id),
) {
  return f.api["exploration:create-next"]({
    projectId: f.project.id,
    chapterId: f.chapter.id,
    sourceFingerprint: view.sourceFingerprint,
    basis: view.basis,
  }) as typeof f.chapter;
}

describe("自由探索的剧情走向", () => {
  it.each([1, 3, 5])(
    "生成 %s 个只读走向，保存模型与实际来源，不写入正文或记忆",
    async (count) => {
      const f = story(),
        before = f.repo.getDetail(f.project.id);
      const result = await run(
        f,
        request(f, "directions", { count }),
        response(count),
      );
      expect(result.result.type).toBe("directions");
      const view = directionView(f.repo, f.project.id, f.chapter.id);
      expect(view.state?.options).toHaveLength(count);
      expect(view.stale).toBe(false);
      expect(view.state).toMatchObject({
        model: options.model,
        turnId: result.turnId,
        instruction: "",
        selectedId: null,
      });
      expect(f.repo.getDetail(f.project.id)).toEqual(before);
      expect(f.api["changes:list"](f.project.id)).toEqual([]);
      const preview = f.api["directions:preview"]({
        projectId: f.project.id,
        chapterId: f.chapter.id,
      }) as TaskPreview;
      expect(allText(preview)).toContain(before.chapters[0].content);
    },
  );
  it.each([0, 6, 2.5])("拒绝非法走向数量 %s", (count) => {
    const f = story();
    expect(
      requestSchema.safeParse(request(f, "directions", { count })).success,
    ).toBe(false);
  });
  it("拒绝数量不足与重复走向，不保存不完整结果", async () => {
    const f = story();
    await expect(
      run(f, request(f, "directions"), response(1)),
    ).rejects.toThrow();
    await expect(
      run(
        f,
        request(f, "directions", { count: 2 }),
        '{"options":[{"title":"相同","content":"相同"},{"title":"相同","content":"相同"}]}',
      ),
    ).rejects.toThrow("重复");
    expect(directionView(f.repo, f.project.id, f.chapter.id).state).toBeNull();
  });
  it("自动走向只接受已写入开篇或续写，同一次采用重复触发不重复调用模型", async () => {
    const f = fixture("explore");
    const set = await proposal(f, request(f, "opening"), "作者尚未审核的正文");
    const r = request(f, "directions", { triggerChangeSetId: set.id });
    await expect(run(f, r, response())).rejects.toThrow("先写入");
    applyChangeSet(f.repo, f.project.id, set.id, [
      { id: set.changes[0].id, after: "作者最终编辑并写入的正文" },
    ]);
    const generate = vi.fn(async () => response());
    const first = await run(f, r, "", { generate });
    const second = await run(f, { ...r, requestId: randomUUID() }, "", {
      generate,
    });
    expect(second.turnId).toBe(first.turnId);
    expect(generate).toHaveBeenCalledTimes(1);
    const preview = f.api["directions:preview"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
    }) as TaskPreview;
    expect(allText(preview)).toContain("作者最终编辑并写入的正文");
    expect(allText(preview)).not.toContain("作者尚未审核的正文");
  });
  it.each(["正文", "依据", "模式"])(
    "生成期间%s改变，结果不能覆盖当前走向",
    async (kind) => {
      const f = story();
      await expect(
        run(f, request(f, "directions"), "", {
          generate: async () => {
            if (kind === "正文")
              f.repo.updateChapter(f.chapter.id, {
                document: textToDocument("新的正文"),
              });
            if (kind === "依据")
              f.repo.addMemory(f.project.id, "knowledge", "主角已经知道身份");
            if (kind === "模式")
              f.repo.updateProject(f.project.id, { mode: "novel" });
            return response();
          },
        }),
      ).rejects.toThrow("已变化");
      expect(
        directionView(f.repo, f.project.id, f.chapter.id).state,
      ).toBeNull();
    },
  );
  it("停止或模型失败不影响已写入正文，走向可以单独重试", async () => {
    const f = story(),
      original = f.repo.getChapter(f.chapter.id).content;
    const controller = new AbortController();
    await expect(
      run(f, request(f, "directions"), "", {
        signal: controller.signal,
        generate: async () => {
          controller.abort();
          return response();
        },
      }),
    ).rejects.toThrow("停止");
    await expect(
      run(f, request(f, "directions"), "", {
        generate: async () => {
          throw Error("模型失败");
        },
      }),
    ).rejects.toThrow("模型失败");
    expect(f.repo.getChapter(f.chapter.id).content).toBe(original);
    await run(f, request(f, "directions"), response());
    expect(
      directionView(f.repo, f.project.id, f.chapter.id).state?.options,
    ).toHaveLength(3);
  });
  it("选项可编辑，一键建章携带来源全文与最终走向，失败重试复用空章", async () => {
    const f = story();
    await run(f, request(f, "directions"), response());
    const option = directionView(f.repo, f.project.id, f.chapter.id).state!
      .options[0];
    const view = choose(f, "作者修改：先查信纸上的水印。", option.id);
    const chapter = next(f, view);
    expect(chapter.explorationSource?.instruction).toContain(
      "先查信纸上的水印",
    );
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
    const r = request(f, "opening", { chapterId: chapter.id });
    const preview = await prepareTaskPreview(f.repo, r, options);
    expect(allText(preview)).toContain("阿禾在城门收到一封信");
    expect(allText(preview)).toContain("作者修改：先查信纸上的水印。");
    await expect(
      run(f, r, "", {
        generate: async () => {
          throw Error("离线");
        },
      }),
    ).rejects.toThrow("离线");
    expect(next(f, view).id).toBe(chapter.id);
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
    await run(f, r, "阿禾举起信纸观察水印。");
    expect(f.repo.getChapter(chapter.id).content).toBe("");
    expect(f.repo.getDetail(f.project.id).memories).toEqual([]);
  });
  it("不用生成选项也可以输入走向；已有下一章正文后不重复建章", () => {
    const f = story();
    choose(f);
    const chapter = next(f);
    f.repo.updateChapter(chapter.id, {
      document: textToDocument("下一章已经写下"),
    });
    expect(() => next(f)).toThrow("下一章已存在");
    expect(f.repo.getDetail(f.project.id).chapters).toHaveLength(2);
  });
  it("下一章候选生成后来源正文被修改，审核不能写入过时正文", async () => {
    const f = story();
    choose(f);
    const chapter = next(f);
    const set = await proposal(
      f,
      request(f, "opening", { chapterId: chapter.id }),
      "阿禾打开了信封。",
    );
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("阿禾已将信封退回，手中不再有信。"),
    });
    expect(() =>
      applyChangeSet(
        f.repo,
        f.project.id,
        set.id,
        set.changes.map((c) => ({ id: c.id, after: c.after })),
      ),
    ).toThrow("上一章正文或故事依据已变化");
    expect(f.repo.getChapter(chapter.id).content).toBe("");
  });
  it("删除创作对话后仍可查看走向生成时的独立来源快照", async () => {
    const f = story();
    const result = await run(f, request(f, "directions"), response());
    f.api["conversation:delete"]({
      projectId: f.project.id,
      id: result.conversationId,
    });
    const preview = f.api["directions:preview"]({
      projectId: f.project.id,
      chapterId: f.chapter.id,
    }) as TaskPreview;
    expect(allText(preview)).toContain("阿禾在城门收到一封信");
    expect(
      directionView(f.repo, f.project.id, f.chapter.id).state?.options,
    ).toHaveLength(3);
  });
  it("完整发送来源章，不受普通前文末尾截取限制；先前章节编辑也会使走向失效", async () => {
    const f = story();
    const source = f.repo.createChapter(f.project.id);
    const body = "来源章开头必须保留" + "完整正文".repeat(2000) + "来源章结尾";
    f.repo.updateChapter(source.id, { document: textToDocument(body) });
    const view = directionView(f.repo, f.project.id, source.id);
    const chosen = f.api["directions:choose"]({
      projectId: f.project.id,
      chapterId: source.id,
      sourceFingerprint: view.sourceFingerprint,
      basis: view.basis,
      selectedId: null,
      instruction: "继续查证",
    }) as DirectionView;
    const chapter = f.api["exploration:create-next"]({
      projectId: f.project.id,
      chapterId: source.id,
      sourceFingerprint: chosen.sourceFingerprint,
      basis: chosen.basis,
    }) as typeof f.chapter;
    const preview = await prepareTaskPreview(
      f.repo,
      request(f, "opening", { chapterId: chapter.id }),
      options,
    );
    expect(allText(preview)).toContain(body);
    await expect(
      prepareTaskPreview(
        f.repo,
        request(f, "opening", { chapterId: chapter.id }),
        {
          ...options,
          capabilities: { ...options.capabilities, contextTokens: 10000 },
        },
      ),
    ).rejects.toThrow("上下文预算");
    f.repo.updateChapter(f.chapter.id, {
      document: textToDocument("更早章节发生了修改"),
    });
    expect(directionView(f.repo, f.project.id, source.id).stale).toBe(true);
    await expect(
      prepareTaskPreview(
        f.repo,
        request(f, "opening", { chapterId: chapter.id }),
        options,
      ),
    ).rejects.toThrow("已变化");
  });
  it.each(["正文", "额外设定", "资料", "记忆"])(
    "%s变化使走向过时，禁止使用旧选项或旧建章请求",
    async (kind) => {
      const f = story();
      await run(f, request(f, "directions"), response());
      const old = choose(f);
      if (kind === "正文")
        f.repo.updateChapter(f.chapter.id, {
          document: textToDocument("信封已被打开"),
        });
      if (kind === "额外设定") node(f, "section", "不允许主角离开城市");
      if (kind === "资料")
        f.repo.updateProject(f.project.id, { world: "这里禁止魔法" });
      if (kind === "记忆")
        f.repo.addMemory(f.project.id, "state", "主角右手受伤");
      const current = directionView(f.repo, f.project.id, f.chapter.id);
      expect(current.stale).toBe(true);
      expect(() => next(f, old)).toThrow("过时");
      expect(() => choose(f, "沿旧选项", old.state!.options[0].id)).toThrow(
        "过时",
      );
      choose(f, "根据变化后的故事重新决定行动。");
      expect(directionView(f.repo, f.project.id, f.chapter.id).stale).toBe(
        false,
      );
      expect(next(f).position).toBe(2);
    },
  );
  it("非末章不能新建后续章；跨作品走向请求被拒绝", () => {
    const f = story();
    choose(f);
    f.repo.createChapter(f.project.id);
    expect(() => next(f)).toThrow("最后一章");
    const other = f.repo.createProject({
      title: "另一个故事",
      premise: "",
      mode: "explore",
    });
    expect(() =>
      f.api["directions:get"]({ projectId: other.id, chapterId: f.chapter.id }),
    ).toThrow("不属于");
  });
  it("重启保留走向、修改后的选择和下一章来源", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exploration-")),
      file = join(dir, "story.sqlite");
    const f = story(file);
    try {
      await run(f, request(f, "directions"), response(3));
      choose(f, "保存的自定方向");
      const chapter = next(f);
      f.repo.close();
      const reopened = fixture("explore", file);
      expect(
        directionView(reopened.repo, f.project.id, f.chapter.id).state
          ?.instruction,
      ).toBe("保存的自定方向");
      expect(
        reopened.repo.getChapter(chapter.id).explorationSource?.instruction,
      ).toBe("保存的自定方向");
      reopened.repo.close();
    } finally {
      if (f.repo.db.open) f.repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
