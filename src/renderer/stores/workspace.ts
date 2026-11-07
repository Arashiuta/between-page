import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type {
  Bootstrap,
  ProjectDetail,
  Project,
  Chapter,
  Settings,
  SettingsInput,
  SoftwareSettings,
  SoftwareSettingsPatch,
  CoverUpload,
  CoverCrop,
  CloseAction,
  Card,
  ImageAsset,
  TaskKind,
  TaskResult,
  DocumentNode,
  CardInput,
  RoleSettings,
  MemoryKind,
  CreativeFreedom,
  StoryDevelopmentDraft,
  PlanningDraft,
  PlanningTarget,
  PlanBlock,
  TaskRequest,
} from "../../shared/types";
import { defaultRoleSettings } from "../../shared/roles";
import { documentToText } from "../../shared/document";
import { toolInfo } from "../../shared/tools";
import { developmentText } from "../../shared/development";
import { normalizeSoftware } from "../../shared/appearance";
import { normalizeProject } from "../../shared/blueprint";
import { normalizeChapterVolume } from "../../shared/planning";

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
  const developmentDraft = ref<StoryDevelopmentDraft | null>(null);
  const planningDraft = ref<PlanningDraft | null>(null);
  const planningTarget = ref<PlanningTarget | undefined>();
  const resultType = ref<TaskResult["resultType"] | null>(null);
  const outputScope = ref<"selection" | "document" | null>(null);
  const sourceContent = ref("");
  const writingScope = ref<"selection" | "document">("selection");
  const outputMode = ref<"rewrite" | "analysis">("rewrite");
  const usePlanDraft = ref(false),
    referenceNovelPlan = ref(false);
  const closePrompt = ref(false),
    closingWindow = ref(false);
  const reviewingDevelopment = ref(false);
  const developmentUndoId = ref("");
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
    () =>
      [
        ...(detail.value?.chapters ?? []),
        ...(detail.value?.fragments ?? []),
      ].find((c) => c.id === chapterId.value) || null,
  );
  const pending = new Map<
    string,
    { action: string; payload: Record<string, unknown> }
  >();
  let saveTimer: ReturnType<typeof setTimeout> | undefined,
    toastTimer: ReturnType<typeof setTimeout> | undefined,
    flushing: Promise<void> | null = null;
  let generationProjectId = "";
  let softwareRevision = 0;
  let taskFinished = Promise.resolve();
  let stopRequested = false;
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
    const revision = softwareRevision;
    const value = await api<Bootstrap>("bootstrap");
    projects.value = value.projects;
    cards.value = value.cards;
    images.value = value.images;
    const pendingSoftware =
      pending.has("software") || saving.value || revision !== softwareRevision
        ? settings.value?.software
        : undefined;
    settings.value = {
      ...value.settings,
      software: pendingSoftware ?? normalizeSoftware(value.settings.software),
    };
    roles.value = value.roles ?? defaultRoleSettings();
    ready.value = true;
  }
  function enqueue(
    key: string,
    action: string,
    payload: Record<string, unknown>,
  ) {
    // Scratch is a complete snapshot: omitted source IDs must not survive merging.
    const old = action === "scratch:save" ? undefined : pending.get(key);
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
              const chapter = [
                ...(detail.value?.chapters ?? []),
                ...(detail.value?.fragments ?? []),
              ].find((c) => c.id === job.payload.id);
              if (chapter) {
                chapter.dirty = (result as Chapter).dirty;
                chapter.updatedAt = (result as Chapter).updatedAt;
              }
            }
            if (job.action === "settings:save" && !pending.has(key)) {
              settings.value = {
                ...(result as Settings),
                software: settings.value!.software,
              };
            }
            if (
              job.action === "settings:software" &&
              !pending.has(key) &&
              settings.value
            ) {
              settings.value.software = result as SoftwareSettings;
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
    Object.assign(
      detail.value.project,
      normalizeProject({ ...detail.value.project, ...patch }),
    );
    if (patch.mode)
      detail.value.chapters = detail.value.chapters.map((chapter) =>
        normalizeChapterVolume(chapter, detail.value!.project),
      );
    enqueue("project:" + detail.value.project.id, "project:update", {
      ...patch,
      id: detail.value.project.id,
    });
  }
  function editPlanning(
    target: PlanningTarget,
    content: string,
    title?: string,
  ) {
    if (!detail.value) return;
    const plan = detail.value.project.novelPlan;
    let block: PlanBlock | undefined;
    if (target.level === "synopsis") block = plan?.synopsis;
    if (target.level === "volume") {
      const volume = plan?.volumes.find((v) => v.id === target.id);
      block = volume?.plan;
      if (volume && title) volume.title = title;
    }
    const c = detail.value.chapters.find(
      (c) =>
        c.id === (target.level === "chapter" ? target.id : target.parentId),
    );
    if (target.level === "chapter" && c) {
      c.planMeta ??= { confirmed: c.plan };
      c.plan = content;
      if (title) c.title = title;
    }
    if (target.level === "scene") {
      const scene = c?.scenes?.find((s) => s.id === target.id);
      block = scene?.plan;
      if (scene && title) scene.title = title;
    }
    if (block) block.content = content;
    enqueue(
      `planning:${detail.value.project.id}:${target.level}:${target.id ?? "synopsis"}`,
      "planning:save",
      { projectId: detail.value.project.id, target, content, title },
    );
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
  function editSoftwareSettings(value: SoftwareSettingsPatch) {
    if (!settings.value) return;
    softwareRevision++;
    const current = normalizeSoftware(settings.value.software);
    settings.value.software = {
      ...current,
      ...value,
      appearance: { ...current.appearance, ...value.appearance },
    };
    enqueue(
      "software",
      "settings:software",
      JSON.parse(JSON.stringify(settings.value.software)),
    );
  }
  async function requestClose() {
    if (closingWindow.value || closePrompt.value) return;
    const action = settings.value?.software.closeAction ?? "ask";
    if (action === "ask") closePrompt.value = true;
    else await confirmClose(action);
  }
  async function confirmClose(
    action: Exclude<CloseAction, "ask">,
    remember = false,
  ) {
    if (closingWindow.value) return;
    closingWindow.value = true;
    try {
      if (remember) editSoftwareSettings({ closeAction: action });
      if (action === "quit" && busy.value) {
        await stopTask();
        await taskFinished;
      }
      scratch();
      await flush();
      await api(action === "minimize" ? "window:hide" : "window:close");
      closePrompt.value = false;
    } finally {
      closingWindow.value = false;
    }
  }
  function editChapter(patch: {
    title?: string;
    plan?: string;
    document?: DocumentNode;
    fragmentContext?: Chapter["fragmentContext"];
  }) {
    const current = chapter.value;
    if (!current) return;
    if (patch.plan !== undefined)
      current.planMeta ??= { confirmed: current.plan };
    Object.assign(current, patch);
    if (patch.document) current.content = documentToText(patch.document);
    current.dirty = true;
    enqueue("chapter:" + current.id, "chapter:update", {
      ...patch,
      id: current.id,
    });
  }
  function renameChapter(id: string, title: string) {
    const target = detail.value?.chapters.find((item) => item.id === id);
    if (!target) throw new Error("章节不存在或不属于当前故事。");
    const name = title.trim();
    if (!name || name.length > 500) throw new Error("章节名称需为 1—500 字。");
    if (name === target.title) return;
    target.title = name;
    target.dirty = true;
    enqueue("chapter:" + id, "chapter:update", { id, title: name });
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
      developmentDraft: developmentDraft.value,
      planningDraft: planningDraft.value,
      resultType: resultType.value,
      outputScope: outputScope.value,
      sourceContent: sourceContent.value,
      planningTarget: planningTarget.value,
      writingScope: writingScope.value,
      outputMode: outputMode.value,
      usePlanDraft: usePlanDraft.value,
      referenceNovelPlan: referenceNovelPlan.value,
      selectedTool: taskKind.value,
      developmentUndoId: developmentUndoId.value,
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
      developmentDraft?: StoryDevelopmentDraft | null;
      planningDraft?: PlanningDraft | null;
      resultType?: TaskResult["resultType"] | null;
      outputScope?: "selection" | "document" | null;
      sourceContent?: string;
      planningTarget?: PlanningTarget;
      writingScope?: "selection" | "document";
      outputMode?: "rewrite" | "analysis";
      usePlanDraft?: boolean;
      referenceNovelPlan?: boolean;
      selectedTool?: TaskKind;
      developmentUndoId?: string;
      outputSelection?: { text: string; from: number; to: number } | null;
    } | null>("scratch:get", id);
    output.value = saved?.output || "";
    instruction.value = saved?.instruction || "";
    outputKind.value = saved?.kind || "chapter";
    outputChapterId.value = saved?.chapterId || "";
    memoryRecords.value = saved?.memoryRecords ?? null;
    memoryRevisionId.value = saved?.memoryRevisionId || "";
    developmentDraft.value = saved?.developmentDraft ?? null;
    planningDraft.value = saved?.planningDraft ?? null;
    resultType.value = saved?.resultType ?? null;
    outputScope.value = saved?.outputScope ?? null;
    sourceContent.value = saved?.sourceContent ?? "";
    planningTarget.value = saved?.planningTarget;
    writingScope.value = saved?.writingScope ?? "selection";
    outputMode.value = saved?.outputMode ?? "rewrite";
    usePlanDraft.value = saved?.usePlanDraft ?? false;
    referenceNovelPlan.value = saved?.referenceNovelPlan ?? false;
    taskKind.value =
      saved?.selectedTool ||
      (detail.value.chapters.some((item) => item.content.trim())
        ? "chapter"
        : "opening");
    reviewingDevelopment.value = false;
    developmentUndoId.value = saved?.developmentUndoId ?? "";
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
    const projectId = detail.value.project.id;
    await flush();
    if (detail.value?.project.id !== projectId) return;
    const created = await api<Chapter>("chapter:create", projectId);
    if (detail.value?.project.id !== projectId) return;
    detail.value.chapters.push(created);
    chapterId.value = created.id;
    selection.value = null;
  }
  async function newFragment() {
    if (!detail.value) return;
    const projectId = detail.value.project.id;
    await flush();
    if (detail.value?.project.id !== projectId) return;
    const created = await api<Chapter>("fragment:create", projectId);
    if (detail.value?.project.id !== projectId) return;
    (detail.value.fragments ??= []).push(created);
    chapterId.value = created.id;
    selection.value = null;
    taskKind.value = "opening";
  }
  async function deleteChapter(id: string) {
    const target = [
      ...(detail.value?.chapters ?? []),
      ...(detail.value?.fragments ?? []),
    ].find((item) => item.id === id);
    if (!target) return;
    if (busy.value || imageBusy.value)
      throw new Error("请先停止或等待当前生成任务完成，再删除章节。");
    await flush();
    if (busy.value || imageBusy.value)
      throw new Error("请先停止或等待当前生成任务完成，再删除章节。");
    const index = Math.max(
      0,
      detail.value?.chapters.findIndex((item) => item.id === id) ?? 0,
    );
    const updated = await api<ProjectDetail>("chapter:delete", {
      id,
      projectId: target.projectId,
    });
    if (detail.value?.project.id !== target.projectId) return;
    detail.value = updated;
    pending.delete("chapter:" + id);
    if (
      ![...updated.chapters, ...(updated.fragments ?? [])].some(
        (item) => item.id === chapterId.value,
      )
    ) {
      chapterId.value =
        updated.chapters[Math.min(index, updated.chapters.length - 1)]?.id ||
        updated.fragments?.[0]?.id ||
        "";
      selection.value = null;
    }
    if (
      planningTarget.value?.id === id ||
      planningTarget.value?.parentId === id
    )
      planningTarget.value = undefined;
    if (
      planningDraft.value?.target.id === id ||
      planningDraft.value?.target.parentId === id
    ) {
      planningDraft.value = null;
      if (resultType.value === "planning") output.value = "";
    }
    if (developmentDraft.value) {
      const candidate = updated.project.blueprintCandidates.find(
        (c) => c.development?.id === developmentDraft.value?.id,
      );
      developmentDraft.value = candidate?.development ?? null;
    }
    if (outputChapterId.value === id) {
      output.value = "";
      outputChapterId.value = "";
      outputSelection.value = null;
      outputScope.value = null;
      sourceContent.value = "";
      resultType.value = null;
      memoryRecords.value = null;
      memoryRevisionId.value = "";
      taskError.value = "";
    }
    scratch();
    images.value = images.value.map((image) =>
      image.chapterId === id
        ? { ...image, chapterId: null, revisionId: null }
        : image,
    );
    const project = projects.value.find(
      (item) => item.id === updated.project.id,
    );
    if (project) Object.assign(project, updated.project);
    notify(`已删除「${target.title}」。`);
  }
  async function removePlanning(target: PlanningTarget) {
    const projectId = detail.value?.project.id;
    if (!projectId) return;
    if (busy.value || imageBusy.value)
      throw new Error("请先停止或等待当前生成任务完成，再清空或删除规划。");
    await flush();
    if (detail.value?.project.id !== projectId) return;
    const updated = await api<ProjectDetail>("planning:remove", {
      projectId,
      target,
    });
    if (detail.value?.project.id !== projectId) return;
    detail.value = updated;
    const removedTarget = (value?: PlanningTarget) =>
      !!value &&
      ["volume", "scene"].includes(target.level) &&
      ((value.level === target.level && value.id === target.id) ||
        (target.level === "volume" && value.parentId === target.id));
    if (removedTarget(planningTarget.value)) planningTarget.value = undefined;
    if (removedTarget(planningDraft.value?.target)) {
      planningDraft.value = null;
      if (resultType.value === "planning") {
        output.value = "";
        resultType.value = null;
      }
    }
    scratch();
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
    options: {
      instruction?: string;
      workflowContext?: string;
      chapterId?: string;
      newChapter?: boolean;
      planningTarget?: PlanningTarget;
      writingScope?: TaskRequest["writingScope"];
      outputMode?: TaskRequest["outputMode"];
      usePlanDraft?: boolean;
    } = {},
  ) {
    if (!detail.value || busy.value || closingWindow.value) return;
    const projectId = detail.value.project.id;
    let markFinished!: () => void;
    taskFinished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    stopRequested = false;
    generationProjectId = projectId;
    busy.value = true;
    taskError.value = "";
    requestId.value = crypto.randomUUID();
    try {
      if (
        options.newChapter ||
        (["opening", "chapter"].includes(kind) && !chapter.value)
      )
        await newChapter();
      await flush();
      if (stopRequested || detail.value?.project.id !== projectId) return;
      if (options.planningTarget) planningTarget.value = options.planningTarget;
      output.value = "";
      memoryRecords.value = null;
      memoryRevisionId.value = "";
      developmentDraft.value = null;
      planningDraft.value = null;
      resultType.value = null;
      outputKind.value = kind;
      taskKind.value = kind;
      const targetChapterId = options.chapterId || chapter.value?.id || "";
      outputChapterId.value = targetChapterId;
      outputSelection.value =
        targetChapterId === chapter.value?.id && selection.value
          ? { ...selection.value }
          : null;
      const selected = outputSelection.value?.text;
      const polish = ["revise", "scene", "dialogue"].includes(kind);
      outputScope.value = polish
        ? selected?.trim()
          ? "selection"
          : (options.writingScope ?? writingScope.value)
        : null;
      sourceContent.value =
        [...detail.value.chapters, ...(detail.value.fragments ?? [])].find(
          (c) => c.id === targetChapterId,
        )?.content ?? "";
      scratch();
      const result = await api<TaskResult>("ai:run", {
        requestId: requestId.value,
        kind,
        projectId,
        chapterId: targetChapterId || undefined,
        instruction: options.instruction ?? instruction.value,
        selection: selected,
        workflowContext: options.workflowContext,
        planningTarget: ["outline", "adjust"].includes(kind)
          ? (options.planningTarget ??
            planningTarget.value ??
            (detail.value.project.mode === "novel"
              ? chapter.value?.kind !== "fragment" && chapter.value
                ? { level: "chapter", id: chapter.value.id }
                : { level: "synopsis" }
              : undefined))
          : undefined,
        writingScope: polish ? (outputScope.value ?? undefined) : undefined,
        outputMode: polish
          ? (options.outputMode ?? outputMode.value)
          : undefined,
        usePlanDraft: options.usePlanDraft ?? usePlanDraft.value,
        referenceNovelPlan: referenceNovelPlan.value,
      });
      if (detail.value?.project.id !== projectId) return;
      requestId.value = "";
      output.value = result.text;
      memoryRecords.value = result.memoryRecords ?? null;
      memoryRevisionId.value = result.memoryRevisionId ?? "";
      developmentDraft.value = result.developmentDraft ?? null;
      planningDraft.value = result.planningDraft ?? null;
      resultType.value = result.resultType ?? (polish ? "rewrite" : null);
      if (
        !result.planningDraft &&
        toolInfo[kind].candidate &&
        result.text.trim()
      ) {
        const labels: Partial<Record<TaskKind, string>> = {
          outline: "故事蓝图候选",
          adjust: "走向调整候选",
          organize: "灵感整理候选",
          brainstorm: "脑暴候选",
          pacing: "节奏诊断候选",
          arc: "人物弧线候选",
          develop: "设定与蓝图建议",
        };
        const candidate = {
          id: crypto.randomUUID(),
          title: labels[kind] ?? "创作候选",
          content: result.text,
          source: kind,
          createdAt: new Date().toISOString(),
          ...(result.developmentDraft
            ? { development: result.developmentDraft }
            : {}),
        };
        editProject({
          blueprintCandidates: [
            candidate,
            ...(detail.value!.project.blueprintCandidates || []),
          ].slice(0, 100),
        });
      }
    } catch (error) {
      if (detail.value?.project.id === projectId)
        taskError.value =
          error instanceof Error ? error.message : String(error);
    } finally {
      requestId.value = "";
      busy.value = false;
      generationProjectId = "";
      if (detail.value?.project.id === projectId) {
        scratch();
        void safe(flush);
      }
      markFinished();
    }
  }
  async function stopTask() {
    stopRequested = true;
    if (requestId.value) await api("ai:cancel", requestId.value);
  }
  function reviewDevelopment(draft: StoryDevelopmentDraft) {
    if (busy.value || draft.projectId !== detail.value?.project.id) return;
    developmentDraft.value = JSON.parse(JSON.stringify(draft));
    outputKind.value = "develop";
    taskKind.value = "develop";
    output.value = developmentText(draft);
    outputChapterId.value = chapter.value?.id ?? "";
    outputSelection.value = null;
    memoryRecords.value = null;
    memoryRevisionId.value = "";
    taskError.value = "";
    reviewingDevelopment.value = true;
    scratch();
  }
  function editDevelopment(draft: StoryDevelopmentDraft) {
    if (!detail.value || draft.projectId !== detail.value.project.id) return;
    developmentDraft.value = JSON.parse(JSON.stringify(draft));
    if (outputKind.value === "develop") output.value = developmentText(draft);
    editProject({
      blueprintCandidates: detail.value.project.blueprintCandidates.map(
        (candidate) =>
          candidate.development?.id === draft.id
            ? {
                ...candidate,
                content: developmentText(draft),
                development: JSON.parse(JSON.stringify(draft)),
              }
            : candidate,
      ),
    });
    scratch();
  }
  async function applyDevelopmentChanges(
    draft: StoryDevelopmentDraft,
    selectedIds: string[],
  ) {
    if (!detail.value || busy.value) return false;
    const projectId = detail.value.project.id;
    await flush();
    if (detail.value?.project.id !== projectId) return false;
    const result = await api<{
      detail: ProjectDetail;
      draft: StoryDevelopmentDraft;
      undoId: string;
    }>("story:apply-development", { projectId, draft, selectedIds });
    if (detail.value?.project.id !== projectId) return false;
    detail.value = result.detail;
    developmentDraft.value = result.draft;
    if (outputKind.value === "develop")
      output.value = developmentText(result.draft);
    developmentUndoId.value = result.undoId;
    scratch();
    await flush();
    notify("已更新选中的蓝图与资料分区，后续创作会参考这些内容。");
    return true;
  }
  async function undoDevelopmentChanges() {
    if (!detail.value || !developmentUndoId.value || busy.value) return;
    const projectId = detail.value.project.id;
    const undoId = developmentUndoId.value;
    await flush();
    if (detail.value?.project.id !== projectId) return;
    const result = await api<{
      detail: ProjectDetail;
      draft: StoryDevelopmentDraft;
    }>("story:undo-development", { projectId, undoId });
    if (detail.value?.project.id !== projectId) return;
    detail.value = result.detail;
    developmentDraft.value = result.draft;
    if (outputKind.value === "develop")
      output.value = developmentText(result.draft);
    developmentUndoId.value = "";
    scratch();
    await flush();
    notify("已撤销本次设定与蓝图更新。");
  }
  async function setModel(kind: "text" | "image", model: string) {
    await flush();
    const result = await api<Settings>("settings:model", { kind, model });
    settings.value = {
      ...result,
      software: settings.value?.software ?? result.software,
    };
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
      detail.value.cards = detail.value.cards.filter(
        (card) => card.id !== deleted.id,
      );
    notify(`已删除资料「${deleted.name}」。`);
  }
  async function createProject(value: {
    title: string;
    premise: string;
    mode: "explore" | "novel";
    creativeFreedom?: CreativeFreedom;
    genre?: string;
    cardIds?: string[];
    cover?: CoverUpload;
  }) {
    await flush();
    const project = await api<Project>("project:create", value);
    await bootstrap();
    return project;
  }
  async function saveProjectCover(
    projectId: string,
    source:
      { upload: CoverUpload } | { imageId: string; crop: CoverCrop } | null,
  ) {
    await flush();
    const project = source
      ? await api<Project>("project:cover:save", { projectId, source })
      : await api<Project>("project:cover:remove", projectId);
    projects.value = projects.value.map((p) =>
      p.id === projectId ? project : p,
    );
    if (detail.value?.project.id === projectId) detail.value.project = project;
    return project;
  }
  function imageUrl(id: string) {
    return "story-asset://asset/" + id;
  }
  function initializeListeners() {
    window.storybook.onProgress((event) => {
      if (
        busy.value &&
        event.requestId === requestId.value &&
        detail.value?.project.id === generationProjectId
      ) {
        output.value += event.delta;
        scratch();
      }
    });
    window.storybook.onClosing((action) => {
      void safe(action === "quit" ? () => confirmClose("quit") : requestClose);
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
    developmentDraft,
    planningDraft,
    planningTarget,
    resultType,
    writingScope,
    outputScope,
    outputMode,
    sourceContent,
    usePlanDraft,
    referenceNovelPlan,
    reviewingDevelopment,
    developmentUndoId,
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
    editPlanning,
    editSettings,
    editSoftwareSettings,
    closePrompt,
    closingWindow,
    requestClose,
    confirmClose,
    editChapter,
    renameChapter,
    openProject,
    refreshProject,
    switchChapter,
    newChapter,
    newFragment,
    deleteChapter,
    removePlanning,
    adopt,
    runTask,
    stopTask,
    reviewDevelopment,
    editDevelopment,
    applyDevelopmentChanges,
    undoDevelopmentChanges,
    setModel,
    saveCard,
    deleteCard,
    createProject,
    saveProjectCover,
    imageUrl,
    initializeListeners,
    scratch,
  };
});
