<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { NButton, NDrawer, NDrawerContent, NInput, NSelect } from "naive-ui";
import {
  AlertCircle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  CornerDownLeft,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Play,
  Square,
} from "lucide-vue-next";
import { effectiveRole, roleDefinitions } from "../../shared/roles";
import { useWorkspace } from "../stores/workspace";
import { toolInfo, toolCategories } from "../../shared/tools";
import { freedomOptions, creativeFreedom } from "../../shared/creation";
import type { TaskKind, TaskPreview } from "../../shared/types";
import { memoryLabels } from "../../shared/types";
import brandMark from "../assets/brand-mark.svg";

const store = useWorkspace();
const emit = defineEmits<{
  apply: [mode: "replace" | "append" | "outline" | "selection" | "prompt"];
}>();
const expanded = ref(false);
const inspecting = ref(false);
const previewLoading = ref(false);
const preview = ref<TaskPreview | null>(null);
const instruction = computed({ get: () => store.instruction, set: value => { store.instruction = value; store.scratch(); } });
const category = ref("正文");
const selectedTool = computed({ get: () => store.taskKind, set: value => { store.taskKind = value; store.scratch(); } });
const applyingMemory = ref(false);

const categories = toolCategories;
watch(selectedTool, value => { category.value = toolInfo[value].category; }, { immediate: true });
watch(selectedTool, async () => {
  if (window.innerWidth <= 1050) expanded.value = true;
  await nextTick();
  document.querySelector('.workbench-tool-detail')?.scrollIntoView({ block: 'nearest' });
});
watch(() => store.busy, async () => {
  await nextTick();
  document.querySelector('.workbench-latest-output')?.scrollIntoView({ block: 'start' });
});
const tools = computed(() => roleDefinitions.filter(
  (role) => role.id !== "material" && toolInfo[role.id as TaskKind]?.category === category.value,
));
const selectedInfo = computed(() => toolInfo[selectedTool.value]);
const currentRole = computed(() => effectiveRole(store.roles, selectedTool.value));
const currentModel = computed(() => currentRole.value.model || store.settings?.text.model || "");
const roleName = computed(() => roleDefinitions.find((role) => role.id === selectedTool.value)?.name || "创作任务");
const blueprintOutput = computed(() => toolInfo[store.outputKind].output === "blueprint");

function chooseCategory(value: string) {
  category.value = value;
  const firstTool = roleDefinitions.find(
    (role) => role.id !== "material" && toolInfo[role.id as TaskKind]?.category === value,
  );
  if (firstTool) selectedTool.value = firstTool.id as TaskKind;
}

async function runTool() {
  store.taskKind = selectedTool.value;
  store.instruction = instruction.value;
  await store.runTask(selectedTool.value, { instruction: instruction.value });
}

async function useResult(kind: "develop" | "chapter") {
  if (store.busy || !store.output.trim()) return;
  const context = store.output;
  selectedTool.value = kind;
  const nextInstruction = kind === "develop"
    ? "将上一步结果中可用的构想整理为人物、世界或蓝图的分区建议，保留与现有设定不冲突的内容。"
    : "根据上一步构思继续当前故事，直接输出正文，按创作自由度补足必要细节。";
  instruction.value = nextInstruction;
  await store.runTask(kind, { instruction: nextInstruction, workflowContext: context });
}

function applyPlan() {
  if (!store.chapter || store.outputChapterId !== store.chapter.id) return;
  store.editChapter({ plan: store.output });
  store.notify("已写入本章计划，后续写作会参考。");
}

async function inspect() {
  if (!store.detail) return;
  previewLoading.value = true;
  await store.safe(async () => {
    await store.flush();
    preview.value = await store.api<TaskPreview>("ai:preview", {
      requestId: crypto.randomUUID(),
      kind: selectedTool.value,
      projectId: store.detail!.project.id,
      chapterId: store.chapter?.id,
      instruction: instruction.value,
      selection: store.selection?.text,
    });
    inspecting.value = true;
  });
  previewLoading.value = false;
}

function applyLatest(mode: "append" | "replace" | "selection") {
  store.scratch();
  emit("apply", mode);
}

async function applyMemoryDraft() {
  if (!store.outputChapterId || !store.memoryRevisionId || !store.memoryRecords?.length) return;
  applyingMemory.value = true;
  await store.safe(async () => {
    await store.flush();
    await store.api("memory:apply-generated", {
      chapterId: store.outputChapterId,
      revisionId: store.memoryRevisionId,
      records: store.memoryRecords,
    });
    await store.refreshProject();
    store.memoryRecords = null;
    store.scratch();
    await store.flush();
    store.notify("已将审核后的记忆写入故事。");
  });
  applyingMemory.value = false;
}
</script>

<template>
  <div class="workbench-dock" :class="{ expanded }">
    <button
      v-if="expanded"
      class="workbench-backdrop"
      type="button"
      aria-label="收起 AI 工作台"
      @click="expanded = false"
    ></button>
    <aside class="workbench-panel">
      <header class="workbench-heading">
        <div class="workbench-heading-title">
          <img class="workbench-brand" :src="brandMark" alt="页间" />
          <h3>AI 工作台</h3>
          <span class="online-dot" :class="{ offline: !store.settings?.text.hasKey }"></span>
        </div>
        <NButton
          quaternary
          circle
          size="small"
          :title="expanded ? '收起工作台' : '展开工作台'"
          :aria-label="expanded ? '收起工作台' : '展开工作台'"
          @click="expanded = !expanded"
        >
          <template #icon><Minimize2 v-if="expanded" :size="15" /><Maximize2 v-else :size="15" /></template>
        </NButton>
      </header>

      <div class="workbench-scroll">
        <div class="workbench-role-row">
          <strong>{{ roleName }}</strong>
          <RouterLink :to="{ path: '/roles', query: { role: selectedTool } }">编辑职责</RouterLink>
        </div>
        <label class="field-label first">{{ currentRole.model ? "文字模型（职责指定）" : "文字模型" }}</label>
        <NSelect
          :value="currentModel || null"
          :options="store.settings?.text.selectedModels.map((id) => ({ label: id, value: id })) || []"
          placeholder="在设置中勾选模型"
          :disabled="store.busy || !!currentRole.model"
          filterable
          @update:value="(value) => store.safe(() => store.setModel('text', value))"
        />

        <div class="workbench-tools">
          <label class="field-label">创作自由度</label>
          <NSelect :value="store.detail ? creativeFreedom(store.detail.project) : 'balanced'" :options="freedomOptions" :disabled="store.busy" @update:value="value => store.editProject({ creativeFreedom: value })" />
          <p class="field-help">{{ freedomOptions.find(item => item.value === (store.detail ? creativeFreedom(store.detail.project) : 'balanced'))?.description }} 已明确的设定始终优先，可随时切换。</p>
          <div class="workbench-section-heading"><h3>创作工具</h3></div>
          <div class="filter-tabs workbench-categories">
            <button v-for="item in categories" :key="item" :class="{ active: category === item }" :disabled="store.busy" @click="chooseCategory(item)">{{ item }}</button>
          </div>
          <div class="workbench-tool-grid">
            <button
              v-for="tool in tools"
              :key="tool.id"
              :class="['workbench-tool', { active: selectedTool === tool.id }]"
              :disabled="store.busy"
              @click="selectedTool = tool.id as TaskKind"
            >
              <strong>{{ tool.name }}</strong><span>{{ tool.description }}</span>
            </button>
          </div>
          <div class="workbench-tool-detail">
            <p>{{ selectedInfo.purpose }}</p>
            <details class="workbench-tool-reference"><summary>查看输入、参考与写入位置</summary><dl>
              <div><dt>所需输入</dt><dd>{{ selectedInfo.input }}</dd></div>
              <div><dt>参考上下文</dt><dd>{{ selectedInfo.context }}</dd></div>
              <div><dt>结果形式</dt><dd>{{ selectedInfo.result }}</dd></div>
              <div><dt>写入目标</dt><dd>{{ selectedInfo.target }}</dd></div>
            </dl></details>
            <label class="field-label">本次要求</label>
            <NInput
              v-model:value="instruction"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 7 }"
              :placeholder="selectedInfo.input"
              :disabled="store.busy"
            />
            <div v-if="store.selection?.text" class="selection-note">
              <FileText :size="13" />已选正文 {{ store.selection.text.length }} 字，将作为本次参考
            </div>
            <div class="context-note"><BookOpen :size="13" /><span>将参考本故事的蓝图、设定与有效记忆</span></div>
            <NButton text class="context-inspect" :loading="previewLoading" :disabled="store.busy" @click="inspect">查看本次参考内容</NButton>
            <div class="workbench-run-actions">
              <NButton v-if="!store.busy" type="primary" block @click="store.safe(runTool)">
                <template #icon><Play :size="15" /></template>{{ selectedTool === 'opening' ? '直接开始故事' : selectedTool === 'chapter' ? '接着写' : selectedTool === 'develop' ? '生成分区建议' : '生成草稿' }}
              </NButton>
              <NButton v-else block @click="store.safe(store.stopTask)">
                <template #icon><Square :size="13" /></template>停止生成，保留内容
              </NButton>
              <RouterLink v-if="!store.settings?.text.hasKey" to="/settings" class="setup-link">先配置文字模型 <ArrowUpRight :size="13" /></RouterLink>
            </div>
          </div>
        </div>

        <div v-if="store.taskError" class="task-error">
          <AlertCircle :size="15" /><p>{{ store.taskError }}</p>
        </div>
        <section v-if="store.output || store.busy" class="workbench-latest-output">
          <div class="workbench-section-heading">
            <h3><LoaderCircle v-if="store.busy" class="spin" :size="14" /><CheckCircle2 v-else :size="14" />{{ store.busy ? "正在生成" : "生成结果" }}</h3>
          </div>
          <NInput
            v-if="store.outputKind !== 'develop'"
            :value="store.output"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 24 }"
            :disabled="store.busy"
            @update:value="store.output = $event; store.scratch()"
          />
          <div v-else-if="store.developmentDraft" class="development-output-summary"><p>{{ store.developmentDraft.summary }}</p><p class="field-help">{{ store.developmentDraft.changes.length }} 个分区建议，可分别编辑、采用；已保存到蓝图候选。</p></div>
          <div v-else class="development-output-summary"><p>{{ store.busy ? '正在整理人物、世界与剧情分区…' : '本次未形成可采用的分区建议，可以调整要求后重新生成。' }}</p></div>
          <div v-if="!store.busy && store.output" class="workbench-actions">
            <template v-if="toolInfo[store.outputKind].output === 'prose'">
              <NButton size="small" type="primary" @click="applyLatest('append')">追加到本章</NButton>
              <NButton size="small" @click="applyLatest('replace')">替换正文</NButton>
            </template>
            <NButton v-else-if="store.outputKind === 'revise' && store.outputSelection" size="small" type="primary" @click="applyLatest('selection')">替换选中文段</NButton>
            <NButton v-else-if="blueprintOutput" size="small" type="primary" @click="emit('apply', 'outline')">写入故事蓝图</NButton>
            <NButton v-else-if="store.outputKind === 'develop' && store.developmentDraft" size="small" type="primary" @click="store.reviewDevelopment(store.developmentDraft)">查看并采用分区建议</NButton>
            <NButton v-else-if="store.outputKind === 'prompt'" size="small" type="primary" @click="emit('apply', 'prompt')"><template #icon><ImageIcon :size="14" /></template>去生成插画</NButton>
          </div>
          <div v-if="!store.busy && store.output && !store.taskError" class="workbench-actions">
            <NButton v-if="store.outputKind !== 'develop' && store.outputKind !== 'notes'" size="small" @click="store.safe(() => useResult('develop'))">据此完善设定与蓝图</NButton>
            <NButton v-if="['blueprint', 'development'].includes(toolInfo[store.outputKind].output) && store.chapter" size="small" @click="store.safe(() => useResult('chapter'))">根据结果写正文</NButton>
            <NButton v-if="store.outputKind === 'outline' && store.outputChapterId === store.chapter?.id" size="small" @click="applyPlan">写入本章计划</NButton>
          </div>
          <p v-if="blueprintOutput" class="workbench-output-note">这份结果也已保存到故事蓝图的「创作候选」，可以先在蓝图页审核。</p>
          <div v-if="store.outputKind === 'notes' && store.memoryRecords?.length" class="memory-draft">
            <div class="memory-meta"><strong>待审核记忆条目</strong><span>{{ store.memoryRecords.length }} 条 · 来源版本 {{ store.memoryRevisionId.slice(0, 8) }}</span></div>
            <article v-for="(record, index) in store.memoryRecords" :key="index" class="memory-draft-row">
              <NSelect v-model:value="record.kind" :options="Object.entries(memoryLabels).map(([value, label]) => ({ value, label }))" @update:value="store.scratch" />
              <NInput v-model:value="record.content" type="textarea" :autosize="{ minRows: 1, maxRows: 5 }" @update:value="store.scratch" />
            </article>
            <NButton size="small" type="primary" :loading="applyingMemory" @click="applyMemoryDraft">确认写入故事记忆</NButton>
          </div>
        </section>
        <div class="assistant-footnote"><CornerDownLeft :size="12" />生成内容先留在草稿区，由你决定采用。</div>
      </div>
    </aside>

    <NDrawer v-model:show="inspecting" placement="right" width="min(820px, 92vw)">
      <NDrawerContent title="本次职责与参考内容" closable>
        <template v-if="preview">
          <p class="material-help">模型：{{ preview.model || "尚未设置" }}。以下为当前编辑状态下构建的请求预览。</p>
          <h3>完整系统提示词</h3>
          <pre class="effective-prompt">{{ preview.systemPrompt }}</pre>
          <h3>创作资料覆盖情况</h3>
          <p class="field-help">固定设定与“始终参考”分区完整保留；原文按段选取。{{ preview.omitted ? `本次有 ${preview.omitted} 个片段未装入，可调整本章计划、整理资料或标记关键分区。` : "本次已装入全部启用的创作资料。" }}</p>
          <div class="coverage-list"><div v-for="(item, index) in preview.coverage" :key="index"><strong>{{ item.card }} · {{ item.source }}</strong><span>{{ item.included }} / {{ item.total }} 段</span></div></div>
          <h3>完整参考上下文</h3>
          <pre class="effective-prompt">{{ preview.context }}</pre>
        </template>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>
