export type Mode = "explore" | "novel";
export type CardKind = "character" | "world" | "inspiration";
export const memoryKinds = [
  "fact",
  "state",
  "relationship",
  "knowledge",
  "foreshadow",
  "summary",
] as const;
export type MemoryKind = (typeof memoryKinds)[number];
export const taskKinds = [
  "brainstorm",
  "settings",
  "blueprint",
  "opening",
  "continue",
  "polish",
  "check",
  "notes",
  "prompt",
  "title",
] as const;
export type TaskKind = (typeof taskKinds)[number];
export type RoleId = TaskKind;
export type CreativeFreedom = "guided" | "balanced" | "free";
export type BlueprintLevel =
  "section" | "synopsis" | "volume" | "chapter" | "scene";
export interface BlueprintNode {
  id: string;
  level: BlueprintLevel;
  parentId: string | null;
  chapterId: string | null;
  title: string;
  content: string;
}
export interface Blueprint {
  nodes: BlueprintNode[];
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
  cover?: StoryCover | null;
  title: string;
  premise: string;
  mode: Mode;
  creativeFreedom: CreativeFreedom;
  genre: string;
  world: string;
  style: string;
  blueprint: Blueprint;
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
  document: DocumentNode;
  content: string;
  acceptedRevisionId: string | null;
  dirty: boolean;
  needsReview: boolean;
  planningReview?: string;
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
export interface SourceDocument {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}
export interface CardSection {
  id: string;
  title: string;
  content: string;
  sourceIds: string[];
}
export interface RefinedMaterial {
  description: string;
  constraints: string;
  sections: CardSection[];
}
export interface Card {
  id: string;
  projectId: string | null;
  sourceCardId?: string | null;
  kind: CardKind;
  name: string;
  description: string;
  constraints: string;
  sections: CardSection[];
  documents: SourceDocument[];
  referenceIds: string[];
  updatedAt: string;
}
export type CardInput = Omit<
  Card,
  "id" | "updatedAt" | "sections" | "documents" | "sourceCardId"
> &
  Partial<Pick<Card, "sections" | "documents">> & { id?: string };
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
  kind: "reference" | "illustration" | "cover";
  name: string;
  notes?: string;
  filename: string;
  prompt: string;
  referenceIds: string[];
  model: string;
  createdAt: string;
}
export interface AIRole {
  id: RoleId;
  prompt: string;
  model: string;
}
export interface RoleSettings {
  commonPrompt: string;
  roles: AIRole[];
}
export interface ModelCapabilities {
  vision: boolean;
  contextTokens: number;
  outputTokens: number;
}
export interface ProviderConfig {
  baseUrl: string;
  key: string;
  model: string;
  selectedModels: string[];
  availableModels: string[];
  capabilities: Record<string, ModelCapabilities>;
  hasKey: boolean;
}
export type CloseAction = "ask" | "minimize" | "quit";
export interface CoverCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface StoryCover {
  imageId: string;
  crop: CoverCrop;
}
export interface CoverUpload {
  name: string;
  dataUrl: string;
  crop: CoverCrop;
}
export type PresetTheme = "classic" | "sage" | "warm" | "night";
export interface ThemeColors {
  primary: string;
  page: string;
  surface: string;
  paper: string;
  ink: string;
  sidebar: string;
}
export interface AppearanceSettings {
  uiFontSize: number;
  editorFontSize: number;
  theme: PresetTheme | "custom";
  customBase: PresetTheme;
  customColors: ThemeColors | null;
}
export interface SoftwareSettings {
  closeAction: CloseAction;
  appearance: AppearanceSettings;
}
export type SoftwareSettingsPatch = {
  closeAction?: CloseAction;
  appearance?: Partial<AppearanceSettings>;
};
export interface Settings {
  software: SoftwareSettings;
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
export interface TextSelection {
  text: string;
  from: number;
  to: number;
}
export interface BlueprintTarget {
  level: BlueprintLevel;
  id?: string;
  parentId?: string;
  chapterId?: string;
  count: number;
}
export type CheckScope =
  | { type: "current"; chapterId: string }
  | { type: "chapters"; chapterIds: string[] }
  | { type: "book" };
export type CheckAspect = "continuity" | "pacing" | "arc";
export type PolishAspect = "expression" | "scene" | "dialogue";
interface RequestBase {
  requestId: string;
  projectId: string;
  mode: Mode;
  instruction: string;
  model?: string;
  conversationId?: string;
  parentTurnId?: string;
}
export type TaskRequest = RequestBase &
  (
    | { kind: "brainstorm" }
    | { kind: "settings"; cardId?: string }
    | { kind: "blueprint"; target: BlueprintTarget }
    | { kind: "opening" | "continue" | "notes" | "title"; chapterId: string }
    | {
        kind: "polish";
        chapterId: string;
        selection: TextSelection;
        aspect: PolishAspect;
      }
    | {
        kind: "check";
        scope: CheckScope;
        aspect: CheckAspect;
        character?: string;
      }
    | { kind: "prompt"; chapterId?: string; selection?: TextSelection }
  );
export type ChangeTarget =
  | {
      type: "setting";
      cardId: string;
      field: "description" | "constraints" | "section";
      sectionId?: string;
      cardKind: CardKind;
      name: string;
      title: string;
    }
  | { type: "project-setting"; field: "world" | "style" }
  | { type: "blueprint"; node: BlueprintNode }
  | {
      type: "prose";
      chapterId: string;
      operation: "opening" | "append" | "selection";
      selection?: TextSelection;
    }
  | { type: "title"; chapterId: string }
  | { type: "memory"; chapterId: string; revisionId: string; kind: MemoryKind };
export interface ProposedChange {
  id: string;
  target: ChangeTarget;
  before: string;
  after: string;
  beforeTitle?: string;
  afterTitle?: string;
  targetBase: string;
  applied: boolean;
}
export interface ChangeSet {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  kind: TaskKind;
  mode: Mode;
  basis: string;
  generationStatus: "complete";
  status: "pending" | "partial" | "applied";
  title: string;
  changes: ProposedChange[];
  createdAt: string;
}
export interface CheckFinding {
  category: "conflict" | "question" | "suggestion";
  chapterId: string;
  quote: string;
  reference: string;
  impact: string;
  suggestion: string;
}
export interface CheckBatch {
  chapterId: string;
  title: string;
  sourceVersion: string;
  status: "complete" | "failed";
  error?: string;
  findings: CheckFinding[];
}
export interface CheckReport {
  aspect: CheckAspect;
  batches: CheckBatch[];
  comparisons: {
    chapterIds: string[];
    status: "complete" | "failed";
    error?: string;
  }[];
  summary: string;
  complete: boolean;
}
export type TaskResult =
  | { type: "chat"; text: string }
  | { type: "report"; text: string; report: CheckReport }
  | { type: "changes"; text: string; changeSetId: string }
  | { type: "illustration"; text: string };
export interface CreationConversation {
  id: string;
  projectId: string;
  mode: Mode;
  kind: TaskKind;
  key: string;
  title: string;
  request: TaskRequest;
  selectedTurnId: string | null;
  createdAt: string;
}
export interface CreationTurn {
  id: string;
  projectId: string;
  conversationId: string;
  number: number;
  parentTurnId: string | null;
  instruction: string;
  status: "generating" | "complete" | "stopped" | "error" | "interrupted";
  rawResponse: string;
  result: TaskResult | null;
  sourceSnapshot: TaskPreview[];
  error: string;
  model: string;
  createdAt: string;
}
export interface ConversationDetail {
  conversation: CreationConversation;
  turns: CreationTurn[];
}
export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "high" | "low" };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | (TextPart | ImagePart)[];
}
export interface ContextSource {
  title: string;
  priority: string;
  characters: number;
}
export interface ReferencePreview {
  id: string;
  name: string;
  owners: string[];
  url: string;
}
export interface TaskPreview {
  model: string;
  messages: ChatMessage[];
  sources: ContextSource[];
  images: ReferencePreview[];
  omitted: string[];
  estimatedTokens: number;
  batches?: { title: string; preview?: TaskPreview; error?: string }[];
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
  conversationId?: string;
  turnId?: string;
}
export interface DesktopAPI {
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
  onClosing(callback: (action?: "quit") => void): () => void;
}
export const memoryLabels: Record<MemoryKind, string> = {
  fact: "故事事实",
  state: "人物状态",
  relationship: "关系变化",
  knowledge: "秘密与认知",
  foreshadow: "已埋伏笔与承诺",
  summary: "章节摘要",
};
