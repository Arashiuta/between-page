<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NModal,
  NInput,
  NSelect,
  NButton,
  NCheckbox,
  NTabs,
  NTabPane,
  NCollapse,
  NCollapseItem,
  NImageGroup,
  NPopconfirm,
} from "naive-ui";
import { ImagePlus, X, FileUp, Plus, Sparkles, Square } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type {
  Card,
  CardKind,
  CardInput,
  ImageAsset,
  SourceDocument,
  MaterialDraft,
} from "../../shared/types";
import {
  applyMaterialDraft,
  materialLength,
  materialLimits,
} from "../../shared/materials";

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
  organizing = ref(false),
  activeTab = ref("content");
const instruction = ref(""),
  draft = ref<MaterialDraft | null>(null),
  append = ref(true),
  requestId = ref("");
const form = ref<CardInput>(empty());
let draftBase = "";
const previewing = ref(false),
  previewIndex = ref(0);
const referenceUrls = computed(() =>
  form.value.referenceIds.map((id) => store.imageUrl(id)),
);
const busy = computed(
  () => saving.value || importing.value || organizing.value,
);
const enabledDocs = computed(
  () => form.value.documents?.filter((doc) => doc.enabled) ?? [],
);
const length = computed(() => materialLength(form.value));
function empty(): CardInput {
  return {
    name: "",
    kind: "character",
    projectId: props.projectId,
    description: "",
    constraints: "",
    sections: [],
    documents: [],
    referenceIds: [],
  };
}
watch(
  () => props.show,
  (value) => {
    previewing.value = false;
    previewIndex.value = 0;
    if (!value) return;
    form.value = props.card
      ? JSON.parse(JSON.stringify(props.card))
      : { ...empty(), kind: props.initialKind ?? "character" };
    form.value.sections ??= [];
    form.value.documents ??= [];
    draft.value = null;
    instruction.value = "";
    activeTab.value = "content";
    append.value = true;
  },
  { immediate: true },
);
async function save() {
  saving.value = true;
  await store.safe(async () => {
    if (length.value > materialLimits.card)
      throw new Error("资料超过 40 万字，请拆分为多个条目。");
    await store.saveCard({
      ...form.value,
      id: props.card?.id,
      projectId: props.projectId,
    });
    emit("update:show", false);
    emit("saved");
    store.notify("资料已保存。");
  });
  saving.value = false;
}
function addSection(title = "") {
  if (form.value.sections!.length >= materialLimits.sections) {
    store.notify("最多添加 50 个分区。", "info");
    return;
  }
  form.value.sections!.push({
    id: crypto.randomUUID(),
    title,
    content: "",
    alwaysInclude: false,
    sourceIds: [],
  });
}
async function importDocuments() {
  importing.value = true;
  await store.safe(async () => {
    const docs = await store.api<SourceDocument[]>("card:import");
    const unique = docs.filter(
      (doc) =>
        !form.value.documents!.some(
          (existing) =>
            existing.name === doc.name && existing.content === doc.content,
        ),
    );
    const candidate = {
      ...form.value,
      documents: [...form.value.documents!, ...unique],
    };
    if (
      candidate.documents.length > materialLimits.documents ||
      materialLength(candidate) > materialLimits.card
    )
      throw new Error(
        "每份资料最多保留 12 份原文、总计 40 万字。请拆分为多个资料条目。",
      );
    form.value.documents = candidate.documents;
    if (!form.value.name && unique.length) {
      const heading = unique[0].content.match(/^#\s+(.+)$/m)?.[1];
      if (heading)
        form.value.name = heading
          .replace(/\s*(能力设定|性格档案|设定档案)$/u, "")
          .trim()
          .slice(0, 100);
    }
    if (docs.length) activeTab.value = "documents";
  });
  importing.value = false;
}
async function organize() {
  organizing.value = true;
  requestId.value = crypto.randomUUID();
  await store.safe(async () => {
    draftBase = JSON.stringify(form.value);
    const value = await store.api<MaterialDraft>("card:organize", {
      requestId: requestId.value,
      instruction: instruction.value,
      card: form.value,
    });
    draft.value = value;
    activeTab.value = "draft";
    append.value = !!(
      form.value.description.trim() ||
      form.value.constraints.trim() ||
      form.value.sections!.length
    );
  });
  organizing.value = false;
  requestId.value = "";
}
function apply() {
  if (!draft.value) return;
  if (draftBase !== JSON.stringify(form.value)) {
    store.notify(
      "资料或原始文档已有修改，请重新整理后应用，避免覆盖后来的编辑。",
      "error",
    );
    return;
  }
  const value = applyMaterialDraft(form.value, draft.value, append.value, () =>
    crypto.randomUUID(),
  );
  if (
    (value.sections?.length ?? 0) > materialLimits.sections ||
    materialLength(value) > materialLimits.card
  ) {
    store.notify("应用后将超过资料容量，请先精简内容或分成多个条目。", "error");
    return;
  }
  form.value = value;
  draft.value = null;
  activeTab.value = "content";
  store.notify("整理结果已应用到编辑区，保存资料后生效。");
}
async function importImages() {
  importing.value = true;
  await store.safe(async () => {
    const images = await store.api<ImageAsset[]>("asset:import", {
      projectId: props.projectId,
    });
    await store.bootstrap();
    form.value.referenceIds = [
      ...new Set([
        ...form.value.referenceIds,
        ...images.map((image) => image.id),
      ]),
    ].slice(0, 12);
  });
  importing.value = false;
}
function sourceNames(ids: string[]) {
  return ids
    .map(
      (id) =>
        form.value.documents?.find((doc) => doc.id === id)?.name ??
        "原文已移除",
    )
    .join("、");
}
</script>
<template>
  <NModal
    :show="show"
    @update:show="!busy && emit('update:show', $event)"
    preset="card"
    :title="card ? '编辑创作资料' : '添加创作资料'"
    :style="{ width: '920px', maxWidth: '94vw' }"
    class="form-modal material-modal"
    :mask-closable="!busy"
    :closable="!busy"
    :close-on-esc="!busy && !previewing"
  >
    <div class="material-editor-scroll">
      <div class="form-two-columns">
        <div>
          <label class="field-label first">名称</label
          ><NInput
            v-model:value="form.name"
            placeholder="角色、世界或灵感的名字"
            :maxlength="100"
            :disabled="busy"
          />
        </div>
        <div>
          <label class="field-label first">资料类型</label
          ><NSelect
            v-model:value="form.kind"
            :disabled="busy"
            :options="[
              { label: '角色 / OC', value: 'character' },
              { label: '世界观', value: 'world' },
              { label: '零碎灵感', value: 'inspiration' },
            ]"
          />
        </div>
      </div>
      <div class="material-actions">
        <NButton :loading="importing" :disabled="busy" @click="importDocuments"
          ><template #icon><FileUp :size="15" /></template>导入文档</NButton
        >
        <NButton
          v-if="!organizing"
          :disabled="busy || !enabledDocs.length"
          @click="organize"
          ><template #icon><Sparkles :size="15" /></template>AI
          整理文档</NButton
        >
        <NButton
          v-else
          @click="store.safe(() => store.api('ai:cancel', requestId))"
          ><template #icon><Square :size="13" /></template>停止整理</NButton
        >
        <span>{{
          organizing
            ? "正在整理，原文和现有资料保留…"
            : `TXT / MD · ${form.documents?.length || 0} 份原文 · ${length.toLocaleString()} 字`
        }}</span>
      </div>
      <NTabs v-model:value="activeTab" type="line" animated>
        <NTabPane name="content" tab="资料内容">
          <label class="field-label first"
            >概述<small>自由填写，可留空</small></label
          >
          <NInput
            v-model:value="form.description"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :disabled="busy"
            placeholder="整体介绍；详细能力、性格和关系可分别放在下方分区。"
          />
          <label class="field-label"
            >固定设定与边界<small
              >写作时始终参考，不会按相关性省略</small
            ></label
          >
          <NInput
            v-model:value="form.constraints"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 10 }"
            :disabled="busy"
            placeholder="不能随意改动的底层规则、角色底线与绝对边界。区分真实限制与表现示例。"
          />
          <div class="section-toolbar compact">
            <h3>
              自定义分区
              <span class="count-tag">{{ form.sections?.length || 0 }}</span>
            </h3>
            <NButton size="small" :disabled="busy" @click="addSection()"
              ><template #icon><Plus :size="14" /></template>新增分区</NButton
            >
          </div>
          <div
            v-for="(section, index) in form.sections"
            :key="section.id"
            class="material-section"
          >
            <div class="material-section-title">
              <NInput
                v-model:value="section.title"
                :disabled="busy"
                :maxlength="200"
                placeholder="分区标题，例如：能力系统、亲密关系、压力反应"
              /><NPopconfirm
                positive-text="移除分区"
                negative-text="取消"
                @positive-click="form.sections!.splice(index, 1)"
                ><template #trigger
                  ><NButton
                    quaternary
                    :disabled="busy"
                    :aria-label="`移除分区 ${section.title || index + 1}`"
                    ><template #icon
                      ><X :size="15" /></template></NButton></template
                >移除「{{
                  section.title || "未命名分区"
                }}」及其内容？原始文档与其他分区保留，保存资料后生效。</NPopconfirm
              >
            </div>
            <NInput
              v-model:value="section.content"
              :disabled="busy"
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 14 }"
              placeholder="保留具体规则、行为情境、例外和示例。内容和格式均可自由编辑。"
            />
            <NCheckbox v-model:checked="section.alwaysInclude" :disabled="busy"
              >始终参考此分区</NCheckbox
            >
            <p v-if="section.sourceIds.length" class="field-help">
              来源：{{ sourceNames(section.sourceIds) }}
            </p>
          </div>
          <p v-if="!form.sections?.length" class="field-help">
            分区标题和数量可自行决定，也可以只保留原始文档，不使用 AI 整理。
          </p>
          <div class="section-toolbar compact">
            <label class="field-label"
              >参考图片<small v-if="form.referenceIds.length"
                >点击图片放大预览</small
              ></label
            ><NButton text :disabled="busy" @click="importImages"
              ><template #icon><ImagePlus :size="15" /></template
              >添加图片</NButton
            >
          </div>
          <div v-if="form.referenceIds.length" class="reference-thumbnails">
            <div v-for="(id, index) in form.referenceIds" :key="id">
              <button
                type="button"
                class="reference-preview"
                :aria-label="`放大预览参考图片 ${index + 1}`"
                title="点击放大预览"
                @click="
                  previewIndex = index;
                  previewing = true;
                "
              >
                <img :src="store.imageUrl(id)" :alt="`参考图片 ${index + 1}`" />
              </button>
              <NPopconfirm
                positive-text="取消关联"
                negative-text="保留"
                :positive-button-props="{ disabled: busy }"
                @positive-click="
                  form.referenceIds = form.referenceIds.filter(
                    (value) => value !== id,
                  )
                "
              >
                <template #trigger>
                  <button
                    type="button"
                    class="reference-remove"
                    :disabled="busy"
                    :aria-label="`取消关联参考图片 ${index + 1}`"
                  >
                    <X :size="12" />
                  </button>
                </template>
                确定取消关联参考图片
                {{ index + 1 }}？原图片保留在插画收藏中，保存资料后生效。
              </NPopconfirm>
            </div>
          </div>
        </NTabPane>
        <NTabPane
          name="documents"
          :tab="`原始文档（${form.documents?.length || 0}）`"
        >
          <p class="material-help">
            导入只读取本地文字；原文随资料保存在软件数据目录。点击「AI
            整理文档」才会将启用的原文与当前资料发送给已配置的文字服务。
          </p>
          <label class="field-label">本次整理要求<small>可选</small></label
          ><NInput
            v-model:value="instruction"
            :disabled="busy"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 5 }"
            placeholder="例如：能力按底层规则整理，性格区分陌生人、熟人、恋人和疲惫状态；不要自行补充外貌。"
          />
          <NCollapse v-if="form.documents?.length" class="document-list">
            <NCollapseItem
              v-for="(doc, index) in form.documents"
              :key="doc.id"
              :name="doc.id"
              :title="`${doc.name} · ${doc.content.length.toLocaleString()} 字`"
            >
              <div class="document-toolbar">
                <NCheckbox v-model:checked="doc.enabled" :disabled="busy"
                  >参与整理与写作参考</NCheckbox
                ><NPopconfirm
                  positive-text="移除原文"
                  negative-text="取消"
                  @positive-click="
                    () => {
                      form.documents!.splice(index, 1);
                      form.sections?.forEach(
                        (s) =>
                          (s.sourceIds = s.sourceIds.filter(
                            (id) => id !== doc.id,
                          )),
                      );
                    }
                  "
                  ><template #trigger
                    ><NButton text :disabled="busy">移除原文</NButton></template
                  >移除原始文档「{{
                    doc.name
                  }}」？已整理分区保留，仅解除该文档的来源关联，保存资料后生效。</NPopconfirm
                >
              </div>
              <label class="field-label">文档名称</label
              ><NInput
                v-model:value="doc.name"
                :disabled="busy"
                :maxlength="500"
              />
              <label class="field-label">原文内容</label>
              <NInput
                v-model:value="doc.content"
                :disabled="busy"
                :maxlength="materialLimits.document"
                type="textarea"
                :autosize="{ minRows: 8, maxRows: 18 }"
              />
            </NCollapseItem>
          </NCollapse>
          <p v-else class="inline-empty">
            尚未导入文档。可以同时选择多份设定文件。
          </p>
          <p class="field-help">
            固定设定与标记为「始终参考」的分区优先进入上下文；其他内容按相关性选取。写作区可查看实际参考内容。停用原文后，已有整理分区仍保留，可继续修改。
          </p>
        </NTabPane>
        <NTabPane v-if="draft" name="draft" tab="整理结果（待应用）">
          <p class="material-help">
            以下为模型建议，尚未写入资料。可以修改后应用；原始文档和参考图片会保留。
          </p>
          <p v-if="draft.name" class="field-help">建议名称：{{ draft.name }}</p>
          <label class="field-label">概述</label
          ><NInput
            v-model:value="draft.description"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
          />
          <label class="field-label">固定设定与边界</label
          ><NInput
            v-model:value="draft.constraints"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 12 }"
          />
          <div
            v-for="(section, index) in draft.sections"
            :key="index"
            class="material-section"
          >
            <NInput
              v-model:value="section.title"
              placeholder="分区标题"
            /><NPopconfirm
              positive-text="移除建议分区"
              negative-text="取消"
              @positive-click="draft.sections.splice(index, 1)"
              ><template #trigger
                ><NButton size="small">移除此项建议</NButton></template
              >移除这项未采用的整理建议？当前资料保留。</NPopconfirm
            ><NInput
              v-model:value="section.content"
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 14 }"
            /><NCheckbox v-model:checked="section.alwaysInclude"
              >始终参考此分区</NCheckbox
            >
            <p class="field-help">
              来源：{{ sourceNames(section.sourceIds) || "未标注" }}
            </p>
          </div>
          <div v-if="draft.questions.length" class="material-questions">
            <h3>待作者确认</h3>
            <p v-for="(question, index) in draft.questions" :key="index">
              {{ index + 1 }}. {{ question }}
            </p>
          </div>
          <div class="material-apply">
            <NCheckbox v-model:checked="append"
              >保留现有内容，追加整理结果</NCheckbox
            >
            <p class="field-help">
              {{
                append
                  ? "现有概述、固定设定和分区都会保留。"
                  : "应用将替换概述、固定设定和分区。"
              }}
            </p>
            <NButton type="primary" @click="apply">应用到资料编辑区</NButton>
          </div>
        </NTabPane>
      </NTabs>
      <p class="info-note">
        {{
          projectId
            ? "这是当前故事的资料副本，修改不会影响资料库和其他故事。"
            : "创建故事时会复制资料及原文，已有故事的设定互不影响。"
        }}
      </p>
    </div>
    <template #footer
      ><div class="modal-footer">
        <span v-if="draft" class="material-unsaved">有整理结果尚未应用</span
        ><NButton :disabled="busy" @click="emit('update:show', false)"
          >取消</NButton
        ><NButton
          type="primary"
          :disabled="
            busy ||
            !form.name.trim() ||
            form.sections?.some((section) => !section.title.trim())
          "
          :loading="saving"
          @click="save"
          >保存资料</NButton
        >
      </div></template
    >
  </NModal>
  <NImageGroup
    v-if="show && form.referenceIds.length"
    v-model:show="previewing"
    v-model:current="previewIndex"
    :src-list="referenceUrls"
  />
</template>
