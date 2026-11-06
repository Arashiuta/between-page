<script setup lang="ts">
import { ref } from "vue";
import { NButton, NSelect, NPopconfirm } from "naive-ui";
import {
  FolderOpen,
  Archive,
  ArrowRight,
  KeyRound,
  HardDrive,
  AppWindow,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { CloseAction } from "../../shared/types";
import AppearanceSettings from "./AppearanceSettings.vue";

const store = useWorkspace();
const backupBusy = ref(false),
  moving = ref(false);
const closeOptions = [
  { label: "每次询问", value: "ask" },
  { label: "最小化到系统托盘", value: "minimize" },
  { label: "关闭程序", value: "quit" },
];
function changeCloseAction(closeAction: CloseAction) {
  store.editSoftwareSettings({ closeAction });
}
async function backup() {
  backupBusy.value = true;
  try {
    await store.safe(async () => {
      await store.flush();
      const path = await store.api<string>("storage:backup");
      store.notify("完整备份已保存：" + path);
    });
  } finally {
    backupBusy.value = false;
  }
}
async function move() {
  moving.value = true;
  try {
    await store.safe(async () => {
      await store.flush();
      const moved = await store.api<boolean>("storage:move");
      if (moved) store.notify("迁移完成，正在重新启动。");
    });
  } finally {
    moving.value = false;
  }
}
</script>

<template>
  <div class="software-settings">
    <AppearanceSettings />
    <section class="settings-card">
      <div class="settings-card-heading">
        <span class="settings-icon"><AppWindow :size="20" /></span>
        <div>
          <h2>窗口行为</h2>
          <p>选择点击右上角关闭按钮时的动作</p>
        </div>
      </div>
      <div class="software-setting-row">
        <div>
          <label id="close-action-label" class="field-label"
            >点击关闭按钮时</label
          >
          <p class="field-help">
            选择「每次询问」可重新显示带有“记住我的选择”的提示。
          </p>
        </div>
        <NSelect
          aria-labelledby="close-action-label"
          :value="store.settings?.software.closeAction ?? 'ask'"
          :options="closeOptions"
          @update:value="changeCloseAction"
        />
      </div>
    </section>
    <section class="settings-card storage-card">
      <div class="settings-card-heading">
        <span class="settings-icon"><HardDrive :size="20" /></span>
        <div>
          <h2>数据存储</h2>
          <p>数据库、参考图、插画、备份与运行缓存集中管理</p>
        </div>
      </div>
      <div class="storage-path">
        <FolderOpen :size="18" /><code>{{ store.settings?.dataDir }}</code>
        <NButton
          size="small"
          @click="store.safe(() => store.api('storage:open'))"
          >打开文件夹</NButton
        >
      </div>
      <div class="storage-actions">
        <div>
          <h3>完整备份</h3>
          <p>生成包含数据库与图片的 ZIP，可在运行中安全备份。</p>
        </div>
        <NButton :loading="backupBusy" :disabled="moving" @click="backup"
          ><template #icon><Archive :size="15" /></template>创建备份</NButton
        >
      </div>
      <div class="storage-actions">
        <div>
          <h3>迁移数据目录</h3>
          <p>选择一个空文件夹，复制完成后重启。原目录保留。</p>
        </div>
        <NPopconfirm
          @positive-click="move"
          positive-text="选择目录"
          negative-text="取消"
        >
          <template #trigger
            ><NButton :loading="moving" :disabled="backupBusy"
              >更换目录<template #icon
                ><ArrowRight :size="15" /></template></NButton
          ></template>
          迁移后将重启软件。当前草稿会先保存，原数据仍然保留。
        </NPopconfirm>
      </div>
      <div class="info-note">
        <KeyRound :size="14" /><span
          >API Key 明文保存在本地数据库中，完整备份会一并包含。</span
        >
      </div>
    </section>
  </div>
</template>
