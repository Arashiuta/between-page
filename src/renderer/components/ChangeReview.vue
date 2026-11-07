<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NModal, NButton, NCheckbox, NInput } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import type { ChangeSet, ProposedChange } from "../../shared/types";
import DiffText from "./DiffText.vue";
const store = useWorkspace(),
  set = ref<ChangeSet | null>(null),
  chosen = ref<string[]>([]),
  drafts = ref<Record<string, string>>({}),
  titles = ref<Record<string, string>>({}),
  applying = ref(false),
  error = ref("");
const show = computed(() => !!store.reviewingChangeId);
function label(c: ProposedChange) {
  const t = c.target;
  return t.type === "setting"
    ? t.name +
        " / " +
        (t.field === "section"
          ? t.title
          : t.field === "description"
            ? "概述"
            : "固定规则")
    : t.type === "blueprint"
      ? t.node.title
      : t.type === "project-setting"
        ? t.field === "world"
          ? "世界规则"
          : "叙事偏好"
        : t.type === "prose"
          ? t.operation === "append"
            ? "文末续写"
            : t.operation === "opening"
              ? "空章开篇"
              : "替换原选区"
          : t.type === "title"
            ? "章节名称"
            : "新增记忆";
}
watch(
  () => store.reviewingChangeId,
  async (id) => {
    set.value = null;
    error.value = "";
    if (!id || !store.detail) return;
    const projectId = store.detail.project.id;
    try {
      const response = await store.api<ChangeSet>("changes:get", {
        projectId,
        id,
      });
      if (
        id !== store.reviewingChangeId ||
        projectId !== store.detail?.project.id
      )
        return;
      set.value = response;
      chosen.value = set.value.changes
        .filter((c) => !c.applied)
        .map((c) => c.id);
      titles.value = Object.fromEntries(
        set.value.changes
          .filter((c) => c.afterTitle !== undefined)
          .map((c) => [c.id, c.afterTitle!]),
      );
      drafts.value = Object.fromEntries(
        set.value.changes.map((c) => [c.id, c.after]),
      );
    } catch (e) {
      if (
        id === store.reviewingChangeId &&
        projectId === store.detail?.project.id
      )
        error.value = (e as Error).message;
    }
  },
);
async function apply() {
  if (!set.value) return;
  applying.value = true;
  error.value = "";
  try {
    const updated = await store.applyChanges(
      set.value.id,
      chosen.value.map((id) => ({
        id,
        after: drafts.value[id],
        ...(titles.value[id] !== undefined ? { title: titles.value[id] } : {}),
      })),
    );
    if (updated) {
      set.value = updated;
      chosen.value = [];
      if (updated.status === "applied") store.reviewingChangeId = "";
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    applying.value = false;
  }
}
</script>
<template>
  <NModal
    :show="show"
    preset="card"
    title="审核 AI 修改"
    :style="{ width: '960px', maxWidth: '94vw' }"
    :mask-closable="!applying"
    :closable="!applying"
    @update:show="
      (v) => {
        if (!v) store.reviewingChangeId = '';
      }
    "
  >
    <p class="field-help">
      按完整目标审核。编辑建议会同步更新差异；确认后才写入故事，采用前自动保存快照。
    </p>
    <p v-if="error" class="review-error" role="alert">{{ error }}</p>
    <article v-for="c in set?.changes" :key="c.id" class="review-item">
      <NCheckbox
        :checked="chosen.includes(c.id)"
        :disabled="c.applied || applying || store.busy"
        @update:checked="
          (v) =>
            (chosen = v
              ? [...chosen, c.id]
              : chosen.filter((id) => id !== c.id))
        "
        >{{ label(c) }} {{ c.applied ? "（已采用）" : "" }}</NCheckbox
      >
      <DiffText
        v-if="c.afterTitle !== undefined"
        :before="c.beforeTitle ?? ''"
        :after="titles[c.id] ?? c.afterTitle"
      /><DiffText :before="c.before" :after="drafts[c.id] ?? c.after" />
      <details v-if="!c.applied">
        <summary>编辑这一项建议</summary>
        <NInput
          v-if="c.afterTitle !== undefined"
          v-model:value="titles[c.id]"
          placeholder="名称"
          :disabled="applying"
        /><NInput
          v-model:value="drafts[c.id]"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 16 }"
          :disabled="applying"
        />
      </details>
    </article>
    <template #footer
      ><div class="modal-footer">
        <NButton :disabled="applying" @click="store.reviewingChangeId = ''"
          >关闭</NButton
        ><NButton
          type="primary"
          :loading="applying"
          :disabled="!chosen.length || store.busy"
          @click="apply"
          >采用所选修改（{{ chosen.length }}）</NButton
        >
      </div></template
    >
  </NModal>
</template>
<style scoped>
.review-item {
  padding: 18px 0;
  border-bottom: 1px solid #dce2e9;
}
.review-error {
  color: #b42318;
  white-space: pre-wrap;
}
</style>
