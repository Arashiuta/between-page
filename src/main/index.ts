import { app, BrowserWindow, ipcMain, protocol, dialog, shell } from "electron";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, copyFile, stat, unlink } from "node:fs/promises";
import { z } from "zod";
import { StoryRepository } from "./database";
import { chat, generateImage, listModels, type Connection } from "./provider";
import { buildTask, parseMemories } from "./prompts";
import {
  importTextDocument,
  buildMaterialMessages,
  parseMaterialDraft,
} from "./materials";
import { roleSettings } from "./roles";
import { effectiveRole, roleDefinitions } from "../shared/roles";
import { materialLimits } from "../shared/materials";
import { builtinWorkflowTemplates } from "../shared/workflows";
import {
  resolveDataDir,
  initializeDirectories,
  settings,
  readKey,
  saveSettings,
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
const jobs = new Map<string, AbortController>();
let closing = false;
let maintenance = false;
const idSchema = z.string().uuid();
const shortText = z.string().max(500);
const longText = z.string().max(200_000);
const kindSchema = z.enum(["character", "world", "inspiration"]);
const roleIdSchema = z.enum([
  "chapter",
  "outline",
  "adjust",
  "check",
  "notes",
  "prompt",
  "revise",
  "organize",
  "brainstorm",
  "scene",
  "dialogue",
  "pacing",
  "arc",
  "material",
]);
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
  kind: z.enum([
    "chapter",
    "outline",
    "adjust",
    "check",
    "notes",
    "prompt",
    "revise",
    "organize",
    "brainstorm",
    "scene",
    "dialogue",
    "pacing",
    "arc",
  ]),
  projectId: idSchema,
  chapterId: idSchema.optional(),
  instruction: longText,
  selection: longText.optional(),
  workflowContext: z.string().max(80_000).optional(),
});
function assertIdle() {
  if (jobs.size) throw new Error("请先停止或等待当前生成任务完成。");
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
        kind: z.enum([
          "chapter",
          "outline",
          "adjust",
          "check",
          "notes",
          "prompt",
          "revise",
          "organize",
          "brainstorm",
          "scene",
          "dialogue",
          "pacing",
          "arc",
        ]),
        instruction: longText,
        output: z.string().max(1_000_000),
        chapterId: z.string().max(40),
        memoryRecords: z.array(z.object({ kind: memoryKindSchema, content: z.string().max(3000) })).max(24).nullable().optional(),
        memoryRevisionId: idSchema.or(z.literal("")).optional(),
        outputSelection: z.object({
          text: z.string().max(500_000),
          from: z.number().int().min(0),
          to: z.number().int().min(0),
        }).nullable().optional(),
      })
      .parse(p);
    repo.getProject(v.projectId);
    repo.setSetting("scratch." + v.projectId, v);
    return true;
  },
  "project:create": (p) =>
    repo.createProject(
      z
        .object({
          title: shortText.trim().min(1),
          premise: longText,
          mode: z.enum(["explore", "novel"]),
          genre: shortText.optional(),
          cardIds: z.array(idSchema).max(100).optional(),
        })
        .parse(p),
    ),
  "project:update": (p) => {
    const { id, ...patch } = z
      .object({
        id: idSchema,
        title: shortText.trim().min(1).optional(),
        premise: longText.optional(),
        mode: z.enum(["explore", "novel"]).optional(),
        genre: shortText.optional(),
        world: longText.optional(),
        style: longText.optional(),
        outline: longText.optional(),
        blueprintSections: z.array(z.object({
          id: z.string().min(1).max(80),
          title: shortText.trim().min(1),
          content: longText,
        })).max(50).optional(),
        blueprintCandidates: z.array(z.object({
          id: idSchema,
          title: shortText.trim().min(1),
          content: z.string().max(1_000_000),
          source: z.enum(["chapter", "outline", "adjust", "check", "notes", "prompt", "revise", "organize", "brainstorm", "scene", "dialogue", "pacing", "arc"]),
          createdAt: z.string().max(40),
        })).max(100).optional(),
        archived: z.boolean().optional(),
      })
      .parse(p);
    return repo.updateProject(id, patch);
  },
  "project:delete": async (p) => {
    const filenames = repo.deleteArchivedProject(idSchema.parse(p));
    await Promise.all(filenames.map((filename) => unlink(join(dataDir, "assets", filename)).catch(() => undefined)));
    return true;
  },
  "workflow:templates:get": () => [
    ...builtinWorkflowTemplates,
    ...repo.listWorkflowTemplates(),
  ],
  "workflow:templates:save": (p) => {
    const templates = z.array(z.object({
      id: z.string().min(1).max(100),
      name: shortText.trim().min(1),
      description: z.string().max(2000),
      builtin: z.boolean().optional(),
      steps: z.array(z.object({
        id: z.string().min(1).max(100),
        kind: z.enum(["chapter", "outline", "adjust", "check", "notes", "prompt", "revise", "organize", "brainstorm", "scene", "dialogue", "pacing", "arc"]),
        title: shortText.trim().min(1),
        instruction: longText,
      })).min(1).max(20),
    })).max(100).parse(p) as WorkflowTemplate[];
    return repo.saveWorkflowTemplates(templates.filter((template) => !template.builtin));
  },
  "workflow:runs:get": (p) => repo.listWorkflowRuns(idSchema.parse(p)),
  "workflow:run:save": (p) => {
    const run = z.object({
      id: idSchema,
      projectId: idSchema,
      templateId: z.string().max(100),
      templateName: shortText,
      chapterId: z.string().max(40),
      steps: z.array(z.object({
        id: z.string().max(100),
        kind: z.enum(["chapter", "outline", "adjust", "check", "notes", "prompt", "revise", "organize", "brainstorm", "scene", "dialogue", "pacing", "arc"]),
        title: shortText,
        instruction: longText,
      })).min(1).max(20),
      results: z.array(z.object({
        stepId: z.string().max(100),
        status: z.enum(["pending", "approved", "skipped"]),
        output: z.string().max(1_000_000),
        updatedAt: z.string().max(40),
        memoryRecords: z.array(z.object({ kind: memoryKindSchema, content: z.string().max(3000) })).max(24).optional(),
        memoryRevisionId: idSchema.optional(),
        applied: z.boolean().optional(),
        outputSelection: z.object({
          text: z.string().max(500_000),
          from: z.number().int().min(0),
          to: z.number().int().min(0),
        }).nullable().optional(),
      })).max(20),
      currentStep: z.number().int().min(0).max(20),
      createdAt: z.string().max(40),
      updatedAt: z.string().max(40),
    }).parse(p) as WorkflowRun;
    return repo.saveWorkflowRun(run);
  },
  "chapter:create": (p) => repo.createChapter(idSchema.parse(p)),
  "chapter:delete": (p) => {
    assertIdle();
    return repo.deleteChapter(idSchema.parse(p));
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
    const built = buildTask(repo, request);
    return {
      systemPrompt: built.messages[0].content,
      context: built.messages[1].content,
      model: connectionForRole(request.kind).model,
      coverage: built.coverage,
      omitted: built.omitted,
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
  "memory:apply-generated": (p) => {
    const value = z.object({
      chapterId: idSchema,
      revisionId: idSchema,
      records: z.array(z.object({ kind: memoryKindSchema, content: z.string().trim().min(1).max(3000) })).min(1).max(24),
    }).parse(p);
    return repo.saveGeneratedMemories(value.chapterId, value.revisionId, value.records);
  },
  "settings:save": (p) => saveSettings(repo, dataDir, p),
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
  "ai:run": async (p, event) => {
    const request: TaskRequest = taskSchema.parse(p);
    if (jobs.has(request.requestId)) throw new Error("任务已经开始。");
    const built = buildTask(repo, request);
    const controller = new AbortController();
    jobs.set(request.requestId, controller);
    try {
      const text = await chat(
        connectionForRole(request.kind),
        built.messages,
        (delta) => {
          if (!event.sender.isDestroyed())
            event.sender.send("ai:progress", {
              requestId: request.requestId,
              delta,
            });
        },
        controller.signal,
      );
      if (controller.signal.aborted)
        throw new Error("生成已停止，收到的内容保留在草稿区。");
      if (request.kind === "notes") {
        const records = parseMemories(text);
        return {
          text: records.map((r) => `- [${r.kind}] ${r.content}`).join("\n\n"),
          memoryRecords: records,
          memoryRevisionId: built.revisionId,
        };
      }
      return { text };
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
      await writeFile(join(dataDir, "assets", filename), bytes);
      imported.push(
        repo.addImage({
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
        }),
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
          data = await readFile(join(dataDir, "assets", ref.filename));
        return {
          data: new Uint8Array(data),
          name: ref.filename,
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
      await writeFile(join(dataDir, "assets", filename), result.bytes);
      return repo.addImage({
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
      });
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
    await copyFile(join(dataDir, "assets", image.filename), result.filePath);
    return result.filePath;
  },
  "project:export": async (p) => {
    const detail = repo.getDetail(idSchema.parse(p));
    const result = await dialog.showSaveDialog({
      title: "导出当前草稿",
      defaultPath: join(
        dataDir,
        "exports",
        detail.project.title.replace(/[<>:"/\\|?*]/g, "_") + ".md",
      ),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "纯文本", extensions: ["txt"] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    const content =
      `# ${detail.project.title}\n\n` +
      detail.chapters
        .map((c) => `## ${c.title}\n\n${c.content}`)
        .join("\n\n---\n\n");
    await writeFile(result.filePath, content, "utf8");
    return result.filePath;
  },
  "storage:backup": () => {
    assertIdle();
    return makeBackup(repo, dataDir);
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
  "window:maximize": () => {
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  },
  "window:close": () => {
    closing = true;
    window?.close();
  },
};

async function createWindow() {
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    backgroundColor: "#f5f7fa",
    title: "页间 · 故事创作工作台",
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
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      repo = new StoryRepository(join(dataDir, "database", "storybook.sqlite"));
      protocol.handle("story-asset", async (request) => {
        try {
          const url = new URL(request.url);
          if (url.hostname !== "asset")
            return new Response("Not found", { status: 404 });
          const image = repo.getImage(idSchema.parse(url.pathname.slice(1)));
          const bytes = await readFile(join(dataDir, "assets", image.filename));
          return new Response(bytes, {
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
            if (maintenance) throw new Error("正在迁移数据，请稍候再操作。");
            return { ok: true, data: await handlers[action](payload, event) };
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
    })
    .catch((error) => {
      dialog.showErrorBox(
        "页间启动失败",
        `无法打开数据目录或应用：\n${error.message}\n\n请将软件放在有写入权限的文件夹后重试。`,
      );
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    for (const controller of jobs.values()) controller.abort();
  });
  app.on("will-quit", () => {
    if (repo?.db.open) repo.close();
  });
}
