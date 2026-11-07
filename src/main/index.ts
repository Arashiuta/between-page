import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  Tray,
  Menu,
} from "electron";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { z } from "zod";
import { StoryRepository } from "./database";
import {
  assetPath,
  readAsset,
  removeAsset,
  saveImageAsset,
  cleanupDeletedAssets,
} from "./assets";
import { assertDataLayoutSupported } from "./data-layout";
import { createProjectWithCover, saveCover } from "./covers";
import { coverUploadSchema, coverCropSchema } from "../shared/cover";
import { chat, generateImage, listModels, type Connection } from "./provider";
import { buildChapterTitleMessages, parseChapterTitle } from "./chapter-title";
import {
  importTextDocument,
  buildMaterialMessages,
  parseMaterialDraft,
} from "./materials";
import { roleSettings } from "./roles";
import { effectiveRole, roleDefinitions } from "../shared/roles";
import { materialLimits } from "../shared/materials";
import { builtinWorkflowTemplates } from "../shared/workflows";
import { taskKinds } from "../shared/types";
import { developmentDraftSchema } from "../shared/development";
import { applyDevelopment } from "./development";
import {
  planningTargetSchema,
  planningDraftSchema,
  planningBase,
  savePlanning,
  applyPlanning,
  planningHistory,
  snapshotPlanning,
  restorePlanning,
  organizePlanning,
  removePlanning,
  managePlanningVersion,
  planningMoveSchema,
  previewPlanningMove,
  movePlanning,
} from "./planning";
import {
  createFragment,
  incorporateFragment,
  reorderChapters,
  exportStory,
} from "./writing";
import appIcon from "../../build/icon.png?asset";
import trayIcon from "../../build/icon.ico?asset";
import {
  conversationHandlers,
  runCreationTask,
  prepareConversationTask,
  applyConversationPlanning,
  applyConversationDevelopment,
  applyConversationMemory,
  synchronizeCandidateEdits,
  undoConversationDevelopment,
} from "./conversations";
import { textSelectionSchema } from "../shared/conversations";
import {
  resolveDataDir,
  initializeDirectories,
  upgradeDataLayout,
  settings,
  readKey,
  saveSettings,
  saveSoftwareSettings,
  imageMime,
  makeBackup,
  migrateData,
} from "./storage";
import type {
  Card,
  ImageAsset,
  TaskRequest,
  DocumentNode,
  RoleId,
  RoleSettings,
  BlueprintSection,
  WorkflowRun,
  WorkflowTemplate,
} from "../shared/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir();
initializeDirectories(dataDir);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "story-asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let repo: StoryRepository;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
const jobs = new Map<string, AbortController>();
let closing = false;
let maintenance = false;
let activeOperations = 0;
const idSchema = z.string().uuid();
const shortText = z.string().max(500);
const longText = z.string().max(200_000);
const kindSchema = z.enum(["character", "world", "inspiration"]);
const taskKindSchema = z.enum(taskKinds);
const roleIdSchema = z.enum([...taskKinds, "material", "title"]);
const freedomSchema = z.enum(["guided", "balanced", "free"]);
const sourceDocumentSchema = z.object({
  id: idSchema,
  name: shortText.trim().min(1),
  content: z.string().max(materialLimits.document),
  enabled: z.boolean(),
});
const cardSectionSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  content: longText,
  alwaysInclude: z.boolean(),
  sourceIds: z.array(idSchema).max(12),
});
const cardContentSchema = z.object({
  name: shortText.trim(),
  kind: kindSchema,
  description: longText,
  constraints: longText,
  sections: z.array(cardSectionSchema).max(materialLimits.sections).default([]),
  documents: z
    .array(sourceDocumentSchema)
    .max(materialLimits.documents)
    .default([]),
});
const memoryKindSchema = z.enum([
  "fact",
  "state",
  "relationship",
  "knowledge",
  "foreshadow",
  "summary",
]);
const documentSchema: z.ZodType<DocumentNode> = z.lazy(() =>
  z.object({
    type: z.string().max(40),
    text: z.string().max(500_000).optional(),
    content: z.array(documentSchema).max(10_000).optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z
      .array(
        z.object({
          type: z.string(),
          attrs: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
  }),
);
const connection = (kind: "text" | "image"): Connection => ({
  ...settings(repo, dataDir)[kind],
  key: readKey(repo, kind),
});
function connectionForRole(id: RoleId): Connection {
  const config = connection("text");
  const model = effectiveRole(roleSettings(repo), id).model;
  if (model && !settings(repo, dataDir).text.selectedModels.includes(model))
    throw new Error(
      "此 AI 职责指定的模型已不在已选列表中，请到「AI 职责」修改模型，或在设置中重新勾选。",
    );
  return { ...config, model: model || config.model };
}
const taskSchema = z.object({
  requestId: idSchema,
  kind: taskKindSchema,
  projectId: idSchema,
  chapterId: idSchema.optional(),
  instruction: longText,
  selection: longText.optional(),
  workflowContext: z.string().max(80_000).optional(),
  planningTarget: planningTargetSchema.optional(),
  writingScope: z.enum(["selection", "document"]).optional(),
  outputMode: z.enum(["rewrite", "analysis"]).optional(),
  usePlanDraft: z.boolean().optional(),
  referenceNovelPlan: z.boolean().optional(),
  conversationId: idSchema.optional(),
  parentTurnId: idSchema.optional(),
  selectionRange: textSelectionSchema.optional(),
});
function assertIdle() {
  if (jobs.size) throw new Error("请先停止或等待当前生成任务完成。");
  if (activeOperations > 1)
    throw new Error("请等待当前文件或保存操作完成后重试。");
}

const handlers: Record<
  string,
  (payload: unknown, event: Electron.IpcMainInvokeEvent) => unknown
> = {
  bootstrap: () => ({
    projects: repo.listProjects(),
    cards: repo.listCards(),
    images: repo.listImages(),
    settings: settings(repo, dataDir),
    roles: roleSettings(repo),
  }),
  "project:get": (p) => repo.getDetail(idSchema.parse(p)),
  "scratch:get": (p) => {
    const id = idSchema.parse(p);
    repo.getProject(id);
    return repo.getSetting("scratch." + id, null);
  },
  "scratch:save": (p) => {
    const v = z
      .object({
        projectId: idSchema,
        kind: taskKindSchema,
        instruction: longText,
        output: z.string().max(1_000_000),
        chapterId: z.string().max(40),
        memoryRecords: z
          .array(
            z.object({ kind: memoryKindSchema, content: z.string().max(3000) }),
          )
          .max(24)
          .nullable()
          .optional(),
        memoryRevisionId: idSchema.or(z.literal("")).optional(),
        developmentDraft: developmentDraftSchema.nullable().optional(),
        planningDraft: planningDraftSchema.nullable().optional(),
        resultType: z
          .enum(["prose", "rewrite", "analysis", "planning"])
          .nullable()
          .optional(),
        sourceContent: z.string().max(1_000_000).optional(),
        outputScope: z.enum(["selection", "document"]).nullable().optional(),
        planningTarget: planningTargetSchema.optional(),
        writingScope: z.enum(["selection", "document"]).optional(),
        outputMode: z.enum(["rewrite", "analysis"]).optional(),
        usePlanDraft: z.boolean().optional(),
        referenceNovelPlan: z.boolean().optional(),
        selectedTool: taskKindSchema.optional(),
        developmentUndoId: idSchema.or(z.literal("")).optional(),
        outputSelection: z
          .object({
            text: z.string().max(500_000),
            from: z.number().int().min(0),
            to: z.number().int().min(0),
          })
          .nullable()
          .optional(),
        conversationId: idSchema.optional(),
        selectedTurnId: idSchema.optional(),
      })
      .parse(p);
    repo.getProject(v.projectId);
    repo.setSetting("scratch." + v.projectId, v);
    return true;
  },
  "project:create": (p) =>
    createProjectWithCover(
      repo,
      dataDir,
      z
        .object({
          title: shortText.trim().min(1),
          premise: longText,
          mode: z.enum(["explore", "novel"]),
          creativeFreedom: freedomSchema.optional(),
          genre: shortText.optional(),
          cardIds: z.array(idSchema).max(100).optional(),
          cover: coverUploadSchema.optional(),
        })
        .parse(p),
    ),
  "project:cover:save": (p) => {
    const value = z
      .object({
        projectId: idSchema,
        source: z.union([
          z.object({ upload: coverUploadSchema }),
          z.object({ imageId: idSchema, crop: coverCropSchema }),
        ]),
      })
      .parse(p);
    return saveCover(repo, dataDir, value.projectId, value.source);
  },
  "project:cover:remove": (p) =>
    saveCover(repo, dataDir, idSchema.parse(p), null),
  "project:update": (p) => {
    const { id, ...patch } = z
      .object({
        id: idSchema,
        title: shortText.trim().min(1).optional(),
        premise: longText.optional(),
        mode: z.enum(["explore", "novel"]).optional(),
        creativeFreedom: freedomSchema.optional(),
        genre: shortText.optional(),
        world: longText.optional(),
        style: longText.optional(),
        outline: longText.optional(),
        blueprintSections: z
          .array(
            z.object({
              id: z.string().min(1).max(80),
              title: shortText.trim().min(1),
              content: longText,
            }),
          )
          .max(50)
          .optional(),
        blueprintCandidates: z
          .array(
            z.object({
              id: idSchema,
              title: shortText.trim().min(1),
              content: z.string().max(1_000_000),
              source: taskKindSchema,
              createdAt: z.string().max(40),
              development: developmentDraftSchema.optional(),
              conversationId: idSchema.optional(),
              turnId: idSchema.optional(),
            }),
          )
          .max(100)
          .optional(),
        archived: z.boolean().optional(),
      })
      .parse(p);
    return repo.db.transaction(() => {
      if (patch.blueprintCandidates)
        patch.blueprintCandidates = synchronizeCandidateEdits(
          repo,
          id,
          patch.blueprintCandidates,
        );
      return repo.updateProject(id, patch);
    })();
  },
  "project:delete": async (p) => {
    assertIdle();
    const filenames = repo.deleteArchivedProject(idSchema.parse(p));
    await Promise.all(
      filenames.map((filename) =>
        removeAsset(dataDir, filename).catch((error) => {
          console.warn("故事已删除，但有素材未能清理：", filename, error);
        }),
      ),
    );
    return true;
  },
  "workflow:templates:get": () => [
    ...builtinWorkflowTemplates,
    ...repo.listWorkflowTemplates(),
  ],
  "workflow:templates:save": (p) => {
    const templates = z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          name: shortText.trim().min(1),
          description: z.string().max(2000),
          builtin: z.boolean().optional(),
          steps: z
            .array(
              z.object({
                id: z.string().min(1).max(100),
                kind: taskKindSchema,
                title: shortText.trim().min(1),
                instruction: longText,
              }),
            )
            .min(1)
            .max(20),
        }),
      )
      .max(100)
      .parse(p) as WorkflowTemplate[];
    return repo.saveWorkflowTemplates(
      templates.filter((template) => !template.builtin),
    );
  },
  "workflow:runs:get": (p) => repo.listWorkflowRuns(idSchema.parse(p)),
  "workflow:run:save": (p) => {
    const run = z
      .object({
        id: idSchema,
        projectId: idSchema,
        templateId: z.string().max(100),
        templateName: shortText,
        chapterId: z.string().max(40),
        steps: z
          .array(
            z.object({
              id: z.string().max(100),
              kind: taskKindSchema,
              title: shortText,
              instruction: longText,
            }),
          )
          .min(1)
          .max(20),
        results: z
          .array(
            z.object({
              stepId: z.string().max(100),
              status: z.enum(["pending", "approved", "skipped"]),
              output: z.string().max(1_000_000),
              updatedAt: z.string().max(40),
              memoryRecords: z
                .array(
                  z.object({
                    kind: memoryKindSchema,
                    content: z.string().max(3000),
                  }),
                )
                .max(24)
                .optional(),
              memoryRevisionId: idSchema.optional(),
              applied: z.boolean().optional(),
              outputSelection: z
                .object({
                  text: z.string().max(500_000),
                  from: z.number().int().min(0),
                  to: z.number().int().min(0),
                })
                .nullable()
                .optional(),
            }),
          )
          .max(20),
        currentStep: z.number().int().min(0).max(20),
        createdAt: z.string().max(40),
        updatedAt: z.string().max(40),
      })
      .parse(p) as WorkflowRun;
    return repo.saveWorkflowRun(run);
  },
  "chapter:create": (p) => repo.createChapter(idSchema.parse(p)),
  "fragment:create": (p) => createFragment(repo, idSchema.parse(p)),
  "fragment:incorporate": (p) => {
    assertIdle();
    const v = z
      .object({
        projectId: idSchema,
        fragmentId: idSchema,
        chapterId: idSchema.optional(),
        beforeId: idSchema.optional(),
        allowRepeat: z.boolean().optional(),
      })
      .parse(p);
    return incorporateFragment(repo, v.projectId, v.fragmentId, v);
  },
  "chapter:reorder": (p) => {
    assertIdle();
    const v = z
      .object({ projectId: idSchema, ids: z.array(idSchema) })
      .parse(p);
    return reorderChapters(repo, v.projectId, v.ids);
  },
  "planning:save": (p) => {
    const v = z
      .object({
        projectId: idSchema,
        target: planningTargetSchema,
        content: longText,
        title: shortText.optional(),
        confirm: z.boolean().optional(),
      })
      .parse(p);
    return savePlanning(repo, v.projectId, v.target, v);
  },
  "planning:apply": (p) => {
    const v = z
      .object({
        draft: planningDraftSchema,
        selectedIds: z.array(idSchema).min(1).max(30),
        turnId: idSchema.optional(),
      })
      .parse(p);
    if (v.turnId)
      return applyConversationPlanning(
        repo,
        v.draft.projectId,
        v.turnId,
        v.selectedIds,
      );
    const detail = applyPlanning(repo, v.draft, v.selectedIds);
    return { detail, base: planningBase(repo, v.draft.projectId) };
  },
  "planning:history": (p) => planningHistory(repo, idSchema.parse(p)),
  "planning:remove": (p) => {
    assertIdle();
    const v = z
      .object({ projectId: idSchema, target: planningTargetSchema })
      .parse(p);
    return removePlanning(repo, v.projectId, v.target);
  },
  "planning:version:update": (p) => {
    const v = z
      .object({
        projectId: idSchema,
        versionId: idSchema,
        label: shortText.trim().min(1),
      })
      .parse(p);
    return managePlanningVersion(repo, v.projectId, v.versionId, v.label);
  },
  "planning:version:delete": (p) => {
    assertIdle();
    const v = z.object({ projectId: idSchema, versionId: idSchema }).parse(p);
    return managePlanningVersion(repo, v.projectId, v.versionId);
  },
  "planning:snapshot": (p) =>
    snapshotPlanning(repo, idSchema.parse(p), "手动保存规划版本"),
  "planning:restore": (p) => {
    const v = z.object({ projectId: idSchema, versionId: idSchema }).parse(p);
    return restorePlanning(repo, v.projectId, v.versionId);
  },
  "planning:organize": (p) => {
    assertIdle();
    const v = z
      .object({
        projectId: idSchema,
        chapterId: idSchema,
        volumeId: idSchema.nullable(),
        sceneIds: z.array(idSchema).optional(),
      })
      .parse(p);
    return organizePlanning(
      repo,
      v.projectId,
      v.chapterId,
      v.volumeId,
      v.sceneIds,
    );
  },
  "planning:move:preview": (p) => {
    assertIdle();
    const v = planningMoveSchema.parse(p);
    return previewPlanningMove(repo, v.projectId, v);
  },
  "planning:move": (p) => {
    assertIdle();
    const v = planningMoveSchema
      .extend({
        base: z.string().length(64),
        confirmNormalization: z.boolean().optional(),
      })
      .parse(p);
    return movePlanning(repo, v.projectId, v, v.base, v.confirmNormalization);
  },
  "planning:acknowledge": (p) => {
    const v = z.object({ projectId: idSchema, chapterId: idSchema }).parse(p);
    const c = repo
      .getDetail(v.projectId)
      .chapters.find((c) => c.id === v.chapterId);
    if (!c) throw new Error("章节不属于当前故事。");
    delete c.planningReview;
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify(c), c.id);
    return repo.getDetail(v.projectId);
  },
  "story:apply-development": (p) => {
    const value = z
      .object({
        projectId: idSchema,
        draft: developmentDraftSchema,
        selectedIds: z.array(idSchema).min(1).max(30),
        turnId: idSchema.optional(),
      })
      .parse(p);
    if (value.turnId)
      return applyConversationDevelopment(
        repo,
        value.projectId,
        value.turnId,
        value.selectedIds,
      );
    return applyDevelopment(
      repo,
      value.projectId,
      value.draft,
      value.selectedIds,
    );
  },
  "story:undo-development": (p) => {
    const value = z.object({ projectId: idSchema, undoId: idSchema }).parse(p);
    return undoConversationDevelopment(repo, value.projectId, value.undoId);
  },
  "chapter:delete": (p) => {
    assertIdle();
    if (typeof p === "string") return repo.deleteChapter(idSchema.parse(p));
    const v = z.object({ id: idSchema, projectId: idSchema }).parse(p);
    if (repo.getChapter(v.id).projectId !== v.projectId)
      throw new Error("章节或片段不属于当前故事。");
    return repo.deleteChapter(v.id);
  },
  "chapter:update": (p) => {
    if (JSON.stringify(p).length > 2_000_000)
      throw new Error("单章内容过大，请拆分为多个章节。");
    const { id, ...patch } = z
      .object({
        id: idSchema,
        title: shortText.trim().min(1).optional(),
        plan: longText.optional(),
        document: documentSchema.optional(),
        fragmentContext: z
          .object({
            time: shortText,
            place: shortText,
            viewpoint: shortText,
            connection: longText,
            anchorId: idSchema.optional(),
          })
          .optional(),
      })
      .parse(p);
    return repo.updateChapter(id, patch);
  },
  "chapter:adopt": (p) => repo.adoptChapter(idSchema.parse(p)),
  "chapter:checkpoint": (p) => {
    const v = z.object({ id: idSchema, label: shortText.optional() }).parse(p);
    return repo.checkpoint(v.id, v.label);
  },
  "chapter:revisions": (p) => repo.listRevisions(idSchema.parse(p)),
  "revision:usage": (p) => {
    const v = z.object({ projectId: idSchema, id: idSchema }).parse(p);
    return repo.revisionUsage(v.projectId, v.id);
  },
  "revision:update": (p) => {
    const v = z
      .object({
        projectId: idSchema,
        id: idSchema,
        label: shortText.trim().min(1),
      })
      .parse(p);
    return repo.manageRevision(v.projectId, v.id, v.label);
  },
  "revision:delete": (p) => {
    assertIdle();
    const v = z.object({ projectId: idSchema, id: idSchema }).parse(p);
    return repo.manageRevision(v.projectId, v.id);
  },
  "chapter:restore": (p) => repo.restoreRevision(idSchema.parse(p)),
  "card:save": (p) => {
    const card = cardContentSchema
      .extend({
        id: idSchema.optional(),
        projectId: idSchema.nullable(),
        name: shortText.trim().min(1),
        referenceIds: z.array(idSchema).max(12),
      })
      .parse(p);
    for (const ref of card.referenceIds) repo.getImage(ref);
    return repo.saveCard(card);
  },
  "card:delete": (p) => repo.deleteCard(idSchema.parse(p)),
  "card:import": async () => {
    const result = await dialog.showOpenDialog({
      title: "导入设定文档",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "文字文档", extensions: ["txt", "md", "markdown"] }],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > materialLimits.documents)
      throw new Error("一次最多导入 12 份文档。");
    const documents = [];
    for (const path of result.filePaths) {
      if ((await stat(path)).size > 2_000_000)
        throw new Error(`${basename(path)} 超过 2 MB，请拆分后导入。`);
      documents.push(importTextDocument(path, await readFile(path)));
    }
    return documents;
  },
  "card:organize": async (p) => {
    const { requestId, instruction, card } = z
      .object({
        requestId: idSchema,
        instruction: longText,
        card: cardContentSchema,
      })
      .parse(p);
    if (jobs.has(requestId)) throw new Error("任务已经开始。");
    const messages = buildMaterialMessages(
      roleSettings(repo),
      { ...card, projectId: null, referenceIds: [] },
      instruction,
    );
    const controller = new AbortController();
    jobs.set(requestId, controller);
    try {
      const output = await chat(
        connectionForRole("material"),
        messages,
        () => {},
        controller.signal,
      );
      if (controller.signal.aborted)
        throw new Error("整理已停止，现有资料和原始文档已保留。");
      return parseMaterialDraft(
        output,
        card.documents.filter((doc) => doc.enabled).map((doc) => doc.id),
      );
    } finally {
      jobs.delete(requestId);
    }
  },
  "roles:save": (p) => {
    const value: RoleSettings = z
      .object({
        commonPrompt: z.string().max(20000),
        roles: z
          .array(
            z.object({
              id: roleIdSchema,
              prompt: z.string().trim().min(1).max(20000),
              model: shortText.trim(),
            }),
          )
          .length(roleDefinitions.length),
      })
      .parse(p);
    if (
      new Set(value.roles.map((role) => role.id)).size !==
      roleDefinitions.length
    )
      throw new Error("AI 职责重复或缺失，请刷新后重试。");
    const available = settings(repo, dataDir).text.selectedModels;
    if (
      value.roles.some((role) => role.model && !available.includes(role.model))
    )
      throw new Error("请为职责选择已勾选的文字模型，或改为跟随当前文字模型。");
    repo.setSetting("ai.roles", value);
    return roleSettings(repo);
  },
  "ai:preview": (p) => {
    const request = taskSchema.parse(p);
    const { built, omittedTurns } = prepareConversationTask(repo, request);
    return {
      systemPrompt: built.messages[0].content,
      context: built.messages[1].content,
      model: connectionForRole(request.kind).model,
      coverage: built.coverage,
      omitted: built.omitted,
      messages: built.messages,
      omittedTurns,
    };
  },
  "card:copy": (p) => {
    const v = z
      .object({ id: idSchema, projectId: idSchema.nullable() })
      .parse(p);
    return repo.copyCard(v.id, v.projectId);
  },
  "memory:add": (p) => {
    const v = z
      .object({
        projectId: idSchema,
        kind: memoryKindSchema,
        content: longText.trim().min(1),
      })
      .parse(p);
    return repo.addMemory(v.projectId, v.kind, v.content);
  },
  "memory:toggle": (p) => {
    const v = z.object({ id: idSchema, active: z.boolean() }).parse(p);
    return repo.setMemoryActive(v.id, v.active);
  },
  "memory:update": (p) => {
    const v = z
      .object({
        projectId: idSchema,
        id: idSchema,
        kind: memoryKindSchema,
        content: longText.trim().min(1),
      })
      .parse(p);
    return repo.updateMemory(v.projectId, v.id, v);
  },
  "memory:delete": (p) => {
    assertIdle();
    const v = z.object({ projectId: idSchema, id: idSchema }).parse(p);
    return repo.deleteMemory(v.projectId, v.id);
  },
  "asset:usage": (p) => repo.imageUsage(idSchema.parse(p)),
  "asset:update": (p) => {
    const v = z
      .object({
        id: idSchema,
        name: shortText.trim().min(1),
        notes: z.string().max(20_000),
      })
      .parse(p);
    return repo.updateImage(v.id, v.name, v.notes);
  },
  "asset:delete": async (p) => {
    assertIdle();
    repo.deleteImage(idSchema.parse(p));
    return { pendingCleanup: await cleanupDeletedAssets(repo, dataDir) };
  },
  "memory:apply-generated": (p) => {
    const value = z
      .object({
        chapterId: idSchema,
        revisionId: idSchema,
        turnId: idSchema.optional(),
        records: z
          .array(
            z.object({
              kind: memoryKindSchema,
              content: z.string().trim().min(1).max(3000),
            }),
          )
          .min(1)
          .max(24),
      })
      .parse(p);
    if (value.turnId)
      return applyConversationMemory(
        repo,
        repo.getChapter(value.chapterId).projectId,
        value.turnId,
      );
    return repo.saveGeneratedMemories(
      value.chapterId,
      value.revisionId,
      value.records,
    );
  },
  "settings:save": (p) => saveSettings(repo, dataDir, p),
  "settings:software": (p) => saveSoftwareSettings(repo, p),
  "settings:models": async (p) => {
    const value = z
      .object({
        kind: z.enum(["text", "image"]),
        baseUrl: z.string().trim().url().max(2000),
        key: z.string().max(4000),
      })
      .parse(p);
    const key = value.key.trim();
    try {
      return await listModels({ baseUrl: value.baseUrl, key });
    } catch (error) {
      const message = error instanceof Error ? error.message : "获取模型失败。";
      throw new Error(key ? message.split(key).join("[已隐藏]") : message);
    }
  },
  "settings:model": (p) => {
    const value = z
      .object({
        kind: z.enum(["text", "image"]),
        model: shortText.trim().min(1),
      })
      .parse(p);
    if (
      !settings(repo, dataDir)[value.kind].selectedModels.includes(value.model)
    )
      throw new Error("请先在设置中勾选并保存此模型。");
    repo.setSetting(`${value.kind}.model`, value.model);
    return settings(repo, dataDir);
  },
  "settings:test": async (p) => {
    if (z.enum(["text", "image"]).parse(p) === "image")
      throw new Error("请在插画页手动生成一张图片，验证生图模型的实际效果。");
    const output = await chat(
      connection("text"),
      [{ role: "user", content: "请只回复：连接成功" }],
      () => {},
    );
    return output.slice(0, 200);
  },
  "ai:chapter-title": async (p) => {
    const request = z
      .object({ requestId: idSchema, projectId: idSchema, chapterId: idSchema })
      .parse(p);
    if (jobs.has(request.requestId)) throw new Error("任务已经开始。");
    const messages = buildChapterTitleMessages(
      repo,
      request.projectId,
      request.chapterId,
    );
    const controller = new AbortController();
    jobs.set(request.requestId, controller);
    try {
      const text = await chat(
        connectionForRole("title"),
        messages,
        () => {},
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error("已停止生成章节名称。");
      return { title: parseChapterTitle(text) };
    } finally {
      jobs.delete(request.requestId);
    }
  },
  "ai:run": async (p, event) => {
    const request: TaskRequest = taskSchema.parse(p);
    if (jobs.has(request.requestId)) throw new Error("任务已经开始。");
    const controller = new AbortController();
    jobs.set(request.requestId, controller);
    try {
      const config = connectionForRole(request.kind);
      return await runCreationTask(repo, request, {
        model: config.model,
        signal: controller.signal,
        generate: (messages, delta) =>
          chat(config, messages, delta, controller.signal),
        progress: (progress) => {
          if (!event.sender.isDestroyed())
            event.sender.send("ai:progress", progress);
        },
      });
    } finally {
      jobs.delete(request.requestId);
    }
  },
  "ai:cancel": (p) => {
    jobs.get(idSchema.parse(p))?.abort();
    return true;
  },
  "asset:import": async (p) => {
    const value = z.object({ projectId: idSchema.nullable() }).parse(p);
    if (value.projectId) repo.getProject(value.projectId);
    const result = await dialog.showOpenDialog({
      title: "选择 OC 或场景参考图",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (result.canceled) return [];
    const imported: ImageAsset[] = [];
    for (const path of result.filePaths.slice(0, 12)) {
      if ((await stat(path)).size > 20_000_000)
        throw new Error("参考图请控制在每张 20 MB 以内。");
      const bytes = await readFile(path),
        info = imageMime(bytes),
        id = randomUUID(),
        filename = id + info.extension;
      imported.push(
        await saveImageAsset(
          repo,
          dataDir,
          {
            id,
            projectId: value.projectId,
            chapterId: null,
            revisionId: null,
            kind: "reference",
            name: basename(path),
            filename,
            prompt: "",
            referenceIds: [],
            model: "",
            createdAt: new Date().toISOString(),
          },
          bytes,
        ),
      );
    }
    return imported;
  },
  "image:generate": async (p) => {
    const value = z
      .object({
        projectId: idSchema,
        chapterId: idSchema.optional(),
        prompt: longText.trim().min(1),
        referenceIds: z.array(idSchema).max(8),
        size: shortText,
        quality: z.enum(["auto", "low", "medium", "high"]),
      })
      .parse(p);
    repo.getProject(value.projectId);
    const chapter = value.chapterId ? repo.getChapter(value.chapterId) : null;
    if (chapter && chapter.projectId !== value.projectId)
      throw new Error("图片章节不属于当前故事。");
    const revisionId = chapter?.acceptedRevisionId ?? null;
    const references = await Promise.all(
      value.referenceIds.map(async (id) => {
        const ref = repo.getImage(id),
          data = await readAsset(dataDir, ref.filename);
        return {
          data: new Uint8Array(data),
          name: basename(ref.filename),
          mime: imageMime(data).mime,
        };
      }),
    );
    const jobId = "image-" + randomUUID(),
      controller = new AbortController();
    jobs.set(jobId, controller);
    try {
      const config = connection("image");
      const result = await generateImage(
        config,
        value.prompt,
        value.size,
        value.quality,
        references,
        controller.signal,
      );
      const info = imageMime(result.bytes),
        id = randomUUID(),
        filename = id + info.extension;
      return await saveImageAsset(
        repo,
        dataDir,
        {
          id,
          projectId: value.projectId,
          chapterId: value.chapterId ?? null,
          revisionId,
          kind: "illustration",
          name: `${chapter?.title || "故事"} · 插画`,
          filename,
          prompt: value.prompt,
          referenceIds: value.referenceIds,
          model: config.model,
          createdAt: new Date().toISOString(),
        },
        result.bytes,
      );
    } finally {
      jobs.delete(jobId);
    }
  },
  "asset:export": async (p) => {
    const image = repo.getImage(idSchema.parse(p));
    const result = await dialog.showSaveDialog({
      title: "保存图片",
      defaultPath: join(
        dataDir,
        "exports",
        image.name + image.filename.slice(image.filename.lastIndexOf(".")),
      ),
    });
    if (result.canceled || !result.filePath) return null;
    await copyFile(await assetPath(dataDir, image.filename), result.filePath);
    return result.filePath;
  },
  "project:export": async (p) => {
    const request =
      typeof p === "string"
        ? { projectId: idSchema.parse(p), fragments: false }
        : z
            .object({
              projectId: idSchema,
              fragments: z.boolean().default(false),
            })
            .parse(p);
    const detail = repo.getDetail(request.projectId);
    const result = await dialog.showSaveDialog({
      title: "导出当前草稿",
      defaultPath: join(
        dataDir,
        "exports",
        detail.project.title.replace(/[<>:"/\\|?*]/g, "_") +
          (request.fragments ? "-片段" : "") +
          ".md",
      ),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "纯文本", extensions: ["txt"] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    const content = exportStory(repo, request.projectId, request.fragments);
    await writeFile(result.filePath, content, "utf8");
    return result.filePath;
  },
  "storage:backup": async () => {
    assertIdle();
    maintenance = true;
    try {
      return await makeBackup(repo, dataDir);
    } finally {
      maintenance = false;
    }
  },
  "storage:open": () => shell.openPath(dataDir),
  "storage:move": async () => {
    assertIdle();
    maintenance = true;
    try {
      if (!(await migrateData(repo, dataDir))) {
        maintenance = false;
        return false;
      }
    } catch (error) {
      maintenance = false;
      throw error;
    }
    setTimeout(() => {
      app.relaunch();
      closing = true;
      app.quit();
    }, 400);
    return true;
  },
  "window:minimize": () => window?.minimize(),
  "window:hide": () => {
    if (tray && !tray.isDestroyed()) window?.hide();
    else throw new Error("系统托盘不可用，请使用标题栏的最小化按钮。");
  },
  "window:maximize": () => {
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  },
  "window:close": () => {
    closing = true;
    window?.close();
  },
};

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray() {
  tray = new Tray(trayIcon);
  tray.setToolTip("页间 · 故事创作工作台");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开页间", click: showWindow },
      { type: "separator" },
      {
        label: "退出页间",
        click: () => {
          showWindow();
          window?.webContents.send("app:closing", "quit");
        },
      },
    ]),
  );
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    backgroundColor: "#f5f7fa",
    title: "页间 · 故事创作工作台",
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const current = new URL(window!.webContents.getURL()),
      target = new URL(url);
    if (
      current.origin !== target.origin ||
      (current.protocol === "file:" && current.pathname !== target.pathname)
    )
      event.preventDefault();
  });
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (!closing) {
      event.preventDefault();
      window?.webContents.send("app:closing");
    }
  });
  window.on("closed", () => {
    window = null;
  });
  if (process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
}

if (hasLock) {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("com.betweenpages.storybook");
      app.setName("页间");
      assertDataLayoutSupported(dataDir);
      repo = new StoryRepository(join(dataDir, "database", "storybook.sqlite"));
      Object.assign(handlers, conversationHandlers(repo));
      const layout = await upgradeDataLayout(repo, dataDir);
      await cleanupDeletedAssets(repo, dataDir);
      if (layout.missing.length)
        console.warn(
          "以下旧图片文件缺失，已保留原记录以便恢复：",
          layout.missing,
        );
      protocol.handle("story-asset", async (request) => {
        try {
          const url = new URL(request.url);
          if (url.hostname !== "asset")
            return new Response("Not found", { status: 404 });
          const image = repo.getImage(idSchema.parse(url.pathname.slice(1)));
          const bytes = await readAsset(dataDir, image.filename);
          return new Response(new Uint8Array(bytes), {
            headers: {
              "Content-Type": imageMime(bytes).mime,
              "Cache-Control": "private, max-age=86400",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      ipcMain.handle(
        "storybook:invoke",
        async (event, action: unknown, payload: unknown) => {
          if (
            event.sender.id !== window?.webContents.id ||
            typeof action !== "string" ||
            !Object.hasOwn(handlers, action)
          )
            return { ok: false, error: "不支持的操作。" };
          try {
            if (maintenance)
              throw new Error("正在备份或迁移数据，请稍候再操作。");
            activeOperations++;
            try {
              return { ok: true, data: await handlers[action](payload, event) };
            } finally {
              activeOperations--;
            }
          } catch (error) {
            let message =
              error instanceof Error ? error.message : "操作失败，请重试。";
            if (error instanceof z.ZodError)
              message = "输入内容不完整或格式不正确，请检查后重试。";
            if (
              error instanceof Error &&
              ["AbortError", "TimeoutError"].includes(error.name)
            )
              message =
                error.name === "AbortError"
                  ? "生成已停止，已收到的内容仍然保留。"
                  : "请求超时，已收到的内容仍然保留。";
            for (const kind of ["text", "image"] as const) {
              const key = readKey(repo, kind);
              if (key) message = message.split(key).join("[已隐藏]");
            }
            return { ok: false, error: message };
          }
        },
      );
      await createWindow();
      createTray();
    })
    .catch((error) => {
      dialog.showErrorBox(
        "页间启动失败",
        `无法打开数据目录或应用：\n${error.message}\n\n请将软件放在有写入权限的文件夹后重试。`,
      );
      closing = true;
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (!closing && window) {
      event.preventDefault();
      window.close();
      return;
    }
    for (const controller of jobs.values()) controller.abort();
  });
  app.on("will-quit", () => {
    tray?.destroy();
    tray = null;
    if (repo?.db.open) repo.close();
  });
}
