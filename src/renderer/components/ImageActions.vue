<script setup lang="ts">
import { ref } from "vue";
import { NModal, NInput, NButton } from "naive-ui";
import type { ImageAsset } from "../../shared/types";
import ItemActions from "./ItemActions.vue";
import { useWorkspace } from "../stores/workspace";
const props = defineProps<{ image: ImageAsset }>();
const emit = defineEmits<{ updated: [image: ImageAsset]; deleted: [] }>();
const store = useWorkspace();
const mode = ref<"edit" | "delete" | null>(null),
  name = ref(""),
  notes = ref(""),
  usage = ref<string[]>([]),
  working = ref(false);
async function open(value: "edit" | "delete") {
  await store.flush();
  usage.value = await store.api("asset:usage", props.image.id);
  name.value = props.image.name;
  notes.value = props.image.notes ?? "";
  mode.value = value;
}
async function save() {
  if (!mode.value || working.value) return;
  working.value = true;
  try {
    await store.flush();
    if (mode.value === "edit") {
      const image = await store.api<ImageAsset>("asset:update", {
        id: props.image.id,
        name: name.value,
        notes: notes.value,
      });
      store.images = store.images.map((i) => (i.id === image.id ? image : i));
      if (store.detail)
        store.detail.images = store.detail.images.map((i) =>
          i.id === image.id ? image : i,
        );
      emit("updated", image);
      store.notify("图片名称与备注已保存。");
    } else {
      const result = await store.api<{ pendingCleanup: number }>(
        "asset:delete",
        props.image.id,
      );
      store.images = store.images.filter((i) => i.id !== props.image.id);
      if (store.detail)
        store.detail.images = store.detail.images.filter(
          (i) => i.id !== props.image.id,
        );
      emit("deleted");
      store.notify(
        result.pendingCleanup
          ? "图片记录已删除，文件清理将在下次启动时重试。"
          : "图片已删除。",
      );
    }
    mode.value = null;
  } finally {
    working.value = false;
  }
}
</script>
<template>
  <ItemActions
    :label="`图片「${image.name}」`"
    :disabled="store.busy || store.imageBusy || working"
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
    :title="mode === 'edit' ? '编辑图片信息' : '删除图片？'"
    :style="{ width: '560px' }"
  >
    <template v-if="mode === 'edit'"
      ><label class="field-label first">名称</label
      ><NInput v-model:value="name" :maxlength="500" /><label
        class="field-label"
        >作者备注</label
      ><NInput
        v-model:value="notes"
        type="textarea"
        :maxlength="20000"
        :autosize="{ minRows: 3, maxRows: 10 }"
      />
      <p class="field-help">原始提示词、模型与生成来源保留。</p></template
    >
    <p v-else>删除「{{ image.name }}」及其图片文件？此操作无法撤销。</p>
    <template v-if="usage.length"
      ><p>引用位置：</p>
      <ul>
        <li v-for="item in usage" :key="item">{{ item }}</li>
      </ul>
      <p class="field-help">
        请先在资料卡中取消关联、移除作品封面，或处理引用这张图的其他图片及撤销记录，再彻底删除。
      </p></template
    >
    <p v-else class="field-help">目前没有其他内容引用这张图片。</p>
    <template #footer
      ><div class="modal-footer">
        <NButton :disabled="working" @click="mode = null">取消</NButton
        ><NButton
          :type="mode === 'delete' ? 'error' : 'primary'"
          :disabled="
            mode === 'delete'
              ? !!usage.length || store.busy || store.imageBusy
              : !name.trim()
          "
          :loading="working"
          @click="store.safe(save)"
          >{{ mode === "delete" ? "确认删除" : "保存信息" }}</NButton
        >
      </div></template
    >
  </NModal>
</template>
