import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { documentToText, textToDocument } from "../shared/document";
import { normalizeChapterVolume } from "../shared/planning";
import {
  normalizeCard,
  materialLength,
  materialLimits,
} from "../shared/materials";
import type {
  Card,
  CardInput,
  Chapter,
  ImageAsset,
  Memory,
  MemoryKind,
  Mode,
  CreativeFreedom,
  Project,
  ProjectDetail,
  Revision,
  DocumentNode,
  WorkflowRun,
  WorkflowTemplate,
} from "../shared/types";
import {
  normalizeProject,
  defaultBlueprintSections,
} from "../shared/blueprint";

const now = () => new Date().toISOString();
function references(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((v) => references(v, id));
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).some((v) => references(v, id))
  );
}
class SQLiteConnection {
  readonly raw: DatabaseSync;
  private depth = 0;
  private sequence = 0;
  constructor(filename: string) {
    this.raw = new DatabaseSync(filename, { timeout: 5000 });
  }
  get open() {
    return this.raw.isOpen;
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  pragma(sql: string) {
    this.raw.exec("PRAGMA " + sql);
  }
  prepare(sql: string) {
    const statement = this.raw.prepare(sql);
    return {
      run: (...args: unknown[]) => statement.run(...(args as SQLInputValue[])),
      get: (...args: unknown[]) => statement.get(...(args as SQLInputValue[])),
      all: (...args: unknown[]) => statement.all(...(args as SQLInputValue[])),
    };
  }
  transaction<T>(fn: () => T): () => T {
    return () => {
      const outer = this.depth === 0,
        name = "nested_" + ++this.sequence;
      this.raw.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const value = fn();
        this.raw.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        this.raw.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`);
        if (!outer) this.raw.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally {
        this.depth--;
      }
    };
  }
  async backup(filename: string) {
    await backup(this.raw, filename);
  }
  close() {
    this.raw.close();
  }
}
export class StoryRepository {
  readonly db: SQLiteConnection;
  constructor(filename: string) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true });
    this.db = new SQLiteConnection(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), position INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id), project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), chapter_id TEXT REFERENCES chapters(id), revision_id TEXT REFERENCES revisions(id), active INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES creation_conversations(id), project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_creation_conversations_project ON creation_conversations(project_id);
      CREATE INDEX IF NOT EXISTS idx_creation_turns_conversation ON creation_turns(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, position);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, active);
      CREATE INDEX IF NOT EXISTS idx_revisions_chapter ON revisions(chapter_id);
      PRAGMA user_version = 1;
    `);
    for (const row of this.db
      .prepare("SELECT id, payload FROM creation_turns")
      .all() as { id: string; payload: string }[]) {
      const turn = JSON.parse(row.payload);
      if (turn.status === "generating") {
        turn.status = "interrupted";
        turn.error = "上次生成因程序关闭而中断，已收到的内容已保留。";
        this.db
          .prepare("UPDATE creation_turns SET payload = ? WHERE id = ?")
          .run(JSON.stringify(turn), row.id);
      }
    }
    const projects = this.db
      .prepare("SELECT id, payload FROM projects")
      .all() as { id: string; payload: string }[];
    const migrate = this.db.prepare(
      "UPDATE projects SET payload = ? WHERE id = ?",
    );
    for (const row of projects) {
      const value = JSON.parse(row.payload) as Project;
      if (!Array.isArray(value.blueprintSections) || value.outline?.trim())
        migrate.run(JSON.stringify(normalizeProject(value)), row.id);
    }
  }
  private all<T>(sql: string, ...args: unknown[]): T[] {
    return (this.db.prepare(sql).all(...args) as { payload: string }[]).map(
      (row) => JSON.parse(row.payload) as T,
    );
  }
  private one<T>(table: string, id: string): T {
    const row = this.db
      .prepare(`SELECT payload FROM ${table} WHERE id = ?`)
      .get(id) as { payload: string } | undefined;
    if (!row) throw new Error("这条记录已不存在，请刷新后重试。");
    return JSON.parse(row.payload) as T;
  }
  private write<T extends { id: string }>(table: string, value: T) {
    this.db
      .prepare(`UPDATE ${table} SET payload = ? WHERE id = ?`)
      .run(JSON.stringify(value), value.id);
  }
  listProjects(): Project[] {
    return this.all<Project>("SELECT payload FROM projects")
      .map(normalizeProject)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  listCards(): Card[] {
    return this.all<Card>("SELECT payload FROM cards WHERE project_id IS NULL")
      .map(normalizeCard)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  listImages(): ImageAsset[] {
    return this.all<ImageAsset>("SELECT payload FROM images").sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  getProject(id: string) {
    return normalizeProject(this.one<Project>("projects", id));
  }
  getChapter(id: string) {
    const chapter = this.one<Chapter>("chapters", id);
    return normalizeChapterVolume(chapter, this.getProject(chapter.projectId));
  }
  getRevision(id: string) {
    return this.one<Revision>("revisions", id);
  }
  getCard(id: string) {
    return normalizeCard(this.one<Card>("cards", id));
  }
  getImage(id: string) {
    return this.one<ImageAsset>("images", id);
  }
  getDetail(id: string): ProjectDetail {
    const project = this.getProject(id);
    const units = this.all<Chapter>(
      "SELECT payload FROM chapters WHERE project_id = ? ORDER BY position",
      id,
    );
    return {
      project,
      chapters: units
        .filter((c) => c.kind !== "fragment")
        .map((c) => normalizeChapterVolume(c, project)),
      fragments: units.filter((c) => c.kind === "fragment"),
      cards: this.all<Card>(
        "SELECT payload FROM cards WHERE project_id = ?",
        id,
      ).map(normalizeCard),
      memories: this.all<Memory>(
        "SELECT payload FROM memories WHERE project_id = ? ORDER BY rowid DESC",
        id,
      ),
      images: this.all<ImageAsset>(
        "SELECT payload FROM images WHERE project_id = ? ORDER BY rowid DESC",
        id,
      ),
    };
  }
  createProject(
    input: {
      title: string;
      premise: string;
      mode: Mode;
      creativeFreedom?: CreativeFreedom;
      genre?: string;
      cardIds?: string[];
    },
    projectId = randomUUID(),
  ): Project {
    return this.db.transaction(() => {
      const project: Project = {
        id: projectId,
        title: input.title,
        premise: input.premise,
        mode: input.mode,
        creativeFreedom:
          input.creativeFreedom ??
          (input.mode === "explore" ? "free" : "guided"),
        genre: input.genre || "未分类",
        world: "",
        style: "",
        outline: "",
        blueprintSections: defaultBlueprintSections(),
        blueprintCandidates: [],
        color: ["sage", "sand", "rose", "slate"][
          this.listProjects().length % 4
        ],
        createdAt: now(),
        updatedAt: now(),
        archived: false,
      };
      this.db
        .prepare("INSERT INTO projects VALUES (?, ?)")
        .run(project.id, JSON.stringify(project));
      for (const id of input.cardIds ?? []) {
        const source = this.getCard(id);
        if (source.projectId !== null)
          throw new Error("请选择资料库中的角色或世界观。");
        this.saveCard({ ...source, id: undefined, projectId: project.id });
      }
      this.createChapter(project.id);
      return this.getProject(project.id);
    })();
  }
  updateProject(
    id: string,
    patch: Partial<
      Pick<
        Project,
        | "title"
        | "premise"
        | "mode"
        | "creativeFreedom"
        | "genre"
        | "world"
        | "style"
        | "outline"
        | "blueprintSections"
        | "blueprintCandidates"
        | "archived"
        | "cover"
        | "novelPlan"
      >
    >,
  ) {
    const project = normalizeProject({
      ...this.getProject(id),
      ...patch,
      updatedAt: now(),
    });
    this.write("projects", project);
    return project;
  }
  deleteArchivedProject(id: string): string[] {
    return this.db.transaction(() => {
      const project = this.getProject(id);
      if (!project.archived) throw new Error("请先归档故事，再彻底删除。");
      const detail = this.getDetail(id);
      const referenced = new Set<string>();
      for (const card of this.all<Card>(
        "SELECT payload FROM cards WHERE project_id IS NULL OR project_id != ?",
        id,
      ))
        for (const imageId of card.referenceIds) referenced.add(imageId);
      for (const image of this.all<ImageAsset>(
        "SELECT payload FROM images WHERE project_id IS NULL OR project_id != ?",
        id,
      )) {
        referenced.add(image.id);
        for (const imageId of image.referenceIds) referenced.add(imageId);
      }
      const removeFiles: string[] = [];
      for (const image of detail.images) {
        if (referenced.has(image.id)) {
          const preserved: ImageAsset = {
            ...image,
            projectId: null,
            chapterId: null,
            revisionId: null,
          };
          this.db
            .prepare(
              "UPDATE images SET project_id = NULL, payload = ? WHERE id = ?",
            )
            .run(JSON.stringify(preserved), image.id);
        } else {
          removeFiles.push(image.filename);
          this.db.prepare("DELETE FROM images WHERE id = ?").run(image.id);
        }
      }
      this.db.prepare("DELETE FROM memories WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM revisions WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM chapters WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM cards WHERE project_id = ?").run(id);
      this.db
        .prepare("DELETE FROM creation_turns WHERE project_id = ?")
        .run(id);
      this.db
        .prepare("DELETE FROM creation_conversations WHERE project_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      this.db
        .prepare("DELETE FROM settings WHERE key = ?")
        .run("scratch." + id);
      this.db
        .prepare("DELETE FROM settings WHERE key = ?")
        .run("creation.imported." + id);
      this.db
        .prepare("DELETE FROM settings WHERE key = ?")
        .run("planning.history." + id);
      this.db
        .prepare("DELETE FROM settings WHERE key LIKE ?")
        .run("workflow.run." + id + ".%");
      this.db
        .prepare("DELETE FROM settings WHERE key = ? OR key LIKE ?")
        .run(`development.undo.${id}`, `development.applied.${id}.%`);
      const stillUsed = new Set(
        this.listImages().map((image) => image.filename),
      );
      return [...new Set(removeFiles)].filter(
        (filename) => !stillUsed.has(filename),
      );
    })();
  }
  listWorkflowTemplates(): WorkflowTemplate[] {
    return this.getSetting<WorkflowTemplate[]>("workflow.templates", []);
  }
  saveWorkflowTemplates(templates: WorkflowTemplate[]): WorkflowTemplate[] {
    this.setSetting("workflow.templates", templates);
    return templates;
  }
  listWorkflowRuns(projectId: string): WorkflowRun[] {
    this.getProject(projectId);
    return this.all<WorkflowRun>(
      "SELECT value AS payload FROM settings WHERE key LIKE ?",
      "workflow.run." + projectId + ".%",
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  saveWorkflowRun(run: WorkflowRun): WorkflowRun {
    this.getProject(run.projectId);
    this.setSetting(`workflow.run.${run.projectId}.${run.id}`, run);
    return run;
  }
  private touch(projectId: string) {
    this.updateProject(projectId, {});
  }
  createChapter(projectId: string): Chapter {
    const project = this.getProject(projectId);
    const row = this.db
      .prepare(
        "SELECT MAX(position) AS position FROM chapters WHERE project_id = ?",
      )
      .get(projectId) as { position: number | null };
    const position = (row.position ?? 0) + 1;
    const chapter: Chapter = {
      id: randomUUID(),
      projectId,
      title: `第${position}章`,
      position,
      plan: "",
      kind: "chapter",
      volumeId:
        project.mode === "novel"
          ? project.novelPlan?.volumes[0]?.id
          : undefined,
      planMeta: {},
      document: textToDocument(""),
      content: "",
      acceptedRevisionId: null,
      dirty: true,
      needsReview: false,
      updatedAt: now(),
    };
    this.db
      .prepare("INSERT INTO chapters VALUES (?, ?, ?, ?)")
      .run(chapter.id, projectId, position, JSON.stringify(chapter));
    this.touch(projectId);
    return chapter;
  }
  deleteChapter(id: string): ProjectDetail {
    return this.db.transaction(() => {
      const chapter = this.getChapter(id);
      const detail = this.getDetail(chapter.projectId);
      const revisionIds = new Set(
        this.listRevisions(id).map((revision) => revision.id),
      );
      const laterIds = new Set(
        detail.chapters
          .filter(
            (item) =>
              chapter.kind !== "fragment" && item.position > chapter.position,
          )
          .map((item) => item.id),
      );

      // Keep illustrations in the story, without references to deleted sources.
      for (const image of this.listImages()) {
        if (
          image.chapterId === id ||
          (image.revisionId && revisionIds.has(image.revisionId))
        ) {
          const preserved: ImageAsset = {
            ...image,
            chapterId: null,
            revisionId: null,
          };
          this.write("images", preserved);
        }
      }
      for (const memory of detail.memories) {
        if (
          memory.chapterId === id ||
          (memory.revisionId && revisionIds.has(memory.revisionId))
        ) {
          this.db.prepare("DELETE FROM memories WHERE id = ?").run(memory.id);
        } else if (
          chapter.acceptedRevisionId &&
          !memory.manual &&
          memory.chapterId &&
          laterIds.has(memory.chapterId)
        ) {
          this.setMemoryActive(memory.id, false);
        }
      }
      this.db.prepare("DELETE FROM revisions WHERE chapter_id = ?").run(id);
      this.db.prepare("DELETE FROM chapters WHERE id = ?").run(id);

      const remaining = detail.chapters.filter((item) => item.id !== id);
      for (const [index, item] of remaining.entries()) {
        const updated = {
          ...item,
          position: index + 1,
          needsReview:
            item.needsReview ||
            !!(
              chapter.acceptedRevisionId &&
              laterIds.has(item.id) &&
              item.acceptedRevisionId
            ),
        };
        if (updated.fragmentContext?.anchorId === id)
          delete updated.fragmentContext.anchorId;
        updated.incorporatedInto = updated.incorporatedInto?.filter(
          (target) => target !== id,
        );
        this.db
          .prepare("UPDATE chapters SET position = ?, payload = ? WHERE id = ?")
          .run(updated.position, JSON.stringify(updated), updated.id);
      }
      for (const fragment of (detail.fragments ?? []).filter(
        (f) => f.id !== id,
      )) {
        if (fragment.fragmentContext?.anchorId === id)
          delete fragment.fragmentContext.anchorId;
        fragment.incorporatedInto = fragment.incorporatedInto?.filter(
          (target) => target !== id,
        );
        this.write("chapters", fragment);
      }
      const invalidSource = (value: unknown) =>
        [...revisionIds].some((r) => references(value, r));
      this.updateProject(chapter.projectId, {
        blueprintCandidates: detail.project.blueprintCandidates.map(
          (candidate) =>
            candidate.development && invalidSource(candidate.development)
              ? {
                  ...candidate,
                  development: {
                    ...candidate.development,
                    warnings: [
                      ...candidate.development.warnings,
                      "来源章节已删除，此候选的正文依据已失效，请重新生成后采用。",
                    ],
                  },
                }
              : candidate,
        ),
      });
      const undoKey = `development.undo.${chapter.projectId}`;
      if (invalidSource(this.getSetting(undoKey, null)))
        this.setSetting(undoKey, null);
      const scratchKey = "scratch." + chapter.projectId;
      const scratch = this.getSetting(scratchKey, null);
      if (references(scratch, id) || invalidSource(scratch))
        this.db.prepare("DELETE FROM settings WHERE key = ?").run(scratchKey);
      for (const run of this.listWorkflowRuns(chapter.projectId)) {
        if (run.chapterId === id || invalidSource(run))
          this.db
            .prepare("DELETE FROM settings WHERE key = ?")
            .run(`workflow.run.${run.projectId}.${run.id}`);
      }
      this.touch(chapter.projectId);
      return this.getDetail(chapter.projectId);
    })();
  }
  updateChapter(
    id: string,
    patch: {
      title?: string;
      plan?: string;
      document?: DocumentNode;
      fragmentContext?: Chapter["fragmentContext"];
    },
  ): Chapter {
    const previous = this.getChapter(id);
    const chapter = { ...previous, ...patch, updatedAt: now() };
    if (patch.plan !== undefined && !chapter.planMeta)
      chapter.planMeta = { confirmed: previous.plan };
    if (patch.document) chapter.content = documentToText(patch.document);
    const accepted = chapter.acceptedRevisionId
      ? this.getRevision(chapter.acceptedRevisionId)
      : null;
    chapter.dirty =
      !accepted ||
      accepted.title !== chapter.title ||
      JSON.stringify(accepted.document) !== JSON.stringify(chapter.document);
    this.write("chapters", chapter);
    this.touch(chapter.projectId);
    return chapter;
  }
  checkpoint(id: string, label = "手动快照"): Revision {
    const chapter = this.getChapter(id);
    const revision: Revision = {
      id: randomUUID(),
      projectId: chapter.projectId,
      chapterId: id,
      title: chapter.title,
      document: chapter.document,
      content: chapter.content,
      label,
      createdAt: now(),
    };
    this.db
      .prepare("INSERT INTO revisions VALUES (?, ?, ?, ?)")
      .run(revision.id, id, chapter.projectId, JSON.stringify(revision));
    return revision;
  }
  listRevisions(chapterId: string): Revision[] {
    return this.all<Revision>(
      "SELECT payload FROM revisions WHERE chapter_id = ? ORDER BY rowid DESC",
      chapterId,
    );
  }
  revisionUsage(projectId: string, id: string): string[] {
    const revision = this.getRevision(id);
    if (revision.projectId !== projectId)
      throw new Error("版本不属于当前故事。");
    const usage: string[] = [];
    for (const c of this.all<Chapter>("SELECT payload FROM chapters"))
      if (c.acceptedRevisionId === id) usage.push(`当前采用：${c.title}`);
    for (const m of this.all<Memory>("SELECT payload FROM memories"))
      if (m.revisionId === id)
        usage.push(
          `故事记忆${m.active ? "" : "（已停用）"}：${m.content.slice(0, 40)}`,
        );
    for (const image of this.listImages())
      if (image.revisionId === id) usage.push(`插画来源：${image.name}`);
    for (const row of this.db
      .prepare("SELECT payload FROM creation_turns WHERE project_id = ?")
      .all(projectId) as { payload: string }[])
      if (references(JSON.parse(row.payload), id))
        usage.push("AI 创作对话版本");
    for (const row of this.db
      .prepare(
        "SELECT payload FROM creation_conversations WHERE project_id = ?",
      )
      .all(projectId) as { payload: string }[])
      if (references(JSON.parse(row.payload), id))
        usage.push("AI 创作对话来源");
    for (const p of this.listProjects())
      for (const candidate of p.blueprintCandidates)
        if (references(candidate.development, id))
          usage.push(`设定候选：${p.title} / ${candidate.title}`);
    for (const row of this.db
      .prepare("SELECT key, value FROM settings")
      .all() as { key: string; value: string }[])
      if (references(JSON.parse(row.value), id))
        usage.push(
          row.key.startsWith("scratch.")
            ? "AI 暂存草稿"
            : row.key.startsWith("workflow.run.")
              ? "工作流记录"
              : row.key.startsWith("development.undo.")
                ? "设定更新撤销记录"
                : "保存的来源记录",
        );
    return [...new Set(usage)];
  }
  manageRevision(projectId: string, id: string, label?: string) {
    return this.db.transaction(() => {
      const revision = this.getRevision(id);
      if (revision.projectId !== projectId)
        throw new Error("版本不属于当前故事。");
      if (label !== undefined) {
        if (!label.trim() || label.length > 500)
          throw new Error("版本标签需为 1—500 字。");
        this.write("revisions", { ...revision, label: label.trim() });
      } else {
        const usage = this.revisionUsage(projectId, id);
        if (usage.length)
          throw new Error(`此版本仍被引用，无法删除：${usage.join("；")}`);
        this.db.prepare("DELETE FROM revisions WHERE id = ?").run(id);
      }
      return this.listRevisions(revision.chapterId);
    })();
  }
  restoreRevision(revisionId: string): Chapter {
    return this.db.transaction(() => {
      const revision = this.getRevision(revisionId);
      this.checkpoint(revision.chapterId, "恢复前的草稿");
      return this.updateChapter(revision.chapterId, {
        title: revision.title,
        document: revision.document,
      });
    })();
  }
  adoptChapter(id: string): Chapter {
    return this.db.transaction(() => {
      const chapter = this.getChapter(id);
      if (chapter.kind === "fragment")
        throw new Error("请先将片段编入章节，再采用并整理正式记忆。");
      if (!chapter.content.trim())
        throw new Error("先写下一些正文，再采用这一章。");
      if (!chapter.dirty && !chapter.needsReview) return chapter;
      const revision = this.checkpoint(
        id,
        chapter.needsReview ? "复核后采用" : "采用版本",
      );
      chapter.acceptedRevisionId = revision.id;
      chapter.dirty = false;
      chapter.needsReview = false;
      chapter.updatedAt = now();
      this.write("chapters", chapter);
      const detail = this.getDetail(chapter.projectId);
      const affected = new Set([
        id,
        ...detail.chapters
          .filter((c) => c.position > chapter.position)
          .map((c) => c.id),
      ]);
      for (const memory of detail.memories) {
        if (
          !memory.manual &&
          memory.chapterId &&
          affected.has(memory.chapterId)
        )
          this.setMemoryActive(memory.id, false);
      }
      for (const later of detail.chapters.filter(
        (c) => c.position > chapter.position && c.acceptedRevisionId,
      )) {
        later.needsReview = true;
        this.write("chapters", later);
      }
      this.touch(chapter.projectId);
      return chapter;
    })();
  }
  saveCard(input: CardInput): Card {
    if (materialLength(input) > materialLimits.card)
      throw new Error("单份资料总量超过 40 万字，请拆成多个资料条目。");
    if (input.projectId) this.getProject(input.projectId);
    if (input.id) {
      const existing = this.getCard(input.id);
      if (existing.projectId !== input.projectId)
        throw new Error("不能移动资料所属的故事，请复制资料。");
    }
    const card: Card = {
      ...input,
      sections: input.sections ?? [],
      documents: input.documents ?? [],
      id: input.id || randomUUID(),
      updatedAt: now(),
    };
    this.db
      .prepare(
        "INSERT INTO cards VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
      )
      .run(card.id, card.projectId, JSON.stringify(card));
    return card;
  }
  copyCard(id: string, projectId: string | null): Card {
    const source = this.getCard(id);
    return this.saveCard({ ...source, id: undefined, projectId });
  }
  deleteCard(id: string): Card {
    const card = this.getCard(id);
    this.db.prepare("DELETE FROM cards WHERE id = ?").run(id);
    return card;
  }
  addMemory(projectId: string, kind: MemoryKind, content: string): Memory {
    this.getProject(projectId);
    const memory: Memory = {
      id: randomUUID(),
      projectId,
      chapterId: null,
      revisionId: null,
      kind,
      content,
      active: true,
      manual: true,
      createdAt: now(),
    };
    this.insertMemory(memory);
    return memory;
  }
  private insertMemory(memory: Memory) {
    this.db
      .prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        memory.id,
        memory.projectId,
        memory.chapterId,
        memory.revisionId,
        memory.active ? 1 : 0,
        JSON.stringify(memory),
      );
  }
  setMemoryActive(id: string, active: boolean): Memory {
    const memory = this.one<Memory>("memories", id);
    if (active && !memory.manual) {
      const chapter = this.getChapter(memory.chapterId!);
      if (
        chapter.acceptedRevisionId !== memory.revisionId ||
        chapter.needsReview
      )
        throw new Error("这条记录的来源已失效，请重新整理记忆。");
    }
    memory.active = active;
    this.db
      .prepare("UPDATE memories SET active = ?, payload = ? WHERE id = ?")
      .run(active ? 1 : 0, JSON.stringify(memory), id);
    return memory;
  }
  saveGeneratedMemories(
    chapterId: string,
    revisionId: string,
    records: { kind: MemoryKind; content: string }[],
  ): number {
    return this.db.transaction(() => {
      const chapter = this.getChapter(chapterId);
      if (chapter.acceptedRevisionId !== revisionId || chapter.needsReview)
        throw new Error(
          "章节版本已变化，本次记忆未写入。请基于最新采用版本重新整理。",
        );
      const revision = this.getRevision(revisionId);
      if (revision.chapterId !== chapterId)
        throw new Error("记忆来源不属于当前章节。");
      for (const memory of this.getDetail(chapter.projectId).memories.filter(
        (m) => m.chapterId === chapterId && !m.manual && m.active,
      ))
        this.setMemoryActive(memory.id, false);
      for (const record of records)
        this.insertMemory({
          ...record,
          id: randomUUID(),
          projectId: chapter.projectId,
          chapterId,
          revisionId,
          active: true,
          manual: false,
          createdAt: now(),
        });
      return records.length;
    })();
  }
  updateMemory(
    projectId: string,
    id: string,
    patch: { kind: MemoryKind; content: string },
  ) {
    return this.db.transaction(() => {
      const memory = this.one<Memory>("memories", id);
      if (memory.projectId !== projectId)
        throw new Error("记忆不属于当前故事。");
      if (!patch.content.trim() || patch.content.length > 200_000)
        throw new Error("请填写有效的记忆内容。");
      const updated = {
        ...memory,
        kind: patch.kind,
        content: patch.content.trim(),
      };
      this.write("memories", updated);
      this.touch(projectId);
      return updated;
    })();
  }
  deleteMemory(projectId: string, id: string) {
    return this.db.transaction(() => {
      const memory = this.one<Memory>("memories", id);
      if (memory.projectId !== projectId)
        throw new Error("记忆不属于当前故事。");
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.touch(projectId);
      return this.getDetail(projectId);
    })();
  }
  imageUsage(id: string): string[] {
    this.getImage(id);
    const usage: string[] = [];
    for (const project of this.listProjects())
      if (project.cover?.imageId === id)
        usage.push(`作品封面：${project.title}`);
    for (const card of this.all<Card>("SELECT payload FROM cards"))
      if (card.referenceIds.includes(id))
        usage.push(
          `资料卡：${card.projectId ? this.getProject(card.projectId).title : "创作资料库"} / ${card.name}`,
        );
    for (const image of this.listImages())
      if (image.referenceIds.includes(id))
        usage.push(`图片参考来源：${image.name}`);
    for (const row of this.db
      .prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'development.undo.%'",
      )
      .all() as { key: string; value: string }[])
      if (references(JSON.parse(row.value), id))
        usage.push("设定更新撤销记录中的图片关联");
    return usage;
  }
  updateImage(id: string, name: string, notes: string) {
    if (!name.trim() || name.length > 500 || notes.length > 20_000)
      throw new Error("图片名称或备注无效。");
    const image = { ...this.getImage(id), name: name.trim(), notes };
    this.write("images", image);
    return image;
  }
  deleteImage(id: string) {
    return this.db.transaction(() => {
      const image = this.getImage(id),
        usage = this.imageUsage(id);
      if (usage.length)
        throw new Error(`图片仍被引用，请先解除关联：${usage.join("；")}`);
      this.db.prepare("DELETE FROM images WHERE id = ?").run(id);
      if (!this.listImages().some((i) => i.filename === image.filename))
        this.setSetting("assets.pendingDeletes", [
          ...new Set([
            ...this.getSetting<string[]>("assets.pendingDeletes", []),
            image.filename,
          ]),
        ]);
      return image;
    })();
  }
  addImage(image: ImageAsset) {
    this.db
      .prepare("INSERT INTO images VALUES (?, ?, ?)")
      .run(image.id, image.projectId, JSON.stringify(image));
    return image;
  }
  removeCoverImage(id: string): string | null {
    const image = this.listImages().find((item) => item.id === id);
    if (!image) return null;
    if (image.kind !== "cover") throw new Error("只能清理封面图片。");
    if (this.listProjects().some((p) => p.cover?.imageId === id)) return null;
    const cards = this.all<Card>("SELECT payload FROM cards");
    if (
      cards.some((c) => c.referenceIds.includes(id)) ||
      this.listImages().some((i) => i.referenceIds.includes(id))
    )
      return null;
    this.db.prepare("DELETE FROM images WHERE id = ?").run(id);
    return this.listImages().some((i) => i.filename === image.filename)
      ? null
      : image.filename;
  }
  updateImageFilename(id: string, filename: string) {
    const image = { ...this.getImage(id), filename };
    this.write("images", image);
    return image;
  }
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  async backup(filename: string) {
    await this.db.backup(filename);
  }
  close() {
    this.db.close();
  }
}
