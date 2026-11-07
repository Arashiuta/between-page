import { defineStore } from "pinia";
import { ref, computed, nextTick } from "vue";
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
import {
  conversationTarget,
  targetKey,
  type CreationConversation,
  type CreationTurn,
  type ConversationDetail,
  type TurnReview,
} from "../../shared/conversations";

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
  const conversations = ref<CreationConversation[]>([]);
  const conversationId = ref("");
  const turns = ref<CreationTurn[]>([]);
  const selectedTurnId = ref("");
  const conversationInvalidReason = ref("");
  const conversationsLoaded = ref(false);
  const conversationLoading = ref(false);
  const activeConversation = computed(() =>
    conversations.value.find((c) => c.id === conversationId.value),
  );
  const selectedTurn = computed(() =>
    turns.value.find((t) => t.id === selectedTurnId.value),
  );
  let conversationRevision = 0;
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
    if (activeConversation.value && !busy.value) {
      if (
        targetKey(activeConversation.value.target) ===
        targetKey(conversationTarget(currentTaskRequest()))
      )
        activeConversation.value.draftInstruction = instruction.value;
      activeConversation.value.updatedAt = new Date().toISOString();
      conversations.value.sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      enqueue("conversation:" + conversationId.value, "conversation:update", {
        projectId: detail.value.project.id,
        id: conversationId.value,
        selectedTurnId: selectedTurnId.value || null,
        draftInstruction: activeConversation.value.draftInstruction,
      });
      if (selectedTurn.value && !busy.value) {
        const review: TurnReview = {
          text: output.value,
          ...(selectedTurn.value.review.resultType
            ? { resultType: selectedTurn.value.review.resultType }
            : {}),
          ...(memoryRevisionId.value
            ? { memoryRevisionId: memoryRevisionId.value }
            : {}),
          memoryRecords: memoryRecords.value,
          developmentDraft: developmentDraft.value,
          planningDraft: planningDraft.value,
        };
        selectedTurn.value.review = JSON.parse(JSON.stringify(review));
        enqueue("turn:" + selectedTurnId.value, "conversation:save-turn", {
          projectId: detail.value.project.id,
          id: selectedTurnId.value,
          review,
        });
      }
    }
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
      ...(conversationId.value ? { conversationId: conversationId.value } : {}),
      ...(selectedTurnId.value ? { selectedTurnId: selectedTurnId.value } : {}),
      developmentUndoId: developmentUndoId.value,
      ...(memoryRevisionId.value
        ? { memoryRevisionId: memoryRevisionId.value }
        : {}),
      outputSelection: outputSelection.value,
    });
  }
  function clearResult() {
    output.value = "";
    memoryRecords.value = null;
    memoryRevisionId.value = "";
    developmentDraft.value = null;
    planningDraft.value = null;
    resultType.value = null;
    sourceContent.value = "";
    outputSelection.value = null;
    outputScope.value = null;
    outputChapterId.value = "";
    taskError.value = "";
  }
  function hydrateTurn(turn?: CreationTurn) {
    clearResult();
    selectedTurnId.value = turn?.id ?? "";
    if (!turn) return;
    const review = JSON.parse(JSON.stringify(turn.review)) as TurnReview;
    output.value = review.text;
    outputKind.value = activeConversation.value?.target.kind ?? taskKind.value;
    outputChapterId.value = activeConversation.value?.target.chapterId ?? "";
    resultType.value = review.resultType ?? null;
    memoryRecords.value = review.memoryRecords ?? null;
    memoryRevisionId.value = review.memoryRevisionId ?? "";
    developmentDraft.value = review.developmentDraft ?? null;
    planningDraft.value = review.planningDraft ?? null;
    sourceContent.value = turn.sourceContent;
    outputSelection.value = turn.selection ?? null;
    outputScope.value = activeConversation.value?.target.writingScope ?? null;
    developmentUndoId.value = turn.undoId ?? "";
    taskError.value = turn.error;
  }
  async function loadConversations(projectId: string) {
    const list = await api<CreationConversation[]>(
      "conversation:list",
      projectId,
    );
    if (detail.value?.project.id !== projectId) return;
    conversations.value = Array.isArray(list) ? list : [];
    conversationsLoaded.value = Array.isArray(list);
  }
  async function openConversation(id: string, adjustTarget = true) {
    if (!detail.value || busy.value) return;
    const projectId = detail.value.project.id;
    const revision = ++conversationRevision;
    scratch();
    await flush();
    conversationLoading.value = true;
    try {
      const value = await api<ConversationDetail>("conversation:get", {
        projectId,
        id,
      });
      if (
        revision !== conversationRevision ||
        detail.value?.project.id !== projectId
      )
        return;
      conversations.value = conversations.value.map((c) =>
        c.id === id ? value.conversation : c,
      );
      conversationId.value = id;
      turns.value = value.turns;
      conversationInvalidReason.value = value.invalidReason ?? "";
      const target = value.conversation.target;
      if (adjustTarget) {
        taskKind.value = target.kind;
        if (
          target.chapterId &&
          [...detail.value.chapters, ...(detail.value.fragments ?? [])].some(
            (c) => c.id === target.chapterId,
          )
        )
          chapterId.value = target.chapterId;
        planningTarget.value = target.planningTarget;
        writingScope.value = target.writingScope ?? "selection";
        outputMode.value = target.outputMode ?? "rewrite";
        selection.value = null;
      }
      instruction.value = value.conversation.draftInstruction;
      hydrateTurn(
        value.turns.find((t) => t.id === value.conversation.selectedTurnId) ??
          value.turns.at(-1),
      );
      await nextTick();
    } finally {
      if (revision === conversationRevision) conversationLoading.value = false;
    }
  }
  function currentTaskRequest(kind: TaskKind = taskKind.value): TaskRequest {
    const polish = ["revise", "scene", "dialogue"].includes(kind);
    const target = activeConversation.value?.target;
    const matching =
      target?.kind === kind &&
      target.chapterId === (chapter.value?.id || undefined);
    const range =
      selection.value ??
      (matching && (!polish || writingScope.value === "selection")
        ? target?.selectionRange
        : undefined);
    return {
      requestId: crypto.randomUUID(),
      kind,
      projectId: detail.value!.project.id,
      chapterId: chapter.value?.id,
      instruction: instruction.value,
      selection: range?.text,
      selectionRange: range ?? undefined,
      planningTarget: ["outline", "adjust"].includes(kind)
        ? (planningTarget.value ??
          (detail.value!.project.mode === "novel"
            ? chapter.value && chapter.value.kind !== "fragment"
              ? { level: "chapter", id: chapter.value.id }
              : { level: "synopsis" }
            : undefined))
        : undefined,
      writingScope: polish
        ? range?.text.trim()
          ? "selection"
          : writingScope.value
        : undefined,
      outputMode: polish ? outputMode.value : undefined,
      usePlanDraft: usePlanDraft.value,
      referenceNovelPlan: referenceNovelPlan.value,
    };
  }
  async function restoreConversation() {
    if (
      !conversationsLoaded.value ||
      busy.value ||
      conversationLoading.value ||
      !detail.value
    )
      return;
    const target = conversationTarget(currentTaskRequest());
    if (
      activeConversation.value &&
      targetKey(activeConversation.value.target) === targetKey(target)
    )
      return;
    const c = conversations.value.find(
      (c) => targetKey(c.target) === targetKey(target),
    );
    if (c) await openConversation(c.id, false);
    else {
      scratch();
      await flush();
      conversationId.value = "";
      selectedTurnId.value = "";
      turns.value = [];
      conversationInvalidReason.value = "";
      clearResult();
      instruction.value = "";
    }
  }
  async function newConversation() {
    if (!detail.value || busy.value) return;
    scratch();
    await flush();
    const c = await api<CreationConversation>("conversation:create", {
      projectId: detail.value.project.id,
      target: conversationTarget(currentTaskRequest()),
    });
    conversations.value.unshift(c);
    conversationId.value = c.id;
    selectedTurnId.value = "";
    turns.value = [];
    conversationInvalidReason.value = "";
    clearResult();
    instruction.value = "";
    conversationsLoaded.value = true;
  }
  async function selectVersion(id: string) {
    if (busy.value) return;
    const projectId = detail.value?.project.id,
      currentConversationId = conversationId.value;
    scratch();
    await flush();
    if (!projectId || !currentConversationId) return;
    const latest = await api<ConversationDetail>("conversation:get", {
      projectId,
      id: currentConversationId,
    });
    if (
      detail.value?.project.id !== projectId ||
      conversationId.value !== currentConversationId
    )
      return;
    turns.value = latest.turns;
    conversationInvalidReason.value = latest.invalidReason ?? "";
    const turn = latest.turns.find((t) => t.id === id);
    if (turn) {
      hydrateTurn(turn);
      scratch();
    }
  }
  async function renameConversation(title: string) {
    if (!detail.value || !conversationId.value) return;
    const c = await api<CreationConversation>("conversation:update", {
      projectId: detail.value.project.id,
      id: conversationId.value,
      title,
    });
    conversations.value = conversations.value.map((item) =>
      item.id === c.id ? c : item,
    );
  }
  async function deleteConversation() {
    if (!detail.value || busy.value || !conversationId.value) return;
    await flush();
    const id = conversationId.value;
    await api("conversation:delete", {
      projectId: detail.value.project.id,
      id,
    });
    conversations.value = conversations.value.filter((c) => c.id !== id);
    conversationId.value = "";
    selectedTurnId.value = "";
    turns.value = [];
    clearResult();
    await refreshProject();
    await restoreConversation();
    scratch();
  }
  async function markResultApplied(label: string) {
    if (!selectedTurn.value || !detail.value) return;
    await markVersionApplied(selectedTurn.value.id, label);
  }
  async function markVersionApplied(id: string, label: string) {
    if (!detail.value) return;
    const turn = await api<CreationTurn>("conversation:applied", {
      projectId: detail.value.project.id,
      id,
      label,
    });
    turns.value = turns.value.map((t) => (t.id === turn.id ? turn : t));
  }
  async function openProject(id: string) {
    await flush();
    conversationRevision++;
    conversationId.value = "";
    selectedTurnId.value = "";
    turns.value = [];
    conversations.value = [];
    conversationsLoaded.value = false;
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
      conversationId?: string;
      selectedTurnId?: string;
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
    await loadConversations(id);
    if (conversationsLoaded.value) {
      const remembered =
        conversations.value.find((c) => c.id === saved?.conversationId) ??
        conversations.value.find((c) => c.legacy);
      if (remembered) await openConversation(remembered.id);
      else await restoreConversation();
    }
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
    if (
      activeConversation.value?.target.chapterId === id ||
      activeConversation.value?.target.planningTarget?.id === id ||
      activeConversation.value?.target.planningTarget?.parentId === id
    ) {
      conversationId.value = "";
      selectedTurnId.value = "";
      turns.value = [];
      clearResult();
    }
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
    if (removedTarget(activeConversation.value?.target.planningTarget)) {
      conversationId.value = "";
      selectedTurnId.value = "";
      turns.value = [];
      clearResult();
    }
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
      newConversation?: boolean;
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
      const request = currentTaskRequest(kind);
      request.requestId = requestId.value;
      request.instruction = options.instruction ?? instruction.value;
      request.workflowContext = options.workflowContext;
      request.chapterId = options.chapterId || request.chapterId;
      request.outputMode = options.outputMode ?? request.outputMode;
      request.usePlanDraft = options.usePlanDraft ?? request.usePlanDraft;
      if (options.planningTarget)
        request.planningTarget = options.planningTarget;
      if (options.writingScope && !request.selection)
        request.writingScope = options.writingScope;
      if (request.writingScope) writingScope.value = request.writingScope;
      if (conversationsLoaded.value) {
        const target = conversationTarget(request);
        let c =
          !options.newConversation && !options.workflowContext
            ? activeConversation.value &&
              targetKey(activeConversation.value.target) === targetKey(target)
              ? activeConversation.value
              : conversations.value.find(
                  (c) => targetKey(c.target) === targetKey(target),
                )
            : undefined;
        if (!c) {
          c = await api<CreationConversation>("conversation:create", {
            projectId,
            target,
          });
          conversations.value.unshift(c);
        }
        if (stopRequested || detail.value?.project.id !== projectId) return;
        request.conversationId = c.id;
        request.parentTurnId =
          c.id === conversationId.value
            ? selectedTurnId.value || undefined
            : c.selectedTurnId || undefined;
        if (c.id !== conversationId.value) {
          turns.value = [];
          selectedTurnId.value = "";
        }
        conversationId.value = c.id;
        conversationLoading.value = true;
      }
      output.value = "";
      memoryRecords.value = null;
      memoryRevisionId.value = "";
      developmentDraft.value = null;
      planningDraft.value = null;
      resultType.value = null;
      outputKind.value = kind;
      taskKind.value = kind;
      const targetChapterId = request.chapterId || "";
      outputChapterId.value = targetChapterId;
      outputSelection.value = request.selectionRange
        ? { ...request.selectionRange }
        : null;
      const selected = outputSelection.value?.text;
      const polish = ["revise", "scene", "dialogue"].includes(kind);
      outputScope.value = polish
        ? selected?.trim()
          ? "selection"
          : (request.writingScope ?? writingScope.value)
        : null;
      sourceContent.value =
        [...detail.value.chapters, ...(detail.value.fragments ?? [])].find(
          (c) => c.id === targetChapterId,
        )?.content ?? "";
      scratch();
      const result = await api<TaskResult>("ai:run", request);
      if (detail.value?.project.id !== projectId) return;
      requestId.value = "";
      output.value = result.text;
      memoryRecords.value = result.memoryRecords ?? null;
      memoryRevisionId.value = result.memoryRevisionId ?? "";
      developmentDraft.value = result.developmentDraft ?? null;
      planningDraft.value = result.planningDraft ?? null;
      resultType.value = result.resultType ?? (polish ? "rewrite" : null);
      if (
        !result.turnId &&
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
      generationProjectId = "";
      if (detail.value?.project.id === projectId) {
        if (conversationLoading.value && conversationId.value) {
          try {
            const failure = taskError.value;
            const value = await api<ConversationDetail>("conversation:get", {
              projectId,
              id: conversationId.value,
            });
            if (detail.value?.project.id === projectId) {
              conversations.value = conversations.value.map((c) =>
                c.id === value.conversation.id ? value.conversation : c,
              );
              turns.value = value.turns;
              hydrateTurn(
                value.turns.find(
                  (t) => t.id === value.conversation.selectedTurnId,
                ) ?? value.turns.at(-1),
              );
              if (failure && !taskError.value) taskError.value = failure;
              instruction.value = value.conversation.draftInstruction;
              const refreshed = await api<ProjectDetail>(
                "project:get",
                projectId,
              );
              if (detail.value?.project.id === projectId)
                detail.value = refreshed;
            }
          } catch (error) {
            notify(
              error instanceof Error ? error.message : String(error),
              "error",
            );
          }
        }
        busy.value = false;
        conversationLoading.value = false;
        scratch();
        void safe(flush);
      }
      busy.value = false;
      conversationLoading.value = false;
      markFinished();
    }
  }
  async function stopTask() {
    stopRequested = true;
    if (requestId.value) await api("ai:cancel", requestId.value);
  }
  function reviewDevelopment(draft: StoryDevelopmentDraft) {
    if (busy.value || draft.projectId !== detail.value?.project.id) return;
    const candidate = detail.value?.project.blueprintCandidates.find(
      (c) => c.development?.id === draft.id,
    );
    if (
      candidate?.conversationId &&
      candidate.turnId &&
      candidate.turnId !== selectedTurnId.value
    ) {
      void safe(async () => {
        await openConversation(candidate.conversationId!);
        await selectVersion(candidate.turnId!);
        reviewingDevelopment.value = true;
      });
      return;
    }
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
    const turnId =
      selectedTurn.value?.review.developmentDraft?.id === draft.id
        ? selectedTurn.value.id
        : detail.value.project.blueprintCandidates.find(
            (c) => c.development?.id === draft.id,
          )?.turnId;
    await flush();
    if (detail.value?.project.id !== projectId) return false;
    const result = await api<{
      detail: ProjectDetail;
      draft: StoryDevelopmentDraft;
      undoId: string;
    }>("story:apply-development", {
      projectId,
      draft,
      selectedIds,
      ...(turnId ? { turnId } : {}),
    });
    if (detail.value?.project.id !== projectId) return false;
    detail.value = result.detail;
    if (turnId && selectedTurnId.value !== turnId) return true;
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
        if (event.turnId) selectedTurnId.value = event.turnId;
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
    conversations,
    conversationId,
    turns,
    selectedTurnId,
    selectedTurn,
    activeConversation,
    conversationInvalidReason,
    conversationLoading,
    loadConversations,
    openConversation,
    restoreConversation,
    newConversation,
    selectVersion,
    renameConversation,
    deleteConversation,
    currentTaskRequest,
    markResultApplied,
    markVersionApplied,
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
