<script setup lang="ts">
import { computed } from "vue";
import { NSelect } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { effectiveRole } from "../../shared/roles";
import type { RoleId } from "../../shared/types";

const props = defineProps<{ role: RoleId; disabled?: boolean }>();
const model = defineModel<string>({ required: true });
const store = useWorkspace();
const fallback = computed(
  () =>
    effectiveRole(store.roles, props.role).model ||
    store.settings?.text.model ||
    "未配置",
);
const options = computed(() =>
  (store.settings?.text.selectedModels ?? []).map((id) => ({
    label: id,
    value: id,
  })),
);
</script>

<template>
  <NSelect
    :value="model || null"
    :options="options"
    :disabled="disabled"
    :placeholder="`跟随职责 / 默认模型（${fallback}）`"
    filterable
    clearable
    @update:value="(value) => (model = value || '')"
  />
</template>
