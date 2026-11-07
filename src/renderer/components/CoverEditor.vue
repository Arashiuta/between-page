<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { NModal, NButton, NSlider, NPopconfirm } from "naive-ui";
import { ImagePlus, RotateCcw } from "lucide-vue-next";
import type { CoverCrop, CoverUpload, Project } from "../../shared/types";
import { COVER_LIMIT, cropCover, coverImageStyle } from "../../shared/cover";
import { useWorkspace } from "../stores/workspace";

const props = defineProps<{
  show: boolean;
  project?: Project;
  initial?: CoverUpload;
}>();
const emit = defineEmits<{
  "update:show": [boolean];
  selected: [CoverUpload];
  saved: [];
}>();
const store = useWorkspace();
const source = ref(""),
  name = ref(""),
  uploaded = ref(false),
  busy = ref(false),
  loading = ref(false),
  error = ref("");
const width = ref(0),
  height = ref(0),
  zoom = ref(1),
  cx = ref(0.5),
  cy = ref(0.5);
const fileInput = ref<HTMLInputElement>(),
  viewport = ref<HTMLDivElement>();
const crop = computed(() =>
  cropCover(
    width.value || 2,
    height.value || 1,
    zoom.value,
    cx.value,
    cy.value,
  ),
);
let selection = 0;
function reset() {
  zoom.value = 1;
  cx.value = cy.value = 0.5;
}
async function load(url: string, saved?: CoverCrop) {
  const ticket = ++selection;
  loading.value = true;
  error.value = "";
  width.value = height.value = 0;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (ticket !== selection) return;
    width.value = image.naturalWidth;
    height.value = image.naturalHeight;
    reset();
    if (saved) {
      zoom.value = Math.min(
        3,
        Math.max(1, cropCover(width.value, height.value).width / saved.width),
      );
      cx.value = saved.x + saved.width / 2;
      cy.value = saved.y + saved.height / 2;
    }
    source.value = url;
  } catch {
    if (ticket === selection) {
      source.value = "";
      error.value = "图片无法读取，请选择有效的 PNG、JPEG 或 WebP 图片。";
    }
  } finally {
    if (ticket === selection) loading.value = false;
  }
}
watch(
  () => props.show,
  (show) => {
    if (!show) {
      selection++;
      source.value = "";
      loading.value = false;
      return;
    }
    uploaded.value = !!props.initial;
    error.value = "";
    source.value = "";
    width.value = height.value = 0;
    name.value = props.initial?.name || "故事封面";
    if (props.initial) void load(props.initial.dataUrl, props.initial.crop);
    else if (props.project?.cover)
      void load(
        store.imageUrl(props.project.cover.imageId),
        props.project.cover.crop,
      );
  },
  { immediate: true },
);
async function choose(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > COVER_LIMIT) {
    error.value =
      file.size > COVER_LIMIT
        ? "封面请控制在 20 MB 以内。"
        : "请选择 PNG、JPEG 或 WebP 图片。";
    return;
  }
  const reader = new FileReader();
  const ticket = ++selection;
  loading.value = true;
  reader.onerror = () => {
    if (ticket === selection) {
      loading.value = false;
      error.value = "无法读取所选文件，请重新选择。";
    }
  };
  reader.onload = async () => {
    if (ticket !== selection) return;
    await load(String(reader.result));
    uploaded.value = true;
    name.value = file.name;
  };
  reader.readAsDataURL(file);
}
let drag: { x: number; y: number; cx: number; cy: number } | null = null;
function pointerDown(event: PointerEvent) {
  if (!width.value || busy.value || event.button !== 0) return;
  drag = {
    x: event.clientX,
    y: event.clientY,
    cx: crop.value.x + crop.value.width / 2,
    cy: crop.value.y + crop.value.height / 2,
  };
  viewport.value?.setPointerCapture(event.pointerId);
}
function pointerMove(event: PointerEvent) {
  if (!drag || !viewport.value) return;
  const rect = viewport.value.getBoundingClientRect();
  const next = cropCover(
    width.value,
    height.value,
    zoom.value,
    drag.cx - ((event.clientX - drag.x) / rect.width) * crop.value.width,
    drag.cy - ((event.clientY - drag.y) / rect.height) * crop.value.height,
  );
  cx.value = next.x + next.width / 2;
  cy.value = next.y + next.height / 2;
}
function moveKey(event: KeyboardEvent) {
  if (!event.key.startsWith("Arrow")) return;
  event.preventDefault();
  const c = crop.value;
  const next = cropCover(
    width.value,
    height.value,
    zoom.value,
    c.x +
      c.width / 2 +
      (event.key === "ArrowLeft"
        ? -0.02
        : event.key === "ArrowRight"
          ? 0.02
          : 0),
    c.y +
      c.height / 2 +
      (event.key === "ArrowUp" ? -0.02 : event.key === "ArrowDown" ? 0.02 : 0),
  );
  cx.value = next.x + next.width / 2;
  cy.value = next.y + next.height / 2;
}
async function save() {
  busy.value = true;
  try {
    if (props.project) {
      await store.saveProjectCover(
        props.project.id,
        uploaded.value
          ? {
              upload: {
                name: name.value,
                dataUrl: source.value,
                crop: crop.value,
              },
            }
          : { imageId: props.project.cover!.imageId, crop: crop.value },
      );
      store.notify("封面已保存。");
      emit("saved");
    } else
      emit("selected", {
        name: name.value,
        dataUrl: source.value,
        crop: crop.value,
      });
    emit("update:show", false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!props.project || busy.value || loading.value) return;
  busy.value = true;
  try {
    await store.saveProjectCover(props.project.id, null);
    store.notify("已恢复默认封面。");
    emit("saved");
    emit("update:show", false);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <NModal
    :show="show"
    @update:show="
      (v) => {
        if (!busy) emit('update:show', v);
      }
    "
    preset="card"
    title="故事封面"
    class="form-modal cover-modal"
    :style="{ width: 'min(640px, 92vw)' }"
    :mask-closable="!busy"
    :closable="!busy"
    :close-on-esc="!busy"
  >
    <p class="field-help">
      支持 PNG、JPEG、WebP，单张不超过 20 MB。拖动图片或用方向键移动，缩放调整
      2:1 取景。
    </p>
    <input
      ref="fileInput"
      type="file"
      accept=".png,.jpg,.jpeg,.webp"
      hidden
      @change="choose"
    />
    <div
      ref="viewport"
      class="cover-crop-viewport"
      tabindex="0"
      role="group"
      aria-label="封面取景，使用方向键移动图片"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="drag = null"
      @pointercancel="drag = null"
      @lostpointercapture="drag = null"
      @keydown="moveKey"
    >
      <img
        v-if="source && width"
        :src="source"
        :style="coverImageStyle(crop)"
        alt="封面取景预览"
        draggable="false"
      />
      <span v-else>{{ loading ? "正在读取图片…" : "请选择一张封面图片" }}</span>
    </div>
    <div class="cover-zoom">
      <span id="cover-zoom-label">缩放 {{ zoom.toFixed(2) }}×</span
      ><NSlider
        v-model:value="zoom"
        :min="1"
        :max="3"
        :step="0.01"
        :disabled="!width || busy || loading"
        aria-labelledby="cover-zoom-label"
      />
    </div>
    <p v-if="error" class="cover-error" role="alert">{{ error }}</p>
    <div class="cover-editor-actions">
      <NButton :disabled="busy || loading" @click="fileInput?.click()"
        ><template #icon><ImagePlus :size="16" /></template
        >{{ source ? "更换图片" : "上传图片" }}</NButton
      >
      <NButton :disabled="!width || busy || loading" @click="reset"
        ><template #icon><RotateCcw :size="15" /></template>重置取景</NButton
      >
      <NPopconfirm
        v-if="project?.cover"
        positive-text="移除封面"
        negative-text="取消"
        :positive-button-props="{ disabled: busy || loading }"
        @positive-click="remove"
      >
        <template #trigger>
          <NButton :disabled="busy || loading">移除封面</NButton>
        </template>
        确定移除《{{
          project.title
        }}》的封面？作品将恢复默认封面，原图片保留在插画收藏中。
      </NPopconfirm>
    </div>
    <template #footer
      ><div class="modal-footer">
        <NButton :disabled="busy" @click="emit('update:show', false)"
          >取消</NButton
        ><NButton
          type="primary"
          :loading="busy"
          :disabled="!source || !width || loading"
          @click="save"
          >{{ project ? "保存封面" : "使用此封面" }}</NButton
        >
      </div></template
    >
  </NModal>
</template>
