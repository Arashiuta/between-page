<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton, NPopconfirm } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { isLegacyPlanning } from "../../shared/blueprint";
const props = defineProps<{
  kind: "settings" | "blueprint" | "outline" | "memory";
}>();
const store = useWorkspace(),
  opened = ref<string[]>([]);
const sets = computed(() =>
  store.changeSets.filter((s) =>
    props.kind === "memory"
      ? s.kind === "notes" || s.kind === "memory_tune"
      : (isLegacyPlanning(s) ? "outline" : s.kind) === props.kind,
  ),
);
const key = computed(() => props.kind + ".candidates");
watch(
  () => store.detail?.project.id,
  async (id) => {
    opened.value = [];
    if (id) {
      const saved = await store.api<string[] | null>("ui:get", {
        projectId: id,
        key: key.value,
      });
      if (id === store.detail?.project.id) opened.value = saved ?? [];
    }
  },
  { immediate: true },
);
function toggle(id: string) {
  opened.value = opened.value.includes(id)
    ? opened.value.filter((x) => x !== id)
    : [...opened.value, id];
  if (store.detail)
    void store.api("ui:save", {
      projectId: store.detail.project.id,
      key: key.value,
      value: opened.value,
    });
}
async function remove(id: string) {
  if (!store.detail) return;
  await store.api("changes:delete", { projectId: store.detail.project.id, id });
  store.changeSets = store.changeSets.filter((s) => s.id !== id);
}
</script>
<template>
  <section class="candidate-shelf">
    <button class="candidate-summary" @click="toggle('all')">
      {{ opened.includes("all") ? "▾" : "▸" }}
      {{
        kind === "settings"
          ? "设定候选"
          : kind === "memory"
            ? "故事记忆候选"
            : kind === "outline"
              ? "大纲候选"
              : "额外设定候选"
      }}
      <span>{{ sets.length }}</span>
    </button>
    <div v-if="opened.includes('all')">
      <p v-if="!sets.length" class="field-help">
        尚无候选。AI 建议经审核后才生效。
      </p>
      <article v-for="s in sets" :key="s.id" class="candidate-item">
        <button class="candidate-summary" @click="toggle(s.id)">
          {{ opened.includes(s.id) ? "▾" : "▸" }} {{ s.title }} ·
          {{
            s.status === "applied"
              ? "已采用"
              : s.status === "partial"
                ? "部分采用"
                : "待审核"
          }}
        </button>
        <div v-if="opened.includes(s.id)">
          <pre>{{ s.changes.map((c) => c.after).join("\n\n") }}</pre>
          <p v-if="isLegacyPlanning(s)" class="field-help">
            旧版分层规划建议，仅供查看；请在大纲规划中重新生成后采用。
          </p>
          <div class="workbench-actions">
            <NButton size="small" @click="store.reviewingChangeId = s.id"
              >查看差异与审核</NButton
            ><NPopconfirm @positive-click="store.safe(() => remove(s.id))"
              ><template #trigger
                ><NButton size="small">删除候选</NButton></template
              >删除候选记录？已采用内容保留。</NPopconfirm
            >
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
<style scoped>
.candidate-shelf {
  margin-top: 28px;
  border-top: 1px solid #dce2e9;
  padding-top: 14px;
}
.candidate-summary {
  border: 0;
  background: transparent;
  text-align: left;
  padding: 10px 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.candidate-summary span {
  background: #e8edf4;
  border-radius: 15px;
  padding: 2px 8px;
}
.candidate-item {
  border-top: 1px solid #e4e8ed;
  padding: 8px;
}
.candidate-item pre {
  white-space: pre-wrap;
  max-height: 300px;
  overflow: auto;
  font: inherit;
}
</style>
