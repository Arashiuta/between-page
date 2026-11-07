<script setup lang="ts">
import { computed } from "vue";
import { diffWordsWithSpace } from "diff";
const props = defineProps<{ before: string; after: string }>();
const parts = computed(() => diffWordsWithSpace(props.before, props.after));
</script>
<template>
  <div class="change-legend">
    <span class="diff-delete">− 删除</span><span class="diff-add">＋ 新增</span>
  </div>
  <pre
    class="change-diff"
  ><template v-for="(p,i) in parts" :key="i"><del v-if="p.removed" class="diff-delete">{{p.value}}</del><ins v-else-if="p.added" class="diff-add">{{p.value}}</ins><span v-else>{{p.value}}</span></template></pre>
</template>
<style>
.change-legend {
  display: flex;
  gap: 12px;
  font-size: 12px;
  margin: 10px 0;
}
.change-diff {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.8;
  border: 1px solid var(--border, #dce2e9);
  border-radius: 8px;
  padding: 16px;
  max-height: 440px;
  overflow: auto;
}
.diff-delete {
  background: #fde2e2;
  color: #8d2525;
  text-decoration: line-through;
}
.diff-add {
  background: #d9f2df;
  color: #195c31;
  text-decoration: none;
}
.change-legend span {
  padding: 2px 7px;
  border-radius: 3px;
}
</style>
