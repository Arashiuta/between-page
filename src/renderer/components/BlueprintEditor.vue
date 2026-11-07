<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NInput,
  NSelect,
  NButton,
  NPopconfirm,
  NModal,
  NTree,
  type TreeOption,
  type TreeDropInfo,
  type TreeDragInfo,
} from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import {
  blueprintLabels,
  orderedBlueprint,
  inPlanningDomain,
  outlineLevels,
  relocateOutline,
  type OutlineDropPosition,
  type PlanningDomain,
} from "../../shared/blueprint";
import type {
  BlueprintLevel,
  BlueprintNode,
  Project,
  Chapter,
} from "../../shared/types";
import CandidateShelf from "./CandidateShelf.vue";
const props = withDefaults(defineProps<{ domain?: PlanningDomain }>(), {
  domain: "blueprint",
});
const emit = defineEmits<{ chapter: [id: string] }>();
const label = computed(() =>
  props.domain === "outline" ? "大纲" : "额外设定",
);
const store = useWorkspace(),
  selected = ref(""),
  draft = ref<BlueprintNode | null>(null),
  original = ref<BlueprintNode | null>(null),
  saving = ref(false),
  moving = ref(false),
  dragging = ref(""),
  outlineDrop = ref<{ id: string; position: OutlineDropPosition } | null>(null),
  history = ref<any[]>([]),
  showHistory = ref(false);
const nodes = computed(() =>
    (store.detail?.project.blueprint.nodes ?? []).filter((n) =>
      inPlanningDomain(n, props.domain),
    ),
  ),
  ordered = computed(() => orderedBlueprint(nodes.value));
const supportedLevels = computed(() =>
  props.domain === "outline" ? outlineLevels : ["section"],
);
const expanded = ref<string[]>([]);
const tree = computed<TreeOption[]>(() => {
  const children = (parentId: string | null): TreeOption[] =>
    nodes.value
      .filter((n) => n.parentId === parentId)
      .map((n) => {
        const nested = children(n.id);
        return {
          key: n.id,
          label: `${blueprintLabels[n.level]} · ${n.title}`,
          ...(nested.length ? { children: nested } : { isLeaf: true }),
        };
      });
  return children(null);
});
const stale = computed(
  () =>
    !!selected.value &&
    JSON.stringify(nodes.value.find((n) => n.id === selected.value) ?? null) !==
      JSON.stringify(original.value),
);
const unsaved = computed(
  () => JSON.stringify(draft.value) !== JSON.stringify(original.value),
);
const dragDisabled = computed(
  () =>
    store.busy ||
    store.directionsBusy ||
    store.saving ||
    saving.value ||
    moving.value ||
    unsaved.value ||
    stale.value,
);
function allowDrop(info: {
  node: TreeOption;
  dropPosition: OutlineDropPosition;
}) {
  if (
    dragDisabled.value ||
    !dragging.value ||
    dragging.value === String(info.node.key)
  )
    return false;
  try {
    relocateOutline(
      nodes.value,
      dragging.value,
      String(info.node.key),
      info.dropPosition,
    );
    return true;
  } catch {
    return false;
  }
}
// Use the hovered row as the exact target. NTree's default indentation-based
// retargeting can otherwise select a neighbouring node or suppress parent drops.
function nodeProps({ option }: { option: TreeOption }) {
  const key = String(option.key);
  const positionAt = (event: DragEvent): OutlineDropPosition => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = event.clientY - rect.top;
    if (allowDrop({ node: option, dropPosition: "inside" }))
      return offset <= 8
        ? "before"
        : offset >= rect.height - 8
          ? "after"
          : "inside";
    return offset < rect.height / 2 ? "before" : "after";
  };
  return {
    class:
      outlineDrop.value?.id === key
        ? "outline-drop-" + outlineDrop.value.position
        : "",
    onDragover: (event: DragEvent) => {
      event.stopPropagation();
      const position = positionAt(event);
      if (!allowDrop({ node: option, dropPosition: position })) {
        outlineDrop.value = null;
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      outlineDrop.value = { id: key, position };
    },
    onDragleave: (event: DragEvent) => {
      if (
        !(event.currentTarget as HTMLElement).contains(
          event.relatedTarget as Node | null,
        ) &&
        outlineDrop.value?.id === key
      )
        outlineDrop.value = null;
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (outlineDrop.value?.id !== key) return;
      void store.safe(() =>
        drop({
          event,
          node: option,
          dragNode: { key: dragging.value },
          dropPosition: positionAt(event),
        }),
      );
    },
  };
}
async function drop(info: TreeDropInfo) {
  if (!store.detail || !allowDrop(info)) return;
  const projectId = store.detail.project.id;
  moving.value = true;
  try {
    await store.flush();
    if (store.detail?.project.id !== projectId) return;
    const p = await store.api<Project>("outline:relocate", {
      projectId,
      id: String(info.dragNode.key),
      targetId: String(info.node.key),
      position: info.dropPosition,
    });
    if (store.detail?.project.id !== projectId) return;
    store.detail.project = {
      ...store.detail.project,
      blueprint: p.blueprint,
      updatedAt: p.updatedAt,
    };
    const parent = p.blueprint.nodes.find(
      (n) => n.id === String(info.dragNode.key),
    )?.parentId;
    if (parent) expanded.value = [...new Set([...expanded.value, parent])];
  } finally {
    moving.value = false;
    dragging.value = "";
    outlineDrop.value = null;
  }
}
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
      props.domain === "outline" &&
      !nodes.value.some((n) => n.level === "synopsis")
        ? "synopsis"
        : props.domain === "outline"
          ? "volume"
          : "section",
    parentId: null,
    chapterId: null,
    title: props.domain === "outline" ? "新规划" : "新条目",
    content: "",
  };
}
watch(
  () => store.detail?.project.id,
  () => {
    if (nodes.value.some((n) => n.id === store.planningNodeId))
      select(store.planningNodeId);
    else if (nodes.value[0]) select(nodes.value[0].id);
    else create();
    expanded.value = nodes.value.map((n) => n.id);
  },
  { immediate: true },
);
watch(
  () => store.planningNodeId,
  (id) => {
    if (nodes.value.some((n) => n.id === id)) {
      select(id);
      expanded.value = nodes.value.map((n) => n.id);
    }
  },
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
    const p = await store.api<Project>(`${props.domain}:save`, {
      projectId: store.detail.project.id,
      node: draft.value,
      base: original.value,
    });
    store.detail.project = p;
    select(draft.value.id);
    store.notify(`${label.value}已保存，后续请求立即参考。`);
  } finally {
    saving.value = false;
  }
}
async function remove() {
  if (!draft.value || !store.detail) return;
  store.detail.project = await store.api(`${props.domain}:remove`, {
    projectId: store.detail.project.id,
    id: draft.value.id,
  });
  if (nodes.value[0]) select(nodes.value[0].id);
  else create();
}
async function move(id: string, step: number) {
  if (!store.detail) return;
  store.detail.project = await store.api(`${props.domain}:move`, {
    projectId: store.detail.project.id,
    id,
    step,
  });
}
async function ai() {
  if (!draft.value) return;
  await save();
  const target = {
    level: draft.value.level,
    id: draft.value.id,
    count: 1,
  };
  if (props.domain === "outline") store.outlineTarget = target;
  else store.blueprintTarget = target;
  await store.chooseTool(props.domain);
}
async function aiChildren() {
  if (!draft.value) return;
  await save();
  const level =
    draft.value.level === "synopsis"
      ? "volume"
      : draft.value.level === "volume"
        ? "chapter"
        : "scene";
  store.outlineTarget = {
    level,
    count: 3,
    ...(level === "volume" ? {} : { parentId: draft.value.id }),
  };
  expanded.value = [...new Set([...expanded.value, draft.value.id])];
  await store.chooseTool("outline");
}
async function newProse() {
  if (!draft.value || !store.detail) return;
  await save();
  const c = await store.api<Chapter>("outline:create-chapter", {
    projectId: store.detail.project.id,
    id: draft.value.id,
  });
  await store.refreshProject();
  await store.switchChapter(c.id);
  emit("chapter", c.id);
}
async function versions() {
  history.value = await store.api(
    `${props.domain}:history`,
    store.detail!.project.id,
  );
  showHistory.value = true;
}
async function restore(id: string) {
  store.detail!.project = await store.api(`${props.domain}:restore`, {
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
        <h2>{{ domain === "outline" ? "大纲规划" : "额外设定" }}</h2>
        <p class="field-help">
          {{
            domain === "outline"
              ? "按总纲、卷、章与场景安排剧情；各层可留空。规划须遵守额外设定、资料与已发生事实。"
              : "自定义条目与内容，约束故事方向、人物行为和叙事规则。两种模式全程参考。"
          }}
          保存即生效。
        </p>
      </div>
      <NButton :disabled="store.busy" @click="store.safe(versions)"
        >版本</NButton
      >
    </div>
    <div
      :class="['blueprint-layout', { 'outline-layout': domain === 'outline' }]"
    >
      <nav :class="['blueprint-nav', { 'outline-nav': domain === 'outline' }]">
        <NButton block :disabled="store.busy" @click="create"
          >添加{{ label }}{{ domain === "outline" ? "节点" : "条目" }}</NButton
        >
        <NTree
          v-if="domain === 'outline'"
          :data="tree"
          block-line
          selectable
          :draggable="!dragDisabled"
          :allow-drop="allowDrop"
          :node-props="nodeProps"
          @dragstart="
            (info: TreeDragInfo) => (dragging = String(info.node.key))
          "
          @dragend="
            dragging = '';
            outlineDrop = null;
          "
          @drop="(info: TreeDropInfo) => store.safe(() => drop(info))"
          :selected-keys="selected ? [selected] : []"
          :expanded-keys="expanded"
          @update:selected-keys="
            (keys) => {
              if (keys[0]) select(String(keys[0]));
            }
          "
          @update:expanded-keys="(keys) => (expanded = keys.map(String))"
        />
        <p v-if="domain === 'outline'" class="field-help" aria-live="polite">
          {{
            unsaved
              ? "请先保存当前修改，再拖动节点。"
              : "拖动节点调整顺序；拖入卷纲或章纲可改变归属。"
          }}
        </p>
        <template v-if="domain === 'blueprint'">
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
            ><button
              aria-label="上移"
              @click="store.safe(() => move(n.id, -1))"
            >
              ↑</button
            ><button aria-label="下移" @click="store.safe(() => move(n.id, 1))">
              ↓
            </button>
          </div>
        </template>
      </nav>
      <div v-if="draft" class="blueprint-form">
        <div v-if="stale" role="alert" class="field-help">
          此节点已被其他操作修改。当前未保存内容已保留，请读取最新版后再编辑。
          <NButton size="small" @click="reload">读取最新版</NButton>
        </div>
        <template v-if="domain === 'outline'">
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
            " /></template
        ><label class="field-label">名称</label
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
        <label class="field-label">{{
          domain === "outline" ? "规划内容" : "约束内容"
        }}</label
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
            >保存{{ label }}</NButton
          ><NButton
            :disabled="store.busy || store.directionsBusy || stale"
            @click="store.safe(ai)"
            >AI 完善此{{ domain === "outline" ? "节点" : "条目" }}</NButton
          >
          <NButton
            v-if="domain === 'outline' && draft.level !== 'scene'"
            :disabled="store.busy || store.directionsBusy || stale"
            @click="store.safe(aiChildren)"
            >AI 生成下级</NButton
          >
          <NButton
            v-if="draft.level === 'chapter'"
            :disabled="store.busy || stale"
            @click="store.safe(newProse)"
            >{{ draft.chapterId ? "进入关联正文" : "创建关联正文" }}</NButton
          >
          <NPopconfirm v-if="original" @positive-click="store.safe(remove)"
            ><template #trigger
              ><NButton :disabled="store.busy">删除</NButton></template
            >删除此{{ label
            }}{{
              domain === "outline" ? "节点及其下级规划" : "条目"
            }}？正文保留。</NPopconfirm
          >
        </div>
      </div>
    </div>
    <CandidateShelf :kind="domain" />
    <NModal
      v-model:show="showHistory"
      preset="card"
      :title="label + '版本'"
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
            >恢复前保存当前{{ label }}快照，仅恢复{{
              label
            }}内容，正文保留。</NPopconfirm
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
.outline-layout {
  grid-template-columns: minmax(150px, 30%) minmax(0, 1fr);
  gap: 18px;
}
.outline-nav {
  display: block;
  min-width: 0;
}
.outline-nav > .n-button {
  width: 100%;
  margin-bottom: 14px;
}
.outline-nav :deep(.outline-drop-inside) {
  box-shadow: inset 0 0 0 2px var(--accent);
  background: var(--accent-soft);
}
.outline-nav :deep(.outline-drop-before) {
  box-shadow: inset 0 2px 0 var(--accent);
}
.outline-nav :deep(.outline-drop-after) {
  box-shadow: inset 0 -2px 0 var(--accent);
}
@media (max-width: 1050px) {
  .outline-layout {
    grid-template-columns: 1fr;
  }
}
</style>
