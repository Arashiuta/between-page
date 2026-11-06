import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { documentToText, textToDocument } from "../shared/document";
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
import { normalizeProject, defaultBlueprintSections } from "../shared/blueprint";

const now = () => new Date().toISOString();
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
      CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, position);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id, active);
      CREATE INDEX IF NOT EXISTS idx_revisions_chapter ON revisions(chapter_id);
      PRAGMA user_version = 1;
    `);
    const projects = this.db
      .prepare("SELECT id, payload FROM projects")
      .all() as { id: string; payload: string }[];
    const migrate = this.db.prepare("UPDATE projects SET payload = ? WHERE id = ?");
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
  private write(table: string, value: { id: string }) {
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
    return this.one<Chapter>("chapters", id);
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
    return {
      project: this.getProject(id),
      chapters: this.all<Chapter>(
        "SELECT payload FROM chapters WHERE project_id = ? ORDER BY position",
        id,
      ),
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
        creativeFreedom: input.creativeFreedom ?? (input.mode === "explore" ? "free" : "balanced"),
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
      return project;
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
      >
    >,
  ) {
    const project = normalizeProject({ ...this.getProject(id), ...patch, updatedAt: now() });
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
            .prepare("UPDATE images SET project_id = NULL, payload = ? WHERE id = ?")
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
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM settings WHERE key = ?").run("scratch." + id);
      this.db
        .prepare("DELETE FROM settings WHERE key LIKE ?")
        .run("workflow.run." + id + ".%");
      this.db.prepare("DELETE FROM settings WHERE key = ? OR key LIKE ?").run(`development.undo.${id}`, `development.applied.${id}.%`);
      const stillUsed = new Set(this.listImages().map((image) => image.filename));
      return [...new Set(removeFiles)].filter((filename) => !stillUsed.has(filename));
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
    this.getProject(projectId);
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
      const revisionIds = new Set(this.listRevisions(id).map((revision) => revision.id));
      const laterIds = new Set(
        detail.chapters.filter((item) => item.position > chapter.position).map((item) => item.id),
      );

      // Keep illustrations in the story, without references to deleted sources.
      for (const image of this.listImages()) {
        if (image.chapterId === id || (image.revisionId && revisionIds.has(image.revisionId))) {
          const preserved: ImageAsset = { ...image, chapterId: null, revisionId: null };
          this.write("images", preserved);
        }
      }
      for (const memory of detail.memories) {
        if (memory.chapterId === id || (memory.revisionId && revisionIds.has(memory.revisionId))) {
          this.db.prepare("DELETE FROM memories WHERE id = ?").run(memory.id);
        } else if (chapter.acceptedRevisionId && !memory.manual && memory.chapterId && laterIds.has(memory.chapterId)) {
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
          needsReview: item.needsReview || !!(chapter.acceptedRevisionId && laterIds.has(item.id) && item.acceptedRevisionId),
        };
        this.db.prepare("UPDATE chapters SET position = ?, payload = ? WHERE id = ?")
          .run(updated.position, JSON.stringify(updated), updated.id);
      }
      const scratchKey = "scratch." + chapter.projectId;
      if (this.getSetting<{ chapterId?: string } | null>(scratchKey, null)?.chapterId === id)
        this.db.prepare("DELETE FROM settings WHERE key = ?").run(scratchKey);
      for (const run of this.listWorkflowRuns(chapter.projectId)) {
        if (run.chapterId === id)
          this.db.prepare("DELETE FROM settings WHERE key = ?")
            .run(`workflow.run.${run.projectId}.${run.id}`);
      }
      this.touch(chapter.projectId);
      return this.getDetail(chapter.projectId);
    })();
  }
  updateChapter(
    id: string,
    patch: { title?: string; plan?: string; document?: DocumentNode },
  ): Chapter {
    const previous = this.getChapter(id);
    const chapter = { ...previous, ...patch, updatedAt: now() };
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
