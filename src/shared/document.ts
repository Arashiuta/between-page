import type { DocumentNode } from "./types";

export function textToDocument(text: string): DocumentNode {
  return {
    type: "doc",
    content: text.split(/\r?\n(?:[\t ]*\r?\n)*/).map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}
export function documentToText(doc: DocumentNode): string {
  if (doc.type === "text") return doc.text ?? "";
  if (doc.type === "hardBreak") return "\n";
  const children = doc.content ?? [];
  const separator = [
    "doc",
    "bulletList",
    "orderedList",
    "blockquote",
    "listItem",
  ].includes(doc.type)
    ? "\n"
    : "";
  return children.map(documentToText).join(separator);
}
export function wordCount(text: string): number {
  return [...text.replace(/\s/g, "")].length;
}
