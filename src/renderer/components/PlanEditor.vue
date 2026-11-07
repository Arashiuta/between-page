<script setup lang="ts">
import { computed } from "vue";
import { NButton, NInput } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import type {
  PlanBlock,
  PlanningTarget,
  ProjectDetail,
} from "../../shared/types";
import {
  planningHints,
  planningLabels,
  planStatus,
} from "../../shared/planning";
const props = defineProps<{
  block: PlanBlock;
  target: PlanningTarget;
  title: string;
  disabled?: boolean;
}>();
const store = useWorkspace();
const status = computed(() => planStatus(props.block));
async function confirm() {
  await store.flush();
  const result = await store.api<{ detail: ProjectDetail }>("planning:save", {
    projectId: store.detail!.project.id,
    target: props.target,
    title: props.title,
    content: props.block.content,
    confirm: true,
  });
  store.detail = result.detail;
  store.notify(
    "已确认规划；关联计划与正文的影响已标记，正文内容没有自动修改。",
  );
}
function generate(adjust = false) {
  store.planningTarget = props.target;
  store.instruction = adjust
    ? "针对待核对原因调整此规划，保留仍然适用的部分。"
    : `完善当前${planningLabels[props.target.level]}，遵循上层规划。`;
  return store.runTask(adjust ? "adjust" : "outline", {
    planningTarget: props.target,
  });
}
</script>
<template>
  <section class="plan-editor">
    <div class="section-toolbar">
      <h3>{{ planningLabels[target.level] }} · {{ title }}</h3>
      <span class="plan-status" :class="{ review: block.reviewReason }">{{
        status
      }}</span>
    </div>
    <p class="field-help">{{ planningHints[target.level] }}</p>
    <NInput
      v-if="target.level !== 'synopsis'"
      :disabled="disabled"
      :value="title"
      placeholder="名称"
      @update:value="
        (value) => store.editPlanning(target, block.content, value)
      "
    />
    <NInput
      :disabled="disabled"
      :value="block.content"
      type="textarea"
      :autosize="{ minRows: 10, maxRows: 30 }"
      :placeholder="planningHints[target.level]"
      @update:value="(value) => store.editPlanning(target, value, title)"
    />
    <p v-if="block.reviewReason" class="review-banner">
      {{ block.reviewReason }} 这不会改变已有正文或正式记忆。
    </p>
    <p
      v-if="block.confirmed !== undefined && block.confirmed !== block.content"
      class="field-help"
    >
      当前有未确认修改。正文默认参考上次确认版本，也可选择使用规划草稿试写。
    </p>
    <div class="workbench-actions">
      <NButton
        type="primary"
        :disabled="disabled || !block.content.trim() || store.busy"
        @click="store.safe(confirm)"
        >确认此规划</NButton
      >
      <NButton
        :disabled="disabled || store.busy"
        @click="store.safe(() => generate())"
        >AI 完善这一项</NButton
      >
      <NButton
        v-if="block.reviewReason"
        :disabled="disabled || store.busy"
        @click="store.safe(() => generate(true))"
        >生成调整建议</NButton
      >
    </div>
    <p class="field-help">
      草稿自动保存。AI 结果在右侧审核，采用后才更新当前规划。
    </p>
  </section>
</template>
