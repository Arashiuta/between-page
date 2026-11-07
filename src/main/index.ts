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

import {
  importTextDocument,
  refineMaterial,
  refineMaterialSchema,
} from "./materials";
import { roleSettings } from "./roles";
import { rolePrompt, roleDefinitions } from "../shared/roles";
import { resolveTextModel } from "../shared/models";
import { materialLimits } from "../shared/materials";
import { prepareReferenceImage } from "./reference-images";
import { taskKinds } from "../shared/types";
import { exportStory } from "./writing";
import { workspaceHandlers } from "./workspace-handlers";
import { requestSchema } from "../shared/requests";
import { defaultCapabilities } from "../shared/tools";
import appIcon from "../../build/icon.png?asset";
import trayIcon from "../../build/icon.ico?asset";
import { runCreationTask, prepareTaskPreview } from "./conversations";
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
  ImageAsset,
  TaskRequest,
  RoleId,
  RoleSettings,
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
const roleIdSchema = z.enum(taskKinds);
const freedomSchema = z.enum(["guided", "balanced", "free"]);
const connection = (kind: "text" | "image"): Connection => ({
  ...settings(repo, dataDir)[kind],
  key: readKey(repo, kind),
});
function connectionForRole(id: RoleId, override?: string): Connection {
  const config = connection("text");
  return {
    ...config,
    model: resolveTextModel(
      settings(repo, dataDir).text,
      roleSettings(repo),
      id,
      override,
    ),
  };
}
function contextOptions(id: RoleId, override?: string) {
  const config = connectionForRole(id, override);
  const capabilities =
    settings(repo, dataDir).text.capabilities[config.model] ??
    defaultCapabilities();
  return {
    model: config.model,
    capabilities,
    readImage: async (imageId: string, maxBytes: number) => {
      const image = repo.getImage(imageId);
      const bytes = await readAsset(dataDir, image.filename);
      return prepareReferenceImage(bytes, maxBytes);
    },
  };
}
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
  "card:refine": async (p) => {
    const value = refineMaterialSchema.parse(p);
    if (jobs.has(value.requestId)) throw new Error("任务已经开始。");
    const controller = new AbortController();
    jobs.set(value.requestId, controller);
    try {
      const config = connectionForRole("settings", value.model);
      const opts = contextOptions("settings", value.model);
      return await refineMaterial(value, {
        prompt: rolePrompt(roleSettings(repo), "settings"),
        capabilities: opts.capabilities,
        generate: (messages) =>
          chat(
            config,
            messages,
            () => {},
            controller.signal,
            opts.capabilities.outputTokens,
          ),
      });
    } finally {
      jobs.delete(value.requestId);
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
  "ai:preview": async (p) => {
    const request = requestSchema.parse(p) as TaskRequest;
    return prepareTaskPreview(
      repo,
      request,
      contextOptions(request.kind, request.model),
    );
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
  "ai:run": async (p, event) => {
    const request = requestSchema.parse(p) as TaskRequest;
    if (jobs.has(request.requestId)) throw new Error("任务已经开始。");
    const controller = new AbortController();
    jobs.set(request.requestId, controller);
    try {
      const config = connectionForRole(request.kind, request.model);
      const opts = contextOptions(request.kind, request.model);
      return await runCreationTask(repo, request, {
        ...opts,
        signal: controller.signal,
        generate: (messages, delta) =>
          chat(
            config,
            messages,
            delta,
            controller.signal,
            opts.capabilities.outputTokens,
          ),
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
    const request = { projectId: idSchema.parse(p) };
    const detail = repo.getDetail(request.projectId);
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
    const content = exportStory(repo, request.projectId);
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
      Object.assign(handlers, workspaceHandlers(repo));
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
