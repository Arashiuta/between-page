<script setup lang="ts">
import { ref, watch, computed, onBeforeUnmount } from "vue";
import { NModal, NInput, NSelect, NButton, NCheckbox } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import TextModelSelect from "./TextModelSelect.vue";
import type {
  Card,
  CardInput,
  CardKind,
  ImageAsset,
  RefinedMaterial,
  SourceDocument,
} from "../../shared/types";
const props = defineProps<{
  show: boolean;
  card?: Card | null;
  projectId: string | null;
  initialKind?: CardKind;
}>();
const emit = defineEmits(["update:show", "saved"]);
const store = useWorkspace();
const saving = ref(false),
  importing = ref(false),
  refining = ref(false);
const documents = ref<SourceDocument[]>([]),
  model = ref("");
const refineError = ref(""),
  refined = ref(false);
let refineRequestId = "",
  stopped = false;
const readOnly = computed(
  () => !!(props.card?.projectId && props.card.sourceCardId),
);
const working = computed(
  () => saving.value || importing.value || refining.value,
);
const empty = (): CardInput => ({
  projectId: props.projectId,
  kind: props.initialKind ?? "character",
  name: "",
  description: "",
  constraints: "",
  sections: [],
  documents: [],
  referenceIds: [],
});
const form = ref<CardInput>(empty());
watch(
  () => props.show,
  (show) => {
    documents.value = [];
    refineError.value = "";
    refined.value = false;
    if (show) {
      form.value = props.card
        ? JSON.parse(JSON.stringify(props.card))
        : empty();
      // Legacy documents are available for one final extraction, never saved again.
      if (!readOnly.value) documents.value = form.value.documents ?? [];
      form.value.documents = [];
    }
  },
  { immediate: true },
);
async function save() {
  if (readOnly.value || working.value) return;
  saving.value = true;
  try {
    const {
      id,
      projectId,
      kind,
      name,
      description,
      constraints,
      sections,
      referenceIds,
    } = form.value;
    const result = await store.saveCard({
      id,
      projectId,
      kind,
      name,
      description,
      constraints,
      sections,
      referenceIds,
    });
    emit("saved");
    emit("update:show", false);
    return result;
  } finally {
    saving.value = false;
  }
}
async function refine() {
  if (readOnly.value || working.value) return;
  refining.value = true;
  refined.value = false;
  refineError.value = "";
  stopped = false;
  refineRequestId = crypto.randomUUID();
  try {
    await store.flush();
    if (stopped) return;
    const { kind, name, description, constraints, sections } = form.value;
    const value = await store.api<RefinedMaterial>("card:refine", {
      requestId: refineRequestId,
      kind,
      name,
      description,
      constraints,
      sections: sections ?? [],
      documents: documents.value,
      ...(model.value ? { model: model.value } : {}),
    });
    if (stopped || !props.show) return;
    form.value.description = value.description;
    form.value.constraints = value.constraints;
    form.value.sections = [...(form.value.sections ?? []), ...value.sections];
    documents.value = [];
    refined.value = true;
  } catch (error) {
    if (!stopped) refineError.value = (error as Error).message;
  } finally {
    refining.value = false;
    refineRequestId = "";
  }
}
async function stopRefine() {
  stopped = true;
  if (refineRequestId) await store.api("ai:cancel", refineRequestId);
}
onBeforeUnmount(() => {
  void stopRefine();
});
async function importDocs() {
  if (readOnly.value || working.value) return;
  importing.value = true;
  try {
    const docs = await store.api<SourceDocument[]>("card:import");
    if (documents.value.length + docs.length > 12)
      throw new Error("一次最多提炼 12 份文档，请先移除部分文档。");
    documents.value = [...documents.value, ...docs];
    if (!form.value.name.trim() && docs[0])
      form.value.name = docs[0].name.replace(/\.(txt|md|markdown)$/i, "");
    refined.value = false;
  } finally {
    importing.value = false;
  }
}
async function images() {
  if (readOnly.value || working.value) return;
  importing.value = true;
  try {
    const values = await store.api<ImageAsset[]>("asset:import", {
      projectId: props.projectId,
    });
    await store.bootstrap();
    form.value.referenceIds = [
      ...new Set([...form.value.referenceIds, ...values.map((i) => i.id)]),
    ];
  } finally {
    importing.value = false;
  }
}
function add() {
  form.value.sections!.push({
    id: crypto.randomUUID(),
    title: "新分区",
    content: "",
    sourceIds: [],
  });
}
</script>
<template>
  <NModal
    :show="show"
    preset="card"
    :title="readOnly ? '查看人物与世界资料' : '编辑人物与世界资料'"
    :style="{ width: '820px', maxWidth: '94vw' }"
    :mask-closable="!working"
    :closable="!working"
    :close-on-esc="!working"
    @update:show="
      (v) => {
        if (!working) emit('update:show', v);
      }
    "
  >
    <p v-if="readOnly" class="field-help">
      此资料从创作资料库引入，只读。需要调整时，请在资料库编辑后重新引入。
    </p>
    <label class="field-label">名称</label>
    <NInput
      v-model:value="form.name"
      :readonly="readOnly"
      :disabled="working"
    />
    <label class="field-label">类型</label>
    <NSelect
      v-model:value="form.kind"
      :disabled="readOnly || working"
      :options="[
        { label: '人物', value: 'character' },
        { label: '世界', value: 'world' },
        { label: '灵感资料', value: 'inspiration' },
      ]"
    />
    <label class="field-label">概述</label>
    <NInput
      v-model:value="form.description"
      type="textarea"
      :readonly="readOnly"
      :disabled="working"
      :autosize="{ minRows: 3, maxRows: 10 }"
    />
    <label class="field-label">固定规则与边界</label>
    <NInput
      v-model:value="form.constraints"
      type="textarea"
      :readonly="readOnly"
      :disabled="working"
      :autosize="{ minRows: 3, maxRows: 12 }"
    />
    <div class="section-toolbar">
      <h3>自由分区与要点</h3>
      <NButton
        v-if="!readOnly"
        size="small"
        :disabled="working || (form.sections?.length ?? 0) >= 50"
        @click="add"
        >添加分区</NButton
      >
    </div>
    <article v-for="s in form.sections" :key="s.id" class="card-section-form">
      <NInput
        v-model:value="s.title"
        :readonly="readOnly"
        :disabled="working"
      />
      <NInput
        v-model:value="s.content"
        type="textarea"
        :readonly="readOnly"
        :disabled="working"
        :autosize="{ minRows: 3, maxRows: 12 }"
      />
      <NButton
        v-if="!readOnly"
        size="tiny"
        :disabled="working"
        @click="form.sections = form.sections!.filter((x) => x.id !== s.id)"
        >移除分区</NButton
      >
    </article>
    <template v-if="!readOnly">
      <div class="section-toolbar">
        <h3>上传文档提炼</h3>
        <NButton
          size="small"
          :disabled="working"
          :loading="importing"
          @click="store.safe(importDocs)"
          >上传 TXT / Markdown</NButton
        >
      </div>
      <p class="field-help">
        原始文档仅用于本次 AI
        提炼，不会保存。提炼结果填入上方的分区与要点，检查后点击“保存资料”。
      </p>
      <article v-for="d in documents" :key="d.id" class="card-section-form">
        <NCheckbox v-model:checked="d.enabled" :disabled="working">{{
          d.name
        }}</NCheckbox>
        <details>
          <summary>查看原文（{{ d.content.length }} 字符）</summary>
          <NInput
            v-model:value="d.content"
            type="textarea"
            :disabled="working"
            :autosize="{ minRows: 5, maxRows: 15 }"
          />
        </details>
        <NButton
          size="tiny"
          :disabled="working"
          @click="documents = documents.filter((x) => x.id !== d.id)"
          >移除文档</NButton
        >
      </article>
      <template v-if="documents.length">
        <label class="field-label">提炼模型</label>
        <TextModelSelect v-model="model" role="settings" :disabled="working" />
        <div class="refine-actions">
          <NButton
            :loading="refining"
            :disabled="
              working ||
              !form.name.trim() ||
              !documents.some((d) => d.enabled && d.content.trim())
            "
            @click="refine"
            >AI 提炼</NButton
          >
          <NButton v-if="refining" @click="store.safe(stopRefine)"
            >停止提炼</NButton
          >
        </div>
      </template>
      <p v-if="refineError" class="refine-error" role="alert">
        {{ refineError }}
      </p>
      <p v-if="refined" class="field-help" role="status">
        已将提炼结果填入资料，原始文档已清除。请检查分区与要点后保存。
      </p>
    </template>
    <div class="section-toolbar">
      <h3>设定参考图</h3>
      <NButton
        v-if="!readOnly"
        size="small"
        :disabled="working"
        @click="store.safe(images)"
        >添加参考图</NButton
      >
    </div>
    <div class="card-reference-images">
      <figure v-for="id in form.referenceIds" :key="id">
        <img :src="store.imageUrl(id)" alt="设定参考图" />
        <NButton
          v-if="!readOnly"
          size="tiny"
          :disabled="working"
          @click="form.referenceIds = form.referenceIds.filter((x) => x !== id)"
          >解除关联</NButton
        >
      </figure>
    </div>
    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="working" @click="emit('update:show', false)">{{
          readOnly ? "关闭" : "取消"
        }}</NButton>
        <NButton
          v-if="!readOnly"
          type="primary"
          :loading="saving"
          :disabled="working || !form.name.trim()"
          @click="store.safe(save)"
          >保存资料</NButton
        >
      </div>
    </template>
  </NModal>
</template>
<style scoped>
.card-section-form {
  border: 1px solid var(--border);
  padding: 13px;
  border-radius: 7px;
  margin: 10px 0;
}
.card-section-form > * {
  margin-bottom: 8px;
}
.card-reference-images {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.card-reference-images figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.card-reference-images img {
  width: 140px;
  height: 140px;
  object-fit: contain;
}
.refine-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.refine-error {
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
