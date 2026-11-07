import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StoryRepository } from "../src/main/database";
import { cleanupDeletedAssets } from "../src/main/assets";
import {
  removePlanning,
  savePlanning,
  planningHistory,
  restorePlanning,
  managePlanningVersion,
} from "../src/main/planning";
import { createFragment, incorporateFragment } from "../src/main/writing";
import { buildTask } from "../src/main/prompts";
import { textToDocument } from "../src/shared/document";
import type { ImageAsset, PlanningTarget } from "../src/shared/types";

const repos: StoryRepository[] = [],
  dirs: string[] = [];
function open(file = ":memory:") {
  const r = new StoryRepository(file);
  repos.push(r);
  return r;
}
function setup(repo = open()) {
  const p = repo.createProject({
    title: "长篇",
    premise: "旅人寻找故乡",
    mode: "novel",
  });
  return { repo, p, c: repo.getDetail(p.id).chapters[0] };
}
function image(patch: Partial<ImageAsset> = {}): ImageAsset {
  return {
    id: randomUUID(),
    projectId: null,
    chapterId: null,
    revisionId: null,
    kind: "reference",
    name: "共享参考图",
    filename: "shared.png",
    prompt: "原始生成词",
    model: "原模型",
    referenceIds: [],
    createdAt: "",
    ...patch,
  };
}
function adopted(repo: StoryRepository, id: string, text = "旅人抵达驿站。") {
  repo.updateChapter(id, { document: textToDocument(text) });
  return repo.adoptChapter(id).acceptedRevisionId!;
}
const request = (
  projectId: string,
  chapterId: string,
  usePlanDraft = false,
) => ({
  requestId: randomUUID(),
  kind: "chapter" as const,
  projectId,
  chapterId,
  instruction: "",
  usePlanDraft,
});
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "story-lists-"));
  dirs.push(path);
  return path;
}
afterEach(async () => {
  repos.splice(0).forEach((r) => {
    if (r.db.open) r.close();
  });
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("规划按需使用和删除", () => {
  it("仅有总纲也能正常续写，未确认与空白层级不会进入请求", () => {
    const { repo, p, c } = setup();
    savePlanning(
      repo,
      p.id,
      { level: "synopsis" },
      { content: "全书主线", confirm: true },
    );
    savePlanning(
      repo,
      p.id,
      { level: "chapter", id: c.id },
      { content: "待定章纲" },
    );
    savePlanning(
      repo,
      p.id,
      { level: "scene", parentId: c.id },
      { title: "未来场景", content: "待定细纲" },
    );
    const built = buildTask(repo, request(p.id, c.id));
    expect(built.messages[1].content).toContain("全书主线");
    expect(built.messages[1].content).not.toMatch(
      /【当前章纲】|【场景细纲|所属分卷|待定章纲|未来场景/,
    );
    expect(built.messages[0].content).toContain("不要求补齐规划");
    const draft = buildTask(repo, request(p.id, c.id, true)).messages[1]
      .content;
    expect(draft).toContain("待定章纲");
    expect(draft).toContain("待定细纲");
  });
  it("清空已确认章纲保留正文、细纲和正式记忆，可用快照恢复", () => {
    const { repo, p, c } = setup();
    savePlanning(
      repo,
      p.id,
      { level: "chapter", id: c.id },
      { content: "本章确认规划", confirm: true },
    );
    savePlanning(
      repo,
      p.id,
      { level: "scene", parentId: c.id },
      { content: "保留的场景", confirm: true },
    );
    const revisionId = adopted(repo, c.id);
    repo.saveGeneratedMemories(c.id, revisionId, [
      { kind: "fact", content: "已抵达" },
    ]);
    const detail = removePlanning(repo, p.id, { level: "chapter", id: c.id });
    expect(detail.chapters[0]).toMatchObject({
      plan: "",
      content: "旅人抵达驿站。",
      acceptedRevisionId: revisionId,
      needsReview: false,
    });
    expect(detail.chapters[0].scenes?.[0].plan.reviewReason).toBeTruthy();
    expect(detail.memories[0].active).toBe(true);
    expect(
      buildTask(repo, request(p.id, c.id)).messages[1].content,
    ).not.toContain("本章确认规划");
    restorePlanning(repo, p.id, planningHistory(repo, p.id)[0].id);
    expect(repo.getChapter(c.id).plan).toBe("本章确认规划");
    expect(repo.getChapter(c.id).content).toBe("旅人抵达驿站。");
  });
  it("删除分卷只影响所属章节，草稿删除不增加正文待核对标记", () => {
    const { repo, p, c } = setup();
    const other = repo.createChapter(p.id);
    const volume = savePlanning(
      repo,
      p.id,
      { level: "volume" },
      { content: "卷内目标", confirm: true },
    ).target;
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ ...c, volumeId: volume.id }), c.id);
    adopted(repo, c.id);
    adopted(repo, other.id);
    const result = removePlanning(repo, p.id, volume);
    expect(result.chapters.map((c) => c.id)).toEqual([c.id, other.id]);
    expect(result.chapters[0].volumeId).toBe(
      result.project.novelPlan!.volumes[0].id,
    );
    expect(result.chapters[0].planningReview).toBeTruthy();
    expect(result.chapters[1].planningReview).toBeUndefined();
    expect(result.chapters[0].planMeta?.reviewReason).toBeUndefined();
    const draft = savePlanning(
      repo,
      p.id,
      { level: "scene", parentId: other.id },
      { content: "草稿" },
    ).target;
    removePlanning(repo, p.id, draft);
    expect(repo.getChapter(other.id).planningReview).toBeUndefined();
    expect(repo.getChapter(other.id).scenes).toEqual([]);
  });
  it("跨故事规划操作拒绝且不留下快照，恢复不复活已删除的章节", () => {
    const { repo, p, c } = setup(),
      other = setup(repo);
    const target: PlanningTarget = { level: "chapter", id: c.id };
    expect(() => removePlanning(repo, other.p.id, target)).toThrow("当前故事");
    expect(planningHistory(repo, other.p.id)).toEqual([]);
    removePlanning(repo, p.id, target);
    const version = planningHistory(repo, p.id)[0];
    repo.deleteChapter(c.id);
    restorePlanning(repo, p.id, version.id);
    expect(repo.getDetail(p.id).chapters).toEqual([]);
    expect(() => managePlanningVersion(repo, other.p.id, version.id)).toThrow(
      "当前故事",
    );
    managePlanningVersion(repo, p.id, version.id, "清空前备份");
    expect(
      planningHistory(repo, p.id).find((v) => v.id === version.id)?.label,
    ).toBe("清空前备份");
    managePlanningVersion(repo, p.id, version.id);
    expect(planningHistory(repo, p.id).some((v) => v.id === version.id)).toBe(
      false,
    );
  });
});

describe("内容删除和历史引用", () => {
  it("删除片段保留已编入的正文；删除锚点章节清理关联", () => {
    const { repo, p, c } = setup();
    const fragment = createFragment(repo, p.id);
    repo.updateChapter(fragment.id, {
      document: textToDocument("未来重逢"),
      fragmentContext: {
        time: "未来",
        place: "",
        viewpoint: "",
        connection: "",
        anchorId: c.id,
      },
    });
    const v = repo.checkpoint(fragment.id);
    incorporateFragment(repo, p.id, fragment.id, { chapterId: c.id });
    repo.deleteChapter(fragment.id);
    expect(repo.getChapter(c.id).content).toContain("未来重逢");
    expect(repo.listRevisions(c.id)).toHaveLength(1);
    expect(() => repo.getRevision(v.id)).toThrow();
    const f = createFragment(repo, p.id);
    repo.updateChapter(f.id, {
      document: textToDocument("另一片段"),
      fragmentContext: {
        time: "",
        place: "",
        viewpoint: "",
        connection: "",
        anchorId: c.id,
      },
    });
    incorporateFragment(repo, p.id, f.id, { chapterId: c.id });
    repo.deleteChapter(c.id);
    expect(repo.getChapter(f.id).fragmentContext?.anchorId).toBeUndefined();
    expect(repo.getChapter(f.id).incorporatedInto).toEqual([]);
    expect(repo.getDetail(p.id).chapters).toEqual([]);
  });
  it("编辑自动记忆保留来源，采用新正文后仍会停用；跨故事编辑拒绝", () => {
    const { repo, p, c } = setup();
    const revisionId = adopted(repo, c.id);
    repo.saveGeneratedMemories(c.id, revisionId, [
      { kind: "fact", content: "原事实" },
    ]);
    const m = repo.getDetail(p.id).memories[0],
      other = setup(repo);
    expect(() =>
      repo.updateMemory(other.p.id, m.id, {
        kind: "state",
        content: "错误修改",
      }),
    ).toThrow("当前故事");
    expect(
      repo.updateMemory(p.id, m.id, { kind: "state", content: "作者修正" }),
    ).toMatchObject({
      manual: false,
      revisionId,
      chapterId: c.id,
      active: true,
    });
    adopted(repo, c.id, "旅人离开驿站。");
    expect(repo.getDetail(p.id).memories[0].active).toBe(false);
    expect(() => repo.setMemoryActive(m.id, true)).toThrow();
    expect(() => repo.deleteMemory(other.p.id, m.id)).toThrow("当前故事");
    repo.deleteMemory(p.id, m.id);
    expect(repo.getChapter(c.id).content).toBe("旅人离开驿站。");
  });
  it("版本标签编辑不改快照，已采用和所有来源引用均阻止单独删除", () => {
    const { repo, p, c } = setup();
    const accepted = adopted(repo, c.id),
      v = repo.checkpoint(c.id, "备用");
    expect(() => repo.manageRevision(p.id, accepted)).toThrow("当前采用");
    repo.manageRevision(p.id, v.id, "重命名快照");
    expect(repo.getRevision(v.id)).toEqual({ ...v, label: "重命名快照" });
    const img = repo.addImage(image({ revisionId: v.id }));
    repo.setSetting(`scratch.${p.id}`, { memoryRevisionId: v.id });
    repo.setSetting(`workflow.run.${p.id}.test`, {
      results: [{ memoryRevisionId: v.id }],
    });
    repo.setSetting(`development.undo.${p.id}`, {
      draftBefore: { sources: [{ revisionId: v.id }] },
    });
    const usage = repo.revisionUsage(p.id, v.id).join(" ");
    expect(usage).toContain("插画来源");
    expect(usage).toContain("暂存");
    expect(usage).toContain("工作流");
    expect(usage).toContain("撤销");
    expect(() => repo.manageRevision(p.id, v.id)).toThrow("仍被引用");
    repo.deleteImage(img.id);
    for (const key of [
      `scratch.${p.id}`,
      `workflow.run.${p.id}.test`,
      `development.undo.${p.id}`,
    ])
      repo.setSetting(key, null);
    repo.manageRevision(p.id, v.id);
    expect(() => repo.getRevision(v.id)).toThrow();
    expect(repo.getChapter(c.id).acceptedRevisionId).toBe(accepted);
  });
  it("停用记忆和设定候选也保护历史来源", () => {
    const { repo, p, c } = setup();
    const revisionId = adopted(repo, c.id);
    repo.saveGeneratedMemories(c.id, revisionId, [
      { kind: "fact", content: "旧记忆" },
    ]);
    adopted(repo, c.id, "新正文");
    expect(() => repo.manageRevision(p.id, revisionId)).toThrow("已停用");
    repo.deleteMemory(p.id, repo.getDetail(p.id).memories[0].id);
    repo.updateProject(p.id, {
      blueprintCandidates: [
        {
          id: randomUUID(),
          title: "提炼",
          content: "",
          source: "develop",
          createdAt: "",
          development: {
            id: randomUUID(),
            projectId: p.id,
            summary: "",
            appliedIds: [],
            warnings: [],
            changes: [
              {
                id: randomUUID(),
                target: "blueprint",
                targetId: "",
                sectionId: "",
                name: "",
                title: "分区",
                content: "提炼",
                mode: "append",
                basis: "established",
                base: null,
                sources: [{ revisionId, quote: "旅人" }],
              },
            ],
          },
        },
      ],
    });
    expect(() => repo.manageRevision(p.id, revisionId)).toThrow("设定候选");
    repo.deleteChapter(c.id);
    expect(
      repo.getProject(p.id).blueprintCandidates[0].development?.warnings.join(),
    ).toContain("来源章节已删除");
  });
});

describe("图片与持久化", () => {
  it("共享图片引用保护，元数据编辑保留生成记录", () => {
    const { repo, p } = setup(),
      other = setup(repo),
      img = repo.addImage(image());
    const card = repo.saveCard({
      projectId: other.p.id,
      kind: "character",
      name: "借用图片",
      description: "",
      constraints: "",
      referenceIds: [img.id],
    });
    expect(repo.imageUsage(img.id).join()).toContain("借用图片");
    expect(() => repo.deleteImage(img.id)).toThrow("先解除关联");
    const updated = repo.updateImage(img.id, "新名称", "作者备注");
    expect(updated).toMatchObject({
      prompt: img.prompt,
      model: img.model,
      notes: "作者备注",
      referenceIds: [],
    });
    repo.saveCard({ ...card, referenceIds: [] });
    const dependent = repo.addImage(image({ referenceIds: [img.id] }));
    expect(() => repo.deleteImage(img.id)).toThrow("图片参考来源");
    repo.deleteImage(dependent.id);
    repo.deleteImage(img.id);
    expect(repo.getDetail(p.id).chapters).toHaveLength(1);
  });
  it("同文件多记录只清理最后一份；清理失败持久化并能重试", async () => {
    const repo = open(),
      dir = await temp();
    const first = repo.addImage(image()),
      second = repo.addImage(image());
    await mkdir(join(dir, "assets", "shared.png"), { recursive: true });
    repo.deleteImage(first.id);
    expect(repo.getSetting("assets.pendingDeletes", [])).toEqual([]);
    repo.deleteImage(second.id);
    expect(await cleanupDeletedAssets(repo, dir)).toBe(1);
    await rm(join(dir, "assets", "shared.png"), { recursive: true });
    await writeFile(join(dir, "assets", "shared.png"), "test");
    expect(await cleanupDeletedAssets(repo, dir)).toBe(0);
    await expect(readFile(join(dir, "assets", "shared.png"))).rejects.toThrow();
  });
  it("旧记录无需破坏性迁移，编辑和清理在重启后保留", async () => {
    const dir = await temp(),
      file = join(dir, "story.sqlite"),
      repo = open(file),
      { p, c } = setup(repo);
    const legacy = { ...c };
    delete legacy.kind;
    delete legacy.planMeta;
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify(legacy), c.id);
    const v = repo.checkpoint(c.id),
      img = repo.addImage(image());
    repo.manageRevision(p.id, v.id, "重启保留");
    repo.updateImage(img.id, "图片名称", "备注");
    savePlanning(repo, p.id, { level: "chapter", id: c.id }, { content: "" });
    repo.close();
    const reopened = open(file);
    expect(reopened.getDetail(p.id).chapters[0].id).toBe(c.id);
    expect(reopened.getRevision(v.id).label).toBe("重启保留");
    expect(reopened.getImage(img.id).notes).toBe("备注");
    reopened.manageRevision(p.id, v.id);
    reopened.close();
    expect(open(file).listRevisions(c.id)).toEqual([]);
  });
});
