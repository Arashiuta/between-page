<script setup lang="ts">
import { ref, computed } from "vue";
import {
  Plus,
  Users,
  Globe,
  Lightbulb,
  ArrowUpRight,
  Feather,
} from "lucide-vue-next";
import CardEditor from "../components/CardEditor.vue";
import { useWorkspace } from "../stores/workspace";
import type { Card, CardKind } from "../../shared/types";
const store = useWorkspace(),
  filter = ref<CardKind>("character"),
  show = ref(false),
  editing = ref<Card | null>(null);
const filtered = computed(() =>
  store.cards.filter((c) => c.kind === filter.value),
);
function open(card: Card | null) {
  editing.value = card;
  show.value = true;
}
</script>
<template>
  <main class="page">
    <div class="page-eyebrow">THE SEEDS OF A STORY</div>
    <div class="page-heading">
      <div>
        <h1>把心里的世界，收好。</h1>
        <p>角色、世界与零碎灵感，都可以成为下一本故事的起点。</p>
      </div>
      <button class="button primary" @click="open(null)">
        <Plus :size="16" />添加创作资料
      </button>
    </div>
    <div class="filter-tabs">
      <button
        v-for="item in [
          { key: 'character' as CardKind, label: '角色 / OC', icon: Users },
          { key: 'world' as CardKind, label: '世界观', icon: Globe },
          {
            key: 'inspiration' as CardKind,
            label: '灵感收集箱',
            icon: Lightbulb,
          },
        ]"
        :key="item.key"
        :class="{ active: filter === item.key }"
        @click="filter = item.key"
      >
        <component :is="item.icon" :size="16" />{{ item.label
        }}<span>{{
          store.cards.filter((c) => c.kind === item.key).length
        }}</span>
      </button>
    </div>
    <div v-if="filtered.length" class="asset-card-grid">
      <article
        v-for="card in filtered"
        :key="card.id"
        class="asset-card"
        @click="open(card)"
      >
        <div v-if="card.referenceIds.length" class="asset-card-image">
          <img :src="store.imageUrl(card.referenceIds[0])" :alt="card.name" />
        </div>
        <div v-else :class="['asset-card-monogram', card.kind]">
          <Feather
            v-if="card.kind === 'character'"
            :size="34"
            :stroke-width="1.2"
          /><Globe
            v-else-if="card.kind === 'world'"
            :size="34"
            :stroke-width="1.2"
          /><Lightbulb v-else :size="34" :stroke-width="1.2" />
        </div>
        <div class="asset-card-body">
          <h3>{{ card.name }}<ArrowUpRight :size="16" /></h3>
          <p>{{ card.description || "还没写完的设定，留给下一次灵感。" }}</p>
          <span>{{
            card.referenceIds.length
              ? card.referenceIds.length + " 张参考图"
              : "独立资料 · 可用于多个故事"
          }}</span>
        </div>
      </article>
    </div>
    <div v-else class="large-empty">
      <div class="empty-icon">
        <Users v-if="filter === 'character'" :size="28" /><Globe
          v-else-if="filter === 'world'"
          :size="28"
        /><Lightbulb v-else :size="28" />
      </div>
      <h3>
        {{
          filter === "character"
            ? "先认识你的第一个角色"
            : filter === "world"
              ? "每个世界都有自己的规则"
              : "灵感不需要完整，也值得被记下"
        }}
      </h3>
      <p>从已有的设定开始，不必把每个空白都填满。</p>
      <button class="button" @click="open(null)">
        <Plus :size="15" />添加{{
          filter === "character"
            ? "角色"
            : filter === "world"
              ? "世界观"
              : "灵感"
        }}
      </button>
    </div>
    <p class="page-footer">
      资料库是起点。每个故事会保留自己的设定副本，经历各自的变化。
    </p>
    <CardEditor
      v-model:show="show"
      :card="editing"
      :project-id="null"
      :initial-kind="filter"
    />
  </main>
</template>
