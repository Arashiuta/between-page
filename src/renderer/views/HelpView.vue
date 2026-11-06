<script setup lang="ts">
import { computed, ref, nextTick, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { NInput } from "naive-ui";
import { BookOpen, Search, ArrowUpRight } from "lucide-vue-next";
import { searchHelp } from "../../shared/help";
const search = ref("");
const route = useRoute(),
  router = useRouter();
const filtered = computed(() => searchHelp(search.value));
const resultCount = computed(() =>
  filtered.value.reduce((sum, c) => sum + c.articles.length, 0),
);
async function scrollToHash() {
  await nextTick();
  if (route.hash)
    document
      .getElementById(route.hash.slice(1))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
}
watch(() => route.hash, scrollToHash, { immediate: true });
async function jumpTo(id: string) {
  await router.replace({ path: "/help", hash: `#${id}` });
  await scrollToHash();
}
</script>
<template>
  <main class="page help-page">
    <div class="page-heading help-heading">
      <div>
        <h1><BookOpen :size="25" />帮助</h1>
        <p>从第一章到完整作品，随时查阅操作指南</p>
      </div>
      <div class="help-search">
        <Search :size="16" /><NInput
          v-model:value="search"
          clearable
          placeholder="搜索操作、设置或常见问题"
          aria-label="搜索帮助"
        />
      </div>
    </div>
    <div class="help-shortcuts">
      <RouterLink to="/settings?tab=models"
        >配置模型<ArrowUpRight :size="14" /></RouterLink
      ><RouterLink to="/settings?tab=software"
        >外观与备份<ArrowUpRight :size="14" /></RouterLink
      ><button
        @click="
          search = '';
          jumpTo('first-story');
        "
      >
        快速开始<ArrowUpRight :size="14" />
      </button>
    </div>
    <p v-if="search.trim()" class="help-result-count" role="status">
      找到 {{ resultCount }} 条说明
      <button class="text-button" @click="search = ''">清空搜索</button>
    </p>
    <div class="help-layout">
      <nav class="help-index" aria-label="帮助目录">
        <strong>使用指南</strong>
        <div
          v-for="category in filtered"
          :key="category.id"
          class="help-index-group"
        >
          <button class="help-category-link" @click="jumpTo(category.id)">
            {{ category.title }}</button
          ><button
            v-for="article in category.articles"
            :key="article.id"
            :class="{ active: route.hash === `#${article.id}` }"
            @click="jumpTo(article.id)"
          >
            {{ article.title }}
          </button>
        </div>
      </nav>
      <div class="help-articles">
        <section
          v-for="category in filtered"
          :id="category.id"
          :key="category.id"
          class="help-category"
        >
          <h2>{{ category.title }}</h2>
          <article
            v-for="article in category.articles"
            :id="article.id"
            :key="article.id"
            class="help-article"
          >
            <component
              :is="article.faq ? 'details' : 'div'"
              :open="article.faq && search.trim() ? true : undefined"
              ><component :is="article.faq ? 'summary' : 'h3'">{{
                article.title
              }}</component>
              <div class="help-article-body">
                <p>{{ article.body }}</p>
                <ol v-if="article.steps">
                  <li v-for="step in article.steps" :key="step">{{ step }}</li>
                </ol>
                <p v-if="article.note" class="help-note">{{ article.note }}</p>
                <div v-if="article.links" class="help-related">
                  <RouterLink
                    v-for="link in article.links"
                    :key="link.to"
                    :to="link.to"
                    >{{ link.label }}<ArrowUpRight :size="14"
                  /></RouterLink>
                </div></div
            ></component>
          </article>
        </section>
        <div v-if="!filtered.length" class="inline-empty">
          <Search :size="24" />
          <p>没有找到匹配的说明，试试「封面」「模型」或「备份」。</p>
          <button class="button" @click="search = ''">清空搜索</button>
        </div>
      </div>
    </div>
  </main>
</template>
