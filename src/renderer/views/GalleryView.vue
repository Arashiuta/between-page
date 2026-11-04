<script setup lang="ts">
import { ref, computed } from "vue";
import { NModal, NButton } from "naive-ui";
import { Images, Download, ArrowUpRight } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import type { ImageAsset } from "../../shared/types";
const store = useWorkspace(),
  filter = ref("illustration"),
  preview = ref<ImageAsset | null>(null);
const items = computed(() =>
  store.images.filter((i) => i.kind === filter.value),
);
</script>
<template>
  <main class="page">
    <div class="page-heading">
      <div>
        <h1>插画收藏</h1>
        <p>查看已生成的插画和导入的参考图片。</p>
      </div>
    </div>
    <div class="filter-tabs">
      <button
        :class="{ active: filter === 'illustration' }"
        @click="filter = 'illustration'"
      >
        故事插画
        <span>{{
          store.images.filter((i) => i.kind === "illustration").length
        }}</span></button
      ><button
        :class="{ active: filter === 'reference' }"
        @click="filter = 'reference'"
      >
        参考图片
        <span>{{
          store.images.filter((i) => i.kind === "reference").length
        }}</span>
      </button>
    </div>
    <div v-if="items.length" class="gallery-grid">
      <button
        v-for="image in items"
        :key="image.id"
        class="image-card"
        @click="preview = image"
      >
        <img :src="store.imageUrl(image.id)" :alt="image.name" />
        <div>
          <strong>{{ image.name }}</strong
          ><span>{{
            store.projects.find((p) => p.id === image.projectId)?.title ||
            "创作资料库"
          }}</span>
        </div>
      </button>
    </div>
    <div v-else class="large-empty">
      <div class="empty-icon"><Images :size="29" /></div>
      <h3>
        {{ filter === "illustration" ? "暂无插画" : "还没有参考图片" }}
      </h3>
      <p>
        {{
          filter === "illustration"
            ? "打开一个故事，在「故事插画」里生成第一张插画。"
            : "可以在角色资料或故事插画中导入已有图片。"
        }}
      </p>
      <RouterLink to="/" class="text-button"
        >回到故事书架 <ArrowUpRight :size="15"
      /></RouterLink>
    </div>
    <NModal
      :show="!!preview"
      @update:show="
        (v) => {
          if (!v) preview = null;
        }
      "
      preset="card"
      :title="preview?.name"
      :style="{ width: 'min(900px,90vw)' }"
      ><template v-if="preview"
        ><img
          :src="store.imageUrl(preview.id)"
          :alt="preview.name"
          class="image-preview"
        />
        <pre v-if="preview.prompt" class="prompt-preview">{{
          preview.prompt
        }}</pre>
        <div class="modal-footer">
          <NButton
            type="primary"
            @click="store.safe(() => store.api('asset:export', preview!.id))"
            ><template #icon><Download :size="15" /></template>导出图片</NButton
          >
        </div></template
      ></NModal
    >
  </main>
</template>
