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
    } | null>("scratch:get", id);
    output.value = saved?.output || "";
    instruction.value = saved?.instruction || "";
    outputKind.value = saved?.kind || "chapter";
    outputChapterId.value = saved?.chapterId || "";
    outputSelection.value = null;
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
  async function adopt() {
    if (!chapter.value) return;
    await flush();
    await api("chapter:adopt", chapter.value.id);
    await refreshProject();
    notify("已采用当前章节，可以整理正式记忆了。");
  }
  async function runTask(kind: TaskKind = taskKind.value) {
    if (!detail.value || busy.value) return;
    await flush();
    output.value = "";
    taskError.value = "";
    busy.value = true;
    requestId.value = crypto.randomUUID();
    outputKind.value = kind;
    outputChapterId.value = chapter.value?.id || "";
    outputSelection.value = selection.value ? { ...selection.value } : null;
    const selected = outputSelection.value?.text;
    scratch();
    try {
      const result = await api<TaskResult>("ai:run", {
        requestId: requestId.value,
        kind,
        projectId: detail.value.project.id,
        chapterId: chapter.value?.id,
        instruction: instruction.value,
        selection: selected,
      });
      requestId.value = "";
      output.value = result.text;
      if (result.notesSaved) {
        await refreshProject();
        notify(`已更新 ${result.notesSaved} 条正式记忆。`);
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
    adopt,
    runTask,
    stopTask,
    setModel,
    saveCard,
    createProject,
    imageUrl,
    initializeListeners,
    scratch,
  };
});
