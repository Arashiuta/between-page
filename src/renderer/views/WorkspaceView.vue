<script setup lang="ts">
import { ref, watch, computed, h, nextTick } from "vue";
import { useRoute } from "vue-router";
import {
  NInput,
  NButton,
  NModal,
  NSelect,
  NPopconfirm,
  NDropdown,
} from "naive-ui";
import {
  ChevronRight,
  Plus,
  FileText,
  Check,
  History,
  Download,
  BookOpen,
  Map,
  Users,
  NotebookPen,
  Images,
  Feather,
  ArrowUpRight,
  AlertCircle,
  MoreHorizontal,
  Copy,
  Archive,
  RotateCcw,
  CheckCheck,
  Trash2,
  ArrowUp,
  ArrowDown,
  Pencil,
  Sparkles,
} from "lucide-vue-next";
import StoryEditor from "../components/StoryEditor.vue";
import CardEditor from "../components/CardEditor.vue";
import ImagePanel from "../components/ImagePanel.vue";
import WorkbenchPanel from "../components/WorkbenchPanel.vue";
import DevelopmentReview from "../components/DevelopmentReview.vue";
import ChapterTitleDialog from "../components/ChapterTitleDialog.vue";
import { useWorkspace } from "../stores/workspace";
import type {
  Card,
  Chapter,
  Revision,
  MemoryKind,
  Memory,
  PlanningTarget,
  ProjectDetail,
} from "../../shared/types";
import { memoryLabels } from "../../shared/types";
import { wordCount } from "../../shared/document";
import { applyBlueprintContent } from "../../shared/blueprint";
import CoverEditor from "../components/CoverEditor.vue";
import NovelPlanner from "../components/NovelPlanner.vue";
import FragmentShelf from "../components/FragmentShelf.vue";
import ItemActions from "../components/ItemActions.vue";
import VersionActions from "../components/VersionActions.vue";
const planningEntry = ref<PlanningTarget["level"]>();
function navigateWorkspace(value: string, level?: PlanningTarget["level"]) {
  planningEntry.value = level;
  tab.value = value;
}
const coverEditor = ref(false);
const store = useWorkspace(),
  route = useRoute(),
  tab = ref("text"),
  loading = ref(true),
  editor = ref<InstanceType<typeof StoryEditor> | null>(null);
const cardModal = ref(false),
  editingCard = ref<Card | null>(null),
  revisionModal = ref(false),
  revisions = ref<Revision[]>([]),
  viewRevision = ref<Revision | null>(null);
const cardToDelete = ref<Pick<Card, "id" | "name" | "projectId"> | null>(null);
const cardToLibrary = ref<Pick<Card, "id" | "name" | "projectId"> | null>(null);
const deletingCard = ref(false);
const copyingCard = ref(false);
const memoryModal = ref(false),
  memoryKind = ref<MemoryKind>("fact"),
  memoryText = ref(""),
  showRetired = ref(false),
  imagePrompt = ref(""),
  confirmApply = ref<null | "replace" | "outline">(null);
const editingMemoryId = ref("");
const memoryToDelete = ref<Memory | null>(null);
function openMemory(memory?: Memory) {
  editingMemoryId.value = memory?.id ?? "";
  memoryKind.value = memory?.kind ?? "fact";
  memoryText.value = memory?.content ?? "";
  memoryModal.value = true;
}
const chapterPlanToClear = ref<Chapter | null>(null);
const removingMemory = ref(false),
  clearingChapterPlan = ref(false);
async function confirmDeleteMemory() {
  const target = memoryToDelete.value,
    projectId = store.detail?.project.id;
  if (!target || !projectId || removingMemory.value) return false;
  removingMemory.value = true;
  const removed = await store.safe(async () => {
    await store.flush();
    const detail = await store.api<ProjectDetail>("memory:delete", {
      projectId,
      id: target.id,
    });
    if (store.detail?.project.id === projectId) store.detail = detail;
    return true;
  });
  removingMemory.value = false;
  if (removed) memoryToDelete.value = null;
  return false;
}
async function confirmClearChapterPlan() {
  const target = chapterPlanToClear.value,
    projectId = store.detail?.project.id;
  if (!target || !projectId || clearingChapterPlan.value) return false;
  clearingChapterPlan.value = true;
  const removed = await store.safe(async () => {
    await store.flush();
    if (store.detail?.project.id !== projectId) return false;
    await store.removePlanning({ level: "chapter", id: target.id });
    return true;
  });
  clearingChapterPlan.value = false;
  if (removed) chapterPlanToClear.value = null;
  return false;
}
const importKind = ref<"all" | "character" | "world">("all");
const chapterMenu = ref({ id: "", x: 0, y: 0, show: false });
const chapterToRename = ref("");
const generateChapterName = ref(false);
const chapterToDelete = ref<Pick<
  Chapter,
  "id" | "title" | "acceptedRevisionId" | "kind"
> | null>(null);
const deletingChapter = ref(false);
const chapterMenuOptions = computed(() => [
  {
    key: "clear-plan",
    label: "清空章纲，保留正文和细纲",
    disabled: store.busy || store.imageBusy,
  },
  {
    key: "up",
    label: "章节上移",
    disabled:
      store.busy || store.detail?.chapters[0]?.id === chapterMenu.value.id,
  },
  {
    key: "down",
    label: "章节下移",
    disabled:
      store.busy || store.detail?.chapters.at(-1)?.id === chapterMenu.value.id,
  },
  {
    key: "rename",
    label: "编辑名称",
    icon: () => h(Pencil, { size: 15 }),
    disabled: deletingChapter.value,
  },
  {
    key: "generate-title",
    label: "AI 生成名称",
    icon: () => h(Sparkles, { size: 15 }),
    disabled:
      store.busy ||
      store.imageBusy ||
      deletingChapter.value ||
      !store.detail?.chapters.some(
        (item) =>
          item.id === chapterMenu.value.id &&
          (item.content.trim() || item.plan.trim()),
      ),
  },
  {
    key: "delete",
    label: "删除章节",
    icon: () => h(Trash2, { size: 15 }),
    props: { style: { color: "var(--danger)" } },
    disabled: store.busy || store.imageBusy || deletingChapter.value,
  },
]);
function openChapterMenu(event: MouseEvent, chapter: Chapter) {
  chapterMenu.value = {
    id: chapter.id,
    x: event.clientX,
    y: event.clientY,
    show: true,
  };
}
function selectChapterMenu(key: string) {
  const chapter = store.detail?.chapters.find(
    (item) => item.id === chapterMenu.value.id,
  );
  chapterMenu.value.show = false;
  if (key === "clear-plan" && chapter) chapterPlanToClear.value = chapter;
  if (key === "up" || key === "down")
    void store.safe(async () => {
      await store.flush();
      const ids = store.detail!.chapters.map((c) => c.id),
        i = ids.indexOf(chapterMenu.value.id),
        next = i + (key === "up" ? -1 : 1);
      if (i < 0 || next < 0 || next >= ids.length) return;
      [ids[i], ids[next]] = [ids[next], ids[i]];
      store.detail = await store.api("chapter:reorder", {
        projectId: store.detail!.project.id,
        ids,
      });
    });
  if ((key === "rename" || key === "generate-title") && chapter) {
    generateChapterName.value = key === "generate-title";
    chapterToRename.value = chapter.id;
  }
  if (key === "delete" && chapter)
    chapterToDelete.value = {
      id: chapter.id,
      title: chapter.title,
      acceptedRevisionId: chapter.acceptedRevisionId,
    };
}
async function confirmDeleteChapter() {
  const target = chapterToDelete.value;
  if (!target || deletingChapter.value) return false;
  deletingChapter.value = true;
  const deleted = await store.safe(async () => {
    await store.deleteChapter(target.id);
    return true;
  });
  deletingChapter.value = false;
  if (deleted) chapterToDelete.value = null;
  return false;
}
const importOptions = [
  { value: "all", label: "全部" },
  { value: "character", label: "OC" },
  { value: "world", label: "世界观" },
] as const;
const candidateTargets = ref<Record<string, string>>({});
async function deleteCandidate(id: string) {
  await store.flush();
  const candidate = store.detail!.project.blueprintCandidates.find(
    (c) => c.id === id,
  );
  store.editProject({
    blueprintCandidates: store.detail!.project.blueprintCandidates.filter(
      (c) => c.id !== id,
    ),
  });
  if (
    candidate?.development?.id === store.developmentDraft?.id &&
    !candidate?.turnId
  ) {
    store.developmentDraft = null;
    store.reviewingDevelopment = false;
    store.output = "";
    store.scratch();
  }
  if (candidatePreview.value?.candidateId === id) candidatePreview.value = null;
  delete candidateTargets.value[id];
  await store.flush();
  store.notify("候选已删除，已采用的内容保留。");
}
const candidatePreview = ref<{ candidateId: string; sectionId: string } | null>(
  null,
);
const candidatePreviewData = computed(() => {
  if (!candidatePreview.value || !store.detail) return null;
  return {
    candidate:
      store.detail.project.blueprintCandidates.find(
        (item) => item.id === candidatePreview.value!.candidateId,
      ) || null,
    section:
      store.detail.project.blueprintSections.find(
        (item) => item.id === candidatePreview.value!.sectionId,
      ) || null,
  };
});
const importCards = computed(() =>
  store.cards.filter(
    (card) =>
      card.kind !== "inspiration" &&
      (importKind.value === "all" || card.kind === importKind.value),
  ),
);
const tabs = computed(() => {
  const blueprintTab = { key: "outline", label: "故事蓝图", icon: Map };
  const textTab = { key: "text", label: "章节正文", icon: FileText };
  return [
    ...(store.detail?.project.mode === "novel"
      ? [
          { key: "overview", label: "作品概览", icon: BookOpen },
          blueprintTab,
          { key: "planning", label: "总纲与章节规划", icon: Map },
          textTab,
        ]
      : [textTab, blueprintTab]),
    { key: "fragments", label: "探索片段", icon: Feather },
    { key: "cards", label: "世界与人物", icon: Users },
    { key: "memory", label: "故事记忆", icon: NotebookPen },
    { key: "images", label: "故事插画", icon: Images },
  ];
});
const filteredMemories = computed(
  () =>
    store.detail?.memories.filter((m) => showRetired.value || m.active) || [],
);
watch(tab, () => {
  chapterMenu.value.show = false;
});
watch(
  () => route.params.id,
  async (id) => {
    chapterMenu.value.show = false;
    chapterToDelete.value = null;
    chapterToRename.value = "";
    cardToDelete.value = null;
    cardToLibrary.value = null;
    loading.value = true;
    await store.safe(() => store.openProject(String(id)));
    tab.value = store.detail?.project.mode === "novel" ? "overview" : "text";
    loading.value = false;
  },
  { immediate: true },
);
watch(
  () => store.detail?.project.mode,
  (mode, previous) => {
    if (previous && mode !== previous) {
      tab.value = mode === "novel" ? "overview" : "text";
      store.planningTarget = undefined;
    }
  },
);
async function showHistory() {
  await store.safe(async () => {
    await store.flush();
    revisions.value = await store.api<Revision[]>(
      "chapter:revisions",
      store.chapter!.id,
    );
    revisionModal.value = true;
  });
}
async function restore(revision: Revision) {
  await store.safe(async () => {
    await store.flush();
    await store.api("chapter:restore", revision.id);
    await store.refreshProject();
    revisionModal.value = false;
    store.notify("已恢复到草稿，采用版本未改变。");
  });
}
async function saveSnapshot() {
  await store.safe(async () => {
    await store.flush();
    await store.api("chapter:checkpoint", {
      id: store.chapter!.id,
      label: "手动快照",
    });
    store.notify("已保存一个可恢复的版本。");
  });
}
function editCard(card: Card | null) {
  editingCard.value = card;
  cardModal.value = true;
}
async function addSettingTemplate(kind: "character" | "world") {
  const titles =
    kind === "character"
      ? ["目标与动机", "关系与矛盾", "人物弧线", "能力与边界", "外貌与表达习惯"]
      : [
          "基本世界规则",
          "能力体系与代价",
          "势力与冲突",
          "地理与重要地点",
          "历史与秘密",
        ];
  const card = await store.saveCard({
    projectId: store.detail!.project.id,
    kind,
    name: kind === "character" ? "待完善的主要人物" : "待完善的世界设定",
    description: "",
    constraints: "",
    sections: titles.map((title) => ({
      id: crypto.randomUUID(),
      title,
      content: "",
      alwaysInclude: false,
      sourceIds: [],
    })),
    documents: [],
    referenceIds: [],
  });
  editCard(card);
}
async function confirmDeleteCard() {
  const target = cardToDelete.value;
  if (!target || deletingCard.value || store.busy || store.imageBusy)
    return false;
  if (target.projectId !== store.detail?.project.id) return false;
  deletingCard.value = true;
  const deleted = await store.safe(async () => {
    await store.deleteCard(target.id);
    return true;
  });
  deletingCard.value = false;
  if (deleted) {
    cardToDelete.value = null;
    if (editingCard.value?.id === target.id) {
      editingCard.value = null;
      cardModal.value = false;
    }
  }
  return false;
}
async function confirmCopyCard() {
  const target = cardToLibrary.value;
  if (!target || copyingCard.value) return false;
  if (target.projectId !== store.detail?.project.id) return false;
  copyingCard.value = true;
  const copied = await store.safe(async () => {
    await store.api("card:copy", { id: target.id, projectId: null });
    await store.bootstrap();
    store.notify(`已将「${target.name}」作为新资料存入资料库。`);
    return true;
  });
  copyingCard.value = false;
  if (copied) cardToLibrary.value = null;
  return false;
}
async function addMemory() {
  await store.safe(async () => {
    await store.flush();
    await store.api(editingMemoryId.value ? "memory:update" : "memory:add", {
      ...(editingMemoryId.value ? { id: editingMemoryId.value } : {}),
      projectId: store.detail!.project.id,
      kind: memoryKind.value,
      content: memoryText.value,
    });
    await store.refreshProject();
    memoryModal.value = false;
    memoryText.value = "";
    store.notify("记忆记录已保存，原有来源与有效性规则保留。");
  });
}
async function applyCandidate(
  id: string,
  sectionId: string,
  replace = false,
  confirmed = false,
) {
  const project = store.detail!.project;
  const candidate = project.blueprintCandidates.find((item) => item.id === id);
  const section = project.blueprintSections.find(
    (item) => item.id === sectionId,
  );
  if (!candidate || !section) return;
  if (replace && section.content.trim() && !confirmed) return;
  if (candidate.turnId)
    await store.api("conversation:check-application", {
      projectId: project.id,
      id: candidate.turnId,
    });
  store.editProject({
    blueprintSections: applyBlueprintContent(
      project.blueprintSections,
      sectionId,
      candidate.content,
      replace ? "replace" : "append",
    ),
  });
  await store.flush();
  if (candidate.turnId)
    await store.markVersionApplied(
      candidate.turnId,
      `已写入蓝图分区「${section.title}」`,
    );
  store.notify(
    replace
      ? `已替换「${section.title}」分区。`
      : `已追加到「${section.title}」分区。`,
  );
}
async function confirmCandidateReplacement() {
  const preview = candidatePreview.value;
  if (!preview) return;
  await applyCandidate(preview.candidateId, preview.sectionId, true, true);
  candidatePreview.value = null;
}
function moveBlueprintSection(index: number, direction: -1 | 1) {
  const sections = [...store.detail!.project.blueprintSections];
  const target = index + direction;
  if (target < 0 || target >= sections.length) return;
  [sections[index], sections[target]] = [sections[target], sections[index]];
  store.editProject({ blueprintSections: sections });
}
function addBlueprintSection() {
  const project = store.detail?.project;
  if (!project) return;
  store.editProject({
    blueprintSections: [
      ...project.blueprintSections,
      { id: crypto.randomUUID(), title: "新分区", content: "" },
    ],
  });
}
function chooseTool(kind: "opening" | "chapter" | "develop" | "adjust") {
  store.taskKind = kind;
  store.planningTarget = undefined;
  store.instruction = "";
  store.scratch();
}
async function writeNextChapter() {
  if (store.busy) return;
  tab.value = "text";
  chooseTool("chapter");
  await store.runTask("chapter", {
    newChapter: true,
    instruction: "接着此前的故事写下一章，按创作自由度安排新的行动与遭遇。",
  });
}
async function apply(
  mode: "replace" | "append" | "outline" | "selection" | "prompt",
  confirmed = false,
) {
  const content = store.output,
    versionId = store.selectedTurnId;
  const targetChapterId = store.outputChapterId,
    source = store.sourceContent;
  const sourceSelection = store.outputSelection
    ? { ...store.outputSelection }
    : null;
  const outputScope = store.outputScope,
    resultType = store.resultType;
  if (
    store.selectedTurn &&
    (store.selectedTurn.status !== "complete" ||
      store.conversationInvalidReason ||
      store.selectedTurn.invalidReason)
  ) {
    store.notify(
      store.conversationInvalidReason ||
        store.selectedTurn.invalidReason ||
        "请选择已完成的版本后采用。",
      "info",
    );
    return;
  }
  if (store.resultType === "analysis" || store.resultType === "planning") {
    store.notify("这份结果需要在对应的建议或规划区域处理。", "info");
    return;
  }
  if (mode === "prompt") {
    imagePrompt.value = content;
    tab.value = "images";
    if (versionId)
      await store.markVersionApplied(versionId, "已送入插画提示词");
    return;
  }
  if (!store.output.trim()) return;
  if (mode === "outline") {
    const section = store.detail!.project.blueprintSections.find(
      (item) => item.title === "整体蓝图",
    );
    if (section?.content.trim() && !confirmed) {
      confirmApply.value = "outline";
      return;
    }
    const sections = store.detail!.project.blueprintSections;
    const target = section || {
      id: crypto.randomUUID(),
      title: "整体蓝图",
      content: "",
    };
    store.editProject({
      outline: "",
      blueprintSections: section
        ? sections.map((item) =>
            item.id === target.id ? { ...item, content } : item,
          )
        : [...sections, { ...target, content }],
    });
    tab.value = "outline";
    await store.flush();
    if (versionId) await store.markVersionApplied(versionId, "已写入故事蓝图");
    store.notify("创作结果已写入可编辑蓝图。");
    return;
  }
  if (!store.chapter || targetChapterId !== store.chapter.id) {
    store.notify("这份结果属于另一个章节，请切回对应章节后使用。", "info");
    return;
  }
  if (
    resultType === "rewrite" &&
    outputScope === "document" &&
    store.chapter.content !== source
  ) {
    store.notify(
      "原文已经变化，请重新生成改写稿，避免覆盖后来的编辑。",
      "error",
    );
    return;
  }
  if (mode === "replace" && store.chapter.content.trim() && !confirmed) {
    confirmApply.value = "replace";
    return;
  }
  tab.value = "text";
  await nextTick();
  await store.safe(async () => {
    await store.flush();
    if (!store.chapter || store.chapter.id !== targetChapterId)
      throw new Error("目标章节已切换，请回到原章节后采用。");
    await store.api("chapter:checkpoint", {
      id: store.chapter!.id,
      label: "写入 AI 草稿前",
    });
    if (!store.chapter || store.chapter.id !== targetChapterId)
      throw new Error("目标章节已切换，请回到原章节后采用。");
    if (
      resultType === "rewrite" &&
      outputScope === "document" &&
      store.chapter.content !== source
    )
      throw new Error("原文已经变化，请重新生成改写稿。");
    if (mode === "selection") {
      if (
        !sourceSelection ||
        !editor.value?.replaceSelected(sourceSelection, content)
      )
        throw new Error("选中文段已经发生变化，请重新选择并改写。");
    } else if (mode === "replace") editor.value?.replace(content);
    else editor.value?.append(content);
    await store.flush();
    if (versionId)
      await store.markVersionApplied(
        versionId,
        mode === "append"
          ? "已追加到章节草稿"
          : mode === "selection"
            ? "已替换选中文段"
            : "已替换章节草稿",
      );
    store.notify("已写入章节草稿。满意后可采用并整理记忆。");
  });
}
async function viewSource(revisionId: string | null) {
  if (!revisionId) return;
  await store.safe(async () => {
    const chapters = store.detail!.chapters;
    for (const chapter of chapters) {
      const list = await store.api<Revision[]>("chapter:revisions", chapter.id);
      const found = list.find((r) => r.id === revisionId);
      if (found) {
        viewRevision.value = found;
        return;
      }
    }
  });
}
</script>
<template>
  <div v-if="loading" class="startup-error">
    <Feather :size="27" />
    <p>正在加载…</p>
  </div>
  <div v-else-if="store.detail" class="workspace-page">
    <header class="workspace-header">
      <div class="breadcrumbs">
        <RouterLink to="/">故事书架</RouterLink
        ><ChevronRight :size="13" /><span>{{
          store.detail.project.title
        }}</span>
      </div>
      <div class="workspace-title-row">
        <div class="workspace-title">
          <h1>{{ store.detail.project.title }}</h1>
          <button class="button small-button" @click="coverEditor = true">
            <Images :size="14" />{{
              store.detail.project.cover ? "调整封面" : "上传封面"
            }}
          </button>
          <span class="mode-badge"
            ><Feather
              v-if="store.detail.project.mode === 'explore'"
              :size="12"
            /><BookOpen v-else :size="12" />{{
              store.detail.project.mode === "explore" ? "自由探索" : "长篇创作"
            }}</span
          >
        </div>
        <button
          class="button small-button"
          @click="
            store.safe(async () => {
              await store.flush();
              const path = await store.api(
                'project:export',
                store.detail!.project.id,
              );
              if (path) store.notify('正文已导出。');
            })
          "
        >
          <Download :size="14" />导出正文
        </button>
      </div>
      <div class="workspace-tabs" role="tablist" aria-label="故事工作区">
        <button
          v-for="item in tabs"
          :key="item.key"
          :class="{ active: tab === item.key }"
          @click="tab = item.key"
        >
          <component :is="item.icon" :size="15" />{{ item.label }}
        </button>
      </div>
    </header>
    <CoverEditor v-model:show="coverEditor" :project="store.detail.project" />
    <div class="workspace-body">
      <div class="writing-area">
        <NovelPlanner
          v-if="tab === 'overview'"
          overview
          @navigate="navigateWorkspace"
        />
        <NovelPlanner
          v-else-if="tab === 'planning'"
          :entry="planningEntry"
          @navigate="navigateWorkspace"
        />
        <FragmentShelf v-else-if="tab === 'fragments'" @write="tab = 'text'" />
        <template v-else-if="tab === 'text'"
          ><aside class="chapter-list" @scroll="chapterMenu.show = false">
            <div class="chapter-list-heading">
              <span>故事章节</span
              ><button
                class="icon-button"
                aria-label="新增章节"
                @click="store.safe(store.newChapter)"
              >
                <Plus :size="16" />
              </button>
            </div>
            <div
              v-for="chapter in store.detail.chapters"
              :key="chapter.id"
              class="chapter-row"
            >
              <button
                :class="[
                  'chapter-item',
                  { active: chapter.id === store.chapterId },
                ]"
                @click="store.safe(() => store.switchChapter(chapter.id))"
                @contextmenu.prevent="openChapterMenu($event, chapter)"
              >
                <FileText :size="14" />
                <div>
                  <span>{{ chapter.title }}</span
                  ><small
                    >{{ wordCount(chapter.content) }} 字
                    <span v-if="chapter.needsReview" class="review-dot"
                      >· 待复核</span
                    ><span
                      v-else-if="chapter.acceptedRevisionId && !chapter.dirty"
                      >· 已采用</span
                    ></small
                  >
                </div></button
              ><ItemActions
                :label="chapter.title"
                :disabled="store.busy || store.imageBusy"
                :actions="
                  chapterMenuOptions.map((item) => ({
                    ...item,
                    disabled:
                      item.key === 'up'
                        ? store.busy ||
                          chapter.id === store.detail!.chapters[0]?.id
                        : item.key === 'down'
                          ? store.busy ||
                            chapter.id === store.detail!.chapters.at(-1)?.id
                          : item.disabled,
                  }))
                "
                @edit="
                  chapterMenu.id = chapter.id;
                  selectChapterMenu('rename');
                "
                @action="
                  (key) => {
                    chapterMenu.id = chapter.id;
                    selectChapterMenu(key);
                  }
                "
              />
            </div>
            <button class="add-chapter" @click="store.safe(store.newChapter)">
              <Plus :size="14" />写下一章
            </button>
            <div class="chapter-count">
              共 {{ store.detail.chapters.length }} 章 ·
              {{
                store.detail.chapters
                  .reduce((n, c) => n + wordCount(c.content), 0)
                  .toLocaleString()
              }}
              字
            </div>
            <button
              class="add-chapter"
              :disabled="store.busy"
              @click="
                store.safe(async () => {
                  await store.newFragment();
                })
              "
            >
              跳写一个片段
            </button>
            <div
              v-for="fragment in store.detail.fragments"
              :key="fragment.id"
              class="chapter-row"
            >
              <button
                class="chapter-item"
                :class="{ active: fragment.id === store.chapterId }"
                @click="store.safe(() => store.switchChapter(fragment.id))"
              >
                <Feather :size="14" /><span
                  >{{ fragment.title }} · 片段</span
                ></button
              ><ItemActions
                :label="fragment.title"
                :disabled="store.busy || store.imageBusy"
                @edit="store.safe(() => store.switchChapter(fragment.id))"
                @action="chapterToDelete = fragment"
              />
            </div>
            <button class="add-chapter" @click="tab = 'fragments'">
              整理与编入片段
            </button>
          </aside>
          <NDropdown
            trigger="manual"
            placement="bottom-start"
            :show="chapterMenu.show"
            :x="chapterMenu.x"
            :y="chapterMenu.y"
            :options="chapterMenuOptions"
            @select="selectChapterMenu"
            @clickoutside="chapterMenu.show = false"
            @update:show="
              (value) => {
                if (!value) chapterMenu.show = false;
              }
            "
          />
          <section v-if="store.chapter" class="chapter-main">
            <div v-if="store.chapter.planningReview" class="review-banner">
              <span
                >{{
                  store.chapter.planningReview
                }}
                正文和正式记忆仍然保留。</span
              ><NButton
                size="tiny"
                @click="
                  store.safe(async () => {
                    await store.flush();
                    store.detail = await store.api('planning:acknowledge', {
                      projectId: store.detail!.project.id,
                      chapterId: store.chapter!.id,
                    });
                  })
                "
                >已核对规划影响</NButton
              >
            </div>
            <div v-if="store.chapter.needsReview" class="review-banner">
              <AlertCircle :size="15" /><span
                >前面的章节已更新，请复核这一章后重新采用。相关自动记忆已停用。</span
              >
            </div>
            <div class="chapter-heading">
              <div class="chapter-topline">
                <span class="small-label"
                  >{{
                    store.chapter.kind === "fragment" ? "FRAGMENT" : "CHAPTER"
                  }}
                  {{
                    store.chapter.kind === "fragment"
                      ? "独立探索片段"
                      : String(store.chapter.position).padStart(2, "0")
                  }}</span
                >
                <div>
                  <button
                    class="icon-button"
                    aria-label="保存版本快照"
                    title="保存版本快照"
                    @click="saveSnapshot"
                  >
                    <Copy :size="15" /></button
                  ><button
                    class="icon-button"
                    aria-label="版本记录"
                    title="版本记录"
                    @click="showHistory"
                  >
                    <History :size="16" />
                  </button>
                </div>
              </div>
              <input
                class="chapter-title-input"
                aria-label="章节标题"
                :value="store.chapter.title"
                @input="
                  store.editChapter({
                    title: ($event.target as HTMLInputElement).value,
                  })
                "
              />
              <div class="chapter-metadata">
                <span
                  >{{
                    wordCount(store.chapter.content).toLocaleString()
                  }}
                  字</span
                ><span>·</span
                ><span>{{
                  store.chapter.dirty ? "正在编辑的草稿" : "已采用的章节"
                }}</span>
              </div>
              <div class="chapter-plan">
                <span>{{
                  store.chapter.kind === "fragment"
                    ? "片段构想（可选）"
                    : store.detail.project.mode === "novel"
                      ? "本章章纲（可在规划页确认）"
                      : "本章计划（可选）"
                }}</span
                ><NInput
                  :value="store.chapter.plan"
                  @update:value="store.editChapter({ plan: $event })"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 5 }"
                  placeholder="可以留空让故事自然发展，也可指定这一章的目标、转折和结束位置。"
                  :bordered="false"
                />
              </div>
            </div>
            <div
              v-if="store.chapter.kind === 'fragment'"
              class="fragment-context"
            >
              <p class="field-help">
                独立片段不进入正式记忆。选择参考锚点后，AI
                只参考锚点以前的正文事实；不选择则独立构思。
              </p>
              <div class="form-two-columns">
                <label
                  v-for="field in [
                    'time',
                    'place',
                    'viewpoint',
                    'connection',
                  ] as const"
                  :key="field"
                  class="field-label"
                  >{{
                    {
                      time: "时间",
                      place: "地点",
                      viewpoint: "视角",
                      connection: "衔接说明",
                    }[field]
                  }}<NInput
                    :value="store.chapter.fragmentContext?.[field] ?? ''"
                    placeholder="可留空，按需补充"
                    @update:value="
                      (value) =>
                        store.editChapter({
                          fragmentContext: {
                            time: '',
                            place: '',
                            viewpoint: '',
                            connection: '',
                            ...store.chapter!.fragmentContext,
                            [field]: value,
                          },
                        })
                    "
                /></label>
              </div>
              <NSelect
                :value="store.chapter.fragmentContext?.anchorId ?? null"
                clearable
                :options="
                  store.detail.chapters.map((c) => ({
                    label: `从 ${c.title} 的处境出发`,
                    value: c.id,
                  }))
                "
                placeholder="不参考正式章节"
                @update:value="
                  (value) =>
                    store.editChapter({
                      fragmentContext: {
                        time: '',
                        place: '',
                        viewpoint: '',
                        connection: '',
                        ...store.chapter!.fragmentContext,
                        anchorId: value ?? undefined,
                      },
                    })
                "
              />
            </div>
            <section
              v-if="
                !store.chapter.content.trim() &&
                !store.detail.chapters.some((chapter) => chapter.content.trim())
              "
              class="story-quick-start"
            >
              <h3>
                {{
                  store.detail.project.mode === "novel"
                    ? "从已有设定开始写作"
                    : "一句话开始故事"
                }}
              </h3>
              <p class="field-help">
                {{
                  store.detail.project.mode === "novel"
                    ? "AI 参考已有设定、可用规划、有效记忆与前文。分卷、章纲和细纲均可留空。"
                    : "角色、能力、世界或氛围，想到什么写什么。其余交给 AI，喜欢以后再完善。"
                }}
              </p>
              <NButton
                v-if="store.detail.project.mode === 'novel'"
                @click="tab = 'planning'"
                >完善本章规划</NButton
              >
              <NInput
                :value="store.detail.project.premise"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 5 }"
                placeholder="写下人物、背景或剧情关键词，其他细节可以自由发挥。"
                :disabled="store.busy"
                @update:value="store.editProject({ premise: $event })"
              />
              <div class="workbench-actions">
                <NButton
                  type="primary"
                  :disabled="store.busy"
                  @click="
                    store.safe(async () => {
                      chooseTool('opening');
                      await store.runTask('opening', { instruction: '' });
                    })
                  "
                  >直接生成开篇</NButton
                ><NButton :disabled="store.busy" @click="chooseTool('develop')"
                  >先完善设定也可以</NButton
                ><NButton
                  v-if="store.detail.project.mode === 'explore'"
                  :disabled="store.busy"
                  @click="chooseTool('adjust')"
                  >调整近期方向</NButton
                >
              </div>
            </section>
            <StoryEditor
              ref="editor"
              :key="store.chapter.id"
              :document="store.chapter.document"
              :placeholder="
                store.detail.project.mode === 'novel' &&
                store.chapter.kind !== 'fragment'
                  ? '依据已有设定、可用规划和前文开始写作；章纲和细纲可按需补充。'
                  : undefined
              "
              @update="store.editChapter({ document: $event })"
              @selection="store.selection = $event"
            />
            <footer class="chapter-footer">
              <span><Check :size="12" />草稿自动保存在本机</span
              ><NButton
                v-if="store.chapter.kind !== 'fragment'"
                size="small"
                :type="
                  store.chapter.dirty || store.chapter.needsReview
                    ? 'primary'
                    : 'default'
                "
                @click="store.safe(store.adopt)"
                :disabled="
                  !store.chapter.content.trim() ||
                  (!store.chapter.dirty && !store.chapter.needsReview)
                "
                ><template #icon><CheckCheck :size="15" /></template
                >{{
                  store.chapter.needsReview
                    ? "复核并采用"
                    : store.chapter.dirty
                      ? "采用当前章节"
                      : "当前版本已采用"
                }}</NButton
              >
            </footer>
            <div v-if="store.chapter.content.trim()" class="story-next-actions">
              <NButton :disabled="store.busy" @click="chooseTool('chapter')">{{
                store.chapter.kind === "fragment"
                  ? "继续当前片段"
                  : "继续当前章节"
              }}</NButton>
              <NButton
                v-if="store.chapter.kind !== 'fragment'"
                :disabled="store.busy"
                @click="store.safe(writeNextChapter)"
                >让故事进入下一章</NButton
              >
              <NButton v-else @click="tab = 'fragments'"
                >将片段编入故事</NButton
              >
              <NButton :disabled="store.busy" @click="chooseTool('develop')"
                >完善写到这里的设定</NButton
              >
              <NButton
                v-if="store.detail.project.mode === 'explore'"
                :disabled="store.busy"
                @click="chooseTool('adjust')"
                >调整近期方向</NButton
              >
            </div>
          </section>
          <section v-else class="chapter-main">
            <div class="inline-empty">
              <FileText :size="27" />
              <p>暂无章节，创建一个章节开始写作。</p>
              <NButton type="primary" @click="store.safe(store.newChapter)">
                <template #icon><Plus :size="15" /></template>新增章节
              </NButton>
            </div>
          </section></template
        >
        <section
          v-else-if="tab === 'outline'"
          class="tab-content blueprint-content"
        >
          <div class="content-heading">
            <div>
              <h2>故事蓝图</h2>
              <p>
                按需要记录未来方向，也可以留空边写边探索。AI
                可协助构建和更新；这些计划不会自动成为已发生的事实。
              </p>
            </div>
          </div>
          <div class="workbench-actions">
            <NButton :disabled="store.busy" @click="chooseTool('develop')"
              >让 AI 构建或完善蓝图</NButton
            ><NButton
              v-if="store.developmentUndoId"
              :disabled="store.busy"
              @click="store.safe(store.undoDevelopmentChanges)"
              >撤销上次设定更新</NButton
            >
          </div>
          <div class="form-two-columns">
            <div>
              <label class="field-label">故事名称</label
              ><NInput
                :value="store.detail.project.title"
                @update:value="store.editProject({ title: $event })"
              />
            </div>
            <div>
              <label class="field-label">创作模式</label
              ><NSelect
                :value="store.detail.project.mode"
                @update:value="store.editProject({ mode: $event })"
                :options="[
                  { label: '自由探索', value: 'explore' },
                  { label: '长篇创作', value: 'novel' },
                ]"
              />
            </div>
          </div>
          <label class="field-label">最初的想法</label
          ><NInput
            :value="store.detail.project.premise"
            @update:value="store.editProject({ premise: $event })"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            placeholder="想看角色经历什么？有哪些场景、关系或冲突？"
          />
          <div class="section-toolbar blueprint-toolbar">
            <label class="field-label"
              >蓝图分区<small
                >可以只写下一站，也可以规划整本故事；栏目名称与顺序都能修改</small
              ></label
            >
            <button class="text-button" @click="addBlueprintSection">
              <Plus :size="14" />添加分区
            </button>
          </div>
          <article
            v-for="(section, index) in store.detail.project.blueprintSections"
            :key="section.id"
            class="blueprint-section"
          >
            <div class="blueprint-section-heading">
              <NInput
                :value="section.title"
                placeholder="分区名称"
                @update:value="
                  (value) =>
                    store.editProject({
                      blueprintSections:
                        store.detail!.project.blueprintSections.map((item) =>
                          item.id === section.id
                            ? { ...item, title: value }
                            : item,
                        ),
                    })
                "
              />
              <button
                class="icon-button"
                aria-label="上移分区"
                :disabled="index === 0"
                @click="moveBlueprintSection(index, -1)"
              >
                <ArrowUp :size="14" />
              </button>
              <button
                class="icon-button"
                aria-label="下移分区"
                :disabled="
                  index === store.detail.project.blueprintSections.length - 1
                "
                @click="moveBlueprintSection(index, 1)"
              >
                <ArrowDown :size="14" />
              </button>
              <NPopconfirm
                positive-text="删除分区"
                negative-text="取消"
                @positive-click="
                  store.editProject({
                    blueprintSections:
                      store.detail!.project.blueprintSections.filter(
                        (item) => item.id !== section.id,
                      ),
                  })
                "
                ><template #trigger
                  ><button
                    class="icon-button danger-icon"
                    aria-label="删除分区"
                    :disabled="store.busy"
                  >
                    <Trash2 :size="14" /></button></template
                >删除「{{
                  section.title
                }}」及其内容？其他分区与正文保留。</NPopconfirm
              >
            </div>
            <NInput
              :value="section.content"
              @update:value="
                (value) =>
                  store.editProject({
                    blueprintSections:
                      store.detail!.project.blueprintSections.map((item) =>
                        item.id === section.id
                          ? { ...item, content: value }
                          : item,
                      ),
                  })
              "
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 18 }"
              placeholder="记录这一部分的故事计划。尚未确定的内容可以留空或标注为待确认。"
            />
          </article>
          <section class="blueprint-candidates">
            <div class="section-toolbar">
              <div>
                <h3>
                  创作候选
                  <span class="count-tag">{{
                    store.detail.project.blueprintCandidates.length
                  }}</span>
                </h3>
                <p class="muted small">
                  规划、灵感和诊断结果保存在这里，不会自动覆盖正式蓝图。
                </p>
              </div>
            </div>
            <article
              v-for="candidate in store.detail.project.blueprintCandidates"
              :key="candidate.id"
              class="blueprint-candidate"
            >
              <div class="blueprint-candidate-meta">
                <NInput
                  :value="candidate.title"
                  :maxlength="500"
                  :aria-label="'编辑候选名称'"
                  @update:value="
                    (value) =>
                      store.editProject({
                        blueprintCandidates:
                          store.detail!.project.blueprintCandidates.map((c) =>
                            c.id === candidate.id ? { ...c, title: value } : c,
                          ),
                      })
                  "
                />
                <NPopconfirm
                  positive-text="删除候选"
                  negative-text="取消"
                  @positive-click="
                    store.safe(() => deleteCandidate(candidate.id))
                  "
                  ><template #trigger
                    ><NButton
                      size="small"
                      :disabled="store.busy || store.imageBusy"
                      >删除候选</NButton
                    ></template
                  >删除「{{
                    candidate.title
                  }}」？已采用的设定、规划与正文保留。</NPopconfirm
                >
                <span>{{
                  new Date(candidate.createdAt).toLocaleString("zh-CN")
                }}</span>
              </div>
              <template v-if="candidate.development"
                ><p>{{ candidate.development.summary }}</p>
                <p
                  v-if="
                    candidate.development.warnings.some((w) =>
                      w.includes('来源章节已删除'),
                    )
                  "
                  class="review-banner"
                >
                  来源章节已删除，正文依据失效，请重新生成后采用。
                </p>
                <NButton
                  :disabled="store.busy"
                  @click="store.reviewDevelopment(candidate.development)"
                  >查看
                  {{ candidate.development.changes.length }} 个分区建议</NButton
                ></template
              >
              <NInput
                v-else
                :value="candidate.content"
                type="textarea"
                :autosize="{ minRows: 4, maxRows: 14 }"
                @update:value="
                  (value) =>
                    store.editProject({
                      blueprintCandidates:
                        store.detail!.project.blueprintCandidates.map((item) =>
                          item.id === candidate.id
                            ? { ...item, content: value }
                            : item,
                        ),
                    })
                "
              />
              <div
                v-if="!candidate.development"
                class="blueprint-candidate-actions"
              >
                <NSelect
                  v-model:value="candidateTargets[candidate.id]"
                  :options="
                    store.detail.project.blueprintSections.map((section) => ({
                      label: section.title,
                      value: section.id,
                    }))
                  "
                  placeholder="选择目标分区"
                />
                <NButton
                  :disabled="!candidateTargets[candidate.id]"
                  @click="
                    applyCandidate(
                      candidate.id,
                      candidateTargets[candidate.id],
                      false,
                    )
                  "
                  >追加</NButton
                >
                <NButton
                  type="warning"
                  :disabled="!candidateTargets[candidate.id]"
                  @click="
                    candidatePreview = {
                      candidateId: candidate.id,
                      sectionId: candidateTargets[candidate.id],
                    }
                  "
                  >预览替换</NButton
                >
              </div>
            </article>
            <div
              v-if="!store.detail.project.blueprintCandidates.length"
              class="inline-empty"
            >
              <Map :size="24" />
              <p>暂时没有候选。可在 AI 工作台规划故事或整理灵感。</p>
            </div>
          </section>
          <label class="field-label">故事里的世界</label
          ><NInput
            :value="store.detail.project.world"
            @update:value="store.editProject({ world: $event })"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 12 }"
            placeholder="记录时代背景、社会规则、地理与整体氛围"
          />
          <p class="field-help blueprint-world-help">
            这里记录本故事的整体世界观，会作为 AI
            参考。更细的角色或世界设定可在「世界与人物」中建立资料卡。
          </p>
          <label class="field-label">写作偏好</label
          ><NInput
            :value="store.detail.project.style"
            @update:value="store.editProject({ style: $event })"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            placeholder="叙述视角、对白节奏、情绪表达、你喜欢或不喜欢的写法……"
          />
        </section>
        <section v-else-if="tab === 'cards'" class="tab-content">
          <div class="content-heading">
            <div>
              <h2>世界与人物</h2>
              <p>这里的设定只属于这个故事，可从资料库带入，也可以单独修改。</p>
            </div>
            <button class="button primary small-button" @click="editCard(null)">
              <Plus :size="15" />添加资料
            </button>
          </div>
          <div class="workbench-actions story-card-toolbar">
            <NButton :disabled="store.busy" @click="chooseTool('develop')"
              >从故事完善人物与世界</NButton
            >
          </div>
          <div
            v-if="store.detail.project.mode === 'novel'"
            class="novel-setting-guide"
          >
            <h3>小说设定准备</h3>
            <p>
              主要人物：目标、动机、关系与变化方向。世界：基本规则、能力边界、主要势力与地点。叙事：视角、文风、节奏和需要保留的秘密。
            </p>
            <p class="field-help">
              可使用已有资料卡的自由分区逐项补充；未完善的部分不阻止正常写作。
            </p>
            <div class="workbench-actions">
              <NButton
                @click="store.safe(() => addSettingTemplate('character'))"
                >添加主要人物模板</NButton
              ><NButton @click="store.safe(() => addSettingTemplate('world'))"
                >添加世界设定模板</NButton
              ><NButton
                :disabled="store.busy"
                @click="
                  store.instruction =
                    '构建主要人物的目标、动机、关系与弧线，以及世界规则、能力边界、主要势力与叙事偏好；保留未确定事项，按分区提供建议。';
                  chooseTool('develop');
                "
                >AI 协助完善小说设定</NButton
              >
            </div>
            <label class="field-label">叙事偏好</label
            ><NInput
              :value="store.detail.project.style"
              type="textarea"
              placeholder="叙述视角、对白节奏、情绪表达、需要保留的秘密……"
              @update:value="(value) => store.editProject({ style: value })"
            />
          </div>
          <div v-if="store.detail.cards.length" class="detail-card-grid">
            <article
              v-for="card in store.detail.cards"
              :key="card.id"
              class="detail-card"
            >
              <div class="detail-card-heading">
                <span class="card-kind">{{
                  card.kind === "character"
                    ? "角色 / OC"
                    : card.kind === "world"
                      ? "世界观"
                      : "灵感"
                }}</span
                ><button
                  class="text-button asset-card-delete"
                  :aria-label="`删除故事资料「${card.name}」`"
                  :disabled="
                    store.busy || store.imageBusy || deletingCard || copyingCard
                  "
                  @click="
                    cardToDelete = {
                      id: card.id,
                      name: card.name,
                      projectId: card.projectId,
                    }
                  "
                >
                  <Trash2 :size="14" />删除
                </button>
              </div>
              <h3>{{ card.name }}</h3>
              <p>
                {{
                  card.description ||
                  card.sections.map((section) => section.title).join("、") ||
                  (card.documents.length
                    ? `${card.documents.length} 份原始文档`
                    : "暂无描述")
                }}
              </p>
              <div v-if="card.constraints" class="card-constraints">
                <span>需要坚持的设定</span>{{ card.constraints }}
              </div>
              <div class="card-actions">
                <button class="text-button" @click="editCard(card)">
                  编辑资料 <ArrowUpRight :size="13" /></button
                ><button
                  class="text-button muted"
                  :disabled="copyingCard || deletingCard"
                  @click="
                    cardToLibrary = {
                      id: card.id,
                      name: card.name,
                      projectId: card.projectId,
                    }
                  "
                >
                  存入资料库
                </button>
              </div>
            </article>
          </div>
          <div v-else class="inline-empty">
            <Users :size="32" />
            <p>暂无设定，可新建或从资料库导入。</p>
            <button class="text-button" @click="editCard(null)">
              添加第一个角色 <Plus :size="14" />
            </button>
          </div>
          <div v-if="store.cards.length" class="import-library">
            <h3>从创作资料库带入</h3>
            <p class="muted small">
              导入后会创建独立副本，不与资料库同步修改。
            </p>
            <div class="filter-tabs compact-tabs">
              <button
                v-for="item in importOptions"
                :key="item.value"
                :class="{ active: importKind === item.value }"
                @click="importKind = item.value"
              >
                {{ item.label }}
              </button>
            </div>
            <div v-if="importCards.length" class="library-chips">
              <button
                v-for="card in importCards"
                :key="card.id"
                @click="
                  store.safe(async () => {
                    await store.api('card:copy', {
                      id: card.id,
                      projectId: store.detail!.project.id,
                    });
                    await store.refreshProject();
                    store.notify('资料已带入故事。');
                  })
                "
              >
                <Plus :size="13" /><span class="import-kind-tag">{{
                  card.kind === "character" ? "OC" : "世界观"
                }}</span
                >{{ card.name }}
              </button>
            </div>
            <p v-else class="muted small">此分类暂时没有可导入资料。</p>
          </div>
        </section>
        <section v-else-if="tab === 'memory'" class="tab-content">
          <div class="content-heading">
            <div>
              <h2>故事记忆</h2>
              <p>
                保存已发生的事实、人物状态与正文已埋的线索；未来如何铺垫和回收放在故事蓝图。采用章节后可运行「记忆整理」，审核后写入，也可手动记录。
              </p>
            </div>
            <button class="button primary small-button" @click="openMemory()">
              <Plus :size="14" />作者记录
            </button>
          </div>
          <div class="section-toolbar">
            <span class="muted small"
              >{{
                store.detail.memories.filter((m) => m.active).length
              }}
              条有效记录 · 每条自动记忆都保留来源</span
            ><button class="text-button" @click="showRetired = !showRetired">
              {{ showRetired ? "只看有效记录" : "查看失效记录" }}
            </button>
          </div>
          <section v-if="store.memoryRecords?.length" class="memory-draft">
            <div class="memory-meta">
              <strong>待审核记忆草稿</strong
              ><span
                >{{ store.memoryRecords.length }} 条 · 来源版本
                {{ store.memoryRevisionId.slice(0, 8) }}</span
              >
            </div>
            <article
              v-for="(record, index) in store.memoryRecords"
              :key="index"
              class="memory-draft-row"
            >
              <NSelect
                v-model:value="record.kind"
                :options="
                  Object.entries(memoryLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))
                "
                @update:value="store.scratch"
              />
              <NInput
                v-model:value="record.content"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 5 }"
                @update:value="store.scratch"
              />
              <NPopconfirm
                positive-text="移除候选"
                negative-text="取消"
                @positive-click="
                  () => {
                    store.memoryRecords?.splice(index, 1);
                    if (!store.memoryRecords?.length)
                      store.memoryRecords = null;
                    store.scratch();
                  }
                "
                ><template #trigger
                  ><NButton size="small" :disabled="store.busy"
                    >移除</NButton
                  ></template
                >移除此条待审核记忆？正式记忆保留。</NPopconfirm
              >
            </article>
            <NButton
              type="primary"
              @click="
                store.safe(async () => {
                  await store.flush();
                  await store.api('memory:apply-generated', {
                    chapterId: store.outputChapterId,
                    revisionId: store.memoryRevisionId,
                    records: store.memoryRecords,
                  });
                  await store.refreshProject();
                  store.memoryRecords = null;
                  store.scratch();
                  await store.flush();
                  store.notify('已将审核后的记忆写入故事。');
                })
              "
              >确认写入故事记忆</NButton
            >
          </section>
          <div v-if="filteredMemories.length" class="memory-list">
            <article
              v-for="memory in filteredMemories"
              :key="memory.id"
              :class="{ retired: !memory.active }"
            >
              <div class="memory-meta">
                <span class="memory-tag">{{ memoryLabels[memory.kind] }}</span
                ><button
                  v-if="memory.revisionId"
                  class="memory-source"
                  @click="viewSource(memory.revisionId)"
                >
                  {{
                    store.detail.chapters.find((c) => c.id === memory.chapterId)
                      ?.title
                  }}
                  · {{ memory.revisionId.slice(0, 6) }}
                  <ArrowUpRight :size="11" /></button
                ><span v-else class="memory-source">作者手动记录</span
                ><span v-if="!memory.active" class="retired-label">已停用</span>
                <ItemActions
                  :label="'记忆：' + memory.content.slice(0, 15)"
                  :disabled="store.busy || store.imageBusy"
                  @edit="openMemory(memory)"
                  @action="memoryToDelete = memory"
                />
              </div>
              <p>{{ memory.content }}</p>
              <button
                class="text-button small"
                @click="
                  store.safe(async () => {
                    await store.api('memory:toggle', {
                      id: memory.id,
                      active: !memory.active,
                    });
                    await store.refreshProject();
                  })
                "
              >
                {{ memory.active ? "停用这条记录" : "重新启用" }}
              </button>
            </article>
          </div>
          <div v-else class="inline-empty">
            <NotebookPen :size="30" />
            <p>暂无有效记忆。采用章节后，可使用「整理正式记忆」提取内容。</p>
            <span class="muted small"
              >草稿、未来大纲和未确认的建议不会自动写入记忆。</span
            >
          </div>
        </section>
        <ImagePanel
          v-else-if="tab === 'images'"
          :initial-prompt="imagePrompt"
        />
      </div>
      <WorkbenchPanel @apply="apply" />
    </div>
    <DevelopmentReview />
    <ChapterTitleDialog
      :show="!!chapterToRename"
      :chapter-id="chapterToRename"
      :generate-on-open="generateChapterName"
      @update:show="
        (value) => {
          if (!value) chapterToRename = '';
        }
      "
    />
    <CardEditor
      v-model:show="cardModal"
      :card="editingCard"
      :project-id="store.detail.project.id"
    />
    <NModal
      :show="!!cardToDelete"
      preset="dialog"
      type="error"
      title="删除故事资料？"
      :content="`确定删除本故事中的「${cardToDelete?.name || ''}」？该资料的内容、分区和原始文档将一并删除。资料库和其他故事中的副本、已有正文、故事记忆及参考图片会保留。此操作无法撤销。`"
      positive-text="确认删除"
      negative-text="取消"
      :positive-button-props="{
        type: 'error',
        loading: deletingCard,
        disabled: store.busy || store.imageBusy,
      }"
      :negative-button-props="{ disabled: deletingCard }"
      :mask-closable="!deletingCard"
      :close-on-esc="!deletingCard"
      :closable="!deletingCard"
      @update:show="
        (value) => {
          if (!value && !deletingCard) cardToDelete = null;
        }
      "
      @positive-click="confirmDeleteCard"
      @negative-click="cardToDelete = null"
    />
    <NModal
      :show="!!cardToLibrary"
      preset="dialog"
      type="info"
      title="存入资料库？"
      :content="`将「${cardToLibrary?.name || ''}」复制为一份新的资料库条目？内容、分区、原始文档和参考图片关联都会复制。已有同名资料不会被覆盖，之后两份资料各自编辑。`"
      positive-text="确认存入"
      negative-text="取消"
      :positive-button-props="{ loading: copyingCard }"
      :negative-button-props="{ disabled: copyingCard }"
      :mask-closable="!copyingCard"
      :close-on-esc="!copyingCard"
      :closable="!copyingCard"
      @update:show="
        (value) => {
          if (!value && !copyingCard) cardToLibrary = null;
        }
      "
      @positive-click="confirmCopyCard"
      @negative-click="cardToLibrary = null"
    />
    <NModal
      :show="!!chapterToDelete"
      preset="dialog"
      type="error"
      :title="
        chapterToDelete?.kind === 'fragment' ? '删除片段？' : '删除整章？'
      "
      :content="
        chapterToDelete?.kind === 'fragment'
          ? `删除「${chapterToDelete.title}」及其版本？已编入章节的内容保留。此操作无法撤销。`
          : `确定删除「${chapterToDelete?.title || ''}」？本章正文、版本记录及关联记忆将一并删除，插画会保留在故事中。${chapterToDelete?.acceptedRevisionId ? '后续已采用章节将标记为待复核，相关自动记忆将停用。' : ''}此操作无法撤销。`
      "
      positive-text="确认删除"
      negative-text="取消"
      :positive-button-props="{
        type: 'error',
        loading: deletingChapter,
        disabled: store.busy || store.imageBusy,
      }"
      :negative-button-props="{ disabled: deletingChapter }"
      :mask-closable="!deletingChapter"
      :close-on-esc="!deletingChapter"
      :closable="!deletingChapter"
      @update:show="
        (value) => {
          if (!value && !deletingChapter) chapterToDelete = null;
        }
      "
      @positive-click="confirmDeleteChapter"
      @negative-click="chapterToDelete = null"
    />
    <NModal
      v-model:show="memoryModal"
      preset="card"
      :title="editingMemoryId ? '编辑记忆记录' : '记下一条作者记录'"
      :style="{ width: '520px' }"
      ><label class="field-label first">记录类型</label
      ><NSelect
        v-model:value="memoryKind"
        :options="
          Object.entries(memoryLabels).map(([value, label]) => ({
            value,
            label,
          }))
        "
      /><label class="field-label">需要记住的内容</label
      ><NInput
        v-model:value="memoryText"
        type="textarea"
        :autosize="{ minRows: 5 }"
        placeholder="请区分已发生的事实与角色的猜测；未来计划更适合放在蓝图。"
      /><template #footer
        ><div class="modal-footer">
          <NButton @click="memoryModal = false">取消</NButton
          ><NButton
            type="primary"
            :disabled="!memoryText.trim()"
            @click="addMemory"
            >保存记录</NButton
          >
        </div></template
      ></NModal
    >
    <NModal
      :show="!!memoryToDelete"
      @update:show="
        (v) => {
          if (!v && !removingMemory) memoryToDelete = null;
        }
      "
      preset="dialog"
      title="删除记忆记录？"
      :content="`将删除「${memoryToDelete?.content.slice(0, 80) ?? ''}」。正文与来源版本保留；此操作无法撤销。`"
      positive-text="删除记录"
      negative-text="取消"
      :positive-button-props="{
        disabled: store.busy || store.imageBusy,
        type: 'error',
        loading: removingMemory,
      }"
      :negative-button-props="{ disabled: removingMemory }"
      :mask-closable="!removingMemory"
      :close-on-esc="!removingMemory"
      :closable="!removingMemory"
      @positive-click="confirmDeleteMemory"
      @negative-click="memoryToDelete = null"
    />
    <NModal
      :show="!!chapterPlanToClear"
      @update:show="
        (v) => {
          if (!v && !clearingChapterPlan) chapterPlanToClear = null;
        }
      "
      preset="dialog"
      title="清空章纲？"
      :content="`清空「${chapterPlanToClear?.title ?? ''}」的章纲及确认内容，保留正文和场景细纲。操作前保存规划快照；关联内容可能标记待核对。`"
      positive-text="清空章纲"
      negative-text="取消"
      :positive-button-props="{
        disabled: store.busy || store.imageBusy,
        type: 'error',
        loading: clearingChapterPlan,
      }"
      :negative-button-props="{ disabled: clearingChapterPlan }"
      :mask-closable="!clearingChapterPlan"
      :close-on-esc="!clearingChapterPlan"
      :closable="!clearingChapterPlan"
      @positive-click="confirmClearChapterPlan"
      @negative-click="chapterPlanToClear = null"
    />
    <NModal
      v-model:show="revisionModal"
      preset="card"
      title="章节版本"
      :style="{ width: '620px' }"
      ><p class="muted small">
        恢复只会更新草稿；采用后才更新正式故事。恢复前会保存当前草稿快照。
      </p>
      <div v-if="revisions.length" class="revision-list">
        <article v-for="revision in revisions" :key="revision.id">
          <div>
            <strong
              >{{ revision.label }}
              <span
                v-if="revision.id === store.chapter?.acceptedRevisionId"
                class="count-tag"
                >当前采用</span
              ></strong
            ><span
              >{{ new Date(revision.createdAt).toLocaleString("zh-CN") }} ·
              {{ wordCount(revision.content) }} 字</span
            >
          </div>
          <button class="text-button" @click="viewRevision = revision">
            查看</button
          ><button class="text-button" @click="restore(revision)">
            <RotateCcw :size="13" />恢复
          </button>
          <VersionActions
            :id="revision.id"
            :label="revision.label"
            @changed="
              store.safe(async () => {
                viewRevision = null;
                revisions = await store.api(
                  'chapter:revisions',
                  store.chapter!.id,
                );
              })
            "
          />
        </article>
      </div>
      <div v-else class="inline-empty">
        <History :size="25" />
        <p>采用章节、手动保存快照或写入 AI 正文时，会保留版本。</p>
      </div></NModal
    >
    <NModal
      :show="!!viewRevision"
      @update:show="
        (v) => {
          if (!v) viewRevision = null;
        }
      "
      preset="card"
      :title="viewRevision?.title + ' · 来源版本'"
      :style="{ width: '760px' }"
      ><template v-if="viewRevision"
        ><p class="muted small">
          {{ viewRevision.label }} ·
          {{ new Date(viewRevision.createdAt).toLocaleString("zh-CN") }}
        </p>
        <pre class="revision-content">{{ viewRevision.content }}</pre>
      </template></NModal
    >
    <NModal
      :show="!!confirmApply"
      @update:show="
        (v) => {
          if (!v) confirmApply = null;
        }
      "
      preset="dialog"
      :title="confirmApply === 'outline' ? '替换故事蓝图？' : '替换本章草稿？'"
      :content="
        confirmApply === 'outline'
          ? '创作结果将替换当前蓝图，请确认已经阅读。'
          : '当前草稿会先保存为版本快照，再写入新的内容。已采用版本暂不改变。'
      "
      positive-text="替换"
      negative-text="取消"
      @positive-click="
        () => {
          const mode = confirmApply!;
          confirmApply = null;
          void apply(mode, true);
        }
      "
      @negative-click="confirmApply = null"
    />
    <NModal
      :show="!!candidatePreview"
      @update:show="
        (value) => {
          if (!value) candidatePreview = null;
        }
      "
      preset="card"
      title="替换蓝图分区前预览"
      class="form-modal blueprint-preview-modal"
      :style="{ width: '900px' }"
    >
      <p class="muted small">
        {{ candidatePreviewData?.section?.title }} · 请对照当前内容与候选内容
      </p>
      <div class="blueprint-preview-columns">
        <div>
          <strong>当前分区</strong
          ><NInput
            :value="candidatePreviewData?.section?.content || ''"
            type="textarea"
            :autosize="{ minRows: 12, maxRows: 24 }"
            readonly
          />
        </div>
        <div>
          <strong>候选内容</strong
          ><NInput
            :value="candidatePreviewData?.candidate?.content || ''"
            type="textarea"
            :autosize="{ minRows: 12, maxRows: 24 }"
            readonly
          />
        </div>
      </div>
      <template #footer
        ><div class="modal-footer">
          <NButton @click="candidatePreview = null">取消</NButton
          ><NButton type="warning" @click="confirmCandidateReplacement"
            >确认替换分区</NButton
          >
        </div></template
      >
    </NModal>
  </div>
</template>
