<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NInput, NSelect, NButton, NPopconfirm, NModal } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { blueprintLabels, orderedBlueprint } from "../../shared/blueprint";
import { modeTools } from "../../shared/tools";
import type {
  BlueprintLevel,
  BlueprintNode,
  Project,
} from "../../shared/types";
import CandidateShelf from "./CandidateShelf.vue";
const store = useWorkspace(),
  selected = ref(""),
  draft = ref<BlueprintNode | null>(null),
  original = ref<BlueprintNode | null>(null),
  saving = ref(false),
  history = ref<any[]>([]),
  showHistory = ref(false);
const nodes = computed(() => store.detail?.project.blueprint.nodes ?? []),
  ordered = computed(() => orderedBlueprint(nodes.value));
const supportedLevels = computed(
  () => modeTools[store.detail!.project.mode].blueprintLevels,
);
const aiSupported = computed(
  () => !!draft.value && supportedLevels.value.includes(draft.value.level),
);
const stale = computed(
  () =>
    !!selected.value &&
    JSON.stringify(nodes.value.find((n) => n.id === selected.value) ?? null) !==
      JSON.stringify(original.value),
);
const levels = computed(() =>
  [
    ...new Set([
      ...supportedLevels.value,
      ...(original.value ? [original.value.level] : []),
    ]),
  ].map((value) => ({
    label: blueprintLabels[value as BlueprintLevel],
    value,
  })),
);
const parents = computed(() =>
  nodes.value
    .filter((n) =>
      draft.value?.level === "scene"
        ? n.level === "chapter"
        : draft.value?.level === "chapter"
          ? n.level === "volume"
          : false,
    )
    .map((n) => ({ label: n.title, value: n.id })),
);
function select(id: string) {
  selected.value = id;
  const n = nodes.value.find((n) => n.id === id);
  draft.value = n ? JSON.parse(JSON.stringify(n)) : null;
  original.value = n ? JSON.parse(JSON.stringify(n)) : null;
}
function create() {
  selected.value = "";
  original.value = null;
  draft.value = {
    id: crypto.randomUUID(),
    level:
      store.detail?.project.mode === "novel" &&
      !nodes.value.some((n) => n.level === "synopsis")
        ? "synopsis"
        : "section",
    parentId: null,
    chapterId: null,
    title: "新分区",
    content: "",
  };
}
watch(
  () => store.detail?.project.id,
  () => {
    if (nodes.value[0]) select(nodes.value[0].id);
    else create();
  },
  { immediate: true },
);
watch(
  () =>
    JSON.stringify(nodes.value.find((n) => n.id === selected.value) ?? null),
  () => {
    if (
      selected.value &&
      JSON.stringify(draft.value) === JSON.stringify(original.value)
    ) {
      if (nodes.value.some((n) => n.id === selected.value))
        select(selected.value);
      else if (nodes.value[0]) select(nodes.value[0].id);
      else create();
    }
  },
);
function reload() {
  if (nodes.value.some((n) => n.id === selected.value)) select(selected.value);
  else if (nodes.value[0]) select(nodes.value[0].id);
  else create();
}
async function save() {
  if (!draft.value || !store.detail) return;
  saving.value = true;
  try {
    await store.flush();
    const p = await store.api<Project>("blueprint:save", {
      projectId: store.detail.project.id,
      node: draft.value,
      base: original.value,
    });
    store.detail.project = p;
    select(draft.value.id);
    store.notify("蓝图已保存，后续请求立即参考。");
  } finally {
    saving.value = false;
  }
}
async function remove() {
  if (!draft.value || !store.detail) return;
  store.detail.project = await store.api("blueprint:remove", {
    projectId: store.detail.project.id,
    id: draft.value.id,
  });
  if (nodes.value[0]) select(nodes.value[0].id);
  else create();
}
async function move(id: string, step: number) {
  if (!store.detail) return;
  store.detail.project = await store.api("blueprint:move", {
    projectId: store.detail.project.id,
    id,
    step,
  });
}
async function ai() {
  if (!draft.value) return;
  await save();
  store.blueprintTarget = {
    level: draft.value.level,
    id: draft.value.id,
    count: 1,
  };
  await store.chooseTool("blueprint");
}
async function versions() {
  history.value = await store.api(
    "blueprint:history",
    store.detail!.project.id,
  );
  showHistory.value = true;
}
async function restore(id: string) {
  store.detail!.project = await store.api("blueprint:restore", {
    projectId: store.detail!.project.id,
    id,
  });
  showHistory.value = false;
  if (nodes.value[0]) select(nodes.value[0].id);
}
</script>
<template>
  <section>
    <div class="section-toolbar">
      <div>
        <h2>故事蓝图</h2>
        <p class="field-help">
          {{ modeTools[store.detail!.project.mode].description }}
          保存即生效；与设定冲突时以蓝图为准。
        </p>
      </div>
      <NButton :disabled="store.busy" @click="store.safe(versions)"
        >版本</NButton
      >
    </div>
    <div class="blueprint-layout">
      <nav class="blueprint-nav">
        <NButton block :disabled="store.busy" @click="create"
          >添加蓝图节点</NButton
        >
        <div
          v-for="n in ordered"
          :key="n.id"
          :class="['blueprint-nav-row', { active: selected === n.id }]"
          :style="{
            paddingLeft:
              n.level === 'scene' ? '28px' : n.parentId ? '16px' : '0',
          }"
        >
          <button @click="select(n.id)">
            <small>{{ blueprintLabels[n.level] }}</small
            >{{ n.title }}</button
          ><button aria-label="上移" @click="store.safe(() => move(n.id, -1))">
            ↑</button
          ><button aria-label="下移" @click="store.safe(() => move(n.id, 1))">
            ↓
          </button>
        </div>
      </nav>
      <div v-if="draft" class="blueprint-form">
        <div v-if="stale" role="alert" class="field-help">
          此节点已被其他操作修改。当前未保存内容已保留，请读取最新版后再编辑。
          <NButton size="small" @click="reload">读取最新版</NButton>
        </div>
        <p v-if="!aiSupported" class="field-help">
          此规划从长篇模式保留，仍作为故事依据并可手工编辑。自由探索模式请使用自由分区进行
          AI 完善。
        </p>
        <label class="field-label">层级</label
        ><NSelect
          v-model:value="draft.level"
          :options="levels"
          :disabled="!!original || store.busy"
          @update:value="
            () => {
              draft!.parentId = null;
              draft!.chapterId = null;
            }
          "
        /><label class="field-label">名称</label
        ><NInput v-model:value="draft.title" />
        <template v-if="draft.level === 'chapter' || draft.level === 'scene'"
          ><label class="field-label">归属</label
          ><NSelect
            v-model:value="draft.parentId"
            :options="parents"
            :clearable="draft.level === 'chapter'"
            placeholder="选择上级规划"
        /></template>
        <template v-if="draft.level === 'chapter'"
          ><label class="field-label">关联正文</label
          ><NSelect
            v-model:value="draft.chapterId"
            clearable
            :options="
              store.detail!.chapters.map((c) => ({
                label: c.title,
                value: c.id,
              }))
            "
            placeholder="可留空"
        /></template>
        <label class="field-label">规划内容</label
        ><NInput
          v-model:value="draft.content"
          type="textarea"
          :autosize="{ minRows: 13, maxRows: 30 }"
        />
        <div class="workbench-actions">
          <NButton
            type="primary"
            :loading="saving"
            :disabled="store.busy || stale"
            @click="store.safe(save)"
            >保存蓝图</NButton
          ><NButton
            :disabled="store.busy || stale || !aiSupported"
            @click="store.safe(ai)"
            >AI 完善此节点</NButton
          ><NPopconfirm v-if="original" @positive-click="store.safe(remove)"
            ><template #trigger
              ><NButton :disabled="store.busy">删除</NButton></template
            >删除此节点及其下级规划？正文保留。</NPopconfirm
          >
        </div>
      </div>
    </div>
    <CandidateShelf kind="blueprint" />
    <NModal
      v-model:show="showHistory"
      preset="card"
      title="蓝图版本"
      :style="{ width: '720px' }"
      ><article v-for="v in history" :key="v.id">
        <details>
          <summary>
            {{ v.createdAt }} · {{ v.blueprint.nodes.length }} 个节点
          </summary>
          <pre class="history-content">{{
            v.blueprint.nodes
              .map((n: BlueprintNode) => n.title + "\n" + n.content)
              .join("\n\n")
          }}</pre>
          <NPopconfirm @positive-click="store.safe(() => restore(v.id))"
            ><template #trigger><NButton>恢复此版本</NButton></template
            >恢复前保存当前蓝图快照，正文保留。</NPopconfirm
          >
        </details>
      </article>
      <p v-if="!history.length">尚无历史版本。</p></NModal
    >
  </section>
</template>
<style scoped>
.blueprint-layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 24px;
  margin-top: 20px;
}
.blueprint-nav-row {
  display: flex;
  align-items: center;
  border-radius: 6px;
  margin-top: 5px;
}
.blueprint-nav-row.active {
  background: #e6eee9;
}
.blueprint-nav-row button {
  border: 0;
  background: transparent;
  cursor: pointer;
  color: inherit;
  padding: 7px;
}
.blueprint-nav-row button:first-child {
  flex: 1;
  text-align: left;
  min-width: 0;
  overflow-wrap: anywhere;
}
.blueprint-nav-row small {
  display: block;
  color: #6e7886;
  font-size: 11px;
}
.history-content {
  white-space: pre-wrap;
  max-height: 400px;
  overflow: auto;
}
@media (max-width: 1250px) {
  .blueprint-layout {
    grid-template-columns: 190px minmax(0, 1fr);
  }
}
</style>

<style scoped>
.blueprint-nav-row.active {
  background: var(--accent-soft);
}
.blueprint-nav-row small {
  color: var(--muted);
}
.blueprint-nav-row {
  border-color: var(--border);
}
@media (max-width: 1280px) {
  .blueprint-layout {
    grid-template-columns: 1fr;
  }
  .blueprint-nav {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .blueprint-nav > .n-button {
    width: auto;
  }
  .blueprint-nav-row {
    min-width: 140px;
    max-width: 100%;
    border: 1px solid var(--border);
  }
}
</style>
