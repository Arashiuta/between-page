<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NInput,
  NButton,
  NSelect,
  NModal,
  NPopconfirm,
  NCheckbox,
} from "naive-ui";
import {
  ChevronLeft,
  Download,
  GripVertical,
  Users,
  Globe,
  Lightbulb,
  Plus,
  Trash2,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type {
  Card,
  CardKind,
  ProjectDetail,
  Revision,
} from "../../shared/types";
import { memoryLabels } from "../../shared/types";
import { freedomOptions } from "../../shared/creation";
import StoryEditor from "../components/StoryEditor.vue";
import WorkbenchPanel from "../components/WorkbenchPanel.vue";
import BlueprintEditor from "../components/BlueprintEditor.vue";
import DirectionsPanel from "../components/DirectionsPanel.vue";
import { blueprintLabels } from "../../shared/blueprint";
import CardEditor from "../components/CardEditor.vue";
import CandidateShelf from "../components/CandidateShelf.vue";
import ChangeReview from "../components/ChangeReview.vue";
import ImagePanel from "../components/ImagePanel.vue";
import VersionActions from "../components/VersionActions.vue";
const store = useWorkspace(),
  route = useRoute(),
  router = useRouter(),
  tab = ref("text"),
  cardKind = ref<CardKind>("character"),
  memoryChapterIds = ref<string[]>([]),
  loading = ref(false),
  cardOpen = ref(false),
  editingCard = ref<Card | null>(null),
  imagePrompt = ref(""),
  history = ref<Revision[]>([]),
  historyOpen = ref(false),
  viewing = ref<Revision | null>(null),
  importOpen = ref(false),
  chapterDragging = ref(""),
  chapterDrop = ref<{ id: string; position: "before" | "after" } | null>(null),
  reordering = ref(false),
  importIds = ref<string[]>([]);
const chapterDragDisabled = computed(
  () => store.busy || store.directionsBusy || store.saving || reordering.value,
);
function endChapterDrag() {
  chapterDragging.value = "";
  chapterDrop.value = null;
}
function startChapterDrag(event: DragEvent, id: string) {
  if (chapterDragDisabled.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  chapterDragging.value = id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-story-chapter", id);
}
function overChapter(event: DragEvent, id: string) {
  if (
    chapterDragDisabled.value ||
    !chapterDragging.value ||
    chapterDragging.value === id
  )
    return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  chapterDrop.value = {
    id,
    position: event.clientY < rect.top + rect.height / 2 ? "before" : "after",
  };
}
const tabs = computed(() => [
  { id: "overview", name: "作品概览" },
  { id: "text", name: "章节正文" },
  { id: "blueprint", name: "额外设定" },
  ...(store.detail?.project.mode === "novel"
    ? [{ id: "outline", name: "大纲规划" }]
    : []),
  { id: "cards", name: "世界与人物" },
  { id: "memory", name: "故事记忆" },
  { id: "images", name: "故事插画" },
]);
const chapterPlan = computed(() =>
  store.detail?.project.blueprint.nodes.find(
    (n) => n.level === "chapter" && n.chapterId === store.chapterId,
  ),
);
const visibleStoryCards = computed(
  () =>
    store.detail?.cards.filter((item) => item.kind === cardKind.value) ?? [],
);
const eligibleMemoryChapters = computed(
  () =>
    store.detail?.chapters.filter(
      (item) => item.acceptedRevisionId && !item.needsReview,
    ) ?? [],
);
watch(
  () => store.detail?.project.id,
  () => {
    memoryChapterIds.value = [];
    store.notesChapterIds = [];
  },
);
watch(
  () => store.chapter?.id,
  (id) => {
    if (
      !memoryChapterIds.value.length &&
      id &&
      eligibleMemoryChapters.value.some((chapter) => chapter.id === id)
    )
      memoryChapterIds.value = [id];
  },
  { immediate: true },
);
const relatedPlans = computed(() =>
  chapterPlan.value
    ? store.detail!.project.blueprint.nodes.filter(
        (n) =>
          n.id === chapterPlan.value!.id ||
          n.id === chapterPlan.value!.parentId ||
          n.parentId === chapterPlan.value!.id,
      )
    : [],
);
function openPlan() {
  store.planningNodeId = chapterPlan.value?.id ?? "";
  tab.value = "outline";
}
watch(
  () => route.params.id,
  async (id) => {
    endChapterDrag();
    loading.value = true;
    try {
      await store.openProject(String(id));
      tab.value = store.detail?.project.mode === "novel" ? "overview" : "text";
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);
async function modeChange(mode: "novel" | "explore") {
  if (!store.detail || store.busy || store.directionsBusy) return;
  store.scratch();
  await store.flush();
  store.editProject({ mode });
  await store.flush();
  await store.openProject(store.detail.project.id);
  tab.value = mode === "novel" ? "overview" : "text";
}
function card(c: Card | null) {
  editingCard.value = c;
  cardOpen.value = true;
}
async function tool(kind: Parameters<typeof store.chooseTool>[0]) {
  await store.chooseTool(kind);
}
async function versions() {
  if (!store.chapter) return;
  await store.flush();
  history.value = await store.api("chapter:revisions", store.chapter.id);
  historyOpen.value = true;
}
async function restore(id: string) {
  await store.flush();
  await store.api("chapter:restore", id);
  await store.refreshProject();
  historyOpen.value = false;
  viewing.value = null;
}
async function dropChapter(event: DragEvent, targetId: string) {
  event.preventDefault();
  if (
    !store.detail ||
    chapterDragDisabled.value ||
    !chapterDrop.value ||
    chapterDrop.value.id !== targetId
  )
    return;
  const id = chapterDragging.value;
  const position = chapterDrop.value.position;
  endChapterDrag();
  if (
    !id ||
    id === targetId ||
    event.dataTransfer?.getData("application/x-story-chapter") !== id
  )
    return;
  const projectId = store.detail.project.id;
  reordering.value = true;
  try {
    await store.flush();
    if (store.detail?.project.id !== projectId) return;
    const original = store.detail.chapters.map((c) => c.id);
    if (!original.includes(id) || !original.includes(targetId)) return;
    const ids = original.filter((x) => x !== id);
    ids.splice(ids.indexOf(targetId) + Number(position === "after"), 0, id);
    if (ids.every((x, i) => x === original[i])) return;
    const detail = await store.api<ProjectDetail>("chapter:reorder", {
      projectId,
      ids,
    });
    if (store.detail?.project.id === projectId) {
      detail.project = store.detail.project;
      // Preserve any text edited while the request was in flight.
      for (const c of detail.chapters) {
        const local = store.detail.chapters.find((x) => x.id === c.id);
        if (local)
          Object.assign(c, {
            title: local.title,
            document: local.document,
            content: local.content,
          });
      }
      store.detail = detail;
    }
  } finally {
    reordering.value = false;
    endChapterDrag();
  }
}
async function copyCards() {
  if (!store.detail) return;
  for (const id of importIds.value)
    await store.api("card:copy", { id, projectId: store.detail.project.id });
  await store.refreshProject();
  importOpen.value = false;
  importIds.value = [];
}
async function checkpoint() {
  if (!store.chapter) return;
  await store.flush();
  await store.api("chapter:checkpoint", {
    id: store.chapter.id,
    label: "手动快照",
  });
  store.notify("快照已保存。");
}
</script>
<template>
  <main v-if="store.detail && !loading" class="studio-page">
    <header class="studio-heading">
      <button
        class="studio-back"
        aria-label="返回书架"
        title="返回书架"
        @click="router.push('/')"
      >
        <ChevronLeft :size="18" />
      </button>
      <div class="studio-title">
        <small
          >{{
            store.detail.project.mode === "novel" ? "长篇创作" : "自由探索"
          }}
          · {{ store.detail.chapters.length }} 章</small
        >
        <h1>{{ store.detail.project.title }}</h1>
      </div>
      <NSelect
        :value="store.detail.project.mode"
        :options="[
          { label: '自由探索', value: 'explore' },
          { label: '长篇创作', value: 'novel' },
        ]"
        :disabled="store.busy || store.directionsBusy"
        style="width: 140px"
        @update:value="(v) => store.safe(() => modeChange(v))"
      /><NButton
        @click="
          store.safe(async () => {
            await store.flush();
            await store.api('project:export', store.detail!.project.id);
          })
        "
        ><template #icon><Download :size="15" /></template>导出正文</NButton
      >
    </header>
    <nav class="studio-tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        :class="{ active: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.name }}
      </button>
    </nav>
    <div class="studio-body">
      <aside class="studio-chapters">
        <div class="section-toolbar">
          <strong>章节目录</strong
          ><NButton
            size="tiny"
            secondary
            :disabled="store.busy"
            @click="
              store.safe(async () => {
                await store.newChapter();
                tab = 'text';
              })
            "
            ><template #icon><Plus :size="13" /></template>新章</NButton
          >
        </div>
        <article
          v-for="(c, i) in store.detail.chapters"
          :key="c.id"
          :class="{
            active: store.chapterId === c.id,
            'chapter-dragging': chapterDragging === c.id,
            'chapter-drop-before':
              chapterDrop?.id === c.id && chapterDrop.position === 'before',
            'chapter-drop-after':
              chapterDrop?.id === c.id && chapterDrop.position === 'after',
          }"
          @dragover="overChapter($event, c.id)"
          @dragleave="
            (event) => {
              if (
                !(event.currentTarget as HTMLElement).contains(
                  event.relatedTarget as Node | null,
                ) &&
                chapterDrop?.id === c.id
              )
                chapterDrop = null;
            }
          "
          @drop="store.safe(() => dropChapter($event, c.id))"
        >
          <button
            class="chapter-link"
            @click="
              store.safe(async () => {
                await store.switchChapter(c.id);
                tab = 'text';
              })
            "
          >
            <span class="chapter-index">{{
              String(i + 1).padStart(2, "0")
            }}</span
            ><span class="chapter-text"
              ><small
                >第 {{ i + 1 }} 章 · {{ c.dirty ? "草稿" : "已采用"
                }}{{ c.needsReview ? " · 待复核" : "" }}</small
              >{{ c.title }}</span
            >
          </button>
          <div class="chapter-row-actions">
            <button
              class="chapter-drag-handle"
              aria-label="拖动调整章节顺序"
              title="拖动调整章节顺序"
              :disabled="chapterDragDisabled"
              :draggable="!chapterDragDisabled"
              @dragstart="startChapterDrag($event, c.id)"
              @dragend="endChapterDrag"
              @click.stop
            >
              <GripVertical :size="14" /></button
            ><NPopconfirm
              @positive-click="store.safe(() => store.deleteChapter(c.id))"
              ><template #trigger
                ><button
                  :disabled="store.busy"
                  aria-label="删除章节"
                  title="删除章节"
                >
                  <Trash2 :size="13" /></button></template
              >删除本章、历史版本和关联记忆？</NPopconfirm
            >
          </div>
        </article>
      </aside>
      <div class="studio-content">
        <section v-if="tab === 'overview'" class="studio-section">
          <h2>作品概览</h2>
          <p>
            额外设定、世界与人物、引入资料和有效故事记忆全程参与创作。{{
              store.detail.project.mode === "novel"
                ? "大纲规划安排卷章结构，各层可留空。"
                : "从当前处境开始，逐章选择故事走向。"
            }}
          </p>
          <label class="field-label">作品名称</label
          ><NInput
            :value="store.detail.project.title"
            @update:value="(v) => store.editProject({ title: v })"
          /><label class="field-label">最初的想法</label
          ><NInput
            :value="store.detail.project.premise"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 10 }"
            @update:value="(v) => store.editProject({ premise: v })"
          /><label class="field-label">创作自由度</label
          ><NSelect
            :value="store.detail.project.creativeFreedom"
            :options="freedomOptions"
            @update:value="(v) => store.editProject({ creativeFreedom: v })"
          />
          <div class="overview-links">
            <button @click="tab = 'cards'">
              世界与人物<br /><small
                >{{ store.detail.cards.length }} 份资料</small
              ></button
            ><button @click="tab = 'blueprint'">
              额外设定<br /><small
                >{{
                  store.detail.project.blueprint.nodes.filter(
                    (n) => n.level === "section",
                  ).length
                }}
                个条目</small
              ></button
            ><button
              v-if="store.detail.project.mode === 'novel'"
              @click="tab = 'outline'"
            >
              大纲规划<br /><small
                >{{
                  store.detail.project.blueprint.nodes.filter(
                    (n) => n.level !== "section",
                  ).length
                }}
                个节点</small
              ></button
            ><button @click="tab = 'text'">
              章节正文<br /><small>{{ store.detail.chapters.length }} 章</small>
            </button>
          </div>
        </section>
        <section v-else-if="tab === 'text'" class="studio-text">
          <template v-if="store.chapter">
            <details
              v-if="store.detail.project.mode === 'novel'"
              class="chapter-planning"
              open
            >
              <summary>
                {{
                  chapterPlan
                    ? "本章关联大纲 · " + chapterPlan.title
                    : "本章尚未关联章纲，可以直接写作"
                }}
              </summary>
              <article v-for="n in relatedPlans" :key="n.id">
                <strong>{{ blueprintLabels[n.level] }} · {{ n.title }}</strong>
                <p class="planning-content">{{ n.content || "尚未填写" }}</p>
              </article>
              <NButton size="small" @click="openPlan">{{
                chapterPlan ? "编辑本章大纲" : "打开大纲规划"
              }}</NButton>
            </details>
            <div
              v-if="
                store.detail.project.mode === 'explore' &&
                store.chapter.explorationSource &&
                !store.chapter.content.trim()
              "
              class="review-banner"
            >
              <strong>本章将按此走向生成</strong>
              <p class="planning-content">
                {{ store.chapter.explorationSource.instruction }}
              </p>
              <span>点击“写开篇”重试生成，继续使用当前空章。</span>
            </div>
            <div class="prose-heading">
              <NInput
                :value="store.chapter.title"
                @update:value="(v) => store.editChapter({ title: v })"
              /><NButton
                :disabled="store.busy"
                @click="store.safe(() => tool('title'))"
                >AI 命名</NButton
              ><NButton :disabled="store.busy" @click="store.safe(versions)"
                >版本</NButton
              >
            </div>
            <p v-if="store.chapter.planningReview" class="review-banner">
              {{ store.chapter.planningReview }}
              <button
                class="text-button"
                @click="
                  store.safe(async () => {
                    await store.api('chapter:acknowledge', store.chapter!.id);
                    await store.refreshProject();
                  })
                "
              >
                已核对
              </button>
            </p>
            <StoryEditor
              :key="store.chapter.id"
              :document="store.chapter.document"
              @update="(document) => store.editChapter({ document })"
              @selection="
                (s) => {
                  if (s) {
                    store.selection = s;
                    store.scratch();
                  }
                }
              "
            />
            <div class="prose-dock">
              <div class="prose-footer">
                <span
                  >{{ store.chapter.content.replace(/\s/g, "").length }} 字 ·
                  {{ store.chapter.dirty ? "未采用修改" : "已采用版本" }}</span
                ><NButton
                  size="small"
                  :disabled="store.busy"
                  @click="store.safe(checkpoint)"
                  >保存快照</NButton
                ><NButton
                  type="primary"
                  size="small"
                  :disabled="store.busy || !store.chapter.content.trim()"
                  @click="store.safe(store.adopt)"
                  >采用本章</NButton
                >
              </div>
              <div class="workbench-actions">
                <NButton
                  :disabled="store.busy"
                  @click="
                    store.safe(() =>
                      tool(
                        store.chapter!.content.trim() ? 'continue' : 'opening',
                      ),
                    )
                  "
                  >{{
                    store.chapter.content.trim() ? "从文末续写" : "写开篇"
                  }}</NButton
                ><NButton
                  :disabled="store.busy || !store.selection"
                  @click="store.safe(() => tool('polish'))"
                  >打磨选中文段</NButton
                ><NButton
                  :disabled="store.busy || !store.chapter.content.trim()"
                  @click="store.safe(() => tool('expand'))"
                  >扩写本章</NButton
                ><NButton
                  :disabled="store.busy"
                  @click="store.safe(() => tool('check'))"
                  >检查故事</NButton
                ><NButton
                  v-if="
                    store.chapter.content.trim() &&
                    store.detail.project.mode === 'novel'
                  "
                  :disabled="store.busy"
                  @click="
                    store.safe(async () => {
                      await store.newChapter();
                      await tool('opening');
                    })
                  "
                  >新建下一章</NButton
                >
              </div>
            </div>
            <DirectionsPanel
              v-if="
                store.detail.project.mode === 'explore' &&
                store.chapter.content.trim()
              "
            />
          </template>
          <div v-else class="inline-empty">
            <p>创建一个空章开始写作。</p>
            <NButton type="primary" @click="store.safe(store.newChapter)"
              >新增章节</NButton
            >
          </div>
        </section>
        <section v-else-if="tab === 'blueprint'" class="studio-section">
          <BlueprintEditor key="blueprint" />
        </section>
        <section
          v-else-if="tab === 'outline' && store.detail.project.mode === 'novel'"
          class="studio-section"
        >
          <BlueprintEditor
            key="outline"
            domain="outline"
            @chapter="tab = 'text'"
          />
        </section>
        <section v-else-if="tab === 'cards'" class="studio-section">
          <div class="section-toolbar">
            <div>
              <h2>世界与人物</h2>
              <p class="field-help">
                叙事偏好和所选类别中的资料参与创作请求；从创作资料库引入的资料只读。
              </p>
            </div>
            <NButton @click="card(null)"
              >添加{{
                cardKind === "character"
                  ? "人物"
                  : cardKind === "world"
                    ? "世界资料"
                    : "灵感资料"
              }}</NButton
            >
          </div>
          <div class="workbench-actions">
            <NButton @click="importOpen = true">从资料库带入</NButton>
          </div>
          <label class="field-label">叙事偏好</label
          ><NInput
            :value="store.detail.project.style"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            @update:value="(v) => store.editProject({ style: v })"
          />
          <nav class="setting-domain-tabs" aria-label="人物与世界资料">
            <button
              v-for="item in [
                { id: 'character' as CardKind, label: '人物', icon: Users },
                { id: 'world' as CardKind, label: '世界', icon: Globe },
                {
                  id: 'inspiration' as CardKind,
                  label: '灵感资料',
                  icon: Lightbulb,
                },
              ]"
              :key="item.id"
              type="button"
              :class="{ active: cardKind === item.id }"
              :aria-pressed="cardKind === item.id"
              @click="cardKind = item.id"
            >
              <component :is="item.icon" :size="16" />{{ item.label }}
              <span>{{
                store.detail.cards.filter((c) => c.kind === item.id).length
              }}</span>
            </button>
          </nav>
          <div class="setting-cards">
            <article v-for="c in visibleStoryCards" :key="c.id">
              <div class="section-toolbar">
                <h3>{{ c.name }}</h3>
                <NButton size="tiny" @click="card(c)">{{
                  c.sourceCardId ? "查看" : "编辑"
                }}</NButton>
              </div>
              <p>{{ c.description || c.constraints || "暂无文字设定" }}</p>
              <div class="setting-images">
                <img
                  v-for="id in c.referenceIds"
                  :key="id"
                  :src="store.imageUrl(id)"
                  :alt="c.name + '参考图'"
                />
              </div>
              <p class="field-help">
                {{ c.sections.length }} 个分区{{
                  c.sourceCardId ? " · 来自创作资料库 · 只读" : ""
                }}
              </p>
              <div class="workbench-actions">
                <NPopconfirm
                  @positive-click="store.safe(() => store.deleteCard(c.id))"
                  ><template #trigger
                    ><NButton size="tiny" :disabled="store.busy"
                      >删除</NButton
                    ></template
                  >删除此设定资料？</NPopconfirm
                >
              </div>
            </article>
            <p v-if="!visibleStoryCards.length" class="field-help">
              此类别暂无资料。
            </p>
          </div>
          <CandidateShelf kind="settings" />
        </section>
        <section v-else-if="tab === 'memory'" class="studio-section">
          <div class="section-toolbar">
            <h2>故事记忆</h2>
          </div>
          <p class="field-help">
            选择已采用且已复核的章节，逐章提取摘要；后续创作只注入已启用的记忆。
          </p>
          <div class="memory-extract-controls">
            <NSelect
              v-model:value="memoryChapterIds"
              multiple
              filterable
              :disabled="store.busy"
              :options="
                eligibleMemoryChapters.map((chapter) => ({
                  label: `第 ${chapter.position} 章 · ${chapter.title}`,
                  value: chapter.id,
                }))
              "
              placeholder="选择要整理的章节"
            />
            <NButton
              type="primary"
              :disabled="store.busy || !memoryChapterIds.length"
              @click="
                store.safe(async () => {
                  store.notesChapterIds = [...memoryChapterIds];
                  await tool('notes');
                })
              "
              >提取章节摘要</NButton
            >
            <NButton
              :disabled="
                store.busy ||
                !store.detail.memories.some((memory) => memory.active)
              "
              @click="
                store.safe(async () => {
                  store.instruction =
                    '检查章节记忆间的冲突与后续变化，合并重复记录，并把已闭环伏笔整理为事实。';
                  await store.runTask('memory_tune');
                })
              "
              >记忆调优</NButton
            >
          </div>
          <p class="field-help">
            调优只分析启用的记忆。章节来源按顺序处理；手工记忆冲突会提示审核，不会自动覆盖。
          </p>
          <article
            v-for="m in store.detail.memories"
            :key="m.id"
            class="memory-entry"
          >
            <NCheckbox
              :checked="m.active"
              @update:checked="
                (v) =>
                  store.safe(async () => {
                    await store.api('memory:toggle', { id: m.id, active: v });
                    await store.refreshProject();
                  })
              "
              >{{ memoryLabels[m.kind] }}</NCheckbox
            >
            <p>{{ m.content }}</p>
            <small>{{
              m.manual
                ? "手工记录"
                : (store.detail.chapters.find((c) => c.id === m.chapterId)
                    ?.title ?? "来源已移除")
            }}</small
            ><NPopconfirm
              @positive-click="
                store.safe(async () => {
                  await store.api('memory:delete', {
                    projectId: store.detail!.project.id,
                    id: m.id,
                  });
                  await store.refreshProject();
                })
              "
              ><template #trigger
                ><NButton text size="tiny">删除</NButton></template
              >删除这条记忆？</NPopconfirm
            >
          </article>
          <CandidateShelf kind="memory" />
        </section>
        <section v-else-if="tab === 'images'" class="studio-section">
          <ImagePanel :initial-prompt="imagePrompt" />
        </section>
      </div>
      <WorkbenchPanel
        @illustration="
          (text) => {
            imagePrompt = text;
            tab = 'images';
          }
        "
      />
    </div>
    <CardEditor
      v-model:show="cardOpen"
      :card="editingCard"
      :project-id="store.detail.project.id"
      :initial-kind="cardKind"
    /><ChangeReview />
    <NModal
      v-model:show="historyOpen"
      preset="card"
      title="正文版本"
      :style="{ width: '760px' }"
      ><article v-for="v in history" :key="v.id" class="history-row">
        <button class="text-button" @click="viewing = v">
          {{ v.label }} · {{ v.createdAt }}</button
        ><VersionActions
          :id="v.id"
          :label="v.label"
          @changed="store.safe(versions)"
        /><NPopconfirm @positive-click="store.safe(() => restore(v.id))"
          ><template #trigger><NButton size="tiny">恢复</NButton></template
          >恢复前保存当前正文快照。</NPopconfirm
        >
      </article>
      <pre v-if="viewing" class="history-prose">{{ viewing.content }}</pre>
      <p v-if="!history.length">尚无快照。</p></NModal
    >
    <NModal
      v-model:show="importOpen"
      preset="card"
      title="带入资料库设定"
      :style="{ width: '600px' }"
      ><NSelect
        v-model:value="importIds"
        multiple
        :options="store.cards.map((c) => ({ label: c.name, value: c.id }))"
      /><template #footer
        ><NButton
          type="primary"
          :disabled="!importIds.length"
          @click="store.safe(copyCards)"
          >复制到本书</NButton
        ></template
      ></NModal
    >
  </main>
  <main v-else class="page">
    <p>{{ loading ? "正在打开作品……" : "作品不存在。" }}</p>
  </main>
</template>
<style scoped>
.chapter-planning {
  margin-bottom: 18px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.chapter-planning summary {
  cursor: pointer;
  font-weight: 600;
}
.chapter-planning article {
  margin: 12px 0;
}
.planning-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.studio-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.studio-heading {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border);
}
.studio-heading h1 {
  font-size: 22px;
  flex: 1;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-tabs {
  display: flex;
  gap: 22px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
}
.studio-tabs {
  overflow-x: auto;
  flex-shrink: 0;
}
.studio-tabs button {
  white-space: nowrap;
  border: 0;
  border-bottom: 3px solid transparent;
  background: transparent;
  padding: 14px 0;
  color: inherit;
  cursor: pointer;
}
.studio-tabs button.active {
  border-bottom-color: var(--primary);
  color: var(--primary);
}
.studio-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.studio-chapters {
  width: 190px;
  flex-shrink: 0;
  overflow: auto;
  border-right: 1px solid var(--border);
  padding: 18px 12px;
}
.studio-chapters article {
  padding: 10px 8px;
  border-radius: 7px;
  margin-top: 9px;
}
.studio-chapters article.active {
  background: var(--accent-soft);
}
.studio-chapters article.chapter-dragging {
  opacity: 0.45;
}
.studio-chapters article.chapter-drop-before {
  box-shadow: 0 -2px 0 var(--primary);
}
.studio-chapters article.chapter-drop-after {
  box-shadow: 0 2px 0 var(--primary);
}
.chapter-row-actions .chapter-drag-handle {
  cursor: grab;
  font-size: 18px;
}
.chapter-row-actions .chapter-drag-handle:active {
  cursor: grabbing;
}
.chapter-row-actions .chapter-drag-handle:disabled {
  cursor: default;
}
.chapter-link {
  display: block;
  border: 0;
  background: transparent;
  text-align: left;
  width: 100%;
  color: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.chapter-link small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 5px;
}
.chapter-row-actions {
  display: flex;
  gap: 8px;
  margin-top: 7px;
}
.chapter-row-actions button {
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  color: var(--muted);
}
.studio-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.studio-section {
  padding: 28px;
  max-width: 1080px;
  margin: auto;
}
.studio-text {
  padding: 22px;
  max-width: 960px;
  margin: auto;
}
.prose-heading {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.prose-heading .n-input {
  flex: 1;
}
.prose-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 15px 0;
}
.prose-footer span {
  flex: 1;
  font-size: 12px;
  color: var(--muted);
}
.overview-links {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-top: 24px;
}
.overview-links button {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: transparent;
  padding: 25px 10px;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.overview-links small {
  display: inline-block;
  color: var(--muted);
  margin-top: 8px;
}
.setting-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 25px;
}
.setting-domain-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 20px 0 10px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--border);
}
.setting-domain-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--surface-muted);
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}
.setting-domain-tabs button:hover {
  border-color: var(--border);
  background: var(--surface);
  color: var(--ink);
}
.setting-domain-tabs button.active {
  border-color: var(--accent-line);
  background: var(--surface);
  color: var(--primary);
  font-weight: 600;
}
.setting-domain-tabs button span {
  min-width: 20px;
  padding: 1px 5px;
  border-radius: 10px;
  background: var(--surface-muted);
  color: var(--muted);
  text-align: center;
  font-size: 12px;
}
.memory-extract-controls {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 760px;
  margin: 12px 0 20px;
}
.memory-extract-controls .n-select {
  flex: 1;
  min-width: 180px;
}
.setting-cards article {
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 17px;
}
.setting-cards p {
  white-space: pre-wrap;
  max-height: 110px;
  overflow: auto;
}
.setting-images {
  display: flex;
  gap: 6px;
}
.setting-images img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 5px;
}
.memory-entry {
  padding: 17px 0;
  border-bottom: 1px solid var(--border);
}
.memory-entry p {
  white-space: pre-wrap;
}
.memory-entry small {
  margin-right: 15px;
  color: var(--muted);
}
.history-row {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  align-items: center;
}
.history-row > button:first-child {
  flex: 1;
  text-align: left;
}
.history-prose {
  white-space: pre-wrap;
  max-height: 460px;
  overflow: auto;
  font: inherit;
  line-height: 1.8;
}
@media (max-width: 1250px) {
  .studio-chapters {
    width: 155px;
  }
  .studio-section {
    padding: 20px;
  }
  .studio-text {
    padding: 16px;
  }
}
</style>

<style scoped>
.studio-heading {
  flex-shrink: 0;
}
.studio-heading,
.studio-tabs,
.studio-chapters,
.setting-cards article,
.memory-entry,
.review-banner {
  border-color: var(--border);
}
.studio-chapters article.active {
  background: var(--accent-soft);
}
.studio-tabs button.active {
  border-color: var(--primary);
  color: var(--primary);
}
.chapter-link small,
.chapter-row-actions button,
.prose-footer span,
.memory-entry small,
.overview-links small {
  color: var(--muted);
}
.studio-section > p {
  line-height: 1.8;
}
.setting-cards h3 {
  margin: 0;
}
.studio-heading .text-button {
  white-space: nowrap;
}
.prose-footer,
.workbench-actions {
  flex-wrap: wrap;
}
.setting-cards .n-button {
  max-width: 100%;
}
@media (max-width: 1050px) {
  .studio-body {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    overflow-y: auto;
    align-items: start;
  }
  .studio-chapters {
    width: auto;
    max-height: 55vh;
  }
  .studio-content {
    overflow: visible;
  }
  .studio-body :deep(.studio-workbench) {
    grid-column: 1 / -1;
    width: auto;
    height: auto;
    max-height: none;
    border-left: 0;
    border-top: 1px solid var(--border);
  }
  .studio-heading {
    flex-wrap: wrap;
    padding: 12px;
  }
  .studio-heading h1 {
    min-width: 120px;
  }
  .studio-tabs {
    gap: 16px;
    padding: 0 12px;
  }
  .overview-links {
    grid-template-columns: 1fr;
  }
  .prose-heading {
    flex-wrap: wrap;
  }
  .studio-text,
  .studio-section {
    padding: 14px;
  }
  .memory-extract-controls {
    flex-direction: column;
  }
  .memory-extract-controls .n-select {
    width: 100%;
  }
}

/* —— 现代化外观层：仅视觉 —— */
.studio-page {
  background: var(--page);
}
.studio-heading {
  gap: 14px;
  padding: 14px 24px 10px;
  border-bottom: 0;
}
.studio-back {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink-soft);
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.studio-back:hover {
  color: var(--primary);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.studio-title {
  flex: 1;
  min-width: 0;
}
.studio-title small {
  display: block;
  font-size: 0.785714rem;
  letter-spacing: 1.5px;
  color: var(--gold-ink);
  margin-bottom: 2px;
}
.studio-heading h1 {
  font-family: var(--serif);
  font-size: 1.571429rem;
  font-weight: 600;
  letter-spacing: 1.5px;
  line-height: 1.3;
}
.studio-tabs {
  gap: 4px;
  margin: 0 24px 12px;
  padding: 4px;
  width: fit-content;
  max-width: calc(100% - 48px);
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-muted);
}
.studio-tabs button {
  padding: 7px 14px;
  border-bottom: 0;
  border-radius: 9px;
  color: var(--muted);
  font-size: 0.928571rem;
  transition:
    background 0.15s,
    color 0.15s,
    box-shadow 0.15s;
}
.studio-tabs button:hover {
  color: var(--ink);
}
.studio-tabs button.active {
  color: var(--ink);
  background: var(--surface);
  font-weight: 600;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 0 0 1px var(--border);
}
.studio-body {
  border-top: 1px solid var(--border);
}
.studio-chapters {
  width: 214px;
  padding: 16px 12px;
  background: var(--surface-muted);
}
.studio-chapters .section-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 6px;
}
.studio-chapters .section-toolbar strong {
  font-size: 0.785714rem;
  letter-spacing: 2px;
  color: var(--muted);
  font-weight: 600;
}
.studio-chapters article {
  position: relative;
  margin-top: 4px;
  padding: 8px 8px 6px;
  border-radius: 10px;
  transition:
    background 0.15s,
    box-shadow 0.15s;
}
.studio-chapters article:hover {
  background: var(--hover-color);
}
.studio-chapters article.active {
  background: var(--surface);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.06),
    0 0 0 1px var(--border);
}
.studio-chapters article.active .chapter-index {
  color: var(--on-primary);
  background: var(--primary);
}
.chapter-link {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 0.928571rem;
  line-height: 1.45;
  color: var(--ink);
}
.chapter-index {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-family: var(--serif);
  font-size: 0.785714rem;
  font-weight: 600;
  color: var(--muted);
  background: var(--surface);
  border: 1px solid var(--border);
}
.chapter-text {
  min-width: 0;
}
.chapter-link small {
  font-size: 0.714286rem;
  margin-bottom: 2px;
}
.chapter-row-actions {
  margin-top: 2px;
  padding-left: 32px;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.studio-chapters article:hover .chapter-row-actions,
.studio-chapters article.active .chapter-row-actions,
.chapter-row-actions:focus-within {
  opacity: 1;
}
.chapter-row-actions button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border-radius: 6px;
}
.chapter-row-actions button:hover:not(:disabled) {
  background: var(--hover-color);
  color: var(--ink);
}
.chapter-row-actions button[aria-label="删除章节"]:hover:not(:disabled) {
  color: var(--danger);
  background: var(--danger-soft);
}
.studio-text {
  padding: 22px 28px 0;
  max-width: 900px;
}
.prose-heading .n-input {
  font-family: var(--serif);
  font-size: 1.142857rem;
}
.prose-dock {
  position: sticky;
  bottom: 0;
  z-index: 3;
  margin: 14px -8px 0;
  padding: 10px 12px 12px;
  border: 1px solid var(--border);
  border-bottom: 0;
  border-radius: 14px 14px 0 0;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.05);
}
.prose-dock .prose-footer {
  margin: 0;
}
.prose-dock .workbench-actions {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.studio-text > :deep(.directions-panel) {
  margin-bottom: 24px;
}
.studio-section {
  padding: 28px 32px;
}
.studio-body :deep(.n-button--default-type) {
  border-color: var(--border);
  background: var(--surface-muted);
  color: var(--ink);
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}
.studio-body :deep(.n-button--default-type:not(.n-button--disabled):hover) {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--ink);
}
.studio-body :deep(.n-button:focus-visible) {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.studio-section > h2 {
  font-family: var(--serif);
  font-size: 1.428571rem;
  letter-spacing: 1px;
  margin-bottom: 8px;
}
.overview-links button {
  position: relative;
  text-align: left;
  padding: 18px 20px;
  border-radius: 14px;
  background: var(--surface);
  font-family: var(--serif);
  font-size: 1.071429rem;
  font-weight: 600;
  transition:
    transform 0.15s,
    box-shadow 0.15s,
    border-color 0.15s;
}
.overview-links button::after {
  content: "→";
  position: absolute;
  right: 18px;
  top: 18px;
  color: var(--muted);
  font-family: inherit;
}
.overview-links button:hover {
  transform: translateY(-2px);
  border-color: var(--accent-line);
  box-shadow: var(--shadow-md);
}
.overview-links small {
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  font-weight: 400;
  font-size: 0.857143rem;
}
.setting-cards article {
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.chapter-planning {
  border-radius: 14px;
  border-left: 3px solid var(--gold);
}
@media (max-width: 1050px) {
  .studio-tabs {
    margin: 0 12px 10px;
    max-width: calc(100% - 24px);
  }
  .chapter-row-actions {
    opacity: 1;
    padding-left: 0;
  }
}
@media (max-width: 1250px) {
  .studio-chapters {
    width: 168px;
    padding: 14px 8px;
  }
  .studio-text {
    padding: 18px 18px 0;
  }
}
</style>
