<script setup lang="ts">
import { ref, watch } from "vue";
import { NModal, NInput, NSelect, NButton } from "naive-ui";
import { ImagePlus, X } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { Card, CardKind, ImageAsset } from "../../shared/types";
const props = defineProps<{
  show: boolean;
  card?: Card | null;
  projectId: string | null;
  initialKind?: CardKind;
}>();
const emit = defineEmits(["update:show", "saved"]),
  store = useWorkspace(),
  busy = ref(false);
const form = ref({
  name: "",
  kind: "character" as CardKind,
  description: "",
  constraints: "",
  referenceIds: [] as string[],
});
watch(
  () => props.show,
  (value) => {
    if (value)
      form.value = {
        name: props.card?.name || "",
        kind: props.card?.kind || props.initialKind || "character",
        description: props.card?.description || "",
        constraints: props.card?.constraints || "",
        referenceIds: [...(props.card?.referenceIds || [])],
      };
  },
);
async function save() {
  busy.value = true;
  await store.safe(async () => {
    await store.saveCard({
      ...form.value,
      id: props.card?.id,
      projectId: props.projectId,
    });
    emit("update:show", false);
    emit("saved");
    store.notify("资料已保存。");
  });
  busy.value = false;
}
async function importImages() {
  await store.safe(async () => {
    const images = await store.api<ImageAsset[]>("asset:import", {
      projectId: props.projectId,
    });
    await store.bootstrap();
    form.value.referenceIds.push(...images.map((i) => i.id));
    form.value.referenceIds = [...new Set(form.value.referenceIds)].slice(
      0,
      12,
    );
  });
}
</script>
<template>
  <NModal
    :show="show"
    @update:show="emit('update:show', $event)"
    preset="card"
    :title="card ? '编辑创作资料' : '添加创作资料'"
    :style="{ width: '650px' }"
    class="form-modal"
  >
    <div class="form-two-columns">
      <div>
        <label class="field-label first">名称</label
        ><NInput
          v-model:value="form.name"
          placeholder="角色、世界或灵感的名字"
          :maxlength="100"
        />
      </div>
      <div>
        <label class="field-label first">资料类型</label
        ><NSelect
          v-model:value="form.kind"
          :options="[
            { label: '角色 / OC', value: 'character' },
            { label: '世界观', value: 'world' },
            { label: '零碎灵感', value: 'inspiration' },
          ]"
        />
      </div>
    </div>
    <label class="field-label">{{
      form.kind === "character"
        ? "人物设定"
        : form.kind === "world"
          ? "世界设定"
          : "记下这个念头"
    }}</label
    ><NInput
      v-model:value="form.description"
      type="textarea"
      :autosize="{ minRows: 7, maxRows: 14 }"
      :placeholder="
        form.kind === 'character'
          ? '外貌、性格、欲望、关系、说话方式……已有多少就写多少。'
          : '规则、氛围、背景、还没决定的事情……'
      "
    />
    <label class="field-label"
      >需要坚持的设定<small
        >角色底线、世界规则或不可随意改动的内容</small
      ></label
    ><NInput
      v-model:value="form.constraints"
      type="textarea"
      :autosize="{ minRows: 2, maxRows: 5 }"
      placeholder="例如：不轻易许诺；即使害怕也不会抛下同伴。"
    />
    <div class="section-toolbar compact">
      <label class="field-label"
        >参考图片<small>用于辅助保持角色形象与画风</small></label
      ><button class="text-button" @click="importImages">
        <ImagePlus :size="15" />添加图片
      </button>
    </div>
    <div v-if="form.referenceIds.length" class="reference-thumbnails">
      <div v-for="id in form.referenceIds" :key="id">
        <img :src="store.imageUrl(id)" alt="参考图片" /><button
          aria-label="取消关联图片"
          @click="form.referenceIds = form.referenceIds.filter((x) => x !== id)"
        >
          <X :size="12" />
        </button>
      </div>
    </div>
    <p v-else class="muted small">可以使用已有 OC 立绘、服装或场景参考图。</p>
    <p class="info-note">
      {{
        projectId
          ? "这是当前故事的资料副本，修改不会影响资料库和其他故事。"
          : "资料库中的内容可用于创建故事；已有故事保留各自的副本。"
      }}
    </p>
    <template #footer
      ><div class="modal-footer">
        <NButton @click="emit('update:show', false)">取消</NButton
        ><NButton
          type="primary"
          :disabled="!form.name.trim()"
          :loading="busy"
          @click="save"
          >保存资料</NButton
        >
      </div></template
    >
  </NModal>
</template>
