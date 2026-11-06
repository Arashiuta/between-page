<script setup lang="ts">
import { ref, watch } from "vue";
import { BookOpen, Feather } from "lucide-vue-next";
import type { Project } from "../../shared/types";
import { coverImageStyle } from "../../shared/cover";
import { useWorkspace } from "../stores/workspace";
const props = defineProps<{ project: Project }>();
const store = useWorkspace(),
  failed = ref(false);
watch(
  () => props.project.cover?.imageId,
  () => (failed.value = false),
);
</script>
<template>
  <div
    :class="[
      'story-cover',
      project.color,
      { 'has-cover': project.cover && !failed },
    ]"
  >
    <img
      v-if="project.cover && !failed"
      class="story-cover-image"
      :src="store.imageUrl(project.cover.imageId)"
      :style="coverImageStyle(project.cover.crop)"
      :alt="`${project.title}的封面`"
      @error="failed = true"
    />
    <span class="cover-mode"
      ><Feather v-if="project.mode === 'explore'" :size="12" /><BookOpen
        v-else
        :size="12"
      />{{ project.mode === "explore" ? "自由探索" : "长篇创作" }}</span
    >
    <template v-if="!project.cover || failed"
      ><div class="cover-lines"></div>
      <BookOpen class="cover-icon" :size="44" :stroke-width="1" /><span
        class="cover-genre"
        >{{ project.genre }}</span
      ></template
    >
    <slot />
  </div>
</template>
