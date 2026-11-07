import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
export const storyExtensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
];
export const storySchema = getSchema(storyExtensions);
