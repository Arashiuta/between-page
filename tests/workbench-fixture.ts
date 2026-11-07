import { afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { StoryRepository } from "../src/main/database";
import { workspaceHandlers } from "../src/main/workspace-handlers";
import { runCreationTask, type RunOptions } from "../src/main/conversations";
import { getChangeSet } from "../src/main/changes";
import type {
  BlueprintLevel,
  Mode,
  TaskKind,
  TaskRequest,
  TaskPreview,
} from "../src/shared/types";
const repositories: StoryRepository[] = [];
afterEach(() =>
  repositories.splice(0).forEach((r) => {
    if (r.db.open) r.close();
  }),
);
export const options = {
  model: "mock-vision",
  capabilities: { vision: true, contextTokens: 2000000, outputTokens: 8000 },
  readImage: async () => "data:image/png;base64,aW1hZ2U=",
};
export function fixture(mode: Mode = "novel", filename = ":memory:") {
  const repo = new StoryRepository(filename);
  repositories.push(repo);
  const project = repo.createProject({
      title: "沙海来信",
      premise: "寻找消失的故乡",
      mode,
    }),
    chapter = repo.getDetail(project.id).chapters[0];
  const api = workspaceHandlers(repo);
  return { repo, project, chapter, api };
}
export type Fixture = ReturnType<typeof fixture>;
export function request(
  f: Fixture,
  kind: TaskKind = "brainstorm",
  patch: Record<string, unknown> = {},
): TaskRequest {
  const base = {
    requestId: randomUUID(),
    projectId: f.project.id,
    mode: f.repo.getProject(f.project.id).mode,
    instruction: "本次要求",
    kind,
  };
  const target =
    kind === "blueprint"
      ? {
          target: {
            level: base.mode === "novel" ? "synopsis" : "section",
            count: 1,
          },
        }
      : kind === "check"
        ? {
            scope: { type: "current", chapterId: f.chapter.id },
            aspect: "continuity",
          }
        : [
              "opening",
              "continue",
              "polish",
              "notes",
              "title",
              "prompt",
            ].includes(kind)
          ? { chapterId: f.chapter.id }
          : {};
  return { ...base, ...target, ...patch } as TaskRequest;
}
export function node(
  f: Fixture,
  level: BlueprintLevel = "section",
  content = "蓝图的全部内容",
  other: Record<string, unknown> = {},
) {
  const n = {
    id: randomUUID(),
    level,
    parentId: null,
    chapterId: null,
    title: "蓝图节点",
    content,
    ...other,
  };
  f.api["blueprint:save"]({ projectId: f.project.id, node: n, base: null });
  return n;
}
export async function run(
  f: Fixture,
  r: TaskRequest,
  response: string,
  overrides: Partial<RunOptions> = {},
) {
  return runCreationTask(f.repo, r, {
    ...options,
    signal: new AbortController().signal,
    progress: () => {},
    generate: async (_m, delta) => {
      delta(response);
      return response;
    },
    ...overrides,
  });
}
export async function proposal(f: Fixture, r: TaskRequest, response: string) {
  const v = await run(f, r, response);
  if (v.result.type !== "changes") throw new Error("No changes");
  return getChangeSet(f.repo, f.project.id, v.result.changeSetId);
}
export const allText = (preview: TaskPreview) =>
  JSON.stringify(preview.messages);
export function settingResponse(content = "新世界规则") {
  return JSON.stringify({
    changes: [{ type: "project", field: "world", content }],
  });
}
