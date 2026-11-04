export type Mode = "explore" | "novel";
export type CardKind = "character" | "world" | "inspiration";
export type MemoryKind =
  "fact" | "state" | "relationship" | "knowledge" | "foreshadow" | "summary";
export type TaskKind =
  | "chapter"
  | "outline"
  | "adjust"
  | "check"
  | "notes"
  | "prompt"
  | "revise"
  | "organize";
export interface DocumentNode {
  type: string;
  text?: string;
  content?: DocumentNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}
export interface Project {
  id: string;
  title: string;
  premise: string;
  mode: Mode;
  genre: string;
  world: string;
  style: string;
  outline: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}
export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  position: number;
  plan: string;
  document: DocumentNode;
  content: string;
  acceptedRevisionId: string | null;
  dirty: boolean;
  needsReview: boolean;
  updatedAt: string;
}
export interface Revision {
  id: string;
  projectId: string;
  chapterId: string;
  title: string;
  document: DocumentNode;
  content: string;
  label: string;
  createdAt: string;
}
export interface Card {
  id: string;
  projectId: string | null;
  kind: CardKind;
  name: string;
  description: string;
  constraints: string;
  referenceIds: string[];
  updatedAt: string;
}
export interface Memory {
  id: string;
  projectId: string;
  chapterId: string | null;
  revisionId: string | null;
  kind: MemoryKind;
  content: string;
  active: boolean;
  manual: boolean;
  createdAt: string;
}
export interface ImageAsset {
  id: string;
  projectId: string | null;
  chapterId: string | null;
  revisionId: string | null;
  kind: "reference" | "illustration";
  name: string;
  filename: string;
  prompt: string;
  referenceIds: string[];
  model: string;
  createdAt: string;
}
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
export interface Settings {
  text: ProviderConfig;
  image: ProviderConfig;
  imageSize: string;
  imageQuality: string;
  dataDir: string;
  version: string;
}
export interface ProjectDetail {
  project: Project;
  chapters: Chapter[];
  cards: Card[];
  memories: Memory[];
  images: ImageAsset[];
}
export interface Bootstrap {
  projects: Project[];
  cards: Card[];
  images: ImageAsset[];
  settings: Settings;
}
export interface TaskRequest {
  requestId: string;
  kind: TaskKind;
  projectId: string;
  chapterId?: string;
  instruction: string;
  selection?: string;
}
export interface TaskResult {
  text: string;
  notesSaved?: number;
}
export interface ImageRequest {
  projectId: string;
  chapterId?: string;
  prompt: string;
  referenceIds: string[];
  size: string;
  quality: string;
}
export interface ProgressEvent {
  requestId: string;
  delta: string;
}
export interface DesktopAPI {
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
  onClosing(callback: () => void): () => void;
}
export const memoryLabels: Record<MemoryKind, string> = {
  fact: "故事事实",
  state: "人物状态",
  relationship: "关系变化",
  knowledge: "秘密与认知",
  foreshadow: "伏笔与承诺",
  summary: "章节摘要",
};
