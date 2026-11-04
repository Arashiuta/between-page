<script setup lang="ts">
import { ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { NInput, NButton, NSelect, NPopconfirm } from "naive-ui";
import {
  Plug,
  Image,
  FolderOpen,
  Archive,
  ArrowRight,
  KeyRound,
  HardDrive,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { SettingsInput } from "../../shared/types";
import ProviderModels from "../components/ProviderModels.vue";
const store = useWorkspace(),
  testing = ref(false),
  backupBusy = ref(false),
  moving = ref(false);
const { settings: currentSettings } = storeToRefs(store);
const form = ref<SettingsInput>({
  text: {
    baseUrl: store.settings!.text.baseUrl,
    model: store.settings!.text.model,
    selectedModels: [...store.settings!.text.selectedModels],
    availableModels: [...store.settings!.text.availableModels],
    key: store.settings!.text.key,
  },
  image: {
    baseUrl: store.settings!.image.baseUrl,
    model: store.settings!.image.model,
    selectedModels: [...store.settings!.image.selectedModels],
    availableModels: [...store.settings!.image.availableModels],
    key: store.settings!.image.key,
  },
  imageSize: store.settings!.imageSize,
  imageQuality: store.settings!.imageQuality,
});
watch(form, (value) => store.editSettings(value), {
  deep: true,
  flush: "sync",
});
async function test() {
  testing.value = true;
  await store.safe(async () => {
    await store.flush();
    const result = await store.api<string>("settings:test", "text");
    store.notify(result);
  });
  testing.value = false;
}
async function backup() {
  backupBusy.value = true;
  await store.safe(async () => {
    await store.flush();
    const path = await store.api<string>("storage:backup");
    store.notify("完整备份已保存：" + path);
  });
  backupBusy.value = false;
}
async function move() {
  moving.value = true;
  await store.safe(async () => {
    await store.flush();
    const moved = await store.api<boolean>("storage:move");
    if (moved) store.notify("迁移完成，正在重新启动。");
  });
  moving.value = false;
}
function openFolder() {
  void store.safe(() => store.api("storage:open"));
}
</script>
<template>
  <main class="page settings-page">
    <div class="page-heading">
      <div>
        <h1>设置与模型</h1>
      </div>
      <span class="muted">更改自动保存</span>
    </div>
    <div class="settings-columns">
      <section class="settings-card">
        <div class="settings-card-heading">
          <span class="settings-icon"><Plug :size="20" /></span>
          <div>
            <h2>文字模型</h2>
            <p>规划剧情、写作与记忆整理</p>
          </div>
          <span v-if="currentSettings?.text.hasKey" class="configured"
            >已配置 Key</span
          >
        </div>
        <label class="field-label">接口地址</label
        ><NInput
          v-model:value="form.text.baseUrl"
          :maxlength="2000"
          placeholder="https://你的服务地址/v1"
        />
        <p class="field-help">支持基础地址或完整的 chat/completions 地址。</p>
        <label class="field-label">API Key</label
        ><NInput
          v-model:value="form.text.key"
          type="password"
          show-password-on="click"
          placeholder="填写你的文字模型 Key"
          :maxlength="4000"
          autocomplete="off"
        />
        <ProviderModels v-model="form.text" kind="text" />
        <div class="settings-card-footer">
          <span>兼容聊天接口 · 支持流式输出</span
          ><NButton size="small" :loading="testing" @click="test"
            >测试模型连通性</NButton
          >
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-card-heading">
          <span class="settings-icon sand"><Image :size="20" /></span>
          <div>
            <h2>插画模型</h2>
            <p>独立配置生图服务</p>
          </div>
          <span v-if="currentSettings?.image.hasKey" class="configured"
            >已配置 Key</span
          >
        </div>
        <label class="field-label">生图接口地址</label
        ><NInput
          v-model:value="form.image.baseUrl"
          :maxlength="2000"
          placeholder="https://你的生图服务地址/v1"
        />
        <p class="field-help">
          支持基础地址或完整图片接口地址，参考图使用编辑接口。
        </p>
        <label class="field-label">API Key</label
        ><NInput
          v-model:value="form.image.key"
          type="password"
          show-password-on="click"
          placeholder="填写你的生图服务 Key"
          :maxlength="4000"
          autocomplete="off"
        />
        <ProviderModels v-model="form.image" kind="image" />
        <div class="form-two-columns">
          <div>
            <label class="field-label">默认尺寸</label
            ><NSelect
              v-model:value="form.imageSize"
              :options="[
                { label: '方形 · 1024 × 1024', value: '1024x1024' },
                { label: '横幅 · 1536 × 1024', value: '1536x1024' },
                { label: '竖幅 · 1024 × 1536', value: '1024x1536' },
                { label: '自动', value: 'auto' },
              ]"
            />
          </div>
          <div>
            <label class="field-label">默认质量</label
            ><NSelect
              v-model:value="form.imageQuality"
              :options="[
                { label: '自动', value: 'auto' },
                { label: '草稿', value: 'low' },
                { label: '标准', value: 'medium' },
                { label: '精细', value: 'high' },
              ]"
            />
          </div>
        </div>
        <div class="settings-card-footer">
          <span>在故事插画页手动生成，验证实际效果。</span>
        </div>
      </section>
    </div>
    <section class="settings-card storage-card">
      <div class="settings-card-heading">
        <span class="settings-icon"><HardDrive :size="20" /></span>
        <div>
          <h2>数据存储</h2>
          <p>数据库、参考图、插画、备份与运行缓存集中管理</p>
        </div>
      </div>
      <div class="storage-path">
        <FolderOpen :size="18" /><code>{{ currentSettings?.dataDir }}</code
        ><NButton size="small" @click="openFolder">打开文件夹</NButton>
      </div>
      <div class="storage-actions">
        <div>
          <h3>完整备份</h3>
          <p>生成包含数据库与图片的 ZIP，可在运行中安全备份。</p>
        </div>
        <NButton :loading="backupBusy" @click="backup"
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
          ><template #trigger
            ><NButton :loading="moving"
              >更换目录
              <template #icon
                ><ArrowRight :size="15" /></template></NButton></template
          >迁移后将重启软件。当前草稿会先保存，原数据仍然保留。</NPopconfirm
        >
      </div>
      <div class="info-note">
        <KeyRound :size="14" /><span
          >API Key 明文保存在本地数据库中，完整备份会一并包含。</span
        >
      </div>
    </section>
    <footer class="page-footer">
      <span>页间 · 故事创作工作台</span
      ><span>版本 {{ currentSettings?.version }}</span>
    </footer>
  </main>
</template>
