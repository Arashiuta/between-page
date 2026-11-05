import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoryRepository } from "../src/main/database";
import { applyBlueprintContent, normalizeProject } from "../src/shared/blueprint";
import { textToDocument } from "../src/shared/document";
import type { ImageAsset, Project, WorkflowRun } from "../src/shared/types";

const repositories: StoryRepository[] = [];
const directories: string[] = [];
function repository(filename = ":memory:") {
  const repo = new StoryRepository(filename);
  repositories.push(repo);
  return repo;
}
afterEach(async () => {
  for (const repo of repositories.splice(0)) repo.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("蓝图迁移与工作流持久化", () => {
  it("追加只并入目标分区，替换只替换目标分区", () => {
    const sections = [
      { id: "core", title: "核心冲突", content: "已有冲突" },
      { id: "arcs", title: "角色弧线", content: "人物变化" },
    ];
    expect(applyBlueprintContent(sections, "core", "新方向", "append")).toEqual([
      { ...sections[0], content: "已有冲突\n\n新方向" },
      sections[1],
    ]);
    expect(applyBlueprintContent(sections, "core", "替代内容", "replace")).toEqual([
      { ...sections[0], content: "替代内容" },
      sections[1],
    ]);
  });

  it("把旧 outline 无损迁入整体蓝图分区", () => {
    const project = {
      id: "legacy",
      title: "旧故事",
      premise: "",
      mode: "novel",
      genre: "",
      world: "",
      style: "",
      outline: "第一幕\n第二幕",
      color: "sage",
      createdAt: "",
      updatedAt: "",
      archived: false,
    } as Project;
    const normalized = normalizeProject(project);
    expect(normalized.outline).toBe("");
    expect(normalized.blueprintSections[0]).toMatchObject({
      title: "整体蓝图",
      content: "第一幕\n第二幕",
    });
  });

  it("启动时迁移旧数据库，并把旧 outline 写入分区", async () => {
    const directory = await mkdtemp(join(tmpdir(), "storybook-blueprint-"));
    directories.push(directory);
    const filename = join(directory, "storybook.sqlite");
    let repo = repository(filename);
    const project = repo.createProject({ title: "迁移故事", premise: "", mode: "novel" });
    const legacy = { ...project, outline: "旧版总纲", blueprintSections: undefined, blueprintCandidates: undefined };
    repo.db.prepare("UPDATE projects SET payload = ? WHERE id = ?").run(JSON.stringify(legacy), project.id);
    repo.close();
    repositories.pop();
    repo = repository(filename);
    expect(repo.getProject(project.id).blueprintSections[0]).toMatchObject({
      title: "整体蓝图",
      content: "旧版总纲",
    });
    expect(repo.getProject(project.id).outline).toBe("");
  });

  it("保存分区变更与流程模板、运行步骤并可重新读取", () => {
    const repo = repository();
    const project = repo.createProject({ title: "工作流故事", premise: "", mode: "explore" });
    const updated = repo.updateProject(project.id, {
      outline: "从兼容接口提交的蓝图",
      blueprintCandidates: [],
    });
    expect(updated.outline).toBe("");
    expect(updated.blueprintSections[0].content).toBe("从兼容接口提交的蓝图");

    const template = {
      id: "custom-flow",
      name: "测试流程",
      description: "审核每一步",
      steps: [{ id: "idea", kind: "brainstorm" as const, title: "脑暴", instruction: "保留多个方向" }],
    };
    repo.saveWorkflowTemplates([template]);
    const run: WorkflowRun = {
      id: "run-1",
      projectId: project.id,
      templateId: template.id,
      templateName: template.name,
      chapterId: repo.getDetail(project.id).chapters[0].id,
      steps: template.steps,
      results: [{ stepId: "idea", status: "approved", output: "方向甲", updatedAt: "2026-01-01" }],
      currentStep: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
    };
    repo.saveWorkflowRun(run);
    expect(repo.listWorkflowTemplates()).toEqual([template]);
    expect(repo.listWorkflowRuns(project.id)).toEqual([run]);
  });
});

describe("归档故事永久删除", () => {
  it("拒绝删除未归档故事", () => {
    const repo = repository();
    const project = repo.createProject({ title: "仍在书架", premise: "", mode: "explore" });
    expect(() => repo.deleteArchivedProject(project.id)).toThrow("请先归档故事");
    expect(repo.getProject(project.id).title).toBe("仍在书架");
  });

  it("清除专属数据与运行记录，保留被资料引用的图片", () => {
    const repo = repository();
    const project = repo.createProject({ title: "待删除", premise: "", mode: "explore" });
    const chapter = repo.getDetail(project.id).chapters[0];
    repo.updateChapter(chapter.id, { document: textToDocument("采用的正文") });
    repo.adoptChapter(chapter.id);
    const revision = repo.getRevision(repo.getChapter(chapter.id).acceptedRevisionId!);
    repo.addMemory(project.id, "fact", "已发生的事实");
    repo.saveCard({ projectId: project.id, kind: "character", name: "故事内 OC", description: "", constraints: "", sections: [], documents: [], referenceIds: [] });
    const ownedImage: ImageAsset = {
      id: "owned-image", projectId: project.id, chapterId: chapter.id, revisionId: revision.id,
      kind: "illustration", name: "共享插画", filename: "owned.png", prompt: "", referenceIds: [], model: "", createdAt: "",
    };
    const exclusiveImage: ImageAsset = { ...ownedImage, id: "exclusive-image", name: "独占插画", filename: "exclusive.png" };
    repo.addImage(ownedImage);
    repo.addImage(exclusiveImage);
    repo.saveCard({ projectId: null, kind: "character", name: "资料库 OC", description: "", constraints: "", sections: [], documents: [], referenceIds: [ownedImage.id] });
    repo.setSetting(`scratch.${project.id}`, { output: "draft" });
    repo.saveWorkflowRun({
      id: "delete-run", projectId: project.id, templateId: "flow", templateName: "流程", chapterId: chapter.id,
      steps: [{ id: "step", kind: "brainstorm", title: "脑暴", instruction: "" }],
      results: [{ stepId: "step", status: "pending", output: "未应用草稿", updatedAt: "" }],
      currentStep: 0, createdAt: "", updatedAt: "",
    });
    repo.updateProject(project.id, { archived: true });

    expect(repo.deleteArchivedProject(project.id)).toEqual(["exclusive.png"]);
    expect(repo.getImage(ownedImage.id)).toMatchObject({ projectId: null, chapterId: null, revisionId: null });
    expect(() => repo.getImage(exclusiveImage.id)).toThrow("不存在");
    expect(repo.getSetting(`scratch.${project.id}`, null)).toBeNull();
    expect(repo.db.prepare("SELECT key FROM settings WHERE key LIKE ?").all(`workflow.run.${project.id}.%`)).toEqual([]);
    expect(repo.db.prepare("SELECT id FROM chapters WHERE project_id = ?").all(project.id)).toEqual([]);
    expect(repo.db.prepare("SELECT id FROM revisions WHERE project_id = ?").all(project.id)).toEqual([]);
    expect(repo.db.prepare("SELECT id FROM memories WHERE project_id = ?").all(project.id)).toEqual([]);
    expect(repo.db.prepare("SELECT id FROM cards WHERE project_id = ?").all(project.id)).toEqual([]);
    expect(() => repo.getProject(project.id)).toThrow("不存在");
  });
});
