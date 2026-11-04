<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NConfigProvider, NModal, NInput, NSelect, NButton } from "naive-ui";
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
} from "lucide-vue-next";
import { useWorkspace } from "./stores/workspace";
const store = useWorkspace(),
  route = useRoute(),
  router = useRouter();
const startupError = ref(""),
  newStory = ref(false),
  creating = ref(false);
const form = ref({
  title: "",
  premise: "",
  mode: "explore" as "explore" | "novel",
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
const theme = {
  common: {
    primaryColor: "#2563eb",
    primaryColorHover: "#1d4ed8",
    primaryColorPressed: "#1e40af",
    primaryColorSuppl: "#2563eb",
    textColorBase: "#1f2937",
    textColor1: "#1f2937",
    textColor2: "#374151",
    textColor3: "#4b5563",
    placeholderColor: "#6b7280",
    borderColor: "#d1d5db",
    bodyColor: "#f5f7fa",
    cardColor: "#ffffff",
    modalColor: "#ffffff",
    popoverColor: "#ffffff",
    inputColor: "#ffffff",
    fontSize: "14px",
    borderRadius: "8px",
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    baseColor: "#ffffff",
  },
  Input: {
    borderFocus: "1px solid #2563eb",
    boxShadowFocus: "0 0 0 2px rgba(37,99,235,.12)",
  },
};
onMounted(async () => {
  try {
    await store.bootstrap();
    store.initializeListeners();
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : String(error);
  }
});
function showCreate() {
  form.value = {
    title: "",
    premise: "",
    mode: "explore",
    genre: "",
    cardIds: [],
  };
  newStory.value = true;
}
async function create() {
  if (!form.value.title.trim()) {
    store.notify("给故事起一个名字吧。", "info");
    return;
  }
  creating.value = true;
  await store.safe(async () => {
    const p = await store.createProject(form.value);
    newStory.value = false;
    await router.push("/story/" + p.id);
  });
  creating.value = false;
}
</script>
<template>
  <NConfigProvider :theme-overrides="theme">
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-icon"><BookOpen :size="23" /></div>
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
            to="/settings"
            :class="['nav-item', { active: route.path === '/settings' }]"
            ><Settings :size="18" /><span>设置与模型</span
            ><ArrowUpRight :size="14"
          /></RouterLink>
          <div class="local-caption">
            <span></span> 本地存储
            <span class="version">{{ store.settings?.version }}</span>
          </div>
        </div>
      </aside>
      <div class="main-shell">
        <header class="titlebar">
          <span>页间 · 故事创作工作台</span>
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
                @click="
                  store.safe(async () => {
                    if (store.busy) await store.stopTask();
                    store.scratch();
                    await store.flush();
                    await store.api('window:close');
                  })
                "
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
          placeholder="输入故事名称"
          :maxlength="100"
          autofocus
          @keyup.enter="create"
        />
        <label class="field-label">选择创作方式</label>
        <div class="mode-options">
          <button
            :class="{ selected: form.mode === 'explore' }"
            @click="form.mode = 'explore'"
          >
            <Feather :size="21" /><strong>自由探索</strong
            ><span>跟随角色，看看接下来会发生什么</span></button
          ><button
            :class="{ selected: form.mode === 'novel' }"
            @click="form.mode = 'novel'"
          >
            <BookOpen :size="21" /><strong>长篇创作</strong
            ><span>从整体构思，走向完整的作品</span>
          </button>
        </div>
        <label class="field-label"
          >你想发生什么？<small>可以只写几句话，之后随时修改</small></label
        ><NInput
          v-model:value="form.premise"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 6 }"
          placeholder="例如：让我的 OC 经营一家只在深夜营业的书店，有一天，店里来了一位认识他过去的客人……"
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
        <template #footer
          ><div class="modal-footer">
            <NButton @click="newStory = false" :disabled="creating"
              >取消</NButton
            ><NButton type="primary" :loading="creating" @click="create"
              >创建故事 <template #icon><ArrowUpRight :size="16" /></template
            ></NButton></div
        ></template>
      </NModal>
    </div>
  </NConfigProvider>
</template>
