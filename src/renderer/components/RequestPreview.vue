<script setup lang="ts">
import type { TaskPreview } from "../../shared/types";
defineProps<{ preview: TaskPreview }>();
</script>
<template>
  <section class="request-preview">
    <p>
      模型：{{ preview.model || "尚未选择" }} · 单次请求上下文估算上限：{{
        preview.estimatedTokens
      }}
    </p>
    <p v-for="s in preview.sources" :key="s.title">
      {{ s.priority }} · {{ s.title }} · {{ s.characters }} 字符
    </p>
    <p v-for="s in preview.omitted" :key="s" class="omitted">省略：{{ s }}</p>
    <div class="reference-thumbnails">
      <figure v-for="i in preview.images" :key="i.id">
        <img :src="i.url" :alt="i.name" />
        <figcaption>
          世界与人物参考图（优先级 2） · {{ i.name }} ·
          {{ i.owners.join("、") }}
        </figcaption>
      </figure>
    </div>
    <details v-for="(m, i) in preview.messages" :key="i">
      <summary>实际消息 {{ i + 1 }} · {{ m.role }}</summary>
      <pre>{{
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
      }}</pre>
    </details>
    <p v-if="preview.batches">
      共
      {{
        preview.batches.length
      }}
      批，以下展开内容就是对应批次发送的请求。构建失败的批次不调用模型。
    </p>
    <details v-for="(b, i) in preview.batches" :key="i">
      <summary>
        {{ i + 1 }}. {{ b.title }} {{ b.error ? "（无法发送）" : "" }}
      </summary>
      <p v-if="b.error" role="alert">{{ b.error }}</p>
      <RequestPreview v-if="b.preview" :preview="b.preview" />
    </details>
  </section>
</template>
<style scoped>
.request-preview {
  font-size: 13px;
  line-height: 1.8;
}
.request-preview pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 520px;
  overflow: auto;
  font: inherit;
  padding: 14px;
  background: var(--page);
}
.request-preview details {
  border-top: 1px solid var(--border, #e1e5eb);
  padding: 10px 0;
}
.request-preview summary {
  cursor: pointer;
}
.omitted {
  color: var(--muted, #697585);
}
.reference-thumbnails {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.reference-thumbnails figure {
  margin: 10px 0;
}
.reference-thumbnails img {
  width: 150px;
  height: 150px;
  object-fit: contain;
}
</style>
