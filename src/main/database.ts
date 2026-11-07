import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { documentToText, textToDocument } from "../shared/document";
import { validateBlueprint } from "../shared/blueprint";
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
} from "../shared/types";
import { normalizeProject, emptyBlueprint } from "../shared/blueprint";

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
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    const hasTables =
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all().length > 0;
    if ((hasTables && version !== 2) || version > 2) {
      this.db.close();
      throw new Error(
        "数据库格式不支持本次工作台重构。请使用新的空数据目录；本版本不迁移旧开发数据。",
      );
    }
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
      CREATE TABLE IF NOT EXISTS change_sets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_change_sets_project ON change_sets(project_id);
      PRAGMA user_version = 2;
    `);
    for (const row of this.db
      .prepare("SELECT id, payload FROM creation_turns")
      .all() as { id: string; payload: string }[]) {
      const turn = JSON.parse(row.payload);
      if (turn.status === "generating") {
        turn.status = "interrupted";
        turn.error = "上次生成因程序关闭而中断。";
        this.db
          .prepare("UPDATE creation_turns SET payload = ? WHERE id = ?")
          .run(JSON.stringify(turn), row.id);
      }
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
    const project = this.getProject(id);
    const units = this.all<Chapter>(
      "SELECT payload FROM chapters WHERE project_id = ? ORDER BY position",
      id,
    );
    return {
      project,
      chapters: units,
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
        blueprint: emptyBlueprint(),
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
        this.copyCard(source.id, project.id);
      }
      this.createChapter(project.id);
      return this.getProject(project.id);
    })();
  }
  updateProject(
    id: string,
    patch: Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>,
  ) {
    const previous = this.getProject(id);
    const project = { ...previous, ...patch, updatedAt: now() };
    if (patch.blueprint)
      validateBlueprint(
        patch.blueprint,
        this.getDetail(id).chapters.map((c) => c.id),
      );
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
      this.db.prepare("DELETE FROM change_sets WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      this.db
        .prepare("DELETE FROM settings WHERE key LIKE ?")
        .run("ui." + id + ".%");
      this.db
        .prepare("DELETE FROM settings WHERE key = ?")
        .run("blueprint.history." + id);
      for (const row of this.db
        .prepare(
          "SELECT key, value FROM settings WHERE key LIKE 'review.snapshot.%'",
        )
        .all() as { key: string; value: string }[]) {
        if (JSON.parse(row.value).projectId === id)
          this.db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
      }
      const stillUsed = new Set(
        this.listImages().map((image) => image.filename),
      );
      return [...new Set(removeFiles)].filter(
        (filename) => !stillUsed.has(filename),
      );
    })();
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
      const chapter = this.getChapter(id),
        detail = this.getDetail(chapter.projectId);
      for (const image of detail.images)
        if (image.chapterId === id)
          this.write("images", { ...image, chapterId: null, revisionId: null });
      this.db.prepare("DELETE FROM memories WHERE chapter_id = ?").run(id);
      this.db.prepare("DELETE FROM revisions WHERE chapter_id = ?").run(id);
      this.db.prepare("DELETE FROM chapters WHERE id = ?").run(id);
      const remaining = detail.chapters.filter((c) => c.id !== id);
      for (const [i, c] of remaining.entries()) {
        c.position = i + 1;
        if (
          chapter.acceptedRevisionId &&
          c.position >= chapter.position &&
          c.acceptedRevisionId
        )
          c.needsReview = true;
        this.db
          .prepare("UPDATE chapters SET position = ?, payload = ? WHERE id = ?")
          .run(c.position, JSON.stringify(c), c.id);
      }
      for (const memory of detail.memories)
        if (
          !memory.manual &&
          memory.chapterId &&
          remaining.some((c) => c.id === memory.chapterId && c.needsReview)
        )
          this.setMemoryActive(memory.id, false);
      this.updateProject(chapter.projectId, {
        blueprint: {
          nodes: detail.project.blueprint.nodes.map((n) =>
            n.chapterId === id ? { ...n, chapterId: null } : n,
          ),
        },
      });
      return this.getDetail(chapter.projectId);
    })();
  }
  updateChapter(
    id: string,
    patch: {
      title?: string;
      document?: DocumentNode;
    },
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
      .prepare("SELECT payload FROM change_sets WHERE project_id = ?")
      .all(projectId) as { payload: string }[])
      if (references(JSON.parse(row.payload), id))
        usage.push("AI 待审核修改来源");
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
    for (const row of this.db
      .prepare("SELECT key, value FROM settings")
      .all() as { key: string; value: string }[])
      if (references(JSON.parse(row.value), id))
        usage.push(
          row.key.startsWith("scratch.") ? "AI 暂存草稿" : "保存的来源记录",
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
  saveCard(input: CardInput, createId?: string): Card {
    if (materialLength({ ...input, documents: [] }) > materialLimits.card)
      throw new Error("单份资料总量超过 40 万字，请拆成多个资料条目。");
    if (input.projectId) this.getProject(input.projectId);
    if (input.id) {
      const existing = this.getCard(input.id);
      if (existing.projectId !== input.projectId)
        throw new Error("不能移动资料所属的故事，请复制资料。");
      if (existing.projectId && existing.sourceCardId)
        throw new Error(
          "从创作资料引入的资料为只读，不能修改。请在创作资料库中编辑后重新引入。",
        );
    }
    if (
      createId &&
      (input.id ||
        this.db.prepare("SELECT id FROM cards WHERE id = ?").get(createId))
    )
      throw new Error("新资料标识已存在。");
    const card: Card = {
      ...input,
      sourceCardId: null,
      sections: (input.sections ?? []).map((section) => ({
        ...section,
        sourceIds: [],
      })),
      documents: [],
      id: input.id || createId || randomUUID(),
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
    return this.db.transaction(() => {
      const card = this.saveCard({ ...source, id: undefined, projectId });
      card.sourceCardId = projectId ? source.sourceCardId || source.id : null;
      this.write("cards", card);
      return card;
    })();
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
        "SELECT key, value FROM settings WHERE key LIKE 'review.snapshot.%'",
      )
      .all() as { key: string; value: string }[])
      if (references(JSON.parse(row.value), id))
        usage.push("修改审核快照中的图片关联");
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
