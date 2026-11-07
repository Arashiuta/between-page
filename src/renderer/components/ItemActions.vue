<script setup lang="ts">
import { NDropdown } from "naive-ui";
import { Pencil, MoreHorizontal } from "lucide-vue-next";
withDefaults(
  defineProps<{
    label: string;
    disabled?: boolean;
    actions?: { key: string; label: string; disabled?: boolean }[];
  }>(),
  { actions: () => [{ key: "delete", label: "删除" }] },
);
defineEmits<{ edit: []; action: [key: string] }>();
</script>
<template>
  <span class="item-actions" @click.stop @contextmenu.stop>
    <button
      class="icon-button"
      :aria-label="`编辑${label}`"
      :disabled="disabled"
      @click="$emit('edit')"
    >
      <Pencil :size="14" />
    </button>
    <NDropdown
      trigger="click"
      placement="bottom-end"
      :options="actions"
      :disabled="disabled"
      @select="(key: string) => $emit('action', key)"
    >
      <button
        class="icon-button"
        :aria-label="`${label}的更多操作`"
        :disabled="disabled"
      >
        <MoreHorizontal :size="16" />
      </button>
    </NDropdown>
  </span>
</template>
