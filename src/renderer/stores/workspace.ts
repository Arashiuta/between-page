import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type {
  Bootstrap,
  ProjectDetail,
  Project,
  Chapter,
  Settings,
  SettingsInput,
  Card,
  ImageAsset,
  TaskKind,
  TaskResult,
  DocumentNode,
  CardInput,
  RoleSettings,
  MemoryKind,
} from "../../shared/types";
import { defaultRoleSettings } from "../../shared/roles";
import { documentToText } from "../../shared/document";

export const useWorkspace = defineStore("workspace", () => {
  const ready = ref(false),
    projects = ref<Project[]>([]),
    cards = ref<Card[]>([]),
    images = ref<ImageAsset[]>([]),
    settings = ref<Settings | null>(null);
  const roles = ref<RoleSettings>(defaultRoleSettings());
  const detail = ref<ProjectDetail | null>(null),
    chapterId = ref(""),
    saving = ref(false),
    saveFailed = ref(false);
  const busy = ref(false),
    imageBusy = ref(false),
    requestId = ref(""),
    taskKind = ref<TaskKind>("chapter"),
    instruction = ref(""),
    output = ref(""),
    outputKind = ref<TaskKind>("chapter"),
    outputChapterId = ref(""),
    memoryRecords = ref<{ kind: MemoryKind; content: string }[] | null>(null),
    memoryRevisionId = ref(""),
    taskError = ref("");
  const selection = ref<{ text: string; from: number; to: number } | null>(
      null,
    ),
    outputSelection = ref<{ text: string; from: number; to: number } | null>(
      null,
    );
  const toast = ref<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const chapter = computed(
    () => detail.value?.chapters.find((c) => c.id === chapterId.value) || null,
  );
  const pending = new Map<
    string,
    { action: string; payload: Record<string, unknown> }
  >();
  let saveTimer: ReturnType<typeof setTimeout> | undefined,
    toastTimer: ReturnType<typeof setTimeout> | undefined,
    flushing: Promise<void> | null = null;
  const api = <T>(action: string, payload?: unknown) =>
    window.storybook.invoke<T>(
      action,
      payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)),
    );
  function notify(
    message: string,
    type: "success" | "error" | "info" = "success",
  ) {
    toast.value = { message, type };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => (toast.value = null),
      type === "error" ? 7500 : 3500,
    );
  }
  async function safe<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    }
  }
  async function bootstrap() {
    if (!window.storybook)
      throw new Error("桌面连接未建立。请通过页间桌面程序启动。");
    const value = await api<Bootstrap>("bootstrap");
    projects.value = value.projects;
    cards.value = value.cards;
    images.value = value.images;
    settings.value = value.settings;
    roles.value = value.roles ?? defaultRoleSettings();
    ready.value = true;
  }
  function enqueue(
    key: string,
    action: string,
    payload: Record<string, unknown>,
  ) {
    const old = pending.get(key);
    pending.set(key, { action, payload: { ...old?.payload, ...payload } });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void safe(flush);
    }, 650);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (flushing) return flushing;
    if (!pending.size) return;
    flushing = (async () => {
      saving.value = true;
      try {
        while (pending.size) {
          const [key, job] = pending.entries().next().value!;
          pending.delete(key);
          try {
            const result = await api<Chapter | Project | unknown>(
              job.action,
              job.payload,
            );
            if (job.action === "chapter:update" && !pending.has(key)) {
              const chapter = detail.value?.chapters.find(
                (c) => c.id === job.payload.id,
              );
              if (chapter) {
                chapter.dirty = (result as Chapter).dirty;
                chapter.updatedAt = (result as Chapter).updatedAt;
              }
            }
            if (job.action === "settings:save" && !pending.has(key)) {
              settings.value = result as Settings;
            }
          } catch (error) {
            const newer = pending.get(key);
            pending.set(key, {
              action: job.action,
              payload: { ...job.payload, ...newer?.payload },
            });
            saveFailed.value = true;
            throw error;
          }
        }
        saveFailed.value = false;
      } finally {
        saving.value = false;
        flushing = null;
      }
    })();
    return flushing;
  }
  function editProject(patch: Partial<Project>) {
    if (!detail.value) return;
    Object.assign(detail.value.project, patch);
    enqueue("project:" + detail.value.project.id, "project:update", {
      ...patch,
      id: detail.value.project.id,
    });
  }
  function editSettings(value: SettingsInput) {
    if (!settings.value) return;
    const snapshot: SettingsInput = JSON.parse(JSON.stringify(value));
    settings.value = {
      ...settings.value,
      ...snapshot,
      text: { ...snapshot.text, hasKey: !!snapshot.text.key.trim() },
      image: { ...snapshot.image, hasKey: !!snapshot.image.key.trim() },
    };
    enqueue("settings", "settings:save", snapshot);
  }
  function editChapter(patch: {
    title?: string;
    plan?: string;
    document?: DocumentNode;
  }) {
    const current = chapter.value;
    if (!current) return;
    Object.assign(current, patch);
    if (patch.document) current.content = documentToText(patch.document);
    current.dirty = true;
    enqueue("chapter:" + current.id, "chapter:update", {
      ...patch,
      id: current.id,
    });
  }
  function scratch() {
    if (!detail.value) return;
    enqueue("scratch:" + detail.value.project.id, "scratch:save", {
      projectId: detail.value.project.id,
      kind: outputKind.value,
      instruction: instruction.value,
      output: output.value,
      chapterId: outputChapterId.value,
      memoryRecords: memoryRecords.value,
      ...(memoryRevisionId.value
        ? { memoryRevisionId: memoryRevisionId.value }
        : {}),
      outputSelection: outputSelection.value,
    });
  }
  async function openProject(id: string) {
    await flush();
    detail.value = await api<ProjectDetail>("project:get", id);
    chapterId.value = detail.value.chapters[0]?.id || "";
    selection.value = null;
    const saved = await api<{
      kind: TaskKind;
      instruction: string;
      output: string;
      chapterId: string;
      memoryRecords?: { kind: MemoryKind; content: string }[] | null;
      memoryRevisionId?: string;
      outputSelection?: { text: string; from: number; to: number } | null;
    } | null>("scratch:get", id);
    output.value = saved?.output || "";
    instruction.value = saved?.instruction || "";
    outputKind.value = saved?.kind || "chapter";
    outputChapterId.value = saved?.chapterId || "";
    memoryRecords.value = saved?.memoryRecords ?? null;
    memoryRevisionId.value = saved?.memoryRevisionId || "";
    outputSelection.value = saved?.outputSelection ?? null;
    taskError.value = "";
  }
  async function refreshProject() {
    if (!detail.value) return;
    await flush();
    detail.value = await api<ProjectDetail>(
      "project:get",
      detail.value.project.id,
    );
  }
  async function switchChapter(id: string) {
    await flush();
    chapterId.value = id;
    selection.value = null;
  }
  async function newChapter() {
    if (!detail.value) return;
    await flush();
    const created = await api<Chapter>(
      "chapter:create",
      detail.value.project.id,
    );
    detail.value.chapters.push(created);
    chapterId.value = created.id;
    selection.value = null;
  }
  async function deleteChapter(id: string) {
    const target = detail.value?.chapters.find((item) => item.id === id);
    if (!target) return;
    if (busy.value || imageBusy.value)
      throw new Error("请先停止或等待当前生成任务完成，再删除章节。");
    await flush();
    if (busy.value || imageBusy.value)
      throw new Error("请先停止或等待当前生成任务完成，再删除章节。");
    const index = detail.value?.chapters.findIndex((item) => item.id === id) ?? 0;
    const updated = await api<ProjectDetail>("chapter:delete", id);
    if (detail.value?.project.id !== target.projectId) return;
    detail.value = updated;
    if (!updated.chapters.some((item) => item.id === chapterId.value)) {
      chapterId.value = updated.chapters[Math.min(index, updated.chapters.length - 1)]?.id || "";
      selection.value = null;
    }
    if (outputChapterId.value === id) {
      output.value = "";
      outputChapterId.value = "";
      outputSelection.value = null;
      memoryRecords.value = null;
      memoryRevisionId.value = "";
      taskError.value = "";
    }
    images.value = images.value.map((image) => image.chapterId === id
      ? { ...image, chapterId: null, revisionId: null }
      : image);
    const project = projects.value.find((item) => item.id === updated.project.id);
    if (project) Object.assign(project, updated.project);
    notify(`已删除「${target.title}」。`);
  }
  async function adopt() {
    if (!chapter.value) return;
    await flush();
    await api("chapter:adopt", chapter.value.id);
    await refreshProject();
    notify("已采用当前章节，可以整理正式记忆了。");
  }
  async function runTask(
    kind: TaskKind = taskKind.value,
    options: { instruction?: string; workflowContext?: string; chapterId?: string } = {},
  ) {
    if (!detail.value || busy.value) return;
    await flush();
    output.value = "";
    memoryRecords.value = null;
    memoryRevisionId.value = "";
    taskError.value = "";
    busy.value = true;
    requestId.value = crypto.randomUUID();
    outputKind.value = kind;
    const targetChapterId = options.chapterId || chapter.value?.id || "";
    outputChapterId.value = targetChapterId;
    outputSelection.value = targetChapterId === chapter.value?.id && selection.value
      ? { ...selection.value }
      : null;
    const selected = outputSelection.value?.text;
    scratch();
    try {
      const result = await api<TaskResult>("ai:run", {
        requestId: requestId.value,
        kind,
        projectId: detail.value.project.id,
        chapterId: targetChapterId || undefined,
        instruction: options.instruction ?? instruction.value,
        selection: selected,
        workflowContext: options.workflowContext,
      });
      requestId.value = "";
      output.value = result.text;
      memoryRecords.value = result.memoryRecords ?? null;
      memoryRevisionId.value = result.memoryRevisionId ?? "";
      if (["outline", "adjust", "organize", "brainstorm", "pacing", "arc"].includes(kind) && result.text.trim()) {
        const labels: Partial<Record<TaskKind, string>> = {
          outline: "故事蓝图候选",
          adjust: "走向调整候选",
          organize: "灵感整理候选",
          brainstorm: "脑暴候选",
          pacing: "节奏诊断候选",
          arc: "人物弧线候选",
        };
        const candidate = {
          id: crypto.randomUUID(),
          title: labels[kind] ?? "创作候选",
          content: result.text,
          source: kind,
          createdAt: new Date().toISOString(),
        };
        editProject({ blueprintCandidates: [candidate, ...(detail.value!.project.blueprintCandidates || [])].slice(0, 100) });
      }
    } catch (error) {
      taskError.value = error instanceof Error ? error.message : String(error);
    } finally {
      requestId.value = "";
      busy.value = false;
      scratch();
      void safe(flush);
    }
  }
  async function stopTask() {
    if (requestId.value) await api("ai:cancel", requestId.value);
  }
  async function setModel(kind: "text" | "image", model: string) {
    await flush();
    settings.value = await api<Settings>("settings:model", { kind, model });
  }
  async function saveCard(card: CardInput) {
    const result = await api<Card>("card:save", card);
    await bootstrap();
    if (detail.value) await refreshProject();
    return result;
  }
  async function deleteCard(id: string) {
    const deleted = await api<Card>("card:delete", id);
    cards.value = cards.value.filter((card) => card.id !== deleted.id);
    if (detail.value)
      detail.value.cards = detail.value.cards.filter((card) => card.id !== deleted.id);
    notify(`已删除资料「${deleted.name}」。`);
  }
  async function createProject(value: {
    title: string;
    premise: string;
    mode: "explore" | "novel";
    genre?: string;
    cardIds?: string[];
  }) {
    const project = await api<Project>("project:create", value);
    await bootstrap();
    return project;
  }
  function imageUrl(id: string) {
    return "story-asset://asset/" + id;
  }
  function initializeListeners() {
    window.storybook.onProgress((event) => {
      if (busy.value && event.requestId === requestId.value) {
        output.value += event.delta;
        scratch();
      }
    });
    window.storybook.onClosing(() => {
      void safe(async () => {
        if (busy.value) await stopTask();
        scratch();
        await flush();
        await api("window:close");
      });
    });
  }
  return {
    ready,
    projects,
    cards,
    images,
    settings,
    roles,
    detail,
    chapterId,
    chapter,
    saving,
    saveFailed,
    busy,
    imageBusy,
    taskKind,
    instruction,
    output,
    outputKind,
    outputChapterId,
    memoryRecords,
    memoryRevisionId,
    outputSelection,
    taskError,
    selection,
    toast,
    api,
    safe,
    notify,
    bootstrap,
    flush,
    editProject,
    editSettings,
    editChapter,
    openProject,
    refreshProject,
    switchChapter,
    newChapter,
    deleteChapter,
    adopt,
    runTask,
    stopTask,
    setModel,
    saveCard,
    deleteCard,
    createProject,
    imageUrl,
    initializeListeners,
    scratch,
  };
});
