<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { NInput, NSelect, NButton, NCheckbox, NModal } from "naive-ui";
import {
  ImagePlus,
  Images,
  Sparkles,
  Download,
  ArrowUpRight,
  AlertCircle,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { ImageAsset } from "../../shared/types";
import ImageActions from "./ImageActions.vue";
const props = defineProps<{ initialPrompt?: string }>(),
  store = useWorkspace(),
  prompt = ref(props.initialPrompt || ""),
  references = ref<string[]>([]);
const size = ref(store.settings?.imageSize || "1024x1024"),
  quality = ref(store.settings?.imageQuality || "auto"),
  preview = ref<ImageAsset | null>(null);
watch(
  () => props.initialPrompt,
  (value) => {
    if (value) prompt.value = value;
  },
);
const available = computed(() => {
  const ids = new Set(store.detail?.cards.flatMap((c) => c.referenceIds) || []);
  return store.images.filter(
    (i) =>
      i.kind === "reference" &&
      (i.projectId === store.detail?.project.id || ids.has(i.id)),
  );
});
const illustrations = computed(
  () => store.detail?.images.filter((i) => i.kind === "illustration") || [],
);
async function importReference() {
  await store.safe(async () => {
    const imported = await store.api<ImageAsset[]>("asset:import", {
      projectId: store.detail!.project.id,
    });
    await store.bootstrap();
    await store.refreshProject();
    references.value.push(...imported.map((i) => i.id));
    references.value = references.value.slice(0, 8);
  });
}
async function generate() {
  if (!prompt.value.trim()) {
    store.notify("先描述一下想画的画面。", "info");
    return;
  }
  store.imageBusy = true;
  await store.safe(async () => {
    await store.flush();
    const image = await store.api<ImageAsset>("image:generate", {
      projectId: store.detail!.project.id,
      chapterId: store.chapter?.id,
      prompt: prompt.value,
      referenceIds: references.value,
      size: size.value,
      quality: quality.value,
    });
    await store.bootstrap();
    await store.refreshProject();
    preview.value = image;
    store.notify("插画已保存到本地。");
  });
  store.imageBusy = false;
}
function stale(image: ImageAsset) {
  if (!image.chapterId) return false;
  const c = store.detail?.chapters.find((c) => c.id === image.chapterId);
  return (
    !!c &&
    (c.dirty || c.acceptedRevisionId !== image.revisionId || c.needsReview)
  );
}
</script>
<template>
  <section class="image-panel tab-content">
    <div class="content-heading">
      <div>
        <h2>故事插画</h2>
      </div>
      <Images :size="29" :stroke-width="1.2" />
    </div>
    <div class="image-form">
      <label class="field-label first">插画模型</label>
      <NSelect
        :value="store.settings?.image.model || null"
        :options="
          store.settings?.image.selectedModels.map((id) => ({
            label: id,
            value: id,
          })) || []
        "
        placeholder="在设置中勾选模型"
        :disabled="store.imageBusy"
        filterable
        @update:value="
          (value) => store.safe(() => store.setModel('image', value))
        "
      />
      <label class="field-label">画面描述</label
      ><NInput
        v-model:value="prompt"
        type="textarea"
        :autosize="{ minRows: 5, maxRows: 12 }"
        placeholder="人物是谁、在哪里、正在做什么？也可以在右侧选择「构思本章插画」。"
      />
      <div class="section-toolbar compact">
        <label class="field-label">参考图<small>可选，最多 8 张</small></label
        ><button class="text-button" @click="importReference">
          <ImagePlus :size="14" />导入参考图
        </button>
      </div>
      <div v-if="available.length" class="reference-selector">
        <label
          v-for="image in available"
          :key="image.id"
          :class="{ selected: references.includes(image.id) }"
          ><img :src="store.imageUrl(image.id)" :alt="image.name" /><NCheckbox
            :checked="references.includes(image.id)"
            :disabled="!references.includes(image.id) && references.length >= 8"
            @update:checked="
              (v) =>
                (references = v
                  ? [...references, image.id]
                  : references.filter((id) => id !== image.id))
            "
          /><span>{{ image.name }}</span></label
        >
      </div>
      <p v-else class="muted small">
        可以导入 OC 立绘；也会显示本故事人物卡里的参考图片。
      </p>
      <div class="image-options">
        <div>
          <label class="field-label">画面尺寸</label
          ><NSelect
            v-model:value="size"
            :options="[
              { label: '方形 · 1024 × 1024', value: '1024x1024' },
              { label: '横幅 · 1536 × 1024', value: '1536x1024' },
              { label: '竖幅 · 1024 × 1536', value: '1024x1536' },
              { label: '自动', value: 'auto' },
            ]"
          />
        </div>
        <div>
          <label class="field-label">生成质量</label
          ><NSelect
            v-model:value="quality"
            :options="[
              { label: '自动', value: 'auto' },
              { label: '草稿 · low', value: 'low' },
              { label: '标准 · medium', value: 'medium' },
              { label: '精细 · high', value: 'high' },
            ]"
          />
        </div>
      </div>
      <div class="image-generate-row">
        <span class="muted small">{{
          references.length
            ? "使用参考图编辑接口，需服务商支持。"
            : "按下按钮后才会调用生图服务。"
        }}</span
        ><NButton
          type="primary"
          :loading="store.imageBusy"
          :disabled="store.busy"
          @click="generate"
          ><template #icon><Sparkles :size="15" /></template
          >{{ store.imageBusy ? "正在绘制，请稍候" : "生成一张插画" }}</NButton
        >
      </div>
      <RouterLink
        v-if="!store.settings?.image.hasKey"
        to="/settings"
        class="setup-link"
        >配置生图 URL、Key 与模型 <ArrowUpRight :size="13"
      /></RouterLink>
    </div>
    <div class="section-toolbar">
      <h3>
        故事插画 <span class="count-tag">{{ illustrations.length }}</span>
      </h3>
    </div>
    <div v-if="illustrations.length" class="image-grid">
      <article
        v-for="image in illustrations"
        :key="image.id"
        class="image-entry"
      >
        <button class="image-card" @click="preview = image">
          <img :src="store.imageUrl(image.id)" :alt="image.name" />
          <div>
            <strong>{{ image.name }}</strong
            ><span v-if="stale(image)" class="stale-label"
              ><AlertCircle :size="11" />正文已变化，可检查插画</span
            ><span v-else>{{
              new Date(image.createdAt).toLocaleDateString("zh-CN")
            }}</span>
          </div></button
        ><ImageActions
          :image="image"
          @updated="
            (value) => {
              if (preview?.id === value.id) preview = value;
            }
          "
          @deleted="
            () => {
              if (preview?.id === image.id) preview = null;
            }
          "
        />
      </article>
    </div>
    <div v-else class="inline-empty">
      <Images :size="25" />
      <p>暂无插画。</p>
    </div>
    <NModal
      :show="!!preview"
      @update:show="
        (v) => {
          if (!v) preview = null;
        }
      "
      preset="card"
      :title="preview?.name"
      :style="{ width: 'min(900px,90vw)' }"
      ><template v-if="preview"
        ><img
          class="image-preview"
          :src="store.imageUrl(preview.id)"
          :alt="preview.name"
        />
        <p class="muted small">
          {{ preview.model }} ·
          {{ new Date(preview.createdAt).toLocaleString("zh-CN") }}
        </p>
        <pre class="prompt-preview">{{ preview.prompt }}</pre>
        <div class="modal-footer">
          <NButton
            @click="
              prompt = preview!.prompt;
              references = [...preview!.referenceIds];
              preview = null;
            "
            >沿用提示词再画一张</NButton
          ><NButton
            type="primary"
            @click="store.safe(() => store.api('asset:export', preview!.id))"
            ><template #icon><Download :size="15" /></template>导出图片</NButton
          >
        </div></template
      ></NModal
    >
  </section>
</template>
