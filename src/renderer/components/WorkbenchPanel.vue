<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NButton,
  NInput,
  NSelect,
  NInputNumber,
  NModal,
  NPopconfirm,
} from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { toolGroups, toolNames, modeTools } from "../../shared/tools";
import { effectiveRole } from "../../shared/roles";
import { blueprintLabels } from "../../shared/blueprint";
import RequestPreview from "./RequestPreview.vue";
import TextModelSelect from "./TextModelSelect.vue";
import type { TaskKind, TaskPreview, BlueprintLevel } from "../../shared/types";
const emit = defineEmits<{ illustration: [text: string] }>();
const store = useWorkspace(),
  group = ref("brainstorm"),
  preview = ref<TaskPreview | null>(null),
  inspectOpen = ref(false),
  renaming = ref(false),
  name = ref("");
const selectedGroup = computed(() =>
  toolGroups.find((g) => g.kinds.includes(store.taskKind)),
);
const tools = computed(() => selectedGroup.value?.kinds ?? [store.taskKind]);
const mode = computed(() => store.detail!.project.mode);
const modeConversations = computed(() =>
  store.conversations.filter(
    (c) => c.mode === mode.value && c.kind !== "settings",
  ),
);
const levels = computed(() =>
  modeTools[mode.value].blueprintLevels.map((v) => ({
    label: blueprintLabels[v as BlueprintLevel],
    value: v,
  })),
);
const targetNodes = computed(() =>
  store
    .detail!.project.blueprint.nodes.filter(
      (n) => n.level === store.blueprintTarget.level,
    )
    .map((n) => ({ label: n.title, value: n.id })),
);
const parentNodes = computed(() =>
  store
    .detail!.project.blueprint.nodes.filter((n) =>
      store.blueprintTarget.level === "scene"
        ? n.level === "chapter"
        : n.level === "volume",
    )
    .map((n) => ({ label: n.title, value: n.id })),
);
const checkCount = computed(() =>
  store.checkScope === "book"
    ? store.detail!.chapters.length
    : store.checkScope === "chapters"
      ? store.checkChapterIds.length
      : store.chapter
        ? 1
        : 0,
);
const checkCalls = computed(() =>
  store.checkAspect === "pacing"
    ? checkCount.value
    : (checkCount.value * (checkCount.value + 1)) / 2,
);
const model = computed(
  () =>
    store.taskModel ||
    effectiveRole(store.roles, store.taskKind).model ||
    store.settings?.text.model ||
    "",
);
const activeSet = computed(() => {
  const r = store.result;
  return r?.type === "changes"
    ? store.changeSets.find((s) => s.id === r.changeSetId)
    : null;
});
const visibleTurns = computed(() =>
  store.turns.filter(
    (t) => store.taskKind === "brainstorm" || t.id === store.selectedTurnId,
  ),
);
watch(
  () => [
    store.checkScope,
    store.checkAspect,
    store.checkCharacter,
    JSON.stringify(store.checkChapterIds),
    store.polishAspect,
    store.settingCardId,
    JSON.stringify(store.blueprintTarget),
  ],
  () => {
    void store.restoreConversation();
    store.scratch();
  },
);
async function choose(value: string) {
  group.value = value;
  const g = toolGroups.find((g) => g.id === value)!;
  await store.chooseTool(
    value === "writing"
      ? store.chapter?.content.trim()
        ? "continue"
        : "opening"
      : g.kinds[0],
  );
}
async function inspect() {
  await store.flush();
  preview.value = await store.api<TaskPreview>(
    "ai:preview",
    store.currentTaskRequest(),
  );
  inspectOpen.value = true;
}
async function inspectSaved() {
  const p = store.selectedTurn?.sourceSnapshot[0];
  if (p) {
    preview.value = p;
    inspectOpen.value = true;
  }
}
async function open(id: string) {
  await store.openConversation(id);
  store.scratch();
}
async function run() {
  await store.runTask();
  if (store.taskKind === "brainstorm" && !store.taskError) {
    store.instruction = "";
    store.scratch();
  }
}
</script>
<template>
  <aside class="studio-workbench">
    <header>
      <h2>创作工具</h2>
      <span
        >{{ mode === "novel" ? "长篇创作" : "自由探索" }} ·
        {{ model || "未配置模型" }}</span
      >
    </header>
    <label class="field-label">创作模型</label>
    <TextModelSelect
      v-model="store.taskModel"
      :role="store.taskKind"
      :disabled="store.busy"
      @update:model-value="store.scratch"
    />
    <div class="tool-grid">
      <button
        v-for="g in toolGroups"
        :key="g.id"
        :class="{ active: selectedGroup?.id === g.id }"
        :disabled="store.busy"
        @click="store.safe(() => choose(g.id))"
      >
        {{ g.name }}
      </button>
    </div>
    <div class="tool-form">
      <h3>{{ toolNames[store.taskKind] }}</h3>
      <p class="field-help" v-if="store.taskKind === 'brainstorm'">
        基于本书全部非正文资料聊一聊。仅保存聊天记录，想法采用前不会变成设定。
      </p>
      <p
        class="field-help"
        v-else-if="['opening', 'continue'].includes(store.taskKind)"
      >
        {{ modeTools[mode].writing }}
        {{
          store.taskKind === "opening"
            ? "只向空章写入开篇。"
            : "只在当前正文结尾追加。"
        }}
      </p>
      <NSelect
        v-if="tools.length > 1"
        :value="store.taskKind"
        :options="tools.map((k) => ({ label: toolNames[k], value: k }))"
        :disabled="store.busy"
        @update:value="(k) => store.safe(() => store.chooseTool(k as TaskKind))"
      />
      <template v-if="store.taskKind === 'blueprint'"
        ><label class="field-label">规划层级</label
        ><NSelect
          v-model:value="store.blueprintTarget.level"
          :disabled="store.busy"
          :options="levels"
          @update:value="
            () =>
              (store.blueprintTarget = {
                level: store.blueprintTarget.level,
                count: 1,
              })
          " /><label class="field-label">修改目标</label
        ><NSelect
          v-model:value="store.blueprintTarget.id"
          :disabled="store.busy"
          clearable
          :options="targetNodes"
          placeholder="新建规划节点"
          @update:value="() => (store.blueprintTarget.count = 1)" /><template
          v-if="!store.blueprintTarget.id"
          ><template
            v-if="['chapter', 'scene'].includes(store.blueprintTarget.level)"
            ><label class="field-label">上级规划</label
            ><NSelect
              v-model:value="store.blueprintTarget.parentId"
              :disabled="store.busy"
              clearable
              :options="parentNodes" /></template
          ><template v-if="store.blueprintTarget.level === 'chapter'"
            ><label class="field-label">关联章节（可选）</label
            ><NSelect
              v-model:value="store.blueprintTarget.chapterId"
              :disabled="store.busy"
              clearable
              :options="
                store.detail!.chapters.map((c) => ({
                  label: c.title,
                  value: c.id,
                }))
              " /></template
          ><label class="field-label">生成数量</label
          ><NInputNumber
            v-model:value="store.blueprintTarget.count"
            :disabled="store.busy"
            :min="1"
            :max="
              store.blueprintTarget.chapterId ||
              store.blueprintTarget.level === 'synopsis'
                ? 1
                : 30
            " /></template
      ></template>
      <template v-if="store.taskKind === 'polish'"
        ><label class="field-label">打磨方向</label
        ><NSelect
          v-model:value="store.polishAspect"
          :disabled="store.busy"
          :options="[
            { label: '表达', value: 'expression' },
            { label: '场景', value: 'scene' },
            { label: '对白', value: 'dialogue' },
          ]"
        />
        <p class="field-help">
          完整参考当前章，仅替换原选区。{{
            store.selection
              ? "已选择 " + store.selection.text.length + " 字"
              : "请先在正文中选择文段。"
          }}
        </p>
        <blockquote v-if="store.selection" class="selection-preview">
          {{ store.selection.text }}
        </blockquote></template
      >
      <template v-if="store.taskKind === 'check'"
        ><label class="field-label">检查方向</label
        ><NSelect
          v-model:value="store.checkAspect"
          :disabled="store.busy"
          :options="[
            { label: '连续性与设定', value: 'continuity' },
            { label: '节奏', value: 'pacing' },
            { label: '人物弧线', value: 'arc' },
          ]"
        /><NInput
          v-if="store.checkAspect === 'arc'"
          v-model:value="store.checkCharacter"
          :disabled="store.busy"
          placeholder="关注的人物（可选）"
        /><label class="field-label">检查范围</label
        ><NSelect
          v-model:value="store.checkScope"
          :disabled="store.busy"
          :options="[
            { label: '当前章', value: 'current' },
            { label: '选定章节', value: 'chapters' },
            { label: '全书', value: 'book' },
          ]"
        /><NSelect
          v-if="store.checkScope === 'chapters'"
          v-model:value="store.checkChapterIds"
          :disabled="store.busy"
          multiple
          :options="
            store.detail!.chapters.map((c) => ({ label: c.title, value: c.id }))
          "
        />
        <p class="field-help">
          报告只供参考。本次 {{ checkCount }} 章，预计
          {{ checkCalls }}
          次模型调用。连续性和人物弧线含两两跨章对照，可缩小章节范围。
        </p></template
      >
      <div class="conversation-controls">
        <NSelect
          :value="store.conversationId || null"
          :options="
            modeConversations.map((c) => ({ label: c.title, value: c.id }))
          "
          filterable
          placeholder="当前模式的历史对话"
          :disabled="store.busy"
          @update:value="(id) => store.safe(() => open(id))"
        />
        <div class="workbench-actions">
          <NButton
            size="tiny"
            :disabled="store.busy"
            @click="store.newConversation"
            >新对话</NButton
          ><NButton
            v-if="store.activeConversation"
            size="tiny"
            :disabled="store.busy"
            @click="
              name = store.activeConversation.title;
              renaming = true;
            "
            >重命名</NButton
          ><NPopconfirm
            v-if="store.activeConversation"
            @positive-click="store.safe(store.deleteConversation)"
            ><template #trigger
              ><NButton size="tiny" :disabled="store.busy"
                >删除对话</NButton
              ></template
            >删除对话记录？已生成的候选和已采用内容保留。</NPopconfirm
          >
        </div>
      </div>
      <div v-if="store.taskKind === 'brainstorm'" class="chat-messages">
        <article v-for="t in visibleTurns" :key="t.id">
          <div class="chat-user">{{ t.instruction }}</div>
          <pre class="chat-assistant">{{
            t.result?.text || t.rawResponse
          }}</pre>
          <p v-if="t.error" class="review-error">{{ t.error }}</p>
          <NButton
            size="tiny"
            :disabled="store.busy"
            @click="store.safe(() => store.selectVersion(t.id))"
            >{{
              t.id === store.selectedTurnId ? "当前分支" : "从此处继续"
            }}</NButton
          >
        </article>
      </div>
      <pre
        v-if="store.taskKind === 'brainstorm' && store.busy"
        class="chat-assistant"
        aria-live="polite"
        >{{ store.output || "正在回复……" }}</pre>
      <label class="field-label">{{
        store.taskKind === "brainstorm" ? "聊点什么？" : "本次要求"
      }}</label
      ><NInput
        v-model:value="store.instruction"
        type="textarea"
        :autosize="{ minRows: 3, maxRows: 10 }"
        :disabled="store.busy"
        :placeholder="
          store.taskKind === 'brainstorm'
            ? '聊聊人物、冲突、世界或故事可能性……'
            : '描述本次希望完成的内容……'
        "
        @update:value="store.scratch"
        @keydown.ctrl.enter="store.safe(run)"
      />
      <div class="workbench-actions">
        <NButton
          type="primary"
          :loading="store.busy"
          :disabled="store.imageBusy"
          @click="store.safe(run)"
          >{{ store.taskKind === "brainstorm" ? "发送" : "生成结果" }}</NButton
        ><NButton v-if="store.busy" @click="store.stopTask">停止</NButton
        ><NButton :disabled="store.busy" @click="store.safe(inspect)"
          >查看实际参考</NButton
        >
      </div>
      <NButton
        v-if="store.selectedTurn?.sourceSnapshot.length"
        text
        size="tiny"
        @click="inspectSaved"
        >查看此结果生成时的来源快照</NButton
      >
      <p v-if="store.taskError" role="alert" class="review-error">
        {{ store.taskError }}
      </p>
      <template v-if="store.taskKind !== 'brainstorm'"
        ><div v-if="store.turns.length" class="result-versions">
          <NSelect
            :value="store.selectedTurnId"
            :options="
              store.turns.map((t) => ({
                label: '版本 ' + t.number + ' · ' + t.status,
                value: t.id,
              }))
            "
            :disabled="store.busy"
            @update:value="(id) => store.safe(() => store.selectVersion(id))"
          />
        </div>
        <pre v-if="store.output" class="tool-result">{{
          store.result?.type === "changes"
            ? "已生成 " + (activeSet?.changes.length ?? 0) + " 项待审核修改。"
            : store.output
        }}</pre>
        <NButton
          v-if="
            store.result?.type === 'changes' &&
            store.selectedTurn?.status === 'complete'
          "
          type="primary"
          :disabled="store.busy"
          @click="store.reviewingChangeId = store.result.changeSetId"
          >查看差异与审核</NButton
        >
        <NButton
          v-if="
            store.result?.type === 'illustration' &&
            store.selectedTurn?.status === 'complete'
          "
          :disabled="store.busy"
          @click="emit('illustration', store.result.text)"
          >送入插画提示词</NButton
        >
        <div v-if="store.result?.type === 'report'" class="report-findings">
          <article v-for="b in store.result.report.batches" :key="b.chapterId">
            <strong
              >{{ b.title }} ·
              {{ b.status === "complete" ? "完成" : "失败" }}</strong
            ><NButton
              text
              size="small"
              @click="store.safe(() => store.switchChapter(b.chapterId))"
              >定位章节</NButton
            >
          </article>
        </div>
      </template>
    </div>
    <NModal v-model:show="renaming" preset="dialog" title="重命名对话"
      ><NInput v-model:value="name" /><template #action
        ><NButton
          @click="
            store.safe(async () => {
              await store.renameConversation(name);
              renaming = false;
            })
          "
          >保存</NButton
        ></template
      ></NModal
    >
    <NModal
      v-model:show="inspectOpen"
      preset="card"
      title="实际请求与参考资料"
      :style="{ width: '980px', maxWidth: '94vw' }"
      ><RequestPreview v-if="preview" :preview="preview"
    /></NModal>
  </aside>
</template>
<style scoped>
.studio-workbench {
  width: 390px;
  flex-shrink: 0;
  border-left: 1px solid #dce2e9;
  background: var(--surface, #fff);
  overflow-y: auto;
  padding: 22px;
  height: 100%;
  box-sizing: border-box;
}
.studio-workbench header h2 {
  font-size: 19px;
  margin: 0;
}
.studio-workbench header span {
  display: block;
  color: #77818d;
  font-size: 12px;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 7px;
  margin: 20px 0;
}
.tool-grid button {
  border: 1px solid #dce2e9;
  background: transparent;
  border-radius: 7px;
  padding: 10px;
  cursor: pointer;
  color: inherit;
}
.tool-grid button.active {
  border-color: #526f5c;
  background: #e6eee9;
  color: #294c36;
}
.tool-form h3 {
  margin: 10px 0;
}
.tool-form .n-select,
.tool-form .n-input-number {
  margin-bottom: 7px;
}
.conversation-controls {
  border-top: 1px solid #e1e5eb;
  padding-top: 15px;
  margin-top: 18px;
}
.tool-result,
.chat-assistant,
.preview-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.8;
}
.tool-result {
  max-height: 540px;
  overflow: auto;
}
.chat-messages {
  max-height: 450px;
  overflow: auto;
  margin-top: 15px;
}
.chat-messages article {
  border-bottom: 1px solid #e2e7ec;
  padding-bottom: 15px;
  margin-bottom: 15px;
}
.chat-user {
  background: #e9eff5;
  padding: 12px;
  border-radius: 8px;
}
.chat-assistant {
  margin: 13px 0;
}
.selection-preview {
  max-height: 100px;
  overflow: auto;
  margin: 10px 0;
  padding: 10px;
  background: #f0f4f7;
}
.review-error {
  color: #b42318;
  white-space: pre-wrap;
}
.result-versions {
  margin-top: 20px;
}
.reference-preview {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.reference-preview img {
  width: 150px;
  height: 150px;
  object-fit: contain;
}
.reference-preview figure {
  margin: 10px 0;
}
.report-findings article {
  display: flex;
  gap: 12px;
  padding: 8px;
}
</style>

<style scoped>
.studio-workbench {
  border-color: var(--border);
  background: var(--surface);
}
.tool-grid button,
.conversation-controls {
  border-color: var(--border);
}
.tool-grid button.active {
  background: var(--accent-soft);
  border-color: var(--primary);
  color: var(--primary);
}
.chat-user,
.selection-preview {
  background: var(--surface-muted);
}
.studio-workbench header span {
  color: var(--muted);
}
.tool-form > .field-help {
  line-height: 1.8;
}
.workbench-actions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 12px;
}
</style>
