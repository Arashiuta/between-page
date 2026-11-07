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
import { useWorkspace } from "../stores/workspace";
import type { Card, ProjectDetail, Revision } from "../../shared/types";
import { memoryLabels } from "../../shared/types";
import { freedomOptions } from "../../shared/creation";
import StoryEditor from "../components/StoryEditor.vue";
import WorkbenchPanel from "../components/WorkbenchPanel.vue";
import BlueprintEditor from "../components/BlueprintEditor.vue";
import CardEditor from "../components/CardEditor.vue";
import CandidateShelf from "../components/CandidateShelf.vue";
import ChangeReview from "../components/ChangeReview.vue";
import ImagePanel from "../components/ImagePanel.vue";
import VersionActions from "../components/VersionActions.vue";
const store = useWorkspace(),
  route = useRoute(),
  router = useRouter(),
  tab = ref("text"),
  loading = ref(false),
  cardOpen = ref(false),
  editingCard = ref<Card | null>(null),
  imagePrompt = ref(""),
  history = ref<Revision[]>([]),
  historyOpen = ref(false),
  viewing = ref<Revision | null>(null),
  importOpen = ref(false),
  importIds = ref<string[]>([]);
const tabs = computed(() => [
  { id: "overview", name: "作品概览" },
  { id: "text", name: "章节正文" },
  { id: "blueprint", name: "故事蓝图" },
  { id: "cards", name: "世界与人物" },
  { id: "memory", name: "故事记忆" },
  { id: "images", name: "故事插画" },
]);
watch(
  () => route.params.id,
  async (id) => {
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
  if (!store.detail || store.busy) return;
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
async function reorder(id: string, step: number) {
  if (!store.detail) return;
  await store.flush();
  const ids = store.detail.chapters.map((c) => c.id),
    a = ids.indexOf(id),
    b = a + step;
  if (b < 0 || b >= ids.length) return;
  [ids[a], ids[b]] = [ids[b], ids[a]];
  store.detail = await store.api<ProjectDetail>("chapter:reorder", {
    projectId: store.detail.project.id,
    ids,
  });
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
      <button class="text-button" @click="router.push('/')">← 书架</button>
      <h1>{{ store.detail.project.title }}</h1>
      <NSelect
        :value="store.detail.project.mode"
        :options="[
          { label: '自由探索', value: 'explore' },
          { label: '长篇创作', value: 'novel' },
        ]"
        :disabled="store.busy"
        style="width: 140px"
        @update:value="(v) => store.safe(() => modeChange(v))"
      /><NButton
        @click="
          store.safe(async () => {
            await store.flush();
            await store.api('project:export', store.detail!.project.id);
          })
        "
        >导出正文</NButton
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
          <strong>章节</strong
          ><NButton
            size="tiny"
            :disabled="store.busy"
            @click="
              store.safe(async () => {
                await store.newChapter();
                tab = 'text';
              })
            "
            >＋ 新章</NButton
          >
        </div>
        <article
          v-for="(c, i) in store.detail.chapters"
          :key="c.id"
          :class="{ active: store.chapterId === c.id }"
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
            <small
              >第 {{ i + 1 }} 章 · {{ c.dirty ? "草稿" : "已采用"
              }}{{ c.needsReview ? " · 待复核" : "" }}</small
            >{{ c.title }}
          </button>
          <div class="chapter-row-actions">
            <button
              aria-label="章节上移"
              :disabled="store.busy || i === 0"
              @click="store.safe(() => reorder(c.id, -1))"
            >
              ↑</button
            ><button
              aria-label="章节下移"
              :disabled="store.busy || i === store.detail.chapters.length - 1"
              @click="store.safe(() => reorder(c.id, 1))"
            >
              ↓</button
            ><NPopconfirm
              @positive-click="store.safe(() => store.deleteChapter(c.id))"
              ><template #trigger
                ><button :disabled="store.busy" aria-label="删除章节">
                  删除
                </button></template
              >删除本章、历史版本和关联记忆？</NPopconfirm
            >
          </div>
        </article>
      </aside>
      <div class="studio-content">
        <section v-if="tab === 'overview'" class="studio-section">
          <h2>作品概览</h2>
          <p>
            世界与人物、故事蓝图构成故事依据。可直接从已有资料开始写作，各层规划均可留空。
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
              故事蓝图<br /><small
                >{{ store.detail.project.blueprint.nodes.length }} 个节点</small
              ></button
            ><button @click="tab = 'text'">
              章节正文<br /><small>{{ store.detail.chapters.length }} 章</small>
            </button>
          </div>
        </section>
        <section v-else-if="tab === 'text'" class="studio-text">
          <template v-if="store.chapter"
            ><div class="prose-heading">
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
                :disabled="store.busy"
                @click="store.safe(() => tool('check'))"
                >检查故事</NButton
              ><NButton
                v-if="store.chapter.content.trim()"
                :disabled="store.busy"
                @click="
                  store.safe(async () => {
                    await store.newChapter();
                    await tool('opening');
                  })
                "
                >新建下一章</NButton
              >
            </div></template
          >
          <div v-else class="inline-empty">
            <p>创建一个空章开始写作。</p>
            <NButton type="primary" @click="store.safe(store.newChapter)"
              >新增章节</NButton
            >
          </div>
        </section>
        <section v-else-if="tab === 'blueprint'" class="studio-section">
          <BlueprintEditor />
        </section>
        <section v-else-if="tab === 'cards'" class="studio-section">
          <div class="section-toolbar">
            <div>
              <h2>世界与人物</h2>
              <p class="field-help">
                全部有效设定与关联参考图参与 AI
                请求。从创作资料库引入的资料只读。
              </p>
            </div>
            <NButton @click="card(null)">添加资料</NButton>
          </div>
          <div class="workbench-actions">
            <NButton @click="importOpen = true">从资料库带入</NButton>
          </div>
          <label class="field-label">世界规则</label
          ><NInput
            :value="store.detail.project.world"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 12 }"
            @update:value="(v) => store.editProject({ world: v })"
          /><label class="field-label">叙事偏好</label
          ><NInput
            :value="store.detail.project.style"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            @update:value="(v) => store.editProject({ style: v })"
          />
          <div class="setting-cards">
            <article v-for="c in store.detail.cards" :key="c.id">
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
          </div>
          <CandidateShelf kind="settings" />
        </section>
        <section v-else-if="tab === 'memory'" class="studio-section">
          <div class="section-toolbar">
            <h2>故事记忆</h2>
            <NButton
              :disabled="store.busy"
              @click="store.safe(() => tool('notes'))"
              >从已采用本章整理</NButton
            >
          </div>
          <p class="field-help">
            记忆须有已采用正文来源；蓝图中的未来事件不能成为事实。
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
  border-bottom: 1px solid #e0e5eb;
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
  border-bottom: 1px solid #dce2e9;
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
  border-bottom-color: #557762;
  color: #3b6149;
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
  border-right: 1px solid #dce2e9;
  padding: 18px 12px;
}
.studio-chapters article {
  padding: 10px 8px;
  border-radius: 7px;
  margin-top: 9px;
}
.studio-chapters article.active {
  background: #e6eee9;
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
  color: #7a8490;
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
  color: #7a8490;
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
  color: #7c8692;
}
.overview-links {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-top: 24px;
}
.overview-links button {
  border: 1px solid #dce2e9;
  border-radius: 9px;
  background: transparent;
  padding: 25px 10px;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.overview-links small {
  display: inline-block;
  color: #7b8591;
  margin-top: 8px;
}
.setting-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 25px;
}
.setting-cards article {
  border: 1px solid #dce2e9;
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
  border-bottom: 1px solid #dce2e9;
}
.memory-entry p {
  white-space: pre-wrap;
}
.memory-entry small {
  margin-right: 15px;
  color: #7c8692;
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
}
</style>
