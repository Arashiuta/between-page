<script setup lang="ts">
import { ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { NInput, NButton, NSelect, NTabs, NTabPane } from "naive-ui";
import { Plug, Image } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { SettingsInput } from "../../shared/types";
import ProviderModels from "../components/ProviderModels.vue";
import SoftwareSettings from "../components/SoftwareSettings.vue";
const store = useWorkspace(),
  testing = ref(false);
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
</script>
<template>
  <main class="page settings-page">
    <div class="page-heading">
      <div>
        <h1>设置</h1>
      </div>
      <span class="muted">更改自动保存</span>
    </div>
    <NTabs type="line" default-value="software" class="settings-tabs" animated>
      <NTabPane name="software" tab="软件设置" display-directive="show">
        <SoftwareSettings />
      </NTabPane>
      <NTabPane name="models" tab="模型设置" display-directive="show">
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
            <p class="field-help">
              支持基础地址或完整的 chat/completions 地址。
            </p>
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
      </NTabPane>
    </NTabs>
    <footer class="page-footer">
      <span>页间 · 故事创作工作台</span
      ><span>版本 {{ currentSettings?.version }}</span>
    </footer>
  </main>
</template>
