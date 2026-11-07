<script setup lang="ts">
import { ref, computed, h, watch } from "vue";
import { NDropdown, NModal } from "naive-ui";
import {
  Plus,
  Users,
  Globe,
  Lightbulb,
  ArrowUpRight,
  Feather,
  Trash2,
} from "lucide-vue-next";
import CardEditor from "../components/CardEditor.vue";
import ItemActions from "../components/ItemActions.vue";
import { useWorkspace } from "../stores/workspace";
import type { Card, CardKind } from "../../shared/types";
const store = useWorkspace(),
  filter = ref<CardKind>("character"),
  show = ref(false),
  editing = ref<Card | null>(null);
const cardMenu = ref({ id: "", x: 0, y: 0, show: false });
const cardToDelete = ref<Pick<Card, "id" | "name"> | null>(null);
const deleting = ref(false);
const cardMenuOptions = computed(() => [
  {
    key: "delete",
    label: "删除资料",
    icon: () => h(Trash2, { size: 15 }),
    props: { style: { color: "var(--danger)" } },
    disabled: deleting.value,
  },
]);
const filtered = computed(() =>
  store.cards.filter((c) => c.kind === filter.value),
);
function open(card: Card | null) {
  cardMenu.value.show = false;
  editing.value = card;
  show.value = true;
}
function openCardMenu(event: MouseEvent, card: Card) {
  cardMenu.value = {
    id: card.id,
    x: event.clientX,
    y: event.clientY,
    show: true,
  };
}
function requestDelete(card: Card) {
  cardMenu.value.show = false;
  cardToDelete.value = { id: card.id, name: card.name };
}
function selectCardMenu(key: string) {
  const card = store.cards.find((item) => item.id === cardMenu.value.id);
  cardMenu.value.show = false;
  if (key === "delete" && card) requestDelete(card);
}
async function confirmDelete() {
  const target = cardToDelete.value;
  if (!target || deleting.value) return false;
  deleting.value = true;
  const deleted = await store.safe(async () => {
    await store.deleteCard(target.id);
    return true;
  });
  deleting.value = false;
  if (deleted) {
    cardToDelete.value = null;
    if (editing.value?.id === target.id) {
      editing.value = null;
      show.value = false;
    }
  }
  return false;
}
watch(filter, () => {
  cardMenu.value.show = false;
});
</script>
<template>
  <main class="page">
    <div class="page-heading">
      <div>
        <h1>创作资料</h1>
        <p>管理角色、世界观和灵感，创建故事时可复制使用。</p>
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
        @contextmenu.prevent="openCardMenu($event, card)"
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
          <p>
            {{
              card.description ||
              card.sections.map((section) => section.title).join("、") ||
              (card.documents.length
                ? `${card.documents.length} 份原始文档`
                : "暂无描述")
            }}
          </p>
          <div class="asset-card-footer">
            <span>{{
              card.referenceIds.length
                ? card.referenceIds.length + " 张参考图"
                : "独立资料 · 可用于多个故事"
            }}</span>
            <ItemActions
              :label="card.name"
              :disabled="deleting"
              @edit="open(card)"
              @action="requestDelete(card)"
            />
            <button
              class="text-button asset-card-delete"
              :aria-label="`删除创作资料「${card.name}」`"
              :disabled="deleting"
              @click.stop="requestDelete(card)"
            >
              <Trash2 :size="14" />删除
            </button>
          </div>
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
            ? "暂无角色"
            : filter === "world"
              ? "暂无世界观"
              : "暂无灵感"
        }}
      </h3>
      <p>点击下方按钮添加资料。</p>
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
    <p class="page-footer">每个故事使用独立的资料副本，修改互不影响。</p>
    <NDropdown
      trigger="manual"
      placement="bottom-start"
      :show="cardMenu.show"
      :x="cardMenu.x"
      :y="cardMenu.y"
      :options="cardMenuOptions"
      @select="selectCardMenu"
      @clickoutside="cardMenu.show = false"
      @update:show="
        (value) => {
          if (!value) cardMenu.show = false;
        }
      "
    />
    <NModal
      :show="!!cardToDelete"
      preset="dialog"
      type="error"
      title="删除创作资料？"
      :content="`确定删除「${cardToDelete?.name || ''}」？资料内容、分区和原始文档将一并删除。已复制到故事中的资料副本和参考图片会保留。此操作无法撤销。`"
      positive-text="确认删除"
      negative-text="取消"
      :positive-button-props="{ type: 'error', loading: deleting }"
      :negative-button-props="{ disabled: deleting }"
      :mask-closable="!deleting"
      :close-on-esc="!deleting"
      :closable="!deleting"
      @update:show="
        (value) => {
          if (!value && !deleting) cardToDelete = null;
        }
      "
      @positive-click="confirmDelete"
      @negative-click="cardToDelete = null"
    />
    <CardEditor
      v-model:show="show"
      :card="editing"
      :project-id="null"
      :initial-kind="filter"
    />
  </main>
</template>
