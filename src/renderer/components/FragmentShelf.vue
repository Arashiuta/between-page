<script setup lang="ts">
import { ref } from "vue";
import { NButton, NSelect, NPopconfirm } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
const store = useWorkspace();
const emit = defineEmits<{ write: [] }>();
const targets = ref<Record<string, string | null>>({}),
  positions = ref<Record<string, string | null>>({});
async function write(id?: string) {
  if (id) await store.switchChapter(id);
  else await store.newFragment();
  emit("write");
}
async function incorporate(id: string, repeat = false) {
  await store.flush();
  store.detail = await store.api("fragment:incorporate", {
    projectId: store.detail!.project.id,
    fragmentId: id,
    chapterId: targets.value[id] || undefined,
    beforeId: positions.value[id] || undefined,
    allowRepeat: repeat,
  });
  store.notify("已编入章节草稿，确认采用后才能整理正式记忆。");
}
</script>
<template>
  <section class="tab-content fragment-shelf">
    <div class="content-heading">
      <h2>探索片段</h2>
      <p>
        先写未来相遇、结尾或另一个视角，之后再接入故事。独立片段不进入正式记忆和正文导出。
      </p>
    </div>
    <div class="workbench-actions">
      <NButton
        type="primary"
        :disabled="store.busy"
        @click="store.safe(() => write())"
        >跳写一个新片段</NButton
      ><NButton
        @click="
          store.safe(async () => {
            await store.flush();
            await store.api('project:export', {
              projectId: store.detail!.project.id,
              fragments: true,
            });
          })
        "
        >单独导出片段</NButton
      >
    </div>
    <p v-if="!store.detail?.fragments?.length" class="field-help">
      还没有独立片段。可以先写最想写的场面，不必决定它是第几章。
    </p>
    <article
      v-for="f in store.detail?.fragments"
      :key="f.id"
      class="fragment-card"
    >
      <div class="section-toolbar">
        <h3>{{ f.title }}</h3>
        <span
          >{{ f.content.length }} 字 ·
          {{
            f.incorporatedInto?.length ? "已编入，保留原稿" : "独立草稿"
          }}</span
        >
      </div>
      <p class="fragment-excerpt">
        {{ f.content.slice(0, 180) || "等待写下第一个场景" }}
      </p>
      <p v-if="f.incorporatedInto?.length" class="field-help">
        已编入：{{
          f.incorporatedInto
            .map(
              (id) =>
                store.detail!.chapters.find((c) => c.id === id)?.title ||
                "已移除的章节",
            )
            .join("、")
        }}。片段原稿与目标章的编入前版本保留。
      </p>
      <div class="workbench-actions">
        <NButton @click="store.safe(() => write(f.id))">编辑与写作</NButton>
        <NPopconfirm
          positive-text="删除片段"
          negative-text="取消"
          @positive-click="store.safe(() => store.deleteChapter(f.id))"
          ><template #trigger
            ><NButton
              type="error"
              secondary
              :disabled="store.busy || store.imageBusy"
              >删除片段</NButton
            ></template
          >删除「{{
            f.title
          }}」及其版本记录？已编入章节的内容会保留。此操作无法撤销。</NPopconfirm
        >
      </div>
      <label class="field-label">编入方式</label>
      <NSelect
        :value="targets[f.id] ?? null"
        clearable
        :options="
          store.detail!.chapters.map((c) => ({
            label: `追加到 ${c.title}`,
            value: c.id,
          }))
        "
        placeholder="编成独立新章"
        @update:value="(value) => (targets[f.id] = value)"
      />
      <NSelect
        v-if="!targets[f.id]"
        :value="positions[f.id] ?? null"
        clearable
        :options="
          store.detail!.chapters.map((c) => ({
            label: `插在 ${c.title} 之前`,
            value: c.id,
          }))
        "
        placeholder="放在故事末尾"
        @update:value="(value) => (positions[f.id] = value)"
      />
      <NPopconfirm
        v-if="f.incorporatedInto?.length"
        @positive-click="store.safe(() => incorporate(f.id, true))"
        ><template #trigger
          ><NButton :disabled="store.busy || !f.content.trim()"
            >再次编入</NButton
          ></template
        >这个片段已经编入过故事，再次操作会重复添加正文。</NPopconfirm
      >
      <NButton
        v-else
        :disabled="store.busy || !f.content.trim()"
        @click="store.safe(() => incorporate(f.id))"
        >编入章节草稿</NButton
      >
    </article>
  </section>
</template>
