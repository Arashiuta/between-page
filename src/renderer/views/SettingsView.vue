<script setup lang="ts">
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { NInput, NButton, NSelect, NCheckbox, NPopconfirm } from "naive-ui";
import {
  Settings,
  Check,
  Plug,
  Image,
  FolderOpen,
  Archive,
  ArrowRight,
  KeyRound,
  HardDrive,
} from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { Settings as SettingsType } from "../../shared/types";
const store = useWorkspace(),
  saving = ref(false),
  testing = ref(false),
  backupBusy = ref(false),
  moving = ref(false);
const { settings: currentSettings } = storeToRefs(store);
const form = ref({
  text: {
    baseUrl: store.settings!.text.baseUrl,
    model: store.settings!.text.model,
    key: "",
    clearKey: false,
  },
  image: {
    baseUrl: store.settings!.image.baseUrl,
    model: store.settings!.image.model,
    key: "",
    clearKey: false,
  },
  imageSize: store.settings!.imageSize,
  imageQuality: store.settings!.imageQuality,
});
async function save() {
  saving.value = true;
  const result = await store.safe(async () => {
    await store.api<SettingsType>("settings:save", form.value);
    await store.bootstrap();
    form.value.text.key = "";
    form.value.image.key = "";
    form.value.text.clearKey = false;
    form.value.image.clearKey = false;
    store.notify("接口配置已保存。");
    return true;
  });
  saving.value = false;
  return result;
}
async function test() {
  testing.value = true;
  await store.safe(async () => {
    if (!(await save())) return;
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
    <div class="page-eyebrow">MAKE YOURSELF AT HOME</div>
    <div class="page-heading">
      <div>
        <h1>让工具，顺着你的习惯。</h1>
        <p>连接你选择的模型服务，故事与插画保存在自己的电脑。</p>
      </div>
      <NButton type="primary" :loading="saving" @click="save"
        ><template #icon><Check :size="16" /></template>保存设置</NButton
      >
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
          placeholder="https://你的服务地址/v1"
        />
        <p class="field-help">支持基础地址或完整的 chat/completions 地址。</p>
        <label class="field-label">API Key</label
        ><NInput
          v-model:value="form.text.key"
          type="password"
          show-password-on="click"
          :placeholder="
            currentSettings?.text.hasKey
              ? '已加密保存；留空保留原 Key'
              : '填写你的文字模型 Key'
          "
          autocomplete="off"
        /><NCheckbox
          v-if="currentSettings?.text.hasKey"
          v-model:checked="form.text.clearKey"
          class="key-checkbox"
          >清除已保存的 Key</NCheckbox
        ><label class="field-label">模型名称</label
        ><NInput
          v-model:value="form.text.model"
          placeholder="填写服务商提供的模型名称"
        />
        <div class="settings-card-footer">
          <span>兼容聊天接口 · 支持流式输出</span
          ><NButton size="small" :loading="testing" @click="test"
            >保存并测试连接</NButton
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
          :placeholder="
            currentSettings?.image.hasKey
              ? '已加密保存；留空保留原 Key'
              : '填写你的生图服务 Key'
          "
          autocomplete="off"
        /><NCheckbox
          v-if="currentSettings?.image.hasKey"
          v-model:checked="form.image.clearKey"
          class="key-checkbox"
          >清除已保存的 Key</NCheckbox
        ><label class="field-label">模型名称</label
        ><NInput
          v-model:value="form.image.model"
          placeholder="gpt-image-2 或服务商使用的别名"
        />
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
          <h2>你的故事，保存在这里</h2>
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
          >Key 使用当前 Windows 账户加密保存。换电脑后通常需要重新填写。</span
        >
      </div>
    </section>
    <footer class="page-footer">
      <span>页间 · 故事创作工作台</span
      ><span>版本 {{ currentSettings?.version }}</span>
    </footer>
  </main>
</template>
