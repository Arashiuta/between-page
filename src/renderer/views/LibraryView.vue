<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import {
  Plus,
  ArrowUpRight,
  BookOpen,
  ArrowRight,
  Archive,
} from "lucide-vue-next";
import { NModal, NInput, NButton } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { textToDocument } from "../../shared/document";
import StoryCover from "../components/StoryCover.vue";
import CoverEditor from "../components/CoverEditor.vue";
import ItemActions from "../components/ItemActions.vue";
import type { Project } from "../../shared/types";
const editingCover = ref<Project>();
const editingProject = ref<Project>();
const projectToDelete = ref<Pick<Project, "id" | "title"> | null>(null);
const deletingProject = ref(false);
const projectForm = ref({ title: "", premise: "", genre: "" });
function editProject(project: Project) {
  editingProject.value = project;
  projectForm.value = {
    title: project.title,
    premise: project.premise,
    genre: project.genre,
  };
}
async function saveProject() {
  if (!editingProject.value) return;
  await store.flush();
  const updated = await store.api<Project>("project:update", {
    id: editingProject.value.id,
    ...projectForm.value,
    title: projectForm.value.title.trim(),
  });
  if (store.detail?.project.id === updated.id) store.detail.project = updated;
  await store.bootstrap();
  editingProject.value = undefined;
  store.notify("作品信息已保存。");
}
const store = useWorkspace(),
  router = useRouter(),
  archived = ref(false),
  search = ref("");
defineEmits(["new-story"]);
const filtered = computed(() =>
  store.projects.filter(
    (p) => p.archived === archived.value && p.title.includes(search.value),
  ),
);
const date = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
  });
async function sample() {
  await store.safe(async () => {
    const card = await store.saveCard({
      projectId: null,
      kind: "character",
      name: "林屿 · 示例 OC",
      description:
        "二十四岁，经营一家旧书店。黑色短发，习惯把袖口挽起。说话慢，记得每位常客爱读的书。面对自己的过去却总是绕开话题。外表平静，实际很在意别人是否会离开。",
      constraints: "不会轻易许诺；不会因为陌生人一句话就倾诉自己的全部经历。",
      referenceIds: [],
    });
    const p = await store.createProject({
      title: "雾里的第十三封信",
      premise:
        "海边小城里，一家只在夜晚营业的旧书店，每逢起雾就会收到一封没有署名的信。店主林屿发现，信里写的竟是他尚未经历的事情。想写缓慢、温柔，带一点悬疑的故事。",
      mode: "explore",
      genre: "日常 · 微悬疑",
      cardIds: [card.id],
    });
    await store.saveCard({
      projectId: p.id,
      kind: "world",
      name: "海边小城",
      description:
        "一座经常起雾的海边小城。旧书店名为「第十三页」，晚上八点开门，凌晨两点打烊。这里偶尔发生难以解释的小事，但生活仍按自己的节奏继续。",
      constraints: "雾中的异事保持克制，不改变日常生活的基本秩序。",
      referenceIds: [],
    });
    await store.openProject(p.id);
    store.editProject({
      style:
        "第三人称有限视角，跟随林屿。对白克制，以动作与细节表达情绪。让悬疑自然地藏在日常里。",
    });
    store.editChapter({
      title: "第一章 · 雾把门推开",

      document: textToDocument(
        "海雾抵达书店的时候，墙上的钟刚好走过八点。\n\n林屿把门口的木牌翻过来，露出「营业中」三个字。木牌底下还挂着一串旧风铃，今天没有风，它却轻轻响了一声。\n\n他停了停，低头看向门缝。\n\n一只米白色的信封躺在那里，边角干燥，仿佛从来没有穿过这条湿漉漉的街。信封上没有地址，只有一行细小的字。\n\n——明天，请晚十分钟关门。",
      ),
    });
    await store.flush();
    await store.api("blueprint:save", {
      projectId: p.id,
      node: {
        id: crypto.randomUUID(),
        level: "section",
        parentId: null,
        chapterId: null,
        title: "近期方向",
        content:
          "建立书店与林屿的日常，让第一封信出现。来信机制与身份保持开放。",
      },
      base: null,
    });
    await router.push("/story/" + p.id);
  });
}
async function toggleArchive(id: string, value: boolean) {
  await store.safe(async () => {
    await store.flush();
    await store.api("project:update", { id, archived: value });
    await store.bootstrap();
    store.notify(value ? "故事已收进归档，可随时恢复。" : "故事已回到书架。");
  });
}
function selectProjectAction(key: string, project: Project) {
  if (store.busy || store.imageBusy || deletingProject.value) return;
  if (key === "archive") void toggleArchive(project.id, !project.archived);
  if (key === "delete" && project.archived)
    projectToDelete.value = { id: project.id, title: project.title };
}
async function confirmDeleteProject() {
  const project = projectToDelete.value;
  if (!project || deletingProject.value || store.busy || store.imageBusy)
    return false;
  deletingProject.value = true;
  const deleted = await store.safe(async () => {
    await store.flush();
    await store.api("project:delete", project.id);
    if (store.detail?.project.id === project.id) {
      store.detail = null;
      store.chapterId = "";
    }
    await store.bootstrap();
    store.notify(`《${project.title}》及其专属内容已彻底删除。`);
    return true;
  });
  deletingProject.value = false;
  if (deleted) projectToDelete.value = null;
  return false;
}
</script>
<template>
  <main class="page library-page">
    <div class="page-heading">
      <h1>故事书架</h1>
      <button class="button primary" @click="$emit('new-story')">
        <Plus :size="16" />新建故事
      </button>
    </div>
    <div class="section-toolbar">
      <div class="section-title">
        <h2>我的故事书架</h2>
        <span class="count-tag"
          >{{ store.projects.filter((p) => !p.archived).length }} 个故事</span
        >
      </div>
      <div class="toolbar-actions">
        <button
          :class="['text-button', { selected: archived }]"
          @click="archived = !archived"
        >
          <Archive :size="15" />{{ archived ? "返回书架" : "归档" }}</button
        ><input
          v-if="store.projects.length > 3"
          v-model="search"
          class="search-input"
          placeholder="找一本故事……"
        />
      </div>
    </div>
    <div v-if="filtered.length" class="story-grid">
      <article
        v-for="p in filtered"
        :key="p.id"
        class="story-card"
        @click="router.push('/story/' + p.id)"
      >
        <StoryCover :project="p"
          ><button
            class="cover-edit-button"
            :aria-label="`设置《${p.title}》的封面`"
            @click.stop="editingCover = p"
          >
            {{ p.cover ? "调整封面" : "上传封面" }}
          </button></StoryCover
        >
        <div class="story-card-body">
          <div class="story-card-title">
            <h3>{{ p.title }}</h3>
            <ArrowUpRight :size="17" />
          </div>
          <p>{{ p.premise || "暂无简介" }}</p>
          <div class="story-card-footer">
            <span>{{ date(p.updatedAt) }} · 最近编辑</span
            ><ItemActions
              :label="`作品《${p.title}》`"
              :disabled="store.busy || store.imageBusy || deletingProject"
              :actions="[
                {
                  key: 'archive',
                  label: p.archived ? '恢复到书架' : '归档作品',
                },
                ...(p.archived
                  ? [{ key: 'delete', label: '彻底删除作品' }]
                  : []),
              ]"
              @edit="editProject(p)"
              @action="(key) => selectProjectAction(key, p)"
            />
          </div>
        </div>
      </article>
      <button class="new-story-card" @click="$emit('new-story')">
        <span><Plus :size="23" /></span><strong>新建故事</strong>
      </button>
    </div>
    <div v-else-if="!archived && !search" class="shelf-empty">
      <div class="empty-icon"><BookOpen :size="27" :stroke-width="1.4" /></div>
      <h3>暂无故事</h3>
      <p>新建故事，或打开示例了解基本功能。</p>
      <button class="text-button" @click="sample">
        打开示例故事 <ArrowRight :size="15" />
      </button>
    </div>
    <div v-else class="shelf-empty">
      <Archive :size="28" />
      <p>{{ archived ? "归档里还没有故事。" : "没有找到这本故事。" }}</p>
    </div>
    <footer class="page-footer">
      <span><span class="tiny-dot"></span> 资料保存在本机</span>
    </footer>
    <CoverEditor
      :show="!!editingCover"
      :project="editingCover"
      @update:show="
        (v) => {
          if (!v) editingCover = undefined;
        }
      "
    />
    <NModal
      :show="!!projectToDelete"
      preset="dialog"
      type="error"
      title="彻底删除作品？"
      :content="`确定彻底删除《${projectToDelete?.title ?? ''}》？章节、版本、记忆和故事专属图片将一并删除。此操作无法撤销。`"
      positive-text="确认删除"
      negative-text="取消"
      :positive-button-props="{
        type: 'error',
        loading: deletingProject,
        disabled: store.busy || store.imageBusy,
      }"
      :negative-button-props="{ disabled: deletingProject }"
      :mask-closable="!deletingProject"
      :close-on-esc="!deletingProject"
      :closable="!deletingProject"
      @update:show="
        (value) => {
          if (!value && !deletingProject) projectToDelete = null;
        }
      "
      @positive-click="confirmDeleteProject"
      @negative-click="projectToDelete = null"
    />
    <NModal
      :show="!!editingProject"
      @update:show="
        (value) => {
          if (!value) editingProject = undefined;
        }
      "
      preset="card"
      title="编辑作品信息"
      :style="{ width: '560px' }"
      ><label class="field-label first">作品名称</label
      ><NInput v-model:value="projectForm.title" :maxlength="500" /><label
        class="field-label"
        >类型</label
      ><NInput v-model:value="projectForm.genre" :maxlength="500" /><label
        class="field-label"
        >简介与创意</label
      ><NInput
        v-model:value="projectForm.premise"
        type="textarea"
        :maxlength="200000"
        :autosize="{ minRows: 4, maxRows: 12 }"
      /><template #footer
        ><div class="modal-footer">
          <NButton @click="editingProject = undefined">取消</NButton
          ><NButton
            type="primary"
            :disabled="!projectForm.title.trim()"
            @click="store.safe(saveProject)"
            >保存信息</NButton
          >
        </div></template
      ></NModal
    >
  </main>
</template>
