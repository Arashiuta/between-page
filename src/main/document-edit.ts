import { Fragment, Slice } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { storySchema } from "../shared/editor-schema";
import type { DocumentNode, TextSelection } from "../shared/types";
import { textToDocument } from "../shared/document";
export function selectionText(document: DocumentNode, s: TextSelection) {
  const doc = storySchema.nodeFromJSON(document);
  if (s.from < 0 || s.to > doc.content.size || s.to <= s.from)
    throw new Error("选区位置无效。");
  return doc.textBetween(s.from, s.to, "\n");
}
export function replaceSelection(
  document: DocumentNode,
  s: TextSelection,
  text: string,
): DocumentNode {
  const doc = storySchema.nodeFromJSON(document);
  if (selectionText(document, s) !== s.text)
    throw new Error("原选区已变化，请重新选择并生成。");
  const replacement = storySchema.nodeFromJSON(textToDocument(text));
  const slice = Slice.maxOpen(replacement.content);
  return new Transform(doc).replaceRange(s.from, s.to, slice).doc.toJSON();
}
export function appendDocument(
  document: DocumentNode,
  text: string,
): DocumentNode {
  const doc = storySchema.nodeFromJSON(document),
    next = storySchema.nodeFromJSON(textToDocument(text));
  return new Transform(doc)
    .insert(doc.content.size, Fragment.from(next.content))
    .doc.toJSON();
}
