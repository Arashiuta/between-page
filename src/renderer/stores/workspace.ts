import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  Bootstrap,
  Card,
  CardInput,
  ChangeSet,
  Chapter,
  CloseAction,
  ConversationDetail,
  CoverCrop,
  CoverUpload,
  CreationConversation,
  CreationTurn,
  CreativeFreedom,
  DocumentNode,
  ImageAsset,
  Project,
  ProjectDetail,
  RoleSettings,
  Settings,
  SettingsInput,
  SoftwareSettingsPatch,
  TaskKind,
  TaskRequest,
  TaskResult,
  TextSelection,
  BlueprintTarget,
  CheckScope,
  CheckAspect,
  PolishAspect,
  DirectionView,
} from "../../shared/types";
import { defaultRoleSettings } from "../../shared/roles";
import { documentToText } from "../../shared/document";
import { normalizeSoftware } from "../../shared/appearance";
import { requestKey } from "../../shared/requests";
export const useWorkspace = defineStore("workspace", () => {
  const ready = ref(false),
    projects = ref<Project[]>([]),
    cards = ref<Card[]>([]),
    images = ref<ImageAsset[]>([]),
    settings = ref<Settings | null>(null),
    roles = ref<RoleSettings>(defaultRoleSettings());
  const detail = ref<ProjectDetail | null>(null),
    chapterId = ref(""),
    saving = ref(false),
    saveFailed = ref(false),
    busy = ref(false),
    imageBusy = ref(false);
  const chapter = computed(
    () => detail.value?.chapters.find((c) => c.id === chapterId.value) ?? null,
  );
  const taskKind = ref<TaskKind>("brainstorm"),
    taskModel = ref(""),
    instruction = ref(""),
    output = ref(""),
    taskError = ref(""),
    selection = ref<TextSelection | null>(null);
  const blueprintTarget = ref<BlueprintTarget>({ level: "section", count: 1 }),
    outlineTarget = ref<BlueprintTarget>({ level: "synopsis", count: 1 }),
    planningNodeId = ref(""),
    settingCardId = ref<string>(),
    checkScope = ref<"current" | "chapters" | "book">("current"),
    checkChapterIds = ref<string[]>([]),
    checkAspect = ref<CheckAspect>("continuity"),
    checkCharacter = ref(""),
    polishAspect = ref<PolishAspect>("expression");
  const conversations = ref<CreationConversation[]>([]),
    conversationId = ref(""),
    turns = ref<CreationTurn[]>([]),
    selectedTurnId = ref(""),
    result = ref<TaskResult | null>(null),
    changeSets = ref<ChangeSet[]>([]),
    reviewingChangeId = ref("");
  const selectedTurn = computed(() =>
      turns.value.find((t) => t.id === selectedTurnId.value),
    ),
    activeConversation = computed(() =>
      conversations.value.find((c) => c.id === conversationId.value),
    );
  const closePrompt = ref(false),
    closingWindow = ref(false),
    toast = ref<{ message: string; type: "success" | "error" | "info" } | null>(
      null,
    );
  let toastTimer: ReturnType<typeof setTimeout>,
    saveTimer: ReturnType<typeof setTimeout>,
    requestId = "",
    generationProjectId = "",
    finished = Promise.resolve(),
    stopRequested = false;
  const directionsBusy = ref(false),
    directionsChapterId = ref(""),
    directionsError = ref(""),
    directionsEpoch = ref(0);
  let directionRequestId = "",
    directionFinished = Promise.resolve(),
    directionStopped = false;
  let projectLoad = 0,
    conversationLoad = 0,
    settingsEdit = 0,
    contentEdit = 0;
  let creatingChapter: Promise<Chapter | undefined> | null = null;
  const pending = new Map<string, { action: string; payload: any }>();
  let flushing: Promise<void> | null = null;
  const api = <T = unknown>(action: string, payload?: unknown) =>
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
  async function safe<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      notify((e as Error).message, "error");
      return undefined;
    }
  }
  function enqueue(key: string, action: string, payload: any) {
    const old = pending.get(key);
    pending.set(key, { action, payload: { ...old?.payload, ...payload } });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void safe(flush), 650);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (flushing) return flushing;
    flushing = (async () => {
      saving.value = true;
      try {
        while (pending.size) {
          const [key, job] = pending.entries().next().value!;
          pending.delete(key);
          try {
            const value = await api<any>(job.action, job.payload);
            if (job.action === "chapter:update" && !pending.has(key)) {
              const c = detail.value?.chapters.find((c) => c.id === value.id);
              if (c) {
                c.dirty = value.dirty;
                c.updatedAt = value.updatedAt;
              }
            }
          } catch (e) {
            pending.set(key, {
              action: job.action,
              payload: { ...job.payload, ...pending.get(key)?.payload },
            });
            saveFailed.value = true;
            throw e;
          }
        }
        saveFailed.value = false;
      } finally {
        saving.value = false;
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
  }
  async function bootstrap() {
    const epoch = settingsEdit,
      b = await api<Bootstrap>("bootstrap");
    projects.value = b.projects;
    cards.value = b.cards;
    images.value = b.images;
    if (settingsEdit === epoch) settings.value = b.settings;
    roles.value = b.roles;
    ready.value = true;
  }

  function editProject(patch: Partial<Project>) {
    contentEdit++;
    if (!detail.value) return;
    Object.assign(detail.value.project, patch);
    enqueue("project:" + detail.value.project.id, "project:update", {
      id: detail.value.project.id,
      ...patch,
    });
  }
  function editChapter(patch: { title?: string; document?: DocumentNode }) {
    contentEdit++;
    if (!chapter.value) return;
    Object.assign(chapter.value, patch);
    if (patch.document) chapter.value.content = documentToText(patch.document);
    enqueue("chapter:" + chapter.value.id, "chapter:update", {
      id: chapter.value.id,
      ...patch,
    });
  }
  function renameChapter(id: string, title: string) {
    contentEdit++;
    const c = detail.value?.chapters.find((c) => c.id === id);
    if (!c) return;
    c.title = title;
    enqueue("chapter:" + id, "chapter:update", { id, title });
  }
  function editSettings(value: SettingsInput) {
    settingsEdit++;
    if (!settings.value) return;
    settings.value = {
      ...settings.value,
      ...value,
      text: { ...value.text, hasKey: !!value.text.key },
      image: { ...value.image, hasKey: !!value.image.key },
    };
    enqueue("settings", "settings:save", value);
  }
  function editSoftwareSettings(value: SoftwareSettingsPatch) {
    settingsEdit++;
    if (!settings.value) return;
    const current = normalizeSoftware(settings.value.software);
    settings.value.software = {
      ...current,
      ...value,
      appearance: { ...current.appearance, ...value.appearance },
    };
    enqueue("software", "settings:software", settings.value.software);
  }
  function scratch() {
    if (!detail.value) return;
    enqueue(
      "ui:" + detail.value.project.id + ":" + detail.value.project.mode,
      "ui:save",
      {
        projectId: detail.value.project.id,
        key: "workbench." + detail.value.project.mode,
        value: {
          taskKind: taskKind.value,
          taskModel: taskModel.value,
          instruction: instruction.value,
          conversationId: conversationId.value,
          chapterId: chapterId.value,
          blueprintTarget: blueprintTarget.value,
          outlineTarget: outlineTarget.value,
          settingCardId: settingCardId.value,
          checkScope: checkScope.value,
          checkChapterIds: checkChapterIds.value,
          checkAspect: checkAspect.value,
          checkCharacter: checkCharacter.value,
          polishAspect: polishAspect.value,
          selection: selection.value,
        },
      },
    );
  }
  async function refreshProject() {
    if (!detail.value) return;
    await flush();
    const pid = detail.value.project.id,
      epoch = contentEdit;
    const [d, sets] = await Promise.all([
      api<ProjectDetail>("project:get", pid),
      api<ChangeSet[]>("changes:list", pid),
    ]);
    if (detail.value?.project.id === pid) {
      if (contentEdit === epoch) detail.value = d;
      else {
        d.project = detail.value.project;
        for (const c of d.chapters) {
          const local = detail.value.chapters.find((x) => x.id === c.id);
          if (local)
            Object.assign(c, {
              title: local.title,
              document: local.document,
              content: local.content,
              dirty: local.dirty,
              updatedAt: local.updatedAt,
            });
        }
        detail.value = d;
      }
      projects.value = projects.value.map((p) =>
        p.id === pid ? detail.value!.project : p,
      );
      changeSets.value = sets;
    }
  }

  function clearConversation() {
    conversationLoad++;
    conversationId.value = "";
    turns.value = [];
    selectedTurnId.value = "";
    result.value = null;
    output.value = "";
    taskError.value = "";
  }
  async function openProject(id: string) {
    const ticket = ++projectLoad;
    if (directionsBusy.value) {
      await stopDirections();
      await directionFinished;
    }
    if (busy.value) {
      await stopTask();
      await finished;
    }
    await flush();
    const loaded = await api<ProjectDetail>("project:get", id);
    if (ticket !== projectLoad) return;
    detail.value = loaded;
    chapterId.value = detail.value.chapters[0]?.id ?? "";
    selection.value = null;
    planningNodeId.value = "";
    directionsError.value = "";
    clearConversation();
    const [cs, sets] = await Promise.all([
      api<CreationConversation[]>("conversation:list", id),
      api<ChangeSet[]>("changes:list", id),
    ]);
    if (ticket !== projectLoad) return;
    conversations.value = cs;
    changeSets.value = sets;
    taskKind.value = "brainstorm";
    taskModel.value = "";
    instruction.value = "";
    settingCardId.value = undefined;
    checkScope.value = "current";
    checkChapterIds.value = [];
    checkAspect.value = "continuity";
    checkCharacter.value = "";
    polishAspect.value = "expression";
    const saved = await api<any>("ui:get", {
      projectId: id,
      key: "workbench." + detail.value.project.mode,
    });
    if (ticket !== projectLoad) return;
    if (saved) {
      taskKind.value =
        saved.taskKind === "settings"
          ? "brainstorm"
          : (saved.taskKind ?? "brainstorm");
      taskModel.value = saved.taskModel ?? "";
      instruction.value = saved.instruction ?? "";
      chapterId.value = detail.value.chapters.some(
        (c) => c.id === saved.chapterId,
      )
        ? saved.chapterId
        : chapterId.value;
      blueprintTarget.value = saved.blueprintTarget ?? {
        level: "section",
        count: 1,
      };
      outlineTarget.value = saved.outlineTarget ?? {
        level: "synopsis",
        count: 1,
      };
      if (blueprintTarget.value.level !== "section") {
        if (detail.value.project.mode === "novel")
          outlineTarget.value = blueprintTarget.value;
        blueprintTarget.value = { level: "section", count: 1 };
        if (taskKind.value === "blueprint")
          taskKind.value =
            detail.value.project.mode === "novel" ? "outline" : "brainstorm";
      }
      if (
        (taskKind.value === "outline" &&
          detail.value.project.mode !== "novel") ||
        taskKind.value === "directions"
      )
        taskKind.value = "brainstorm";
      settingCardId.value = saved.settingCardId;
      checkScope.value = saved.checkScope ?? "current";
      checkChapterIds.value = saved.checkChapterIds ?? [];
      checkAspect.value = saved.checkAspect ?? "continuity";
      checkCharacter.value = saved.checkCharacter ?? "";
      polishAspect.value = saved.polishAspect ?? "expression";
      selection.value = saved.selection ?? null;
      if (
        saved.conversationId &&
        conversations.value.some(
          (c) => c.id === saved.conversationId && c.kind !== "settings",
        )
      )
        await openConversation(saved.conversationId, false);
    } else {
      taskKind.value = "brainstorm";
      instruction.value = "";
      blueprintTarget.value = {
        level: "section",
        count: 1,
      };
      outlineTarget.value = { level: "synopsis", count: 1 };
    }
  }
  async function switchChapter(id: string) {
    if (busy.value) return;
    await flush();
    chapterId.value = id;
    selection.value = null;
    await restoreConversation();
    scratch();
  }
  async function newChapter() {
    if (!detail.value || busy.value || imageBusy.value) return;
    if (creatingChapter) return creatingChapter;
    const pid = detail.value.project.id;
    creatingChapter = (async () => {
      await flush();
      const c = await api<Chapter>("chapter:create", pid);
      if (detail.value?.project.id !== pid) return c;
      if (!detail.value.chapters.some((x) => x.id === c.id))
        detail.value.chapters.push(c);
      chapterId.value = c.id;
      selection.value = null;
      clearConversation();
      scratch();
      return c;
    })();
    try {
      return await creatingChapter;
    } finally {
      creatingChapter = null;
    }
  }
  async function deleteChapter(id: string) {
    if (!detail.value || busy.value || imageBusy.value) return;
    await flush();
    const pid = detail.value.project.id,
      index = detail.value.chapters.findIndex((c) => c.id === id),
      current = chapterId.value === id;
    const d = await api<ProjectDetail>("chapter:delete", {
      projectId: pid,
      id,
    });
    if (detail.value?.project.id !== pid) return;
    detail.value = d;
    if (current) {
      chapterId.value =
        d.chapters[Math.min(index, d.chapters.length - 1)]?.id ?? "";
      selection.value = null;
      clearConversation();
    }
    scratch();
  }

  async function adopt() {
    if (!chapter.value) return;
    await flush();
    await api("chapter:adopt", chapter.value.id);
    await refreshProject();
    notify("已采用本章，可整理正式记忆。");
  }
  function currentTaskRequest(): TaskRequest {
    if (!detail.value) throw new Error("请先打开作品。");
    const base = {
      requestId: crypto.randomUUID(),
      projectId: detail.value.project.id,
      mode: detail.value.project.mode,
      instruction: instruction.value,
      ...(taskModel.value ? { model: taskModel.value } : {}),
    };
    const cid = chapter.value?.id;
    let r: TaskRequest;
    switch (taskKind.value) {
      case "brainstorm":
        r = { ...base, kind: "brainstorm" };
        break;
      case "settings":
        r = {
          ...base,
          kind: "settings",
          ...(settingCardId.value ? { cardId: settingCardId.value } : {}),
        };
        break;
      case "blueprint":
      case "outline": {
        const t =
          taskKind.value === "outline"
            ? outlineTarget.value
            : blueprintTarget.value;
        r = {
          ...base,
          kind: taskKind.value,
          target: {
            level: t.level,
            count: t.count || 1,
            ...(t.id ? { id: t.id } : {}),
            ...(!t.id && t.parentId ? { parentId: t.parentId } : {}),
            ...(!t.id && t.chapterId ? { chapterId: t.chapterId } : {}),
          },
        };
        break;
      }
      case "directions":
        if (!cid) throw new Error("请先选择章节。");
        r = {
          ...base,
          kind: "directions",
          chapterId: cid,
          count: settings.value?.software.directionCount ?? 3,
        };
        break;
      case "check": {
        const scope: CheckScope =
          checkScope.value === "book"
            ? { type: "book" }
            : checkScope.value === "chapters"
              ? { type: "chapters", chapterIds: checkChapterIds.value }
              : { type: "current", chapterId: cid ?? "" };
        r = {
          ...base,
          kind: "check",
          scope,
          aspect: checkAspect.value,
          ...(checkCharacter.value ? { character: checkCharacter.value } : {}),
        };
        break;
      }
      case "polish":
        if (!cid || !selection.value) throw new Error("请先选中要打磨的正文。");
        r = {
          ...base,
          kind: "polish",
          chapterId: cid,
          selection: { ...selection.value },
          aspect: polishAspect.value,
        };
        break;
      case "prompt":
        r = {
          ...base,
          kind: "prompt",
          ...(cid ? { chapterId: cid } : {}),
          ...(selection.value ? { selection: { ...selection.value } } : {}),
        };
        break;
      default:
        if (!cid) throw new Error("请先创建或选择章节。");
        r = { ...base, kind: taskKind.value, chapterId: cid };
    }
    if (activeConversation.value?.key === requestKey(r)) {
      r.conversationId = conversationId.value;
      if (selectedTurn.value?.status === "complete")
        r.parentTurnId = selectedTurnId.value;
    }
    return r;
  }
  async function restoreConversation() {
    if (busy.value || !detail.value) return;
    let request: TaskRequest;
    try {
      request = currentTaskRequest();
    } catch {
      clearConversation();
      return;
    }
    const c = conversations.value.find(
      (c) =>
        c.key === requestKey(request) && c.mode === detail.value!.project.mode,
    );
    if (activeConversation.value?.key === requestKey(request)) return;
    clearConversation();
    if (c) await openConversation(c.id, false);
  }
  async function newConversation() {
    clearConversation();
    scratch();
  }
  async function openConversation(id: string, adjust = true) {
    if (!detail.value) return;
    const ticket = ++conversationLoad,
      pid = detail.value.project.id,
      mode = detail.value.project.mode;
    const d = await api<ConversationDetail>("conversation:get", {
      projectId: pid,
      id,
    });
    if (
      ticket !== conversationLoad ||
      detail.value?.project.id !== pid ||
      detail.value.project.mode !== mode
    )
      return;
    if (!adjust) {
      let key: string;
      try {
        key = requestKey(currentTaskRequest());
      } catch {
        return;
      }
      if (d.conversation.key !== key) return;
    }
    if (d.conversation.mode !== detail.value.project.mode)
      throw new Error("请切换到此对话对应的创作模式。");
    const r = d.conversation.request;
    if (r.kind === "settings")
      throw new Error("完善设定工具已移除，请在资料编辑中使用 AI 提炼。");
    if (adjust) {
      taskKind.value = r.kind;
      taskModel.value = r.model ?? "";
      if ("chapterId" in r && r.chapterId) chapterId.value = r.chapterId;
      if (r.kind === "blueprint") blueprintTarget.value = r.target;
      if (r.kind === "outline") outlineTarget.value = r.target;
      if (r.kind === "polish") {
        selection.value = r.selection;
        polishAspect.value = r.aspect;
      }
      if (r.kind === "check") {
        checkScope.value = r.scope.type;
        checkChapterIds.value =
          r.scope.type === "chapters" ? r.scope.chapterIds : [];
        if (r.scope.type === "current") chapterId.value = r.scope.chapterId;
        checkAspect.value = r.aspect;
        checkCharacter.value = r.character ?? "";
      }
    }
    conversationId.value = d.conversation.id;
    turns.value = d.turns;
    selectedTurnId.value = d.conversation.selectedTurnId ?? "";
    result.value = selectedTurn.value?.result ?? null;
    output.value =
      selectedTurn.value?.result?.text ?? selectedTurn.value?.rawResponse ?? "";
    taskError.value = selectedTurn.value?.error ?? "";
  }
  async function selectVersion(id: string) {
    if (!detail.value) return;
    await api("conversation:select", {
      projectId: detail.value.project.id,
      id: conversationId.value,
      turnId: id,
    });
    await openConversation(conversationId.value, false);
    scratch();
  }
  async function renameConversation(title: string) {
    if (!detail.value) return;
    await api("conversation:rename", {
      projectId: detail.value.project.id,
      id: conversationId.value,
      title,
    });
    conversations.value = await api(
      "conversation:list",
      detail.value.project.id,
    );
  }
  async function deleteConversation() {
    if (!detail.value) return;
    await api("conversation:delete", {
      projectId: detail.value.project.id,
      id: conversationId.value,
    });
    clearConversation();
    conversations.value = await api(
      "conversation:list",
      detail.value.project.id,
    );
    scratch();
  }
  async function chooseTool(kind: TaskKind) {
    if (busy.value || directionsBusy.value) return;
    if (kind === "settings") throw new Error("请在资料编辑中使用 AI 提炼。");
    if (kind === "outline" && detail.value?.project.mode !== "novel")
      throw new Error("大纲规划仅用于长篇模式。");
    taskKind.value = kind;
    await restoreConversation();
    scratch();
  }
  async function runTask(kind?: TaskKind) {
    if (busy.value || directionsBusy.value || !detail.value) return;
    if (kind) taskKind.value = kind;
    busy.value = true;
    taskError.value = "";
    let attemptedKey = "";
    stopRequested = false;
    let done!: () => void;
    finished = new Promise((resolve) => (done = resolve));
    generationProjectId = detail.value.project.id;
    try {
      await flush();
      if (stopRequested) return;
      const r = currentTaskRequest();
      attemptedKey = requestKey(r);
      requestId = r.requestId;
      output.value = "";
      result.value = null;
      const value = await api<{
        conversationId: string;
        turnId: string;
        result: TaskResult;
      }>("ai:run", r);
      if (detail.value?.project.id !== generationProjectId) return;
      conversations.value = await api("conversation:list", generationProjectId);
      await openConversation(value.conversationId, false);
      await refreshProject();
    } catch (e) {
      const error = (e as Error).message;
      const list = await api<CreationConversation[]>(
        "conversation:list",
        generationProjectId,
      ).catch(() => []);
      if (detail.value?.project.id === generationProjectId) {
        conversations.value = list;
        const c = list.find((c) => c.key === attemptedKey);
        if (c) await openConversation(c.id, false).catch(() => {});
        taskError.value = error;
      }
    } finally {
      busy.value = false;
      requestId = "";
      scratch();
      done();
    }
  }
  async function stopTask() {
    stopRequested = true;
    if (requestId) await api("ai:cancel", requestId);
  }
  async function applyChanges(
    id: string,
    changes: { id: string; after: string; title?: string }[],
  ) {
    if (!detail.value) return;
    const pid = detail.value.project.id;
    const original = changeSets.value.find((s) => s.id === id);
    const directionChapterIds =
      original && ["opening", "continue"].includes(original.kind)
        ? original.changes
            .filter(
              (c) =>
                !c.applied &&
                changes.some((i) => i.id === c.id) &&
                c.target.type === "prose",
            )
            .map((c) => (c.target.type === "prose" ? c.target.chapterId : ""))
        : [];
    await flush();
    const value = await api<{ detail: ProjectDetail; changeSet: ChangeSet }>(
      "changes:apply",
      { projectId: detail.value.project.id, id, changes },
    );
    if (detail.value?.project.id !== pid) return value.changeSet;
    detail.value = value.detail;
    changeSets.value = changeSets.value.map((s) =>
      s.id === id ? value.changeSet : s,
    );
    notify("修改已采用。");
    if (value.detail.project.mode === "explore") {
      // The prose transaction has committed. Direction failures must not fail or roll it back.
      for (const cid of new Set(directionChapterIds))
        void generateDirections(cid, id);
    }
    return value.changeSet;
  }
  async function generateDirections(cid: string, triggerChangeSetId?: string) {
    if (
      !detail.value ||
      busy.value ||
      directionsBusy.value ||
      detail.value.project.mode !== "explore"
    )
      return;
    const pid = detail.value.project.id;
    directionsBusy.value = true;
    directionsChapterId.value = cid;
    directionStopped = false;
    directionsError.value = "";
    let done!: () => void;
    directionFinished = new Promise((resolve) => (done = resolve));
    directionRequestId = crypto.randomUUID();
    try {
      await flush();
      if (directionStopped) return;
      const r: TaskRequest = {
        requestId: directionRequestId,
        projectId: pid,
        mode: "explore",
        kind: "directions",
        chapterId: cid,
        count: settings.value?.software.directionCount ?? 3,
        instruction: "请根据审核写入后的当前章生成下一章走向。",
        ...(taskModel.value ? { model: taskModel.value } : {}),
        ...(triggerChangeSetId ? { triggerChangeSetId } : {}),
      };
      await api("ai:run", r);
      await api("ui:save", {
        projectId: pid,
        key: "direction-draft." + cid,
        value: null,
      });
    } catch (e) {
      if (detail.value?.project.id === pid)
        directionsError.value = (e as Error).message;
    } finally {
      directionRequestId = "";
      directionsBusy.value = false;
      directionsEpoch.value++;
      done();
    }
  }
  async function stopDirections() {
    directionStopped = true;
    if (directionRequestId) await api("ai:cancel", directionRequestId);
  }
  function saveDirectionDraft(cid: string, value: unknown) {
    if (!detail.value) return;
    const pid = detail.value.project.id;
    enqueue("direction-draft:" + pid + ":" + cid, "ui:save", {
      projectId: pid,
      key: "direction-draft." + cid,
      value,
    });
  }
  async function createExplorationChapter(cid: string, view: DirectionView) {
    if (!detail.value || busy.value || directionsBusy.value || creatingChapter)
      return;
    const pid = detail.value.project.id;
    const navigation = projectLoad;
    const current = () =>
      navigation === projectLoad && detail.value?.project.id === pid;
    creatingChapter = (async () => {
      await flush();
      if (!current()) return;
      const c = await api<Chapter>("exploration:create-next", {
        projectId: pid,
        chapterId: cid,
        sourceFingerprint: view.sourceFingerprint,
        basis: view.basis,
      });
      if (!current()) return;
      await refreshProject();
      if (!current()) return;
      chapterId.value = c.id;
      selection.value = null;
      instruction.value = "";
      clearConversation();
      taskKind.value = "opening";
      scratch();
      await runTask();
      return c;
    })();
    try {
      return await creatingChapter;
    } finally {
      creatingChapter = null;
    }
  }
  async function requestClose() {
    if (closingWindow.value) return;
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
        await finished;
      }
      if (action === "quit" && directionsBusy.value) {
        await stopDirections();
        await directionFinished;
      }
      scratch();
      await flush();
      await api(action === "minimize" ? "window:hide" : "window:close");
      closePrompt.value = false;
    } finally {
      closingWindow.value = false;
    }
  }
  async function setModel(kind: "text" | "image", model: string) {
    await flush();
    settings.value = await api<Settings>("settings:model", { kind, model });
  }
  async function saveCard(card: CardInput) {
    await flush();
    const value = await api<Card>("card:save", card);
    await bootstrap();
    if (detail.value) await refreshProject();
    return value;
  }
  async function deleteCard(id: string) {
    const value = await api<Card>("card:delete", id);
    cards.value = cards.value.filter((c) => c.id !== id);
    if (detail.value)
      detail.value.cards = detail.value.cards.filter((c) => c.id !== id);
    notify(`「${value.name}」已删除。`);
    return value;
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
    const p = await api<Project>("project:create", value);
    await bootstrap();
    return p;
  }
  async function saveProjectCover(
    projectId: string,
    source:
      { upload: CoverUpload } | { imageId: string; crop: CoverCrop } | null,
  ) {
    await flush();
    const p = await api<Project>(
      source ? "project:cover:save" : "project:cover:remove",
      source ? { projectId, source } : projectId,
    );
    projects.value = projects.value.map((x) => (x.id === p.id ? p : x));
    if (detail.value?.project.id === p.id) detail.value.project = p;
    return p;
  }
  const imageUrl = (id: string) => "story-asset://asset/" + id;
  function initializeListeners() {
    window.storybook.onProgress((e) => {
      if (
        e.requestId === requestId &&
        detail.value?.project.id === generationProjectId
      ) {
        output.value += e.delta;
        if (e.conversationId) conversationId.value = e.conversationId;
        if (e.turnId) selectedTurnId.value = e.turnId;
      }
    });
    window.storybook.onClosing(
      (a) =>
        void safe(a === "quit" ? () => confirmClose("quit") : requestClose),
    );
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
    taskModel,
    instruction,
    output,
    taskError,
    selection,
    blueprintTarget,
    outlineTarget,
    planningNodeId,
    directionsBusy,
    directionsChapterId,
    directionsError,
    directionsEpoch,
    settingCardId,
    checkScope,
    checkChapterIds,
    checkAspect,
    checkCharacter,
    polishAspect,
    conversations,
    conversationId,
    turns,
    selectedTurnId,
    selectedTurn,
    activeConversation,
    result,
    changeSets,
    reviewingChangeId,
    closePrompt,
    closingWindow,
    toast,
    api,
    notify,
    safe,
    flush,
    bootstrap,
    editProject,
    editChapter,
    renameChapter,
    editSettings,
    editSoftwareSettings,
    scratch,
    refreshProject,
    openProject,
    switchChapter,
    newChapter,
    deleteChapter,
    adopt,
    currentTaskRequest,
    restoreConversation,
    newConversation,
    openConversation,
    selectVersion,
    renameConversation,
    deleteConversation,
    chooseTool,
    runTask,
    stopTask,
    applyChanges,
    generateDirections,
    stopDirections,
    saveDirectionDraft,
    createExplorationChapter,
    requestClose,
    confirmClose,
    setModel,
    saveCard,
    deleteCard,
    createProject,
    saveProjectCover,
    imageUrl,
    initializeListeners,
  };
});
