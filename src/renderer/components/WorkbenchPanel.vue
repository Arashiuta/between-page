<script setup lang="ts">
import { computed, ref } from "vue";
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
  Sparkles,
  Square,
} from "lucide-vue-next";
import { effectiveRole, roleDefinitions } from "../../shared/roles";
import { useWorkspace } from "../stores/workspace";
import type { TaskKind, TaskPreview } from "../../shared/types";

const store = useWorkspace();
const emit = defineEmits<{
  apply: [mode: "replace" | "append" | "outline" | "selection" | "prompt"];
}>();
const expanded = ref(false);
const inspecting = ref(false);
const previewLoading = ref(false);
const preview = ref<TaskPreview | null>(null);
const instruction = ref("");
const category = ref("正文");
const selectedTool = ref<TaskKind>("chapter");
const applyingMemory = ref(false);

const categories = ["灵感", "策划", "正文", "润色", "检查", "插画构思"];
const toolInfo: Record<TaskKind, {
  category: string;
  purpose: string;
  input: string;
  context: string;
  result: string;
  target: string;
}> = {
  brainstorm: { category: "灵感", purpose: "围绕一个核心点发散出不同方向，帮助打开思路。", input: "一个画面、人物关系、冲突或问题。", context: "故事想法、蓝图、人物与世界资料。", result: "多个可选方向及其吸引力、代价和冲突。", target: "灵感候选；确认后可放入蓝图。" },
  organize: { category: "灵感", purpose: "把零碎想法归类，指出相互关系与仍待确认之处。", input: "随手记录的句子、片段和问题。", context: "故事想法、蓝图与创作资料。", result: "整理后的主题、片段和待确认事项。", target: "蓝图候选。" },
  outline: { category: "策划", purpose: "规划整本故事方向，或按要求细化当前章节计划。", input: "希望发生的事件、人物变化、阶段或结局倾向。", context: "已有蓝图、章节计划、故事资料与记忆。", result: "有因果关系的剧情方案或章节计划。", target: "蓝图候选或章节计划草稿。" },
  adjust: { category: "策划", purpose: "根据新想法调整后续走向，同时保留已发生事实。", input: "要改变的方向及必须保留的内容。", context: "既有蓝图、采用章节、人物关系和伏笔。", result: "调整后的后续安排与受影响事项。", target: "蓝图候选。" },
  chapter: { category: "正文", purpose: "根据本章计划续写或起草正文。", input: "本章目标、场景要求、篇幅或留白。", context: "当前章节、蓝图、人物资料和正式记忆。", result: "可编辑的正文草稿。", target: "章节草稿；写入前可保存版本快照。" },
  scene: { category: "正文", purpose: "设计或改写一个有目标、阻力、转折的场景。", input: "场景目标、出场人物、希望出现的变化。", context: "选中文段、章节计划、人物资料与上下文。", result: "场景方案或场景正文。", target: "章节草稿。" },
  revise: { category: "润色", purpose: "按指定方向改写选中的段落，保留其余事实。", input: "先在正文选中文段，再写修改方向。", context: "选中文段、当前章节、人物与写作偏好。", result: "可直接替换选区的文段。", target: "选中文段；写入前保存版本快照。" },
  dialogue: { category: "润色", purpose: "打磨对白语气、节奏和潜台词。", input: "对白片段及人物当下的关系或情绪。", context: "当前章节、角色资料和故事记忆。", result: "对白替换稿或具体打磨建议。", target: "章节草稿。" },
  pacing: { category: "检查", purpose: "检查推进、重复、信息释放、张弛和章节钩子。", input: "检查范围及希望重点关注的问题。", context: "章节正文、章节计划和蓝图。", result: "有文本依据的节奏诊断与优先调整建议。", target: "诊断草稿；由作者决定是否采纳。" },
  arc: { category: "检查", purpose: "追踪人物欲望、选择、代价和阶段变化。", input: "关注的人物及其预期变化。", context: "人物设定、关系、采用章节与蓝图。", result: "人物弧线诊断及待补足环节。", target: "诊断草稿或蓝图候选。" },
  check: { category: "检查", purpose: "核对时间线、人物认知、设定规则和前后连续性。", input: "检查范围或想核对的人物、秘密、伏笔。", context: "采用章节、故事资料与正式记忆。", result: "带依据的问题清单和小幅修正选项。", target: "检查结果草稿。" },
  notes: { category: "检查", purpose: "从已采用章节提取事实和人物认知，先供作者审核。", input: "当前章节必须已经采用。", context: "该章节的已采用版本。", result: "分类记忆草稿。", target: "确认后写入故事记忆。" },
  prompt: { category: "插画构思", purpose: "把一个故事瞬间整理成完整的绘图提示词。", input: "想绘制的瞬间，也可先选择正文片段。", context: "人物当前外观、服装、场景和参考图。", result: "可编辑的静态画面提示词。", target: "插画生成面板。" },
};
const tools = computed(() => roleDefinitions.filter(
  (role) => role.id !== "material" && toolInfo[role.id as TaskKind]?.category === category.value,
));
const selectedInfo = computed(() => toolInfo[selectedTool.value]);
const currentRole = computed(() => effectiveRole(store.roles, selectedTool.value));
const currentModel = computed(() => currentRole.value.model || store.settings?.text.model || "");
const roleName = computed(() => roleDefinitions.find((role) => role.id === selectedTool.value)?.name || "创作任务");
const blueprintOutput = computed(() => ["outline", "adjust", "organize", "brainstorm"].includes(store.outputKind));

function chooseCategory(value: string) {
  category.value = value;
  const firstTool = roleDefinitions.find(
    (role) => role.id !== "material" && toolInfo[role.id as TaskKind]?.category === value,
  );
  if (firstTool) selectedTool.value = firstTool.id as TaskKind;
}

async function runTool() {
  if (!instruction.value.trim() && ["brainstorm", "organize", "outline", "adjust", "scene", "dialogue", "prompt"].includes(selectedTool.value)) {
    store.notify("先写下本次创作的想法或要求。", "info");
    return;
  }
  store.taskKind = selectedTool.value;
  store.instruction = instruction.value;
  await store.runTask(selectedTool.value, { instruction: instruction.value });
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
          <Sparkles :size="17" />
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
          <div class="workbench-section-heading"><h3>创作工具</h3></div>
          <div class="filter-tabs workbench-categories">
            <button v-for="item in categories" :key="item" :class="{ active: category === item }" @click="chooseCategory(item)">{{ item }}</button>
          </div>
          <div class="workbench-tool-grid">
            <button
              v-for="tool in tools"
              :key="tool.id"
              :class="['workbench-tool', { active: selectedTool === tool.id }]"
              @click="selectedTool = tool.id as TaskKind"
            >
              <strong>{{ tool.name }}</strong><span>{{ tool.description }}</span>
            </button>
          </div>
          <div class="workbench-tool-detail">
            <p>{{ selectedInfo.purpose }}</p>
            <dl>
              <div><dt>所需输入</dt><dd>{{ selectedInfo.input }}</dd></div>
              <div><dt>参考上下文</dt><dd>{{ selectedInfo.context }}</dd></div>
              <div><dt>结果形式</dt><dd>{{ selectedInfo.result }}</dd></div>
              <div><dt>写入目标</dt><dd>{{ selectedInfo.target }}</dd></div>
            </dl>
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
                <template #icon><Play :size="15" /></template>生成草稿
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
            :value="store.output"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 24 }"
            :disabled="store.busy"
            @update:value="store.output = $event; store.scratch()"
          />
          <div v-if="!store.busy && store.output" class="workbench-actions">
            <template v-if="['chapter', 'scene', 'dialogue'].includes(store.outputKind)">
              <NButton size="small" type="primary" @click="applyLatest('append')">追加到本章</NButton>
              <NButton size="small" @click="applyLatest('replace')">替换正文</NButton>
            </template>
            <NButton v-else-if="store.outputKind === 'revise' && store.outputSelection" size="small" type="primary" @click="applyLatest('selection')">替换选中文段</NButton>
            <NButton v-else-if="blueprintOutput" size="small" type="primary" @click="emit('apply', 'outline')">写入故事蓝图</NButton>
            <NButton v-else-if="store.outputKind === 'prompt'" size="small" type="primary" @click="emit('apply', 'prompt')"><template #icon><ImageIcon :size="14" /></template>去生成插画</NButton>
          </div>
          <p v-if="blueprintOutput" class="workbench-output-note">这份结果也已保存到故事蓝图的「创作候选」，可以先在蓝图页审核。</p>
          <div v-if="store.outputKind === 'notes' && store.memoryRecords?.length" class="memory-draft">
            <div class="memory-meta"><strong>待审核记忆条目</strong><span>{{ store.memoryRecords.length }} 条 · 来源版本 {{ store.memoryRevisionId.slice(0, 8) }}</span></div>
            <article v-for="(record, index) in store.memoryRecords" :key="index" class="memory-draft-row">
              <NSelect v-model:value="record.kind" :options="Object.entries({ fact: '故事事实', state: '人物状态', relationship: '关系变化', knowledge: '秘密与认知', foreshadow: '伏笔与承诺', summary: '章节摘要' }).map(([value, label]) => ({ value, label }))" @update:value="store.scratch" />
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
