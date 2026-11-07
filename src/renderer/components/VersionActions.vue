<script setup lang="ts">
import { ref } from "vue";
import { NModal, NInput, NButton } from "naive-ui";
import ItemActions from "./ItemActions.vue";
import { useWorkspace } from "../stores/workspace";
const props = defineProps<{ id: string; label: string }>();
const emit = defineEmits<{ changed: [deletedId?: string] }>();
const store = useWorkspace();
const mode = ref<"edit" | "delete" | null>(null),
  label = ref(""),
  usage = ref<string[]>([]),
  working = ref(false);
async function open(value: "edit" | "delete") {
  await store.flush();
  usage.value =
    value === "delete"
      ? await store.api("revision:usage", {
          projectId: store.detail!.project.id,
          id: props.id,
        })
      : [];
  label.value = props.label;
  mode.value = value;
}
async function save() {
  if (!mode.value || working.value) return;
  working.value = true;
  try {
    await store.flush();
    const deleting = mode.value === "delete";
    await store.api(`revision:${deleting ? "delete" : "update"}`, {
      projectId: store.detail!.project.id,
      id: props.id,
      ...(!deleting ? { label: label.value.trim() } : {}),
    });
    mode.value = null;
    emit("changed", deleting ? props.id : undefined);
    store.notify(deleting ? "已删除无引用的历史版本。" : "版本标签已更新。");
  } finally {
    working.value = false;
  }
}
</script>
<template>
  <ItemActions
    :label="`版本「${props.label}」`"
    :disabled="store.busy || store.imageBusy || working"
    :actions="[{ key: 'delete', label: '删除此版本' }]"
    @edit="store.safe(() => open('edit'))"
    @action="store.safe(() => open('delete'))"
  />
  <NModal
    :show="!!mode"
    @update:show="
      (v) => {
        if (!v && !working) mode = null;
      }
    "
    preset="card"
    :title="mode === 'edit' ? '编辑版本标签' : '删除历史版本？'"
    :style="{ width: '520px' }"
  >
    <NInput
      v-if="mode === 'edit'"
      v-model:value="label"
      :maxlength="500"
      placeholder="版本标签"
    />
    <template v-else>
      <p>
        删除「{{
          props.label
        }}」将移除此快照，当前正文与规划不变。此操作无法撤销。
      </p>
      <template v-if="usage.length"
        ><p>此版本仍被引用，请先处理以下引用：</p>
        <ul>
          <li v-for="item in usage" :key="item">{{ item }}</li>
        </ul></template
      >
    </template>
    <template #footer
      ><div class="modal-footer">
        <NButton :disabled="working" @click="mode = null">取消</NButton
        ><NButton
          :type="mode === 'delete' ? 'error' : 'primary'"
          :disabled="
            mode === 'delete'
              ? !!usage.length || store.busy || store.imageBusy
              : !label.trim()
          "
          :loading="working"
          @click="store.safe(save)"
          >{{ mode === "delete" ? "确认删除" : "保存标签" }}</NButton
        >
      </div></template
    >
  </NModal>
</template>
