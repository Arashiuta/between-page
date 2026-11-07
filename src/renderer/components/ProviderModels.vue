<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NInput,
  NButton,
  NSelect,
  NCheckbox,
  NModal,
  NAlert,
  NPagination,
  NInputNumber,
} from "naive-ui";
import { Download, ListChecks, Plus } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import { modelSelection } from "../../shared/models";
import { defaultCapabilities } from "../../shared/tools";
import type { ModelCapabilities } from "../../shared/types";

interface Draft {
  baseUrl: string;
  key: string;
  model: string;
  selectedModels: string[];
  availableModels: string[];
  capabilities: Record<string, ModelCapabilities>;
}
const props = defineProps<{ kind: "text" | "image" }>();
const config = defineModel<Draft>({ required: true });
const store = useWorkspace();
const show = ref(false),
  loading = ref(false),
  error = ref("");
const candidates = ref<string[]>([]),
  checked = ref<string[]>([]);
const search = ref(""),
  manual = ref(""),
  page = ref(1);
const filtered = computed(() =>
  candidates.value.filter((id) =>
    id.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const rows = computed(() =>
  filtered.value.slice((page.value - 1) * 50, page.value * 50),
);
watch(search, () => (page.value = 1));
const options = computed(() =>
  config.value.selectedModels.map((id) => ({ label: id, value: id })),
);
const capabilityModel = ref(config.value.model);
watch(
  () => config.value.model,
  (model) => (capabilityModel.value = model),
);
const capability = computed({
  get: () =>
    config.value.capabilities[capabilityModel.value] ?? defaultCapabilities(),
  set: (value: ModelCapabilities) =>
    (config.value = {
      ...config.value,
      capabilities: {
        ...config.value.capabilities,
        [capabilityModel.value]: value,
      },
    }),
});
function open() {
  candidates.value = [
    ...new Set([
      ...config.value.availableModels,
      ...config.value.selectedModels,
    ]),
  ].sort();
  checked.value = [...config.value.selectedModels];
  search.value = "";
  manual.value = "";
  page.value = 1;
  error.value = "";
  show.value = true;
}
async function fetchModels() {
  if (!show.value) open();
  loading.value = true;
  error.value = "";
  try {
    const list = await store.api<string[]>("settings:models", {
      kind: props.kind,
      baseUrl: config.value.baseUrl,
      key: config.value.key,
    });
    candidates.value = [...new Set([...list, ...checked.value])].sort();
    syncSelection();
    page.value = 1;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "获取模型列表失败。";
  } finally {
    loading.value = false;
  }
}
function toggle(id: string, value: boolean) {
  if (value && !checked.value.includes(id)) {
    if (checked.value.length >= 200) {
      error.value = "最多勾选 200 个模型。";
      return;
    }
    checked.value.push(id);
  } else if (!value)
    checked.value = checked.value.filter((item) => item !== id);
  syncSelection();
}
function add() {
  const id = manual.value.trim();
  if (!id) return;
  if (!candidates.value.includes(id))
    candidates.value = [...candidates.value, id].sort();
  toggle(id, true);
  manual.value = "";
  search.value = id;
}
function syncSelection() {
  config.value = {
    ...config.value,
    ...modelSelection(config.value.model, checked.value, candidates.value),
  };
}
</script>
<template>
  <label class="field-label">默认模型</label>
  <NSelect
    v-model:value="config.model"
    :options="options"
    filterable
    placeholder="获取列表并勾选模型，或手动添加"
  />
  <div class="model-toolbar">
    <NButton size="small" @click="fetchModels"
      ><template #icon><Download :size="14" /></template>获取模型列表</NButton
    >
    <NButton size="small" @click="open"
      ><template #icon><ListChecks :size="14" /></template>管理模型（{{
        config.selectedModels.length
      }}）</NButton
    >
  </div>
  <details
    v-if="kind === 'text' && config.selectedModels.length"
    class="model-capabilities"
  >
    <summary>模型能力与上下文预算</summary>
    <p class="field-help">
      按服务商说明填写。有关联参考图时，未启用图片输入的模型会阻止请求；软件不会省略图片继续调用。预算采用保守估算。
    </p>
    <NSelect v-model:value="capabilityModel" :options="options" />
    <NCheckbox
      :checked="capability.vision"
      @update:checked="(vision) => (capability = { ...capability, vision })"
      >支持图片输入</NCheckbox
    >
    <label class="field-label">上下文容量（token）</label>
    <NInputNumber
      :value="capability.contextTokens"
      :min="4096"
      :max="10000000"
      @update:value="
        (v) => {
          if (v) capability = { ...capability, contextTokens: v };
        }
      "
    />
    <label class="field-label">预留并限制输出（token）</label>
    <NInputNumber
      :value="capability.outputTokens"
      :min="256"
      :max="200000"
      @update:value="
        (v) => {
          if (v) capability = { ...capability, outputTokens: v };
        }
      "
    />
  </details>
  <NModal
    v-model:show="show"
    preset="card"
    :title="kind === 'text' ? '选择文字模型' : '选择插画模型'"
    :style="{ width: '680px', maxWidth: '90vw' }"
    :mask-closable="!loading"
    :closable="!loading"
    :close-on-esc="!loading"
  >
    <p class="model-help">勾选或取消勾选后自动保存，可在设置页选择默认模型。</p>
    <div class="model-search">
      <NInput v-model:value="search" placeholder="搜索模型名称" clearable />
      <NButton :loading="loading" @click="fetchModels">刷新列表</NButton>
    </div>
    <NAlert v-if="error" type="error" :bordered="false" class="model-error">{{
      error
    }}</NAlert>
    <div class="model-selection-summary">
      <span>共 {{ filtered.length }} 个 · 已勾选 {{ checked.length }} 个</span>
      <div>
        <NButton
          text
          @click="rows.forEach((id) => toggle(id, true))"
          :disabled="loading || !rows.length"
          >全选本页</NButton
        ><NButton
          text
          @click="
            checked = [];
            syncSelection();
          "
          :disabled="loading || !checked.length"
          >清空勾选</NButton
        >
      </div>
    </div>
    <div class="model-list" :aria-busy="loading">
      <NCheckbox
        v-for="id in rows"
        :key="id"
        :checked="checked.includes(id)"
        :disabled="loading || (!checked.includes(id) && checked.length >= 200)"
        @update:checked="(value) => toggle(id, value)"
        >{{ id }}</NCheckbox
      >
      <p v-if="!rows.length" class="model-empty">
        {{
          loading ? "正在获取模型…" : "没有匹配的模型，可刷新列表或手动添加。"
        }}
      </p>
    </div>
    <NPagination
      v-if="filtered.length > 50"
      v-model:page="page"
      :page-size="50"
      :item-count="filtered.length"
      :page-slot="7"
      class="model-pagination"
    />
    <div class="model-manual">
      <NInput
        v-model:value="manual"
        placeholder="手动添加模型名称（服务未提供列表时）"
        :maxlength="500"
        :disabled="loading"
        @keyup.enter="add"
      />
      <NButton :disabled="loading || !manual.trim()" @click="add"
        ><template #icon><Plus :size="14" /></template>添加</NButton
      >
    </div>
    <template #footer
      ><div class="modal-footer">
        <NButton type="primary" :disabled="loading" @click="show = false"
          >完成（已勾选 {{ checked.length }} 个）</NButton
        >
      </div></template
    >
  </NModal>
</template>
