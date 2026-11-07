// Isolated local UI acceptance harness. Uses an in-memory database and no model service.
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
let handle;
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
            children: `window.storybook={invoke:async(action,payload)=>{const r=await fetch('/__qa_api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});const v=await r.json();if(!v.ok)throw Error(v.error);return v.data},onProgress:()=>()=>{},onClosing:()=>()=>{}};`,
          },
        ];
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith("/__qa_asset/")) {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#d4dcca"/><circle cx="460" cy="90" r="42" fill="#f5deb0"/><path d="M0 360L180 170 330 300 450 200 600 350V400H0" fill="#809582"/><text x="24" y="45" font-size="24" fill="#34483d">本地验收图片</text></svg>',
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
          } catch (error) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: error.message }));
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
const load = (path) => server.ssrLoadModule(resolve(root, path));
const { StoryRepository } = await load("src/main/database.ts");
const planning = await load("src/main/planning.ts");
const writing = await load("src/main/writing.ts");
const { buildTask } = await load("src/main/prompts.ts");
const { defaultRoleSettings } = await load("src/shared/roles.ts");
const { normalizeSoftware } = await load("src/shared/appearance.ts");
const { textToDocument } = await load("src/shared/document.ts");
const repo = new StoryRepository(":memory:");
const novel = repo.createProject({
  title: "沙海来信 · 长篇验收",
  premise: "修理师带着一封陌生来信，寻找沙海深处消失的故乡。",
  mode: "novel",
});
planning.savePlanning(
  repo,
  novel.id,
  { level: "synopsis" },
  {
    content:
      "主题：记忆与归属。主线：修理师沿驿站寻找故乡，结局由他选择重建而非回到过去。",
    confirm: true,
  },
);
const volume = planning.savePlanning(
  repo,
  novel.id,
  { level: "volume", id: novel.novelPlan.volumes[0].id },
  {
    title: "第一卷 · 沙海驿站",
    content: "找到燃料，认识向导，发现来信上的印记。",
    confirm: true,
  },
).target;
const c = repo.getDetail(novel.id).chapters[0];
planning.savePlanning(
  repo,
  novel.id,
  { level: "chapter", id: c.id },
  {
    title: "第一封信",
    content: "在修理铺发现来信，决定前往驿站。",
    confirm: true,
  },
);
if (process.argv.includes("--planning-tree")) {
  const secondVolume = planning.savePlanning(
    repo,
    novel.id,
    { level: "volume" },
    { title: "第二卷 · 旧公路", content: "追随印记", confirm: true },
  ).target.id;
  planning.savePlanning(
    repo,
    novel.id,
    { level: "volume" },
    { title: "第三卷 · 空卷", content: "" },
  );
  const chapters = [
    c,
    repo.createChapter(novel.id),
    repo.createChapter(novel.id),
    repo.createChapter(novel.id),
  ];
  for (const [i, chapter] of chapters.entries()) {
    const value = repo.getChapter(chapter.id);
    value.title = ["第一封信", "路口相逢", "沙海驿站", "修理铺的清晨"][i];
    value.volumeId = i === 3 ? null : i === 1 ? secondVolume : volume.id;
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify(value), value.id);
    repo.updateChapter(value.id, {
      document: textToDocument(`${value.title}的验收正文，拖动后应完整保留。`),
    });
    repo.adoptChapter(value.id);
  }
  for (const title of ["发现来信", "决定启程"])
    planning.savePlanning(
      repo,
      novel.id,
      { level: "scene", parentId: c.id },
      { title, content: `${title}的场景安排`, confirm: true },
    );
}
const explore = repo.createProject({
  title: "铁皮车的下一站 · 探索验收",
  premise: "能操纵金属的旅人开车冒险，走一步看一步。",
  mode: "explore",
});
const f = writing.createFragment(repo, explore.id);
repo.updateChapter(f.id, {
  title: "多年后的一次重逢",
  document: textToDocument(
    "铁皮车停在旧驿站前。他看见那盏许多年未曾亮起的灯。",
  ),
});
const qaImage = repo.addImage({
  id: crypto.randomUUID(),
  projectId: null,
  chapterId: null,
  revisionId: null,
  kind: "reference",
  name: "共享参考图 · 先解除引用",
  filename: "qa-shared.png",
  prompt: "验收原始提示词",
  model: "模拟模型",
  referenceIds: [],
  createdAt: new Date().toISOString(),
});
repo.saveCard({
  projectId: novel.id,
  kind: "character",
  name: "修理师 · 图片引用验收",
  description: "旅人",
  constraints: "",
  referenceIds: [qaImage.id],
});
repo.addImage({
  ...qaImage,
  id: crypto.randomUUID(),
  name: "可清理的参考图",
  filename: "qa-unused.png",
});
const settings = {
  software: normalizeSoftware({}),
  text: {
    baseUrl: "http://mock.local/v1",
    key: "",
    hasKey: true,
    model: "本地验收模型",
    selectedModels: ["本地验收模型"],
    availableModels: ["本地验收模型"],
  },
  image: {
    baseUrl: "",
    key: "",
    hasKey: false,
    model: "",
    selectedModels: [],
    availableModels: [],
  },
  imageSize: "1024x1024",
  imageQuality: "auto",
  dataDir: "内存数据库（验收专用）",
  version: "0.3.3-qa",
};
handle = async (action, p) => {
  if (action === "bootstrap")
    return {
      projects: repo.listProjects(),
      cards: repo.listCards(),
      images: repo.listImages(),
      settings,
      roles: defaultRoleSettings(),
    };
  if (action === "project:get") return repo.getDetail(p);
  if (action === "project:update") {
    const { id, ...patch } = p;
    return repo.updateProject(id, patch);
  }
  if (action === "project:create") return repo.createProject(p);
  if (action === "project:export") return "验收导出已模拟";
  if (action === "scratch:get") return repo.getSetting(`scratch.${p}`, null);
  if (action === "scratch:save") {
    repo.setSetting(`scratch.${p.projectId}`, p);
    return true;
  }
  if (action === "chapter:update") {
    const { id, ...patch } = p;
    return repo.updateChapter(id, patch);
  }
  if (action === "chapter:create") return repo.createChapter(p);
  if (action === "chapter:adopt") return repo.adoptChapter(p);
  if (action === "chapter:checkpoint") return repo.checkpoint(p.id, p.label);
  if (action === "chapter:revisions") return repo.listRevisions(p);
  if (action === "chapter:restore") return repo.restoreRevision(p);
  if (action === "chapter:delete")
    return repo.deleteChapter(typeof p === "string" ? p : p.id);
  if (action === "revision:usage") return repo.revisionUsage(p.projectId, p.id);
  if (action === "revision:update")
    return repo.manageRevision(p.projectId, p.id, p.label);
  if (action === "revision:delete")
    return repo.manageRevision(p.projectId, p.id);
  if (action === "planning:version:update")
    return planning.managePlanningVersion(
      repo,
      p.projectId,
      p.versionId,
      p.label,
    );
  if (action === "planning:version:delete")
    return planning.managePlanningVersion(repo, p.projectId, p.versionId);
  if (action === "planning:remove")
    return planning.removePlanning(repo, p.projectId, p.target);
  if (action === "chapter:reorder")
    return writing.reorderChapters(repo, p.projectId, p.ids);
  if (action === "fragment:create") return writing.createFragment(repo, p);
  if (action === "fragment:incorporate")
    return writing.incorporateFragment(repo, p.projectId, p.fragmentId, p);
  if (action === "planning:save")
    return planning.savePlanning(repo, p.projectId, p.target, p);
  if (action === "planning:apply")
    return {
      detail: planning.applyPlanning(repo, p.draft, p.selectedIds),
      base: planning.planningBase(repo, p.draft.projectId),
    };
  if (action === "planning:history") return planning.planningHistory(repo, p);
  if (action === "planning:snapshot")
    return planning.snapshotPlanning(repo, p, "手动版本");
  if (action === "planning:restore")
    return planning.restorePlanning(repo, p.projectId, p.versionId);
  if (action === "planning:organize")
    return planning.organizePlanning(
      repo,
      p.projectId,
      p.chapterId,
      p.volumeId,
      p.sceneIds,
    );
  if (action === "planning:move:preview")
    return planning.previewPlanningMove(repo, p.projectId, p);
  if (action === "planning:move")
    return planning.movePlanning(
      repo,
      p.projectId,
      p,
      p.base,
      p.confirmNormalization,
    );
  if (action === "planning:acknowledge") {
    const chapter = repo.getChapter(p.chapterId);
    delete chapter.planningReview;
    repo.db
      .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
      .run(JSON.stringify(chapter), chapter.id);
    return repo.getDetail(p.projectId);
  }
  if (action === "memory:apply-generated")
    return repo.saveGeneratedMemories(p.chapterId, p.revisionId, p.records);
  if (action === "card:save") return repo.saveCard(p);
  if (action === "card:delete") return repo.deleteCard(p);
  if (action === "memory:add")
    return repo.addMemory(p.projectId, p.kind, p.content);
  if (action === "memory:update")
    return repo.updateMemory(p.projectId, p.id, p);
  if (action === "memory:delete") return repo.deleteMemory(p.projectId, p.id);
  if (action === "memory:toggle") return repo.setMemoryActive(p.id, p.active);
  if (action === "asset:usage") return repo.imageUsage(p);
  if (action === "asset:update") return repo.updateImage(p.id, p.name, p.notes);
  if (action === "asset:delete") {
    repo.deleteImage(p);
    return { pendingCleanup: 0 };
  }
  if (action === "project:delete") return repo.deleteArchivedProject(p);
  if (action === "roles:save") return p;
  if (action === "ai:preview") {
    const built = buildTask(repo, p);
    return {
      systemPrompt: built.messages[0].content,
      context: built.messages[1].content,
      coverage: built.coverage,
      omitted: built.omitted,
      model: settings.text.model,
    };
  }
  if (action === "ai:run") {
    console.log(
      `QA AI request: ${p.kind} ${p.projectId} ${p.planningTarget?.level ?? "prose"}`,
    );
    buildTask(repo, p);
    if (p.planningTarget) {
      const count =
        p.planningTarget.id || p.planningTarget.level === "synopsis"
          ? 1
          : (p.planningTarget.count ?? 1);
      const text = JSON.stringify({
        items: Array.from({ length: count }, (_, i) => ({
          title: `沙海旅程 ${i + 1}`,
          content: `目标：寻找线索。行动：在第 ${i + 1} 个驿站与向导交谈。转折：发现来信中隐藏的印记。结束位置：决定沿旧公路继续前进。`,
        })),
      });
      return {
        text,
        resultType: "planning",
        planningDraft: planning.parsePlanning(
          repo,
          p.projectId,
          p.planningTarget,
          planning.planningBase(repo, p.projectId),
          text,
        ),
      };
    }
    if (p.outputMode === "analysis")
      return {
        text: "对白可以减少解释，用停顿和动作表达人物尚未说出的顾虑。",
        resultType: "analysis",
      };
    if (p.kind === "notes") {
      const chapter = repo.getChapter(p.chapterId);
      return {
        text: "旅人来到驿站。",
        memoryRevisionId: chapter.acceptedRevisionId,
        memoryRecords: [{ kind: "fact", content: "旅人来到驿站。" }],
      };
    }
    return {
      text: "风把沙粒推过门槛。修理师按住信封，在那枚褪色的印记上停了片刻。\n\n门外传来刹车声。他抬起头，看见向导正把一只空油桶从车上搬下来。",
      resultType: ["revise", "scene", "dialogue"].includes(p.kind)
        ? "rewrite"
        : "prose",
    };
  }
  if (action.startsWith("window:") || action === "ai:cancel") return true;
  throw new Error(`验收工具尚未模拟 ${action}`);
};
await server.listen();
console.log(
  `Isolated UI: http://127.0.0.1:5174\nNovel: /#/story/${novel.id}\nExplore: /#/story/${explore.id}`,
);
