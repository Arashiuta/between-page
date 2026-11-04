<script setup lang="ts">
import { computed, ref } from "vue";
import { NSelect, NInput, NButton, NDrawer, NDrawerContent } from "naive-ui";
import {
  Sparkles,
  ArrowUpRight,
  Square,
  Maximize2,
  FileText,
  CheckCircle2,
  BookOpen,
  Image,
  CornerDownLeft,
  AlertCircle,
  LoaderCircle,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { TaskKind } from "../../shared/types";
const store = useWorkspace(),
  expanded = ref(false);
defineEmits<{
  apply: [mode: "replace" | "append" | "outline" | "selection" | "prompt"];
}>();
const options = [
  { label: "续写 / 生成本章", value: "chapter" },
  { label: "规划故事蓝图", value: "outline" },
  { label: "调整后续走向", value: "adjust" },
  { label: "整理零碎灵感", value: "organize" },
  { label: "改写选中文段", value: "revise" },
  { label: "检查前后矛盾", value: "check" },
  { label: "整理正式记忆", value: "notes" },
  { label: "构思本章插画", value: "prompt" },
];
const hints: Record<TaskKind, string> = {
  chapter: "希望这一章发生什么？也可以留空，按本章计划继续。",
  outline: "故事想往哪里走？有哪些人物变化、冲突或结局想看到？",
  adjust: "例如：让他们逐渐失去信任，但保留之前真诚的关系。",
  organize: "把你零碎的想法直接写在这里，不必先整理。",
  revise: "先在正文选中一段文字，再描述修改要求。",
  check: "有特别想检查的人物、秘密或伏笔吗？",
  notes: "从当前采用版本提取事实。草稿和未来计划不会被当作已经发生的事。",
  prompt: "想画哪个瞬间？可以先在正文选中一段，或直接描述画面。",
};
const buttonLabel = computed(
  () => options.find((o) => o.value === store.taskKind)?.label || "开始创作",
);
const chapterOutput = computed(() => store.outputKind === "chapter");
const outlineOutput = computed(() =>
  ["outline", "adjust", "organize"].includes(store.outputKind),
);
</script>
<template>
  <aside class="assistant-panel">
    <div class="assistant-heading">
      <div class="assistant-avatar"><Sparkles :size="19" /></div>
      <div>
        <h3>创作搭档</h3>
        <span>一起，把故事往前写。</span>
      </div>
      <span
        class="online-dot"
        :class="{ offline: !store.settings?.text.hasKey }"
      ></span>
    </div>
    <div class="assistant-body">
      <div class="assistant-greeting">
        <span class="small-label">A LITTLE INSPIRATION</span>
        <p>下一页，<br />你想让什么发生？</p>
      </div>
      <label class="field-label first">这次一起做什么</label
      ><NSelect
        :value="store.taskKind"
        @update:value="store.taskKind = $event"
        :options="options"
        :disabled="store.busy"
      />
      <NInput
        :value="store.instruction"
        @update:value="
          store.instruction = $event;
          store.scratch();
        "
        type="textarea"
        :placeholder="hints[store.taskKind]"
        :autosize="{ minRows: 5, maxRows: 8 }"
        :disabled="store.busy"
        class="assistant-input"
      />
      <div v-if="store.selection?.text" class="selection-note">
        <FileText :size="13" />已选择
        {{ store.selection.text.length }} 字，将作为本次参考
      </div>
      <div class="context-note">
        <BookOpen :size="13" /><span>自动参考本故事的设定与有效记忆</span>
      </div>
      <NButton
        v-if="!store.busy"
        type="primary"
        block
        @click="store.safe(() => store.runTask())"
        ><template #icon><Sparkles :size="15" /></template
        >{{ buttonLabel }}</NButton
      ><NButton v-else block @click="store.safe(store.stopTask)"
        ><template #icon><Square :size="13" /></template
        >停止生成，保留内容</NButton
      >
      <RouterLink
        v-if="!store.settings?.text.hasKey"
        to="/settings"
        class="setup-link"
        >先配置文字模型 <ArrowUpRight :size="13"
      /></RouterLink>
      <div v-if="store.taskError" class="task-error">
        <AlertCircle :size="15" />
        <p>{{ store.taskError }}</p>
      </div>
      <div v-if="store.output || store.busy" class="assistant-result">
        <div class="result-heading">
          <span
            ><LoaderCircle
              v-if="store.busy"
              class="spin"
              :size="13"
            /><CheckCircle2 v-else :size="13" />{{
              store.busy ? "正在构思……" : "这次的创作结果"
            }}</span
          ><button
            aria-label="展开创作结果"
            class="icon-button"
            @click="expanded = true"
          >
            <Maximize2 :size="14" />
          </button>
        </div>
        <pre class="result-preview" @dblclick="expanded = true">{{
          store.output || "让想法慢慢成形……"
        }}</pre>
        <button class="text-button result-expand" @click="expanded = true">
          展开阅读与编辑 <ArrowUpRight :size="13" />
        </button>
        <div v-if="!store.busy && store.output" class="result-actions">
          <template v-if="chapterOutput"
            ><button
              class="button primary small-button"
              @click="$emit('apply', 'append')"
            >
              追加到本章</button
            ><button
              class="button small-button"
              @click="$emit('apply', 'replace')"
            >
              替换正文
            </button></template
          ><button
            v-else-if="outlineOutput"
            class="button primary small-button"
            @click="$emit('apply', 'outline')"
          >
            写入故事蓝图</button
          ><button
            v-else-if="store.outputKind === 'revise'"
            class="button primary small-button"
            :disabled="!store.outputSelection"
            @click="$emit('apply', 'selection')"
          >
            替换选中文段</button
          ><button
            v-else-if="store.outputKind === 'prompt'"
            class="button primary small-button"
            @click="$emit('apply', 'prompt')"
          >
            <Image :size="13" />去生成插画
          </button>
        </div>
      </div>
      <div v-else class="assistant-tip">
        <span>一点小提示</span>
        <p>
          不必一次想好所有细节。你可以先让角色经历一次相遇，再决定故事会走向哪里。
        </p>
        <div class="tip-line"></div>
      </div>
    </div>
    <div class="assistant-footnote">
      <CornerDownLeft :size="12" /> 生成内容先留在草稿区，由你决定采用。
    </div>
    <NDrawer v-model:show="expanded" :width="680"
      ><NDrawerContent title="创作草稿" closable
        ><p class="muted small">
          可以先修改这里的内容，再写入故事。草稿不会自动成为正式设定。
        </p>
        <NInput
          :value="store.output"
          @update:value="
            store.output = $event;
            store.scratch();
          "
          type="textarea"
          :autosize="{ minRows: 20 }"
          :disabled="store.busy"
          class="expanded-output"
        />
        <div v-if="store.taskError" class="task-error">
          {{ store.taskError }}
        </div>
        <template #footer
          ><div class="modal-footer">
            <NButton v-if="!store.busy && chapterOutput && store.output" type="primary" @click="$emit('apply','append');expanded=false">追加到本章</NButton>
            <NButton v-if="!store.busy && chapterOutput && store.output" @click="$emit('apply','replace');expanded=false">替换正文</NButton>
            <NButton v-if="!store.busy && outlineOutput && store.output" type="primary" @click="$emit('apply','outline');expanded=false">写入故事蓝图</NButton>
            <NButton v-if="!store.busy && store.outputKind==='revise' && store.outputSelection" type="primary" @click="$emit('apply','selection');expanded=false">替换选中文段</NButton>
            <NButton v-if="!store.busy && store.outputKind==='prompt' && store.output" type="primary" @click="$emit('apply','prompt');expanded=false">去生成插画</NButton>
            <NButton @click="expanded = false">回到故事</NButton
            ><NButton v-if="store.busy" @click="store.safe(store.stopTask)"
              >停止生成</NButton
            >
          </div></template
        ></NDrawerContent
      ></NDrawer
    >
  </aside>
</template>
