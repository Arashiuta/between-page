<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { NButton, NInput, NModal } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import type { DirectionView, TaskPreview } from "../../shared/types";
import RequestPreview from "./RequestPreview.vue";

const store = useWorkspace();
const view = ref<DirectionView | null>(null),
  selectedId = ref<string | null>(null),
  text = ref("");
const draftFingerprint = ref(""),
  draftBasis = ref(""),
  loading = ref(false),
  creating = ref(false),
  error = ref("");
const preview = ref<TaskPreview | null>(null),
  showPreview = ref(false);
let ticket = 0,
  timer: ReturnType<typeof setTimeout>;
const blocked = computed(
  () => store.busy || store.directionsBusy || creating.value,
);
const generationError = computed(() =>
  store.directionsChapterId === store.chapterId ? store.directionsError : "",
);
const last = computed(
  () => store.detail?.chapters.at(-1)?.id === store.chapterId,
);
const stale = computed(
  () =>
    !!view.value &&
    ((!!selectedId.value && view.value.stale) ||
      draftFingerprint.value !== view.value.sourceFingerprint ||
      draftBasis.value !== view.value.basis),
);
const snapshot = computed(() =>
  JSON.stringify([
    store.chapter?.document,
    store.detail?.project,
    store.detail?.cards,
    store.detail?.memories,
  ]),
);

async function load() {
  const pid = store.detail?.project.id,
    cid = store.chapterId,
    request = ++ticket;
  if (!pid || !cid) return;
  loading.value = true;
  try {
    await store.flush();
    const [current, draft] = await Promise.all([
      store.api<DirectionView>("directions:get", {
        projectId: pid,
        chapterId: cid,
      }),
      store.api<any>("ui:get", {
        projectId: pid,
        key: "direction-draft." + cid,
      }),
    ]);
    if (
      request !== ticket ||
      pid !== store.detail?.project.id ||
      cid !== store.chapterId
    )
      return;
    view.value = current;
    selectedId.value = draft?.selectedId ?? current.state?.selectedId ?? null;
    text.value = draft?.instruction ?? current.state?.instruction ?? "";
    draftFingerprint.value =
      draft?.sourceFingerprint ??
      current.state?.sourceFingerprint ??
      current.sourceFingerprint;
    draftBasis.value = draft?.basis ?? current.state?.basis ?? current.basis;
  } catch (e) {
    if (request === ticket) error.value = (e as Error).message;
  } finally {
    if (request === ticket) loading.value = false;
  }
}
watch(
  () => [store.detail?.project.id, store.chapterId, store.directionsEpoch],
  () => {
    error.value = "";
    void load();
  },
  { immediate: true },
);
watch(snapshot, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 700);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  ticket++;
});

function saveDraft() {
  if (!view.value) return;
  store.saveDirectionDraft(store.chapterId, {
    selectedId: selectedId.value,
    instruction: text.value,
    sourceFingerprint: draftFingerprint.value,
    basis: draftBasis.value,
  });
}
function choose(id: string) {
  const option = view.value?.state?.options.find((o) => o.id === id);
  if (!option || !view.value || view.value.stale) return;
  selectedId.value = id;
  text.value = option.content;
  draftFingerprint.value = view.value.sourceFingerprint;
  draftBasis.value = view.value.basis;
  saveDraft();
}
function edit(value: string) {
  text.value = value;
  if (view.value) {
    if (view.value.stale) selectedId.value = null;
    draftFingerprint.value = view.value.sourceFingerprint;
    draftBasis.value = view.value.basis;
  }
  saveDraft();
}
async function next() {
  if (!view.value || !store.detail) return;
  const pid = store.detail.project.id,
    cid = store.chapterId;
  creating.value = true;
  error.value = "";
  try {
    await store.flush();
    const chosen = await store.api<DirectionView>("directions:choose", {
      projectId: pid,
      chapterId: cid,
      sourceFingerprint: draftFingerprint.value,
      basis: draftBasis.value,
      selectedId: selectedId.value,
      instruction: text.value,
    });
    await store.createExplorationChapter(cid, chosen);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}
async function inspect() {
  if (!store.detail) return;
  preview.value = await store.api<TaskPreview | null>("directions:preview", {
    projectId: store.detail.project.id,
    chapterId: store.chapterId,
  });
  showPreview.value = !!preview.value;
}
</script>

<template>
  <section class="directions-panel" aria-label="下一章走向">
    <div class="section-toolbar">
      <div>
        <h3>下一章会发生什么？</h3>
        <p class="field-help">
          参考额外设定、世界与人物、引入资料和有效记忆。选择一个走向后可修改，也可以自行填写。
        </p>
      </div>
      <NButton
        v-if="store.directionsBusy"
        @click="store.safe(store.stopDirections)"
        >停止生成走向</NButton
      >
      <NButton
        v-else
        :disabled="blocked || loading || !store.chapter?.content.trim()"
        @click="store.generateDirections(store.chapterId)"
        >{{ view?.state?.options.length ? "换一组" : "生成走向" }}（{{
          store.settings?.software.directionCount ?? 3
        }}
        个）</NButton
      >
    </div>
    <p v-if="store.directionsBusy" role="status" class="field-help">
      正在根据当前正文生成下一章走向…
    </p>
    <p v-if="view?.stale || stale" role="status" class="review-banner">
      正文或故事依据已变化，旧走向需要更新。可以换一组，或根据当前故事重新填写自定走向。
    </p>
    <p v-if="generationError || error" role="alert" class="review-error">
      {{ error || generationError }} 可单独重试，当前正文已保留。
    </p>
    <div class="direction-options">
      <button
        v-for="option in view?.state?.options ?? []"
        :key="option.id"
        :class="['direction-card', { selected: selectedId === option.id }]"
        :disabled="blocked || loading || view?.stale"
        :aria-pressed="selectedId === option.id"
        @click="choose(option.id)"
      >
        <strong>{{ option.title }}</strong
        ><span>{{ option.content }}</span>
      </button>
    </div>
    <label class="field-label">{{
      selectedId ? "修改所选走向" : "自定下一章走向"
    }}</label>
    <NInput
      :value="text"
      type="textarea"
      :disabled="blocked || loading"
      :autosize="{ minRows: 3, maxRows: 10 }"
      placeholder="写下你希望下一章发生的事情…"
      @update:value="edit"
    />
    <div class="workbench-actions">
      <NButton
        type="primary"
        :loading="creating"
        :disabled="
          blocked ||
          loading ||
          !last ||
          !text.trim() ||
          stale ||
          !store.chapter?.content.trim()
        "
        @click="next"
        >生成下一章</NButton
      >
      <NButton
        v-if="view?.state?.turnId"
        :disabled="blocked"
        @click="store.safe(inspect)"
        >走向生成的参考资料</NButton
      >
      <span v-if="!last" class="field-help"
        >在作品最后一章生成下一章；已有后续章节可从章节列表进入。</span
      >
    </div>
    <NModal
      v-model:show="showPreview"
      preset="card"
      title="走向生成的实际请求与参考资料"
      :style="{ width: '980px', maxWidth: '94vw' }"
      ><RequestPreview v-if="preview" :preview="preview"
    /></NModal>
  </section>
</template>

<style scoped>
.directions-panel {
  margin-top: 28px;
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
.directions-panel h3 {
  margin: 0;
}
.directions-panel .section-toolbar {
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
}
.direction-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 12px;
  margin: 16px 0;
}
.direction-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--paper);
  color: var(--ink);
  text-align: left;
  font: inherit;
  line-height: 1.7;
  cursor: pointer;
}
.direction-card.selected {
  border-color: var(--primary);
  background: var(--accent-soft);
}
.direction-card:disabled {
  opacity: 0.6;
  cursor: default;
}
.direction-card span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.review-error {
  color: #b42318;
}
</style>
