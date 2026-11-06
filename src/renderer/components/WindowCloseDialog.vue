<script setup lang="ts">
import { ref, watch } from "vue";
import { NButton, NCheckbox, NModal } from "naive-ui";
import { Minus, Power } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import brandMark from "../assets/brand-mark.svg";

const store = useWorkspace();
const remember = ref(false);
watch(
  () => store.closePrompt,
  (show) => {
    if (show) remember.value = false;
  },
);
</script>

<template>
  <NModal
    v-model:show="store.closePrompt"
    preset="card"
    title="关闭页间"
    class="form-modal close-window-dialog"
    :style="{ width: '460px' }"
    :closable="!store.closingWindow"
    :mask-closable="!store.closingWindow"
    :close-on-esc="!store.closingWindow"
  >
    <div class="close-window-heading">
      <img :src="brandMark" alt="页间" />
      <div>
        <h2>要最小化还是关闭程序？</h2>
        <p>
          最小化后收起到系统托盘，点击托盘图标可恢复，生成任务会继续。关闭程序会停止任务，并先保存当前内容。
        </p>
      </div>
    </div>
    <NCheckbox
      v-model:checked="remember"
      :disabled="store.closingWindow || !store.ready"
    >
      记住我的选择
    </NCheckbox>
    <p class="field-help">之后可在「设置 → 软件设置」中修改。</p>
    <template #footer>
      <div class="close-window-actions">
        <NButton
          :disabled="store.closingWindow"
          @click="store.closePrompt = false"
          >取消</NButton
        >
        <NButton
          :disabled="store.closingWindow"
          @click="store.safe(() => store.confirmClose('minimize', remember))"
        >
          <template #icon><Minus :size="16" /></template>最小化到托盘
        </NButton>
        <NButton
          type="primary"
          :loading="store.closingWindow"
          @click="store.safe(() => store.confirmClose('quit', remember))"
        >
          <template #icon><Power :size="16" /></template>关闭程序
        </NButton>
      </div>
    </template>
  </NModal>
</template>
