<script setup lang="ts">
import { onMounted, ref, computed, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NConfigProvider,
  NModal,
  NInput,
  NSelect,
  NButton,
  NPopconfirm,
  darkTheme,
} from "naive-ui";
import {
  BookOpen,
  Library,
  Users,
  Images,
  Settings,
  Plus,
  ArrowUpRight,
  Minus,
  Square,
  X,
  Feather,
  Check,
  LoaderCircle,
  AlertCircle,
  Bot,
  CircleHelp,
} from "lucide-vue-next";
import { useWorkspace } from "./stores/workspace";
import brandMark from "./assets/brand-mark.svg";
import { freedomOptions } from "../shared/creation";
import WindowCloseDialog from "./components/WindowCloseDialog.vue";
import CoverEditor from "./components/CoverEditor.vue";
import {
  defaultAppearance,
  appearanceTokens,
  activeColors,
  isDark,
} from "../shared/appearance";
import { coverImageStyle } from "../shared/cover";
import { naiveTheme } from "./theme";
import type { CreativeFreedom, CoverUpload } from "../shared/types";
const store = useWorkspace(),
  route = useRoute(),
  router = useRouter();
const startupError = ref(""),
  newStory = ref(false),
  creating = ref(false);
const coverEditor = ref(false),
  newCover = ref<CoverUpload>();
const form = ref({
  title: "",
  premise: "",
  mode: "explore" as "explore" | "novel",
  creativeFreedom: "free" as CreativeFreedom,
  genre: "",
  cardIds: [] as string[],
});
const options = computed(() =>
  store.cards
    .filter((c) => c.kind !== "inspiration")
    .map((c) => ({
      label: (c.kind === "character" ? "角色 · " : "世界 · ") + c.name,
      value: c.id,
    })),
);
const nav = [
  { to: "/", label: "故事书架", icon: Library },
  { to: "/cards", label: "创作资料", icon: Users },
  { to: "/gallery", label: "插画收藏", icon: Images },
  { to: "/roles", label: "AI 职责", icon: Bot },
];
const appearance = computed(
  () => store.settings?.software.appearance ?? defaultAppearance(),
);
const theme = computed(() => naiveTheme(appearance.value));
const componentTheme = computed(() =>
  isDark(activeColors(appearance.value).surface) ? darkTheme : null,
);
watchEffect(() => {
  const tokens = appearanceTokens(appearance.value);
  for (const [key, value] of Object.entries(tokens))
    document.documentElement.style.setProperty(`--${key}`, value);
  document.documentElement.style.colorScheme = isDark(tokens.page)
    ? "dark"
    : "light";
});
onMounted(async () => {
  store.initializeListeners();
  try {
    await store.bootstrap();
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : String(error);
  }
});
function showCreate() {
  newCover.value = undefined;
  form.value = {
    title: "",
    premise: "",
    mode: "explore",
    creativeFreedom: "free",
    genre: "",
    cardIds: [],
  };
  newStory.value = true;
}
async function create() {
  creating.value = true;
  await store.safe(async () => {
    const p = await store.createProject({
      ...form.value,
      cover: newCover.value,
      title: form.value.title.trim() || "未命名故事",
    });
    newStory.value = false;
    await router.push("/story/" + p.id);
  });
  creating.value = false;
}
</script>
<template>
  <NConfigProvider :theme="componentTheme" :theme-overrides="theme">
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-icon"><img :src="brandMark" alt="" /></div>
          <div><strong>页间</strong><span>BETWEEN PAGES</span></div>
        </div>
        <button class="new-story-button" @click="showCreate">
          <Plus :size="17" /> 新建故事
        </button>
        <div class="nav-label">我的创作空间</div>
        <nav>
          <RouterLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            :class="[
              'nav-item',
              {
                active:
                  item.to === '/'
                    ? route.path === '/' || route.path.startsWith('/story/')
                    : route.path === item.to,
              },
            ]"
            ><component :is="item.icon" :size="18" /><span>{{
              item.label
            }}</span
            ><span
              v-if="
                item.to === '/' &&
                store.projects.filter((p) => !p.archived).length
              "
              class="nav-count"
              >{{ store.projects.filter((p) => !p.archived).length }}</span
            ></RouterLink
          >
        </nav>
        <div
          class="sidebar-stories"
          v-if="store.projects.some((p) => !p.archived)"
        >
          <div class="nav-label">最近编辑</div>
          <RouterLink
            v-for="p in store.projects.filter((p) => !p.archived).slice(0, 4)"
            :key="p.id"
            :to="'/story/' + p.id"
            class="recent-story"
            ><span :class="['story-dot', p.color]"></span
            ><span>{{ p.title }}</span></RouterLink
          >
        </div>
        <div class="sidebar-bottom">
          <RouterLink
            to="/help"
            :class="['nav-item', { active: route.path === '/help' }]"
            ><CircleHelp :size="18" /><span>帮助</span><ArrowUpRight :size="14"
          /></RouterLink>
          <RouterLink
            to="/settings"
            :class="['nav-item', { active: route.path === '/settings' }]"
            ><Settings :size="18" /><span>设置</span><ArrowUpRight :size="14"
          /></RouterLink>
          <div class="local-caption">
            <span></span> 本地存储
            <span class="version">{{ store.settings?.version }}</span>
          </div>
        </div>
      </aside>
      <div class="main-shell">
        <header class="titlebar">
          <span class="titlebar-brand"
            ><img :src="brandMark" alt="页间" />页间 · 故事创作工作台</span
          >
          <div class="titlebar-right">
            <span
              v-if="store.saveFailed"
              class="save-status error"
              @click="store.safe(store.flush)"
              ><AlertCircle :size="12" />保存失败 · 点击重试</span
            ><span v-else-if="store.saving" class="save-status"
              ><LoaderCircle :size="12" class="spin" />保存中</span
            ><span v-else class="save-status"
              ><Check :size="12" />本地自动保存</span
            >
            <div class="window-controls">
              <button
                aria-label="最小化"
                @click="store.safe(() => store.api('window:minimize'))"
              >
                <Minus :size="15" /></button
              ><button
                aria-label="最大化"
                @click="store.safe(() => store.api('window:maximize'))"
              >
                <Square :size="11" /></button
              ><button
                class="close"
                aria-label="关闭"
                @click="store.safe(store.requestClose)"
              >
                <X :size="16" />
              </button>
            </div>
          </div>
        </header>
        <div v-if="startupError" class="startup-error">
          <AlertCircle :size="35" />
          <h2>暂时无法打开创作空间</h2>
          <p>{{ startupError }}</p>
          <p>请通过桌面程序启动，并确认数据目录可写。</p>
        </div>
        <RouterView v-else-if="store.ready" @new-story="showCreate" />
        <div v-else class="startup-error">
          <LoaderCircle class="spin" :size="30" />
          <p>正在加载…</p>
        </div>
      </div>
      <Transition name="toast"
        ><div v-if="store.toast" :class="['toast-message', store.toast.type]">
          <AlertCircle v-if="store.toast.type === 'error'" :size="17" /><Check
            v-else
            :size="17"
          />{{ store.toast.message
          }}<button @click="store.toast = null"><X :size="14" /></button></div
      ></Transition>
      <WindowCloseDialog />
      <NModal
        v-model:show="newStory"
        preset="card"
        title="新建故事"
        class="form-modal"
        :style="{ width: '580px' }"
        :mask-closable="!creating"
      >
        <label class="field-label">故事名称</label
        ><NInput
          v-model:value="form.title"
          placeholder="可以稍后再取名"
          :maxlength="100"
          autofocus
          @keyup.enter="create"
        />
        <label class="field-label">选择创作方式</label>
        <div class="mode-options">
          <button
            :class="{ selected: form.mode === 'explore' }"
            @click="
              form.mode = 'explore';
              form.creativeFreedom = 'free';
            "
          >
            <Feather :size="21" /><strong>自由探索</strong
            ><span>跟随角色，看看接下来会发生什么</span></button
          ><button
            :class="{ selected: form.mode === 'novel' }"
            @click="
              form.mode = 'novel';
              form.creativeFreedom = 'guided';
            "
          >
            <BookOpen :size="21" /><strong>长篇创作</strong
            ><span>完善设定与分层大纲，逐章写成小说</span>
          </button>
        </div>
        <label class="field-label"
          >你想发生什么？<small>可以只写几句话，之后随时修改</small></label
        ><NInput
          v-model:value="form.premise"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 6 }"
          placeholder="写下主角、故事背景或想发生的事。没有完整设定也可以，之后边写边补。"
        />
        <label class="field-label"
          >AI 可以发挥多少？<small
            >创作中随时可调整，明确设定始终优先</small
          ></label
        >
        <NSelect
          v-model:value="form.creativeFreedom"
          :options="freedomOptions"
        />
        <label class="field-label"
          >带上你的角色与世界观<small>可选，将复制到本故事</small></label
        ><NSelect
          v-model:value="form.cardIds"
          multiple
          :options="options"
          placeholder="选择已有创作资料"
          :disabled="!options.length"
        />
        <label class="field-label"
          >故事封面<small>可选，之后随时更换</small></label
        >
        <div v-if="newCover" class="new-cover-preview">
          <img
            :src="newCover.dataUrl"
            :style="coverImageStyle(newCover.crop)"
            alt="新故事封面"
          />
        </div>
        <div class="cover-editor-actions">
          <NButton :disabled="creating" @click="coverEditor = true">{{
            newCover ? "调整或更换封面" : "上传封面"
          }}</NButton
          ><NPopconfirm
            v-if="newCover"
            positive-text="移除封面"
            negative-text="取消"
            :positive-button-props="{ disabled: creating }"
            @positive-click="newCover = undefined"
          >
            <template #trigger>
              <NButton :disabled="creating">移除封面</NButton>
            </template>
            确定移除已选择的封面？新故事将使用默认封面。
          </NPopconfirm>
        </div>
        <template #footer
          ><div class="modal-footer">
            <NButton @click="newStory = false" :disabled="creating"
              >取消</NButton
            ><NButton type="primary" :loading="creating" @click="create"
              >创建故事 <template #icon><ArrowUpRight :size="16" /></template
            ></NButton></div
        ></template>
      </NModal>
      <CoverEditor
        v-model:show="coverEditor"
        :initial="newCover"
        @selected="(v) => (newCover = v)"
      />
    </div>
  </NConfigProvider>
</template>
