import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { StoryRepository } from "../src/main/database";
import { buildTask } from "../src/main/prompts";
import {
  applyDevelopment,
  buildDevelopmentContext,
  parseDevelopment,
  undoDevelopment,
} from "../src/main/development";
import { textToDocument } from "../src/shared/document";
import { normalizeProject } from "../src/shared/blueprint";
import type { TaskKind } from "../src/shared/types";

const repositories: StoryRepository[] = [];
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});
function setup() {
  const repo = new StoryRepository(":memory:");
  repositories.push(repo);
  const project = repo.createProject({
    title: "废土旅途",
    premise: "能操纵金属的人来到废土，开始公路冒险。",
    mode: "explore",
  });
  const chapter = repo.getDetail(project.id).chapters[0];
  return { repo, project, chapter };
}
function task(kind: TaskKind, projectId: string, chapterId?: string) {
  return {
    requestId: randomUUID(),
    kind,
    projectId,
    chapterId,
    instruction: "",
  };
}
function proposal(overrides = {}) {
  return {
    target: "blueprint",
    targetId: "story-phases",
    sectionId: "",
    name: "",
    title: "阶段推进",
    content: "先寻找燃料，再沿废弃公路前往下一座聚落。",
    mode: "append",
    basis: "proposal",
    sources: [],
    ...overrides,
  };
}
function draft(
  repo: StoryRepository,
  projectId: string,
  changes = [proposal()],
) {
  const context = buildDevelopmentContext(repo, repo.getDetail(projectId));
  return parseDevelopment(
    JSON.stringify({
      summary: "逐站冒险，保留结局空白。",
      changes,
      warnings: [],
    }),
    context.snapshot,
  );
}

describe("从关键词开始、边写边完善", () => {
  it("没有设定和章节计划也能开篇或续写，自由度与后补规则会进入实际请求", () => {
    const { repo, project, chapter } = setup();
    for (const kind of ["opening", "chapter"] as const) {
      const built = buildTask(repo, task(kind, project.id, chapter.id));
      expect(built.messages[0].content).toContain("自由发挥");
      expect(built.messages[0].content).toContain(
        "没有完整设定或本章计划也应直接创作",
      );
      expect(built.messages[1].content).toContain("公路冒险");
    }
    repo.updateProject(project.id, {
      creativeFreedom: "guided",
      world: "操纵金属不能影响活人体内的铁元素。",
    });
    const built = buildTask(repo, task("chapter", project.id, chapter.id));
    expect(built.messages[0].content).toContain("本次创作自由度：遵循设定");
    expect(built.messages[0].content).not.toContain("作者授权你主动构思");
    expect(built.messages[1].content).toContain("不能影响活人体内的铁元素");
    expect(
      normalizeProject({ ...project, creativeFreedom: undefined })
        .creativeFreedom,
    ).toBe("balanced");
  });

  it("下一章可衔接前章草稿，但不会提前使用后章或其他故事的内容", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, {
      document: textToDocument("临时主角驾着铁皮车逃离沙暴，右手受伤。"),
    });
    const next = repo.createChapter(project.id);
    const future = repo.createChapter(project.id);
    repo.updateChapter(future.id, {
      document: textToDocument("尚未发生的终点 SECRET_END"),
    });
    const built = buildTask(repo, task("chapter", project.id, next.id));
    expect(built.messages[1].content).toContain("右手受伤");
    expect(built.messages[1].content).toContain("尚未采用，仅供续写衔接");
    expect(built.messages[1].content).not.toContain("SECRET_END");
    expect(repo.getDetail(project.id).memories).toEqual([]);
  });

  it("完善设定读取故事范围的采用版本，含当前章，草稿与新构思仍标为候选", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, {
      document: textToDocument("他只能操纵接触过的金属。"),
    });
    const accepted = repo.adoptChapter(chapter.id);
    const later = repo.createChapter(project.id);
    repo.updateChapter(later.id, {
      document: textToDocument("他把车留在盐湖的驿站。"),
    });
    repo.adoptChapter(later.id);
    repo.updateChapter(chapter.id, {
      document: textToDocument("新的未采用草稿，主角能飞。"),
    });
    const other = repo.createProject({
      title: "别的故事",
      premise: "",
      mode: "explore",
    });
    repo.addMemory(other.id, "fact", "PRIVATE_OTHER_WORLD");
    const built = buildTask(repo, task("develop", project.id, chapter.id));
    expect(built.messages[1].content).toContain(accepted.acceptedRevisionId);
    expect(built.messages[1].content).toContain("只能操纵接触过的金属");
    expect(built.messages[1].content).toContain("车留在盐湖");
    expect(built.messages[1].content).toContain("只能作为 proposal");
    expect(built.messages[1].content).not.toContain("PRIVATE_OTHER_WORLD");
    expect(built.developmentSnapshot!.sources).toHaveLength(2);
  });

  it("记忆整理不会收到自由创作授权", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, {
      document: textToDocument("他在路边拾起了一把钥匙。"),
    });
    repo.adoptChapter(chapter.id);
    const built = buildTask(repo, task("notes", project.id, chapter.id));
    expect(built.messages[0].content).not.toContain("作者授权你主动构思");
    expect(built.messages[0].content).toContain("不把大纲、猜想");
  });

  it("长章节续写仍包含最新结尾，避免重复从开头写起", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, {
      document: textToDocument(
        "开篇规则：金属需要接触。" +
          "一路向前。".repeat(6000) +
          "最新结尾：伙伴在桥边失踪了。",
      ),
    });
    const built = buildTask(repo, task("chapter", project.id, chapter.id));
    expect(built.messages[1].content).toContain("开篇规则：金属需要接触");
    expect(built.messages[1].content).toContain("最新结尾：伙伴在桥边失踪");
    expect(built.messages[1].content).toContain("请从结尾衔接");
  });
});

describe("分区提案与采用", () => {
  it("校验正文依据、故事所属和目标 ID，不能伪造已确立设定", () => {
    const { repo, project, chapter } = setup();
    repo.updateChapter(chapter.id, {
      document: textToDocument("他的右手不能再握住方向盘。"),
    });
    const accepted = repo.adoptChapter(chapter.id);
    const good = proposal({
      basis: "established",
      sources: [
        {
          revisionId: accepted.acceptedRevisionId,
          quote: "右手不能再握住方向盘",
        },
      ],
    });
    expect(draft(repo, project.id, [good]).changes[0].basis).toBe(
      "established",
    );
    expect(() =>
      draft(repo, project.id, [proposal({ basis: "established" })]),
    ).toThrow("正文证据");
    expect(() =>
      draft(repo, project.id, [proposal({ targetId: "missing-section" })]),
    ).toThrow("不存在");
    expect(() =>
      draft(repo, project.id, [
        proposal({
          sources: [{ revisionId: randomUUID(), quote: "不存在的引用" }],
        }),
      ]),
    ).toThrow("无法核对");
    const template = repo.saveCard({
      projectId: null,
      kind: "character",
      name: "模板",
      description: "",
      constraints: "",
      referenceIds: [],
    });
    expect(() =>
      draft(repo, project.id, [
        proposal({ target: "character", targetId: template.id, name: "模板" }),
      ]),
    ).toThrow("不属于当前故事");
  });

  it("原子更新蓝图和人物分区，保留固定规则、原始文档及图片，不生成正式记忆", () => {
    const { repo, project } = setup();
    const card = repo.saveCard({
      projectId: project.id,
      kind: "character",
      name: "旅人",
      description: "临时主角",
      constraints: "无法控制人体内金属。",
      documents: [
        {
          id: randomUUID(),
          name: "原稿",
          content: "作者的原始设定。",
          enabled: true,
        },
      ],
      sections: [],
      referenceIds: [randomUUID()],
    });
    const plan = draft(repo, project.id, [
      proposal(),
      proposal({
        target: "character",
        targetId: card.id,
        name: "旅人",
        title: "能力的具体用法",
        content: "可将接触过的金属拼成临时车架。",
      }),
    ]);
    const result = applyDevelopment(
      repo,
      project.id,
      plan,
      plan.changes.map((change) => change.id),
    );
    expect(
      result.detail.project.blueprintSections.find(
        (section) => section.id === "story-phases",
      )!.content,
    ).toContain("寻找燃料");
    expect(result.detail.cards[0]).toMatchObject({
      constraints: card.constraints,
      documents: card.documents,
      referenceIds: card.referenceIds,
    });
    expect(result.detail.cards[0].sections[0]).toMatchObject({
      title: "能力的具体用法",
      alwaysInclude: true,
    });
    expect(result.detail.memories).toEqual([]);
    const undone = undoDevelopment(repo, project.id, result.undoId);
    expect(undone.detail.project.blueprintSections).toEqual(
      project.blueprintSections,
    );
    expect(undone.detail.cards[0].sections).toEqual([]);
    expect(undone.detail.cards[0].documents).toEqual(card.documents);
    expect(undone.draft.appliedIds).toEqual([]);
    expect(() =>
      applyDevelopment(
        repo,
        project.id,
        undone.draft,
        undone.draft.changes.map((change) => change.id),
      ),
    ).not.toThrow();
  });

  it("同一个新角色可以分批采用多个分区，剩余建议会定位到已创建资料", () => {
    const { repo, project } = setup();
    const plan = draft(repo, project.id, [
      proposal({
        target: "character",
        targetId: "",
        name: "阿尘",
        title: "能力",
        content: "能够操纵金属。",
      }),
      proposal({
        target: "character",
        targetId: "",
        name: "阿尘",
        title: "性格",
        content: "好奇而谨慎。",
      }),
    ]);
    const first = applyDevelopment(repo, project.id, plan, [
      plan.changes[0].id,
    ]);
    expect(first.draft.changes[1].targetId).toBe(first.detail.cards[0].id);
    const second = applyDevelopment(repo, project.id, first.draft, [
      plan.changes[1].id,
    ]);
    expect(second.detail.cards).toHaveLength(1);
    expect(second.detail.cards[0].sections).toHaveLength(2);
    expect(() =>
      applyDevelopment(repo, project.id, plan, [plan.changes[0].id]),
    ).toThrow("已经采用");
    const undone = undoDevelopment(repo, project.id, second.undoId);
    expect(undone.detail.cards[0].sections).toHaveLength(1);
  });

  it("后续手改资料、重新采用章节或跨故事应用时，旧提案不会覆盖新内容", () => {
    const { repo, project, chapter } = setup();
    const plan = draft(repo, project.id);
    repo.updateProject(project.id, {
      blueprintSections: project.blueprintSections.map((section) =>
        section.id === "story-phases"
          ? { ...section, content: "作者刚决定留在小镇。" }
          : section,
      ),
    });
    expect(() =>
      applyDevelopment(repo, project.id, plan, [plan.changes[0].id]),
    ).toThrow("已修改");
    repo.updateChapter(chapter.id, {
      document: textToDocument("主角失去了右手。"),
    });
    const adopted = repo.adoptChapter(chapter.id);
    const sourced = draft(repo, project.id, [
      proposal({
        basis: "established",
        sources: [
          { revisionId: adopted.acceptedRevisionId, quote: "失去了右手" },
        ],
      }),
    ]);
    repo.updateChapter(chapter.id, {
      document: textToDocument("主角只有轻伤。"),
    });
    repo.adoptChapter(chapter.id);
    expect(() =>
      applyDevelopment(repo, project.id, sourced, [sourced.changes[0].id]),
    ).toThrow("采用版本已变化");
    const other = repo.createProject({
      title: "另一本",
      mode: "explore",
      premise: "",
    });
    expect(() =>
      applyDevelopment(repo, other.id, plan, [plan.changes[0].id]),
    ).toThrow("不属于当前故事");
  });

  it("部分建议不合法时全部回滚，撤销也会保留后来的手工编辑", () => {
    const { repo, project } = setup();
    const plan = draft(repo, project.id, [
      proposal(),
      proposal({
        target: "world",
        targetId: "",
        name: "废土",
        title: "聚落",
        content: "盐湖附近有驿站。",
      }),
    ]);
    const broken = structuredClone(plan);
    broken.changes[1].targetId = randomUUID();
    expect(() =>
      applyDevelopment(
        repo,
        project.id,
        broken,
        broken.changes.map((change) => change.id),
      ),
    ).toThrow();
    expect(repo.getProject(project.id).blueprintSections).toEqual(
      project.blueprintSections,
    );
    expect(repo.getDetail(project.id).cards).toEqual([]);
    const result = applyDevelopment(
      repo,
      project.id,
      plan,
      plan.changes.map((change) => change.id),
    );
    repo.saveCard({
      ...result.detail.cards[0],
      constraints: "作者后来补充的规则。",
    });
    expect(() => undoDevelopment(repo, project.id, result.undoId)).toThrow(
      "后续编辑",
    );
    expect(repo.getDetail(project.id).cards[0].constraints).toContain(
      "后来补充",
    );
  });
});
