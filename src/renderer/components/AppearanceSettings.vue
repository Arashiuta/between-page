<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { NInputNumber, NButton, NColorPicker } from "naive-ui";
import { Palette, RotateCcw } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import {
  activeColors,
  defaultAppearance,
  themePresets,
} from "../../shared/appearance";
import type { AppearanceSettings, ThemeColors } from "../../shared/types";

const store = useWorkspace();
const appearance = computed(
  () => store.settings?.software.appearance ?? defaultAppearance(),
);
const colors = computed(() => activeColors(appearance.value));
const draft = reactive({} as ThemeColors),
  errors = reactive<Record<string, string>>({});
const fields: { key: keyof ThemeColors; label: string }[] = [
  { key: "primary", label: "主色" },
  { key: "page", label: "页面背景" },
  { key: "surface", label: "卡片背景" },
  { key: "paper", label: "正文纸张" },
  { key: "ink", label: "主要文字" },
  { key: "sidebar", label: "侧栏背景" },
];
watch(
  colors,
  (value) => {
    Object.assign(draft, value);
    for (const key of Object.keys(errors)) delete errors[key];
  },
  { immediate: true },
);
function edit(patch: Partial<AppearanceSettings>) {
  store.editSoftwareSettings({ appearance: patch });
}
function selectTheme(theme: AppearanceSettings["theme"]) {
  if (theme === "custom" && !appearance.value.customColors)
    edit({
      theme,
      customBase:
        appearance.value.theme === "custom"
          ? appearance.value.customBase
          : appearance.value.theme,
      customColors: { ...colors.value },
    });
  else edit({ theme });
}
function changeColor(key: keyof ThemeColors, value: string) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    errors[key] = "请输入 # 加六位十六进制颜色。";
    return;
  }
  delete errors[key];
  edit({ customColors: { ...colors.value, [key]: value.toLowerCase() } });
}
function font(key: "uiFontSize" | "editorFontSize", value: number | null) {
  if (value !== null) edit({ [key]: Math.round(value) });
}
function restore() {
  edit(defaultAppearance());
  store.notify("已恢复默认外观。");
}
</script>
<template>
  <section class="settings-card appearance-settings">
    <div class="settings-card-heading">
      <span class="settings-icon"><Palette :size="20" /></span>
      <div>
        <h2>界面外观</h2>
        <p>字号与配色即时生效，更改自动保存</p>
      </div>
    </div>
    <div class="appearance-fonts">
      <div>
        <label id="ui-font-label" class="field-label">界面字号</label
        ><NInputNumber
          :value="appearance.uiFontSize"
          :min="12"
          :max="20"
          :step="1"
          :precision="0"
          aria-labelledby="ui-font-label"
          @update:value="(v) => font('uiFontSize', v)"
          ><template #suffix>px</template></NInputNumber
        >
        <p class="field-help">菜单、按钮与表单 · 默认 14 px</p>
      </div>
      <div>
        <label id="story-font-label" class="field-label">正文字号</label
        ><NInputNumber
          :value="appearance.editorFontSize"
          :min="14"
          :max="32"
          :step="1"
          :precision="0"
          aria-labelledby="story-font-label"
          @update:value="(v) => font('editorFontSize', v)"
          ><template #suffix>px</template></NInputNumber
        >
        <p class="field-help">正文编辑与章节版本阅读 · 默认 17 px</p>
      </div>
    </div>
    <label class="field-label">配色主题</label>
    <div class="theme-options" role="group" aria-label="配色主题">
      <button
        v-for="preset in themePresets"
        :key="preset.id"
        :class="['theme-option', { selected: appearance.theme === preset.id }]"
        :aria-pressed="appearance.theme === preset.id"
        @click="selectTheme(preset.id)"
      >
        <span
          class="theme-swatch"
          :style="{
            background: preset.colors.page,
            color: preset.colors.primary,
            borderColor: preset.colors.sidebar,
          }"
          >Aa</span
        ><span>{{ preset.name }}</span>
      </button>
      <button
        :class="['theme-option', { selected: appearance.theme === 'custom' }]"
        :aria-pressed="appearance.theme === 'custom'"
        @click="selectTheme('custom')"
      >
        <span class="theme-swatch custom-swatch"><Palette :size="20" /></span
        ><span>自定义配色</span>
      </button>
    </div>
    <div v-if="appearance.theme === 'custom'" class="custom-colors">
      <p class="field-help">
        自定义基于「{{
          themePresets.find((p) => p.id === appearance.customBase)?.name
        }}」。次级文字、边框和交互状态自动搭配；切换主题会保留这套自定义颜色。
      </p>
      <div class="color-fields">
        <div v-for="field in fields" :key="field.key" class="color-field">
          <label :id="`color-${field.key}-label`">{{ field.label }}</label>
          <div>
            <NColorPicker
              :value="colors[field.key]"
              :show-alpha="false"
              :modes="['hex']"
              :aria-labelledby="`color-${field.key}-label`"
              @update:value="(v) => changeColor(field.key, v)"
            /><input
              v-model="draft[field.key]"
              class="color-hex-input"
              :aria-label="`${field.label}十六进制颜色`"
              :aria-invalid="!!errors[field.key]"
              spellcheck="false"
              maxlength="7"
              @change="changeColor(field.key, draft[field.key])"
            />
          </div>
          <p v-if="errors[field.key]" class="cover-error" role="alert">
            {{ errors[field.key] }}
          </p>
        </div>
      </div>
    </div>
    <div class="appearance-preview">
      <strong>创作空间预览</strong>
      <p>让角色走进故事，让文字保持舒适。</p>
      <span class="memory-tag">当前主题</span
      ><button class="button primary" type="button" disabled>按钮示例</button>
    </div>
    <div class="appearance-reset">
      <p class="field-help">恢复页间经典、默认字号和默认配色。</p>
      <NButton @click="restore"
        ><template #icon><RotateCcw :size="15" /></template
        >恢复默认外观</NButton
      >
    </div>
  </section>
</template>
