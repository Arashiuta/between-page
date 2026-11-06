<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NInput,
  NSelect,
} from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { developmentLabel } from "../../shared/development";
import type {
  DevelopmentChange,
  StoryDevelopmentDraft,
} from "../../shared/types";

const store = useWorkspace();
const draft = ref<StoryDevelopmentDraft | null>(null);
const selectedIds = ref<string[]>([]);
const applying = ref(false);
watch(
  () => store.developmentDraft,
  (value) => {
    const resetSelection =
      draft.value?.id !== value?.id ||
      draft.value?.appliedIds.join() !== value?.appliedIds.join();
    draft.value = value ? JSON.parse(JSON.stringify(value)) : null;
    if (resetSelection)
      selectedIds.value =
        value?.changes
          .filter((change) => !value.appliedIds.includes(change.id))
          .map((change) => change.id) ?? [];
  },
  { immediate: true },
);
const remaining = computed(
  () =>
    draft.value?.changes.filter(
      (change) => !draft.value!.appliedIds.includes(change.id),
    ) ?? [],
);
function select(id: string, checked: boolean) {
  selectedIds.value = checked
    ? [...selectedIds.value, id]
    : selectedIds.value.filter((value) => value !== id);
}
function persist() {
  if (draft.value) store.editDevelopment(draft.value);
}
function before(change: DevelopmentChange): string {
  if (!change.base) return "";
  return change.target === "blueprint"
    ? (store.detail?.project.blueprintSections.find(
        (section) => section.id === change.targetId,
      )?.content ?? "")
    : (store.detail?.cards
        .find((card) => card.id === change.targetId)
        ?.sections.find((section) => section.id === change.sectionId)
        ?.content ?? "");
}
function sourceTitle(revisionId: string) {
  return (
    store.detail?.chapters.find(
      (chapter) => chapter.acceptedRevisionId === revisionId,
    )?.title ?? "原采用版本"
  );
}
async function apply() {
  if (!draft.value || applying.value) return;
  applying.value = true;
  await store.safe(() =>
    store.applyDevelopmentChanges(draft.value!, selectedIds.value),
  );
  applying.value = false;
}
</script>

<template>
  <NDrawer
    v-model:show="store.reviewingDevelopment"
    placement="right"
    width="min(1000px, 96vw)"
    :mask-closable="!applying"
    :close-on-esc="!applying"
  >
    <NDrawerContent title="完善设定与蓝图" :closable="!applying">
      <template v-if="draft">
        <p class="field-help">
          采用后会成为后续创作的设定或计划。正文提炼保留引用，新增构想另作标记；故事记忆仍从采用正文单独整理。
        </p>
        <p class="development-summary">{{ draft.summary }}</p>
        <ul v-if="draft.warnings.length" class="development-warnings">
          <li v-for="warning in draft.warnings" :key="warning">
            {{ warning }}
          </li>
        </ul>
        <div class="section-toolbar">
          <NCheckbox
            :checked="
              !!remaining.length && selectedIds.length === remaining.length
            "
            :disabled="applying || !remaining.length"
            @update:checked="
              (checked) =>
                (selectedIds = checked
                  ? remaining.map((change) => change.id)
                  : [])
            "
            >选择未采用分区</NCheckbox
          >
          <span class="muted small"
            >{{ draft.appliedIds.length }} /
            {{ draft.changes.length }} 项已采用</span
          >
        </div>
        <article
          v-for="change in draft.changes"
          :key="change.id"
          class="development-change"
          :class="{ 'is-applied': draft.appliedIds.includes(change.id) }"
        >
          <div class="section-toolbar">
            <NCheckbox
              :checked="selectedIds.includes(change.id)"
              :disabled="applying || draft.appliedIds.includes(change.id)"
              @update:checked="(checked) => select(change.id, checked)"
              ><strong>{{ developmentLabel(change) }}</strong></NCheckbox
            >
            <span class="memory-tag">{{
              draft.appliedIds.includes(change.id)
                ? "已采用"
                : change.basis === "established"
                  ? "正文提炼"
                  : "新增构想"
            }}</span>
          </div>
          <template
            v-if="
              change.base && (change.target === 'blueprint' || change.sectionId)
            "
          >
            <NSelect
              v-model:value="change.mode"
              size="small"
              :disabled="applying || draft.appliedIds.includes(change.id)"
              :options="[
                { label: '追加到现有分区', value: 'append' },
                { label: '替换此分区（下方填写完整内容）', value: 'replace' },
              ]"
              @update:value="persist"
            />
            <details class="development-before">
              <summary>查看当前分区内容</summary>
              <pre>{{ before(change) || "当前分区为空" }}</pre>
            </details>
          </template>
          <NInput
            v-model:value="change.content"
            type="textarea"
            :autosize="{ minRows: 4, maxRows: 16 }"
            :maxlength="12000"
            :disabled="applying || draft.appliedIds.includes(change.id)"
            :aria-label="developmentLabel(change) + '内容'"
            @blur="persist"
          />
          <details v-if="change.sources.length" class="development-sources">
            <summary>查看 {{ change.sources.length }} 条正文依据</summary>
            <blockquote
              v-for="source in change.sources"
              :key="source.revisionId + source.quote"
            >
              <strong
                >{{ sourceTitle(source.revisionId) }} ·
                {{ source.revisionId.slice(0, 8) }}</strong
              >
              <p>{{ source.quote }}</p>
            </blockquote>
          </details>
        </article>
      </template>
      <template #footer>
        <div class="development-review-actions">
          <NButton
            v-if="store.developmentUndoId"
            :disabled="applying || store.busy"
            @click="store.safe(store.undoDevelopmentChanges)"
            >撤销上次更新</NButton
          >
          <NButton
            :disabled="applying"
            @click="store.reviewingDevelopment = false"
            >关闭</NButton
          >
          <NButton
            type="primary"
            :loading="applying"
            :disabled="store.busy || !selectedIds.length"
            @click="apply"
            >采用选中的 {{ selectedIds.length }} 个分区</NButton
          >
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>
