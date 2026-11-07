// Local acceptance server: isolated database + production services + simulated models.
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const qaRoot = join(root, ".qa");
await mkdir(qaRoot, { recursive: true });
const directory = await mkdtemp(join(qaRoot, "workbench-"));
let handle;
const clients = new Set();
const traces = [];
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const server = await createServer({
  configFile: false,
  root: resolve(root, "src/renderer"),
  plugins: [
    vue(),
    {
      name: "isolated-acceptance",
      transform(code, id) {
        if (
          id.replaceAll("\\", "/").endsWith("/src/renderer/stores/workspace.ts")
        )
          return code.replace('"story-asset://asset/"', '"/__qa_asset/"');
      },
      transformIndexHtml() {
        return [
          {
            tag: "script",
            injectTo: "head-prepend",
            children: `window.storybook={invoke:async(action,payload)=>{const r=await fetch('/__qa_api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});const v=await r.json();if(!v.ok)throw Error(v.error);return v.data},onProgress:fn=>{const s=new EventSource('/__qa_progress');s.onmessage=e=>fn(JSON.parse(e.data));return()=>s.close()},onClosing:()=>()=>{}};`,
          },
        ];
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url === "/__qa_progress") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write("\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
          }
          if (req.url?.startsWith("/__qa_asset/")) {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#d4dcca"/><circle cx="460" cy="90" r="42" fill="#f5deb0"/><path d="M0 360L180 170 330 300 450 200 600 350V400H0" fill="#809582"/><text x="24" y="45" font-size="24" fill="#34483d">本地模拟参考图</text></svg>',
            );
            return;
          }
          if (req.url === "/__qa_state") {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                directory,
                traces,
                projects: repo.listProjects(),
                details: repo.listProjects().map((p) => repo.getDetail(p.id)),
              }),
            );
            return;
          }
          if (req.url !== "/__qa_api") return next();
          try {
            let body = "";
            for await (const chunk of req) body += chunk;
            const { action, payload } = JSON.parse(body);
            const data = await handle(action, payload);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, data }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    fs: { allow: [root] },
  },
});
const load = (p) => server.ssrLoadModule(resolve(root, p));
const { StoryRepository } = await load("src/main/database.ts");
const { workspaceHandlers } = await load("src/main/workspace-handlers.ts");
const { runCreationTask, prepareTaskPreview } = await load(
  "src/main/conversations.ts",
);
const { defaultRoleSettings } = await load("src/shared/roles.ts");
const { refineMaterial } = await load("src/main/materials.ts");
const { resolveTextModel } = await load("src/shared/models.ts");
const { normalizeSoftware } = await load("src/shared/appearance.ts");
const { textToDocument } = await load("src/shared/document.ts");
const repo = new StoryRepository(join(directory, "storybook.sqlite")),
  api = workspaceHandlers(repo);
const capabilities = {
  vision: true,
  contextTokens: 128000,
  outputTokens: 8000,
};
const settings = {
  software: normalizeSoftware({}),
  text: {
    baseUrl: "http://mock.local/v1",
    key: "local-mock-only",
    model: "模拟文字模型",
    selectedModels: ["模拟文字模型", "模拟提炼模型"],
    availableModels: ["模拟文字模型", "模拟提炼模型"],
    capabilities: { 模拟文字模型: capabilities, 模拟提炼模型: capabilities },
    hasKey: true,
  },
  image: {
    baseUrl: "http://mock.local/v1",
    key: "local-mock-only",
    model: "模拟插画模型",
    selectedModels: ["模拟插画模型"],
    availableModels: ["模拟插画模型"],
    capabilities: {},
    hasKey: true,
  },
  imageSize: "1024x1024",
  imageQuality: "auto",
  dataDir: directory,
  version: "重构验收",
};
const libraryCard = repo.saveCard({
  projectId: null,
  kind: "world",
  name: "雾港世界 · 资料库",
  description: "雾夜才开放航线的港口。",
  constraints: "只有持灯的船可以出航。",
  sections: [
    {
      id: randomUUID(),
      title: "航行规则",
      content: "- 航线只在雾夜开放。",
      sourceIds: [],
    },
  ],
  referenceIds: [],
});
for (const mode of ["novel", "explore"]) {
  const p = repo.createProject({
    title: mode === "novel" ? "沙海来信 · 长篇验收" : "雾港书店 · 自由探索",
    premise:
      mode === "novel"
        ? "修理师阿禾寻找消失的故乡，沙海里藏着一封迟到的信。"
        : "只在雾夜营业的书店收到一封关于明天的来信。",
    mode,
    cardIds: [libraryCard.id],
  });
  repo.updateProject(p.id, {
    world: "沙海规则：水源稀少，通信依靠驿站，不能凭空传送物品。",
    style: "第三人称有限视角，以行动和细节表现情绪。",
  });
  const img = repo.addImage({
    id: randomUUID(),
    projectId: p.id,
    chapterId: null,
    revisionId: null,
    kind: "reference",
    name: "阿禾外观参考",
    filename: "mock.png",
    prompt: "",
    referenceIds: [],
    model: "mock",
    createdAt: new Date().toISOString(),
  });
  repo.saveCard({
    projectId: p.id,
    kind: "character",
    name: "阿禾",
    description: "年轻修理师，灰色斗篷，习惯先检查门轴再推门。",
    constraints: "不能读取他人思想；不轻易许诺。",
    sections: [
      {
        id: randomUUID(),
        title: "人物动机",
        content: "找回故乡失联的消息。",
        sourceIds: [],
      },
    ],
    documents: [
      {
        id: randomUUID(),
        name: "人物原始笔记.md",
        content: "阿禾修理东西时会数呼吸，紧张时会摸左手袖口。",
        enabled: true,
      },
    ],
    referenceIds: [img.id],
  });
  const chapter = repo.getDetail(p.id).chapters[0];
  repo.updateChapter(chapter.id, {
    title: "第一章 · 风里的来信",
    document: textToDocument(
      "阿禾停在驿站门前，手指先摸过生锈的门轴。\n\n风从沙海深处吹来，把一封没有署名的信推到他的脚边。他弯下腰，发现信封边角干燥。\n\n“有人来过？”他问。柜台后的老人没有回答，只将一杯水推近了一些。",
    ),
  });
  repo.adoptChapter(chapter.id);
  const section = {
    id: randomUUID(),
    level: "section",
    parentId: null,
    chapterId: null,
    title: mode === "novel" ? "全局约束与伏笔" : "近期方向与未定空间",
    content:
      "创作地基：先建立驿站日常与来信之谜；主角尚不知道来信者身份。结局可以保留空白。",
  };
  api["blueprint:save"]({ projectId: p.id, node: section, base: null });
  if (mode === "novel") {
    const volume = {
      id: randomUUID(),
      level: "volume",
      parentId: null,
      chapterId: null,
      title: "第一卷 · 逆风",
      content: "沿驿站路线寻找寄信者。",
    };
    api["blueprint:save"]({ projectId: p.id, node: volume, base: null });
    api["blueprint:save"]({
      projectId: p.id,
      node: {
        id: randomUUID(),
        level: "chapter",
        parentId: volume.id,
        chapterId: chapter.id,
        title: "第一章安排",
        content: "在细节中呈现阿禾的谨慎；信封作为第一个异常。",
      },
      base: null,
    });
  }
}
const context = {
  model: "模拟文字模型",
  capabilities,
  readImage: async () => png,
};
function response(r) {
  const d = repo.getDetail(r.projectId);
  if (r.kind === "brainstorm")
    return "可以从“信封为什么没有沾沙”聊起：它可能刚被放下，也可能来自一个不会经历风沙的地方。你希望这件事先触动阿禾的好奇，还是他的戒心？这些都只是讨论中的可能性。";
  if (r.kind === "settings") {
    const c = d.cards.find((c) => c.id === r.cardId);
    return JSON.stringify({
      changes: c
        ? [
            {
              type: "card",
              cardId: c.id,
              kind: c.kind,
              name: c.name,
              field: "constraints",
              title: "",
              content:
                "不能读取他人思想；承诺之前会先核实情况。紧张时摸左手袖口。",
            },
          ]
        : [
            {
              type: "project",
              field: "world",
              content: d.project.world + "\n远行者离开驿站前必须登记水量。",
            },
          ],
    });
  }
  if (r.kind === "blueprint")
    return JSON.stringify({
      items: Array.from(
        { length: r.target.id ? 1 : r.target.count },
        (_, i) => ({
          title: r.target.id
            ? d.project.blueprint.nodes.find((n) => n.id === r.target.id).title
            : "来信线索 " + (i + 1),
          content:
            "阿禾先核对信封纸张与驿站登记，再决定沿旧路线寻找寄信者。保留来信者身份，遵守上级规划。",
        }),
      ),
    });
  if (r.kind === "opening")
    return "清晨的风绕过驿站，阿禾将最后一根门栓推回原位。\n\n柜台上多了一张地图，水渍恰好圈住一处早已废弃的地名。";
  if (r.kind === "continue")
    return "阿禾没有碰那杯水。他把信封翻了个面，借窗边的光辨认纸上的压痕。\n\n老人终于开口：“如果要走，等风停下来。”";
  if (r.kind === "polish")
    return "风贴着门缝滑进来，阿禾的手指在锈迹上停了一瞬。";
  if (r.kind === "title") return JSON.stringify({ title: "风停之前" });
  if (r.kind === "notes")
    return JSON.stringify({
      records: [
        { kind: "fact", content: "阿禾在驿站收到一封没有署名、边角干燥的信。" },
      ],
    });
  if (r.kind === "check") return '{"findings":[]}';
  return "沙海边缘的旧驿站，年轻修理师身穿灰色斗篷，手持米白色信封，侧逆光，风沙与安静的室内形成层次，克制的叙事情绪。";
}
const jobs = new Map();
handle = async (action, p) => {
  traces.push({
    action,
    kind: p?.kind,
    mode: p?.mode,
    time: new Date().toISOString(),
  });
  if (action === "bootstrap")
    return {
      projects: repo.listProjects(),
      cards: repo.listCards(),
      images: repo.listImages(),
      settings,
      roles: defaultRoleSettings(),
    };
  const taskContext = (role) => ({
    ...context,
    model: resolveTextModel(
      settings.text,
      defaultRoleSettings(),
      role,
      p?.model,
    ),
  });
  if (action === "card:refine")
    return refineMaterial(p, {
      prompt: "忠实提炼上传文档。",
      capabilities,
      generate: async (messages) => {
        traces.push({
          request: "card:refine",
          model: taskContext("settings").model,
          messages: messages.length,
        });
        return JSON.stringify({
          description: "从文档提炼的人物资料。",
          constraints: "忠实遵守人物原始规则。",
          sections: [
            { title: "原文要点", content: "- 从隔离资料导入的完整人物规则。" },
          ],
        });
      },
    });
  if (action === "ai:preview")
    return prepareTaskPreview(repo, p, taskContext(p.kind));
  if (action === "ai:run") {
    const controller = new AbortController();
    jobs.set(p.requestId, controller);
    try {
      return await runCreationTask(repo, p, {
        ...taskContext(p.kind),
        signal: controller.signal,
        progress: (e) => {
          for (const client of clients)
            client.write("data: " + JSON.stringify(e) + "\n\n");
        },
        generate: async (messages, delta) => {
          const serialized = JSON.stringify(messages),
            d = repo.getDetail(p.projectId);
          for (const text of [
            d.project.world,
            d.project.style,
            ...d.project.blueprint.nodes.map((n) => n.content),
            ...d.cards.flatMap((c) => [
              c.description,
              c.constraints,
              ...c.sections.map((s) => s.content),
              ...c.documents.filter((x) => x.enabled).map((x) => x.content),
            ]),
          ])
            if (text && !serialized.includes(JSON.stringify(text).slice(1, -1)))
              throw Error("验收断言：缺少完整基础资料");
          if (
            d.cards.some((c) => c.referenceIds.length) &&
            !serialized.includes('"type":"image_url"')
          )
            throw Error("验收断言：未实际发送参考图");
          if (
            p.kind === "brainstorm" &&
            d.chapters.some(
              (c) =>
                c.content &&
                serialized.includes(JSON.stringify(c.content).slice(1, -1)),
            )
          )
            throw Error("验收断言：脑暴包含正文");
          traces.push({
            request: p.kind,
            mode: p.mode,
            images: (serialized.match(/image_url/g) || []).length,
            messages: messages.length,
          });
          const text = response(p);
          for (const part of text.match(/.{1,50}/gs) || []) {
            if (controller.signal.aborted) throw Error("已停止");
            delta(part);
            await new Promise((r) => setTimeout(r, 8));
          }
          return text;
        },
      });
    } finally {
      jobs.delete(p.requestId);
    }
  }
  if (action === "ai:cancel") {
    jobs.get(p)?.abort();
    return true;
  }
  if (action === "project:create") return repo.createProject(p);
  if (action === "project:delete") return repo.deleteArchivedProject(p);
  if (action === "project:export") return "模拟导出，不写外部目录";
  if (action === "settings:save") {
    Object.assign(settings, p);
    return settings;
  }
  if (action === "settings:software") {
    settings.software = {
      ...settings.software,
      ...p,
      appearance: { ...settings.software.appearance, ...p.appearance },
    };
    return settings.software;
  }
  if (action === "settings:model") {
    settings[p.kind].model = p.model;
    return settings;
  }
  if (action === "roles:save") return p;
  if (action.startsWith("window:")) return true;
  if (action === "card:import")
    return [
      {
        id: randomUUID(),
        name: "验收原文.md",
        content: "从隔离资料导入的完整人物规则。",
        enabled: true,
      },
    ];
  if (action === "asset:usage") return repo.imageUsage(p);
  if (action === "asset:update") return repo.updateImage(p.id, p.name, p.notes);
  if (action === "asset:delete") return repo.deleteImage(p);
  if (action === "asset:export") return "mock-export";
  if (action === "asset:import" || action === "image:generate") {
    const image = repo.addImage({
      id: randomUUID(),
      projectId: p.projectId,
      chapterId: p.chapterId ?? null,
      revisionId: null,
      kind: action === "asset:import" ? "reference" : "illustration",
      name: "本地模拟图片",
      filename: "mock.png",
      prompt: p.prompt ?? "",
      referenceIds: p.referenceIds ?? [],
      model: "模拟插画模型",
      createdAt: new Date().toISOString(),
    });
    return action === "asset:import" ? [image] : image;
  }
  if (!api[action]) throw Error("验收未实现：" + action);
  return api[action](p);
};
await server.listen();
console.log("UI QA: http://127.0.0.1:5174 | isolated: " + directory);
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, async () => {
    for (const c of clients) c.end();
    await server.close();
    repo.close();
    process.exit(0);
  });
