<script setup lang="ts">
import { watch, computed } from "vue";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, Heading2, Undo2, Redo2, Quote } from "lucide-vue-next";
import type { DocumentNode } from "../../shared/types";
import { textToDocument } from "../../shared/document";
const props = defineProps<{ document: DocumentNode; placeholder?: string }>();
const emit = defineEmits<{
  update: [document: DocumentNode];
  selection: [selection: { text: string; from: number; to: number } | null];
}>();
const editor = useEditor({
  extensions: [StarterKit.configure({ link: { openOnClick: false } })],
  content: props.document as JSONContent,
  editorProps: {
    attributes: {
      class: "story-prose",
      "aria-label": "章节正文",
      role: "textbox",
      "aria-multiline": "true",
    },
  },
  onUpdate: ({ editor }) => emit("update", editor.getJSON() as DocumentNode),
  onSelectionUpdate: ({ editor }) => {
    const { from, to } = editor.state.selection;
    emit(
      "selection",
      from === to
        ? null
        : { from, to, text: editor.state.doc.textBetween(from, to, "\n") },
    );
  },
});
watch(
  () => props.document,
  (value) => {
    if (
      editor.value &&
      JSON.stringify(editor.value.getJSON()) !== JSON.stringify(value)
    )
      editor.value.commands.setContent(value as JSONContent, {
        emitUpdate: false,
      });
  },
  { deep: true },
);
const isEmpty = computed(() => editor.value?.isEmpty ?? true);
function replace(text: string) {
  editor.value?.commands.setContent(textToDocument(text) as JSONContent);
}
function append(text: string) {
  if (!editor.value) return;
  editor.value.commands.insertContentAt(
    editor.value.state.doc.content.size,
    textToDocument(text).content as JSONContent[],
  );
}
function replaceSelected(
  selection: { from: number; to: number; text: string },
  text: string,
) {
  if (!editor.value) return false;
  const doc = editor.value.state.doc;
  if (
    selection.to > doc.content.size ||
    doc.textBetween(selection.from, selection.to, "\n") !== selection.text
  )
    return false;
  editor.value.commands.insertContentAt(
    { from: selection.from, to: selection.to },
    textToDocument(text).content as JSONContent[],
  );
  return true;
}
defineExpose({ replace, append, replaceSelected });
</script>
<template>
  <div class="story-editor">
    <div v-if="editor" class="editor-toolbar">
      <div>
        <button
          aria-label="加粗"
          :class="{ active: editor.isActive('bold') }"
          @click="editor.chain().focus().toggleBold().run()"
        >
          <Bold :size="15" /></button
        ><button
          aria-label="斜体"
          :class="{ active: editor.isActive('italic') }"
          @click="editor.chain().focus().toggleItalic().run()"
        >
          <Italic :size="15" /></button
        ><button
          aria-label="小标题"
          :class="{ active: editor.isActive('heading') }"
          @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          <Heading2 :size="17" /></button
        ><button
          aria-label="引用"
          :class="{ active: editor.isActive('blockquote') }"
          @click="editor.chain().focus().toggleBlockquote().run()"
        >
          <Quote :size="15" />
        </button>
      </div>
      <div>
        <button aria-label="撤回" @click="editor.chain().focus().undo().run()">
          <Undo2 :size="15" /></button
        ><button aria-label="重做" @click="editor.chain().focus().redo().run()">
          <Redo2 :size="15" />
        </button>
      </div>
    </div>
    <div class="editor-paper">
      <div v-if="isEmpty" class="editor-placeholder">
        故事从这里开始。<br /><span>{{
          placeholder ||
          "写下第一句话，或只给几个关键词让 AI 开篇。设定和计划都可以之后再补。"
        }}</span>
      </div>
      <EditorContent :editor="editor" />
    </div>
  </div>
</template>
