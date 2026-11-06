<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { NButton, NInput, NModal } from "naive-ui";
import { Sparkles } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";

const props = defineProps<{
  show: boolean;
  chapterId: string;
  generateOnOpen: boolean;
}>();
const emit = defineEmits<{ "update:show": [show: boolean] }>();
const store = useWorkspace();
const chapter = computed(() =>
  store.detail?.chapters.find((item) => item.id === props.chapterId),
);
const name = ref("");
const error = ref("");
const saving = ref(false);
const requestId = ref("");
const generating = computed(() => !!requestId.value);
const canGenerate = computed(
  () => !!(chapter.value?.content.trim() || chapter.value?.plan.trim()),
);
let generation = 0;

function stop() {
  generation++;
  const id = requestId.value;
  requestId.value = "";
  if (id) void store.api("ai:cancel", id).catch(() => {});
}
function close() {
  if (saving.value) return;
  stop();
  emit("update:show", false);
}
async function generate() {
  const target = chapter.value;
  if (
    !target ||
    generating.value ||
    saving.value ||
    store.busy ||
    store.imageBusy
  )
    return;
  const snapshot = {
    projectId: target.projectId,
    chapterId: target.id,
    content: target.content,
    plan: target.plan,
    title: target.title,
  };
  const token = ++generation;
  const id = crypto.randomUUID();
  requestId.value = id;
  error.value = "";
  try {
    await store.flush();
    if (
      token !== generation ||
      !props.show ||
      store.detail?.project.id !== snapshot.projectId
    )
      return;
    const result = await store.api<{ title: string }>("ai:chapter-title", {
      requestId: id,
      projectId: snapshot.projectId,
      chapterId: snapshot.chapterId,
    });
    if (
      token !== generation ||
      !props.show ||
      chapter.value?.id !== snapshot.chapterId ||
      store.detail?.project.id !== snapshot.projectId
    )
      return;
    if (
      chapter.value.content !== snapshot.content ||
      chapter.value.plan !== snapshot.plan ||
      chapter.value.title !== snapshot.title
    )
      throw new Error("本章内容或名称已修改，请重新生成名称。");
    name.value = result.title;
  } catch (cause) {
    if (token === generation && props.show)
      error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === generation) requestId.value = "";
  }
}
async function save() {
  const target = chapter.value;
  if (!target || saving.value || generating.value || !name.value.trim()) return;
  saving.value = true;
  error.value = "";
  try {
    store.renameChapter(target.id, name.value);
    await store.flush();
    store.notify("章节名称已保存。");
    emit("update:show", false);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
watch(
  () => [props.show, props.chapterId] as const,
  ([show]) => {
    stop();
    error.value = "";
    name.value = chapter.value?.title ?? "";
    if (show && props.generateOnOpen) void generate();
  },
  { immediate: true },
);
onBeforeUnmount(stop);
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="编辑章节名称"
    :style="{ width: '520px' }"
    :mask-closable="!saving"
    :close-on-esc="!saving"
    :closable="!saving"
    @update:show="
      (value) => {
        if (!value) close();
      }
    "
  >
    <p class="field-help">
      {{ chapter?.title }} · AI
      优先参考本章正文，没有正文时参考章节计划。生成的名称可以修改后再保存。
    </p>
    <label class="field-label" for="chapter-name">章节名称</label>
    <NInput
      id="chapter-name"
      v-model:value="name"
      placeholder="输入章节名称"
      :maxlength="500"
      :disabled="generating || saving"
      autofocus
      @keyup.enter="save"
    />
    <p v-if="error" class="chapter-name-error" role="alert">{{ error }}</p>
    <p v-if="!canGenerate" class="field-help">
      写一些本章正文或章节计划后，即可让 AI 生成名称。
    </p>
    <div class="workbench-actions">
      <NButton
        :loading="generating"
        :disabled="!canGenerate || store.busy || store.imageBusy || saving"
        @click="generate"
        ><template #icon><Sparkles :size="15" /></template
        >{{ generating ? "正在生成名称" : "AI 生成名称" }}</NButton
      >
      <NButton v-if="generating" @click="stop">停止生成</NButton>
    </div>
    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="saving" @click="close">取消</NButton
        ><NButton
          type="primary"
          :loading="saving"
          :disabled="!name.trim() || generating"
          @click="save"
          >保存名称</NButton
        >
      </div>
    </template>
  </NModal>
</template>
