export type Mode = "explore" | "novel";
export type CardKind = "character" | "world" | "inspiration";
export type MemoryKind =
  "fact" | "state" | "relationship" | "knowledge" | "foreshadow" | "summary";
export const taskKinds = [
  "opening", "chapter", "develop", "outline", "adjust", "check", "notes",
  "prompt", "revise", "organize", "brainstorm", "scene", "dialogue", "pacing", "arc",
] as const;
export type TaskKind = typeof taskKinds[number];
export type CreativeFreedom = "guided" | "balanced" | "free";
export interface BlueprintSection {
  id: string;
  title: string;
  content: string;
}
export interface BlueprintCandidate {
  id: string;
  title: string;
  content: string;
  source: TaskKind;
  createdAt: string;
  development?: StoryDevelopmentDraft;
}
export interface DevelopmentChange {
  id: string;
  target: "blueprint" | "character" | "world";
  targetId: string;
  sectionId: string;
  name: string;
  title: string;
  content: string;
  mode: "append" | "replace";
  basis: "established" | "proposal";
  sources: { revisionId: string; quote: string }[];
  base: string | null;
}
export interface StoryDevelopmentDraft {
  id: string;
  projectId: string;
  summary: string;
  changes: DevelopmentChange[];
  warnings: string[];
  appliedIds: string[];
}
export interface WorkflowStep {
  id: string;
  kind: TaskKind;
  title: string;
  instruction: string;
}
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  builtin?: boolean;
}
export interface WorkflowStepResult {
  stepId: string;
  status: "pending" | "approved" | "skipped";
  output: string;
  updatedAt: string;
  memoryRecords?: { kind: MemoryKind; content: string }[];
  memoryRevisionId?: string;
  applied?: boolean;
  outputSelection?: { text: string; from: number; to: number } | null;
}
export interface WorkflowRun {
  id: string;
  projectId: string;
  templateId: string;
  templateName: string;
  chapterId: string;
  steps: WorkflowStep[];
  results: WorkflowStepResult[];
  currentStep: number;
  createdAt: string;
  updatedAt: string;
}
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
  creativeFreedom?: CreativeFreedom;
  genre: string;
  world: string;
  style: string;
  outline: string;
  blueprintSections: BlueprintSection[];
  blueprintCandidates: BlueprintCandidate[];
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
  sections: CardSection[];
  documents: SourceDocument[];
  referenceIds: string[];
  updatedAt: string;
}
export interface CardSection {
  id: string;
  title: string;
  content: string;
  alwaysInclude: boolean;
  sourceIds: string[];
}
export interface SourceDocument {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}
export type CardInput = Omit<
  Card,
  "id" | "updatedAt" | "sections" | "documents"
> &
  Partial<Pick<Card, "sections" | "documents">> & { id?: string };
export interface MaterialDraft {
  name: string;
  description: string;
  constraints: string;
  sections: Omit<CardSection, "id">[];
  questions: string[];
}
export type RoleId = TaskKind | "material" | "title";
export interface AIRole {
  id: RoleId;
  prompt: string;
  model: string;
}
export interface RoleSettings {
  commonPrompt: string;
  roles: AIRole[];
}
export interface MaterialCoverage {
  card: string;
  source: string;
  included: number;
  total: number;
}
export interface TaskPreview {
  systemPrompt: string;
  context: string;
  model: string;
  coverage: MaterialCoverage[];
  omitted: number;
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
  key: string;
  model: string;
  selectedModels: string[];
  availableModels: string[];
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
export type SettingsInput = Pick<Settings, "imageSize" | "imageQuality"> & {
  text: Omit<ProviderConfig, "hasKey">;
  image: Omit<ProviderConfig, "hasKey">;
};
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
  roles: RoleSettings;
}
export interface TaskRequest {
  requestId: string;
  kind: TaskKind;
  projectId: string;
  chapterId?: string;
  instruction: string;
  selection?: string;
  workflowContext?: string;
}
export interface TaskResult {
  text: string;
  notesSaved?: number;
  memoryRecords?: { kind: MemoryKind; content: string }[];
  memoryRevisionId?: string;
  developmentDraft?: StoryDevelopmentDraft;
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
  foreshadow: "已埋伏笔与承诺",
  summary: "章节摘要",
};
