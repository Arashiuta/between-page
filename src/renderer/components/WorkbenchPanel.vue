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
import {
  Lightbulb,
  ScrollText,
  ListTree,
  PenLine,
  Sparkles,
  ScanSearch,
  NotebookPen,
  Palette,
  Save,
  Plus,
  Expand,
  Trash2,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import { toolGroups, toolNames, modeTools } from "../../shared/tools";
import { effectiveRole } from "../../shared/roles";
import {
  blueprintLabels,
  outlineLevels,
  isLegacyPlanning,
} from "../../shared/blueprint";
import RequestPreview from "./RequestPreview.vue";
import TextModelSelect from "./TextModelSelect.vue";
import type {
  TaskKind,
  TaskPreview,
  BlueprintLevel,
  CreationTurn,
} from "../../shared/types";
const turnStatusLabels: Record<CreationTurn["status"], string> = {
  generating: "生成中",
  complete: "已完成",
  stopped: "已停止",
  error: "失败",
  interrupted: "已中断",
};
const emit = defineEmits<{ illustration: [text: string] }>();
const store = useWorkspace(),
  group = ref("brainstorm"),
  panelTab = ref<"create" | "saved">("create"),
  preview = ref<TaskPreview | null>(null),
  inspectOpen = ref(false),
  resultOpen = ref(false),
  sessionTitle = ref(""),
  renaming = ref(false),
  name = ref(""),
  renameId = ref("");
const selectedGroup = computed(() =>
  toolGroups.find((g) => g.kinds.includes(store.taskKind)),
);
const tools = computed(() => selectedGroup.value?.kinds ?? [store.taskKind]);
const mode = computed(() => store.detail!.project.mode);
const groupIcons: Record<string, unknown> = {
  brainstorm: Lightbulb,
  blueprint: ScrollText,
  outline: ListTree,
  writing: PenLine,
  polish: Sparkles,
  checking: ScanSearch,
  notes: NotebookPen,
  prompt: Palette,
};
const availableGroups = computed(() =>
  toolGroups.filter((g) => g.id !== "outline" || mode.value === "novel"),
);
const planningTarget = computed({
  get: () =>
    store.taskKind === "outline" ? store.outlineTarget : store.blueprintTarget,
  set: (value) => {
    if (store.taskKind === "outline") store.outlineTarget = value;
    else store.blueprintTarget = value;
  },
});
const savedConversations = computed(() => store.conversations);
const resultText = computed(() =>
  store.result?.type === "changes"
    ? activeSet.value?.changes.length
      ? `已生成 ${activeSet.value.changes.length} 项待审核修改。`
      : activeSet.value?.warnings?.length
        ? `发现 ${activeSet.value.warnings.length} 条手工记忆冲突提示。`
        : "没有需要审核的修改。"
    : store.output,
);
const expandedResultText = computed(() =>
  store.result?.type === "changes" && activeSet.value
    ? activeSet.value.changes.map((change) => change.after).join("\n\n")
    : resultText.value,
);
const levels = computed(() =>
  (store.taskKind === "outline" ? outlineLevels : ["section"]).map((v) => ({
    label: blueprintLabels[v as BlueprintLevel],
    value: v,
  })),
);
const targetNodes = computed(() =>
  store
    .detail!.project.blueprint.nodes.filter(
      (n) => n.level === planningTarget.value.level,
    )
    .map((n) => ({ label: n.title, value: n.id })),
);
const parentNodes = computed(() =>
  store
    .detail!.project.blueprint.nodes.filter((n) =>
      planningTarget.value.level === "scene"
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
const legacy = computed(
  () =>
    (!!activeSet.value && isLegacyPlanning(activeSet.value)) ||
    store.activeConversation?.kind === "settings" ||
    (store.activeConversation?.request.kind === "blueprint" &&
      store.activeConversation.request.target.level !== "section"),
);
const visibleTurns = computed(() =>
  store.turns.filter(
    (t) => store.taskKind === "brainstorm" || t.id === store.selectedTurnId,
  ),
);
watch(
  () => [store.conversationId, store.activeConversation?.title] as const,
  ([, title]) => {
    sessionTitle.value = title ?? "";
  },
  { immediate: true },
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
    JSON.stringify(store.outlineTarget),
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
async function openSaved(id: string) {
  await store.openConversation(id, true);
  panelTab.value = "create";
  group.value =
    toolGroups.find((item) => item.kinds.includes(store.taskKind))?.id ??
    "brainstorm";
  store.scratch();
}
function beginRename(id: string, title: string) {
  renameId.value = id;
  name.value = title;
  renaming.value = true;
}
async function confirmRename() {
  await store.renameConversation(name.value, renameId.value);
  renaming.value = false;
}
let committingSessionTitle = false;
async function commitSessionTitle() {
  const conversation = store.activeConversation;
  if (!conversation || committingSessionTitle) return;
  const title = sessionTitle.value.trim();
  if (!title) {
    sessionTitle.value = conversation.title;
    return;
  }
  if (title === conversation.title) {
    sessionTitle.value = title;
    return;
  }
  committingSessionTitle = true;
  try {
    const saved = await store.safe(async () => {
      await store.renameConversation(title, conversation.id);
      return true;
    });
    sessionTitle.value =
      store.activeConversation?.id === conversation.id
        ? store.activeConversation.title
        : saved
          ? title
          : conversation.title;
  } finally {
    committingSessionTitle = false;
  }
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
      <span class="workbench-mark">
        <Sparkles :size="16" />
      </span>
      <h2>创作工具</h2>
      <span>{{ mode === "novel" ? "长篇创作" : "自由探索" }} ·
        {{ model || "未配置模型" }}</span>
    </header>
    <nav class="workbench-tabs" role="tablist" aria-label="创作对话">
      <button role="tab" :aria-selected="panelTab === 'create'" :class="{ active: panelTab === 'create' }"
        @click="panelTab = 'create'">
        创作
      </button>
      <button role="tab" :aria-selected="panelTab === 'saved'" :class="{ active: panelTab === 'saved' }"
        @click="panelTab = 'saved'">
        已保存 <span>{{ savedConversations.length }}</span>
      </button>
    </nav>
    <section v-if="panelTab === 'saved'" class="saved-conversations">
      <h3>已保存</h3>
      <p v-if="!savedConversations.length" class="field-help">
        尚无保存的对话。
      </p>
      <article v-for="conversation in savedConversations" :key="conversation.id"
        :class="{ current: conversation.id === store.conversationId }">
        <button class="saved-conversation-open" @click="store.safe(() => openSaved(conversation.id))">
          <strong>{{ conversation.title }}</strong>
          <small>{{ toolNames[conversation.kind] }} ·
            {{ new Date(conversation.createdAt).toLocaleString() }}</small>
        </button>
        <div class="saved-conversation-actions">
          <NButton quaternary circle size="small" title="重命名对话" aria-label="重命名对话"
            @click="beginRename(conversation.id, conversation.title)"><template #icon>
              <PenLine :size="15" />
            </template></NButton>
          <NPopconfirm @positive-click="
            store.safe(() => store.deleteConversationById(conversation.id))
            ">
            <template #trigger>
              <NButton quaternary circle size="small" title="删除对话" aria-label="删除对话">
                <template #icon>
                  <Trash2 :size="15" />
                </template>
              </NButton>
            </template>
            删除这条已保存对话？已生成的候选和已采用内容保留。
          </NPopconfirm>
        </div>
      </article>
    </section>
    <div v-else class="workbench-pane">
      <label class="field-label">创作模型</label>
      <TextModelSelect v-model="store.taskModel" :role="store.taskKind" :disabled="store.busy"
        @update:model-value="store.scratch" />
      <div class="tool-grid">
        <button v-for="g in availableGroups" :key="g.id" :class="{ active: selectedGroup?.id === g.id }"
          :disabled="store.busy" @click="store.safe(() => choose(g.id))">
          <component :is="groupIcons[g.id]" :size="17" /><span>{{
            g.name
            }}</span>
        </button>
      </div>
      <div class="tool-form">
        <h3>{{ toolNames[store.taskKind] }}</h3>
        <p class="field-help" v-if="store.taskKind === 'brainstorm'">
          基于本书全部非正文资料聊一聊。仅保存聊天记录，想法采用前不会变成设定。
        </p>
        <p class="field-help" v-else-if="store.taskKind === 'blueprint'">
          自定义文章的特殊要求与故事约束，如视角限制、能力代价、感情线边界，供创作时持续参考。条目名称与内容均可自由定义。
        </p>
        <p class="field-help" v-else-if="['opening', 'continue', 'expand'].includes(store.taskKind)">
          {{ modeTools[mode].writing }}
          {{
            store.taskKind === "opening"
              ? "只向空章写入开篇。"
              : store.taskKind === "continue"
                ? "只在本章正文结尾追加，不转入下一章。"
                : "扩充当前章并生成完整替换稿，经审核后写入。"
          }}
        </p>
        <NSelect v-if="tools.length > 1" :value="store.taskKind"
          :options="tools.map((k) => ({ label: toolNames[k], value: k }))" :disabled="store.busy" @update:value="
            (k) => store.safe(() => store.chooseTool(k as TaskKind))
          " />
        <template v-if="store.taskKind === 'blueprint' || store.taskKind === 'outline'"><template
            v-if="store.taskKind === 'outline'"><label class="field-label">规划层级</label>
            <NSelect v-model:value="planningTarget.level" :disabled="store.busy" :options="levels" @update:value="
              () =>
              (planningTarget = {
                level: planningTarget.level,
                count: 1,
              })
            " />
          </template><label class="field-label">修改目标</label>
          <NSelect v-model:value="planningTarget.id" :disabled="store.busy" clearable :options="targetNodes"
            :placeholder="store.taskKind === 'outline' ? '新建规划节点' : '新建额外设定条目'
              " @update:value="() => (planningTarget.count = 1)" /><template v-if="!planningTarget.id"><template
              v-if="['chapter', 'scene'].includes(planningTarget.level)"><label class="field-label">上级规划</label>
              <NSelect v-model:value="planningTarget.parentId" :disabled="store.busy" clearable
                :options="parentNodes" />
            </template><template v-if="planningTarget.level === 'chapter'"><label class="field-label">关联章节（可选）</label>
              <NSelect v-model:value="planningTarget.chapterId" :disabled="store.busy" clearable :options="store.detail!.chapters.map((c) => ({
                label: c.title,
                value: c.id,
              }))
                " />
            </template><label class="field-label">生成数量</label>
            <NInputNumber v-model:value="planningTarget.count" :disabled="store.busy" :min="1" :max="planningTarget.chapterId || planningTarget.level === 'synopsis'
                ? 1
                : 30
              " />
          </template>
        </template>
        <template v-if="store.taskKind === 'polish'"><label class="field-label">打磨方向</label>
          <NSelect v-model:value="store.polishAspect" :disabled="store.busy" :options="[
            { label: '表达', value: 'expression' },
            { label: '场景', value: 'scene' },
            { label: '对白', value: 'dialogue' },
          ]" />
          <p class="field-help">
            完整参考当前章，仅替换原选区。{{
              store.selection
                ? "已选择 " + store.selection.text.length + " 字"
                : "请先在正文中选择文段。"
            }}
          </p>
          <blockquote v-if="store.selection" class="selection-preview">
            {{ store.selection.text }}
          </blockquote>
        </template>
        <template v-if="store.taskKind === 'check'"><label class="field-label">检查方向</label>
          <NSelect v-model:value="store.checkAspect" :disabled="store.busy" :options="[
            { label: '连续性与设定', value: 'continuity' },
            { label: '节奏', value: 'pacing' },
            { label: '人物弧线', value: 'arc' },
          ]" />
          <NInput v-if="store.checkAspect === 'arc'" v-model:value="store.checkCharacter" :disabled="store.busy"
            placeholder="关注的人物（可选）" /><label class="field-label">检查范围</label>
          <NSelect v-model:value="store.checkScope" :disabled="store.busy" :options="[
            { label: '当前章', value: 'current' },
            { label: '选定章节', value: 'chapters' },
            { label: '全书', value: 'book' },
          ]" />
          <NSelect v-if="store.checkScope === 'chapters'" v-model:value="store.checkChapterIds" :disabled="store.busy"
            multiple :options="store.detail!.chapters.map((c) => ({
              label: c.title,
              value: c.id,
            }))
              " />
          <p class="field-help">
            报告只供参考。本次 {{ checkCount }} 章，预计
            {{ checkCalls }}
            次模型调用。连续性和人物弧线含两两跨章对照，可缩小章节范围。
          </p>
        </template>
        <div class="conversation-controls">
          <label class="field-label" for="session-title">本次运行的会话标题</label>
          <NInput id="session-title" v-model:value="sessionTitle" :maxlength="200"
            :disabled="store.busy || !store.activeConversation" :placeholder="store.activeConversation
                ? '输入会话标题'
                : '生成第一轮后可编辑会话标题'
              " aria-label="本次运行的会话标题" @keydown.enter.prevent="commitSessionTitle" @blur="commitSessionTitle" />
          <div class="conversation-actions">
            <NButton v-if="store.activeConversation && !store.activeConversation.saved" class="conversation-action"
              type="primary" size="small" :disabled="store.busy" @click="store.safe(() => store.saveConversation())">
              <template #icon>
                <Save :size="14" />
              </template>保存对话
            </NButton>
            <NButton class="conversation-action" secondary size="small" :disabled="store.busy"
              @click="store.newConversation"><template #icon>
                <Plus :size="14" />
              </template>新对话</NButton>
            <NPopconfirm v-if="store.activeConversation" @positive-click="store.safe(store.deleteConversation)">
              <template #trigger>
                <NButton class="conversation-action" type="error" secondary size="small" :disabled="store.busy">
                  <template #icon>
                    <Trash2 :size="14" />
                  </template>
                  删除对话
                </NButton>
              </template>
              删除对话记录？已生成的候选和已采用内容保留。
            </NPopconfirm>
          </div>
        </div>
        <div v-if="store.taskKind === 'brainstorm'" class="chat-messages">
          <article v-for="t in visibleTurns" :key="t.id">
            <div class="chat-user">{{ t.instruction }}</div>
            <pre v-if="t.status === 'complete'" class="chat-assistant">{{
              t.result?.text || t.rawResponse
            }}</pre>
            <p v-if="t.error" class="review-error">{{ t.error }}</p>
            <NButton size="tiny" :disabled="store.busy" @click="store.safe(() => store.selectVersion(t.id))">{{
              t.id === store.selectedTurnId ? "当前分支" : "从此处继续"
            }}</NButton>
          </article>
        </div>
        <pre v-if="store.taskKind === 'brainstorm' && store.busy" class="generation-status" aria-live="polite">
      正在生成，完成后显示结果。</pre>
        <label class="field-label">{{
          store.taskKind === "brainstorm" ? "聊点什么？" : "本次要求"
          }}</label>
        <NInput v-model:value="store.instruction" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }"
          :disabled="store.busy" :placeholder="store.taskKind === 'brainstorm'
              ? '聊聊人物、冲突、世界或故事可能性……'
              : store.taskKind === 'blueprint'
                ? '描述希望新增或完善的特殊要求与约束，例如限制叙事视角、明确能力代价……'
                : '描述本次希望完成的内容……'
            " @update:value="store.scratch" @keydown.ctrl.enter="store.safe(run)" />
        <div class="workbench-actions">
          <NButton type="primary" :loading="store.busy" :disabled="store.imageBusy || store.directionsBusy || legacy"
            @click="store.safe(run)">{{
              store.taskKind === "brainstorm" ? "发送" : "生成结果"
            }}</NButton>
          <NButton v-if="store.busy" @click="store.stopTask">停止</NButton>
          <NButton :disabled="store.busy" @click="store.safe(inspect)">查看实际参考</NButton>
        </div>
        <p v-if="store.busy && store.taskKind !== 'brainstorm'" class="generation-status" role="status">
          正在生成，完成后显示结果。
        </p>
        <NButton v-if="store.selectedTurn?.sourceSnapshot.length" text size="tiny" @click="inspectSaved">查看此结果生成时的来源快照
        </NButton>
        <p v-if="store.taskError" role="alert" class="review-error">
          {{ store.taskError }}
        </p>
        <p v-if="legacy" class="field-help">
          旧版分层规划对话仅供查看，请在大纲规划中重新生成。
        </p>
        <template v-if="store.taskKind !== 'brainstorm'">
          <div v-if="store.turns.length" class="result-versions">
            <NSelect :value="store.selectedTurnId" :options="store.turns.map((t) => ({
              label:
                '版本 ' + t.number + ' · ' + turnStatusLabels[t.status],
              value: t.id,
            }))
              " :disabled="store.busy" @update:value="(id) => store.safe(() => store.selectVersion(id))" />
          </div>
          <div v-if="store.output && !store.busy" class="result-reading">
            <pre class="tool-result">{{ resultText }}</pre>
            <NButton quaternary circle size="small" title="放大查看结果" aria-label="放大查看结果" @click="resultOpen = true">
              <template #icon>
                <Expand :size="16" />
              </template></NButton>
          </div>
          <NButton v-if="
            store.result?.type === 'changes' &&
            store.selectedTurn?.status === 'complete'
          " type="primary" :disabled="store.busy" @click="store.reviewingChangeId = store.result.changeSetId">查看差异与审核
          </NButton>
          <NButton v-if="
            store.result?.type === 'illustration' &&
            store.selectedTurn?.status === 'complete'
          " :disabled="store.busy" @click="emit('illustration', store.result.text)">送入插画提示词</NButton>
          <div v-if="store.result?.type === 'report'" class="report-findings">
            <article v-for="b in store.result.report.batches" :key="b.chapterId">
              <strong>{{ b.title }} ·
                {{ b.status === "complete" ? "完成" : "失败" }}</strong>
              <NButton text size="small" @click="store.safe(() => store.switchChapter(b.chapterId))">定位章节</NButton>
            </article>
          </div>
        </template>
      </div>
    </div>
    <NModal v-model:show="renaming" preset="dialog" title="重命名对话">
      <NInput v-model:value="name" /><template #action>
        <NButton @click="
          store.safe(async () => {
            await store.renameConversation(name, renameId);
            renaming = false;
          })
          ">保存</NButton>
      </template>
    </NModal>
    <NModal v-model:show="inspectOpen" preset="card" title="实际请求与参考资料" :style="{ width: '980px', maxWidth: '94vw' }">
      <RequestPreview v-if="preview" :preview="preview" />
    </NModal>
    <NModal v-model:show="resultOpen" preset="card" title="生成结果"
      :style="{ width: 'min(1100px, 94vw)', maxHeight: '90vh' }"
      :content-style="{ overflow: 'auto', maxHeight: 'calc(90vh - 100px)' }">
      <pre class="expanded-result">{{ expandedResultText }}</pre>
    </NModal>
  </aside>
</template>
<style scoped>
.studio-workbench {
  width: 390px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
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
  color: var(--muted);
  font-size: 12px;
  margin-top: 6px;
  overflow-wrap: anywhere;
}

.workbench-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  margin: 18px 0 14px;
  padding: 4px;
  border-radius: 8px;
  background: var(--surface-muted);
}

.workbench-tabs button {
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}

.workbench-tabs button.active {
  color: var(--primary);
  background: var(--surface);
  border-color: var(--border);
  box-shadow: 0 1px 2px rgb(24 36 30 / 8%);
}

.workbench-tabs button:focus-visible,
.saved-conversation-open:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.saved-conversations h3 {
  margin: 8px 0 16px;
  font-size: 16px;
}

.saved-conversations article {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 6px 8px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid transparent;
  border-radius: 7px;
  background: var(--surface);
}

.saved-conversations article:hover {
  background: var(--surface-muted);
}

.saved-conversations article.current {
  border-left-color: var(--primary);
  background: var(--accent-soft);
}

.saved-conversation-open {
  min-width: 0;
  padding: 4px 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.saved-conversation-open strong,
.saved-conversation-open small {
  display: block;
  overflow-wrap: anywhere;
}

.saved-conversation-open small {
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
}

.saved-conversation-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 7px;
  margin: 20px 0;
}

.tool-grid button {
  border: 1px solid var(--border);
  background: transparent;
  border-radius: 7px;
  padding: 10px;
  cursor: pointer;
  color: inherit;
}

.tool-grid button.active {
  border-color: var(--primary);
  background: var(--accent-soft);
  color: var(--primary);
}

.tool-form h3 {
  margin: 10px 0;
}

.tool-form .n-select,
.tool-form .n-input-number {
  margin-bottom: 7px;
}

.conversation-controls {
  border-top: 1px solid var(--border);
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
  max-height: 340px;
  overflow: auto;
}

.generation-status {
  margin: 12px 0;
  color: var(--muted);
  font: inherit;
}

.result-reading {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.result-reading .tool-result {
  min-width: 0;
  flex: 1;
}

.expanded-result {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.85;
}

.chat-messages {
  max-height: 450px;
  overflow: auto;
  margin-top: 15px;
}

.chat-messages article {
  border-bottom: 1px solid var(--border);
  padding-bottom: 15px;
  margin-bottom: 15px;
}

.chat-user {
  background: var(--accent-soft);
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
  background: var(--surface-muted);
}

.review-error {
  color: var(--danger);
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

.tool-form>.field-help {
  line-height: 1.8;
}

.workbench-actions {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.conversation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 11px;
}

.conversation-actions .conversation-action {
  min-height: 34px;
  border-radius: 7px;
}

.conversation-actions .conversation-action:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

/* —— 现代化外观层：仅视觉 —— */
.studio-workbench {
  width: 380px;
  padding: 20px 20px 28px;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.studio-workbench header {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  align-items: center;
  padding-bottom: 16px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.workbench-mark {
  grid-row: span 2;
  width: 34px;
  height: 34px;
  display: grid !important;
  place-items: center;
  margin: 0 !important;
  border-radius: 10px;
  color: var(--gold-ink) !important;
  background: var(--gold-soft);
  border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent);
}

.studio-workbench header h2 {
  font-family: var(--serif);
  font-size: 1.214286rem;
  letter-spacing: 1px;
}

.studio-workbench header span:not(.workbench-mark) {
  margin-top: 2px;
}

.tool-grid {
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin: 16px 0 18px;
}

.tool-grid button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 2px 8px;
  border-radius: 12px;
  border-color: transparent;
  background: var(--surface-muted);
  color: var(--ink-soft);
  font-size: 0.785714rem;
  line-height: 1.25;
  text-align: center;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s,
    transform 0.15s;
}

.tool-grid button svg {
  color: var(--muted);
  transition: color 0.15s;
}

.tool-grid button:hover:not(:disabled) {
  background: var(--hover-color);
  color: var(--ink);
  transform: translateY(-1px);
}

.tool-grid button.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--primary);
  font-weight: 600;
}

.tool-grid button.active svg {
  color: var(--primary);
}

.tool-form {
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-muted) 55%, var(--surface));
}

.tool-form h3 {
  margin: 0 0 6px;
  font-family: var(--serif);
  font-size: 1.071429rem;
  letter-spacing: 0.5px;
}

.conversation-controls {
  border-top-style: dashed;
}

.chat-user {
  margin-left: 24px;
  border-radius: 14px 14px 4px 14px;
  background: var(--accent-soft);
  color: var(--ink);
}

.chat-assistant {
  padding: 12px 14px;
  border-radius: 14px 14px 14px 4px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.chat-messages article {
  border-bottom: 0;
}

.selection-preview {
  border-left: 3px solid var(--gold);
  border-radius: 0 8px 8px 0;
  font-family: var(--serif);
}

@media (max-width: 1250px) {
  .studio-workbench {
    width: 330px;
    padding: 16px 14px 24px;
  }
}
</style>
