import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  ChangeSet,
  ChangeTarget,
  ProjectDetail,
  ProposedChange,
  TaskRequest,
} from "../shared/types";
import { basis, explorationBasis, fingerprint } from "./context";
import { replaceSelection, appendDocument } from "./document-edit";
import { textToDocument } from "../shared/document";
import { isLegacyPlanning, validateBlueprint } from "../shared/blueprint";
import { memoryKinds } from "../shared/types";
import { snapshotBlueprint } from "./blueprint-history";
const cleanJSON = (s: string) =>
  JSON.parse(
    s
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/i, "")
      .replace(/\s*\x60\x60\x60$/, ""),
  );
export function getChangeSet(
  repo: StoryRepository,
  projectId: string,
  id: string,
): ChangeSet {
  const row = repo.db
    .prepare("SELECT payload FROM change_sets WHERE id = ? AND project_id = ?")
    .get(id, projectId) as { payload: string } | undefined;
  if (!row) throw new Error("修改建议不存在或不属于当前故事。");
  return JSON.parse(row.payload);
}
export function saveChangeSet(repo: StoryRepository, set: ChangeSet) {
  repo.db
    .prepare(
      "INSERT INTO change_sets VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
    )
    .run(set.id, set.projectId, JSON.stringify(set));
}
export function listChangeSets(repo: StoryRepository, id: string) {
  repo.getProject(id);
  return (
    repo.db
      .prepare(
        "SELECT payload FROM change_sets WHERE project_id = ? ORDER BY rowid DESC",
      )
      .all(id) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as ChangeSet);
}
function currentTarget(d: ProjectDetail, t: ChangeTarget): unknown {
  switch (t.type) {
    case "setting":
      return d.cards.find((c) => c.id === t.cardId) ?? null;
    case "project-setting":
      return d.project[t.field];
    case "blueprint":
      return d.project.blueprint.nodes.find((n) => n.id === t.node.id) ?? null;
    case "title":
    case "prose":
      return d.chapters.find((c) => c.id === t.chapterId) ?? null;
    case "memory":
      return {
        chapter: d.chapters.find((c) => c.id === t.chapterId),
        memories: d.memories.filter((m) => m.chapterId === t.chapterId),
      };
    case "memory-tune": {
      const chapter = t.chapterId
        ? d.chapters.find((c) => c.id === t.chapterId)
        : null;
      return {
        memories: d.memories.filter((m) => t.memoryIds.includes(m.id)),
        source: chapter
          ? {
              id: chapter.id,
              acceptedRevisionId: chapter.acceptedRevisionId,
              needsReview: chapter.needsReview,
              position: chapter.position,
            }
          : null,
      };
    }
  }
}
export function buildChangeSet(
  d: ProjectDetail,
  r: TaskRequest,
  text: string,
  ids: { conversationId: string; turnId: string },
  base: string,
): ChangeSet {
  const changes: ProposedChange[] = [],
    warnings: string[] = [];
  const add = (
    target: ChangeTarget,
    before: string,
    after: string,
    beforeTitle?: string,
    afterTitle?: string,
  ) =>
    changes.push({
      id: randomUUID(),
      target,
      before,
      after,
      ...(afterTitle !== undefined
        ? { beforeTitle: beforeTitle ?? "", afterTitle }
        : {}),
      targetBase: fingerprint(currentTarget(d, target)),
      applied: false,
    });
  const chapter =
    "chapterId" in r ? d.chapters.find((c) => c.id === r.chapterId) : undefined;
  if (
    r.kind === "opening" ||
    r.kind === "continue" ||
    r.kind === "expand" ||
    r.kind === "polish"
  ) {
    if (!chapter) throw new Error("章节不存在。");
    add(
      {
        type: "prose",
        chapterId: chapter.id,
        operation:
          r.kind === "opening"
            ? "opening"
            : r.kind === "continue"
              ? "append"
              : r.kind === "expand"
                ? "replace"
                : "selection",
        ...(r.kind === "polish" ? { selection: r.selection } : {}),
      },
      r.kind === "expand"
        ? chapter.content
        : r.kind === "polish"
          ? r.selection.text
          : "",
      text,
    );
  } else if (r.kind === "title") {
    const title = z
      .object({
        title: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine((v) => !/[\r\n\u0000-\u001f]/.test(v)),
      })
      .strict()
      .parse(cleanJSON(text)).title;
    add({ type: "title", chapterId: chapter!.id }, chapter!.title, title);
  } else if (r.kind === "blueprint" || r.kind === "outline") {
    if (
      (r.kind === "blueprint" && r.target.level !== "section") ||
      (r.kind === "outline" &&
        (r.mode !== "novel" || r.target.level === "section"))
    )
      throw new Error("规划目标超出本工具权限。");
    const parsed = z
      .object({
        items: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(500),
                content: z.string().min(1).max(500000),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      })
      .strict()
      .parse(cleanJSON(text));
    const target = r.target,
      existing = d.project.blueprint.nodes.find((n) => n.id === target.id);
    if (parsed.items.length !== (target.id ? 1 : target.count))
      throw new Error("额外设定结果数量与目标不一致。");
    for (const i of parsed.items) {
      const node = existing
        ? { ...existing, title: i.title, content: i.content }
        : {
            id: randomUUID(),
            level: target.level,
            parentId: target.parentId ?? null,
            chapterId: target.chapterId ?? null,
            ...i,
          };
      add(
        { type: "blueprint", node },
        existing?.content ?? "",
        i.content,
        existing?.title,
        i.title,
      );
    }
  } else if (r.kind === "settings") {
    const schema = z
      .object({
        changes: z
          .array(
            z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("card"),
                  cardId: z.string().optional(),
                  kind: z.enum(["character", "world", "inspiration"]),
                  name: z.string().min(1).max(500),
                  field: z.enum(["description", "constraints", "section"]),
                  sectionId: z.string().optional(),
                  title: z.string().max(500),
                  content: z.string().min(1).max(200000),
                })
                .strict(),
              z
                .object({
                  type: z.literal("project"),
                  field: z.literal("style"),
                  content: z.string().min(1).max(200000),
                })
                .strict(),
            ]),
          )
          .min(1)
          .max(50),
      })
      .strict()
      .parse(cleanJSON(text));
    const newCards = new Map<string, string>();
    for (const c of schema.changes) {
      if (c.type === "project") {
        if (r.cardId) throw new Error("本次只允许修改指定资料。");
        add(
          { type: "project-setting", field: c.field },
          d.project[c.field],
          c.content,
        );
        continue;
      }
      const existing = c.cardId
        ? d.cards.find((x) => x.id === c.cardId)
        : undefined;
      if (c.cardId && !existing)
        throw new Error("设定结果引用了不存在或跨故事的资料。");
      if (r.cardId && c.cardId !== r.cardId)
        throw new Error("本次只允许修改指定资料。");
      if (existing && existing.kind !== c.kind)
        throw new Error("不能修改资料类型。");
      if (existing?.sourceCardId)
        throw new Error("从创作资料引入的资料为只读，不能修改。");
      const key = c.kind + ":" + c.name;
      if (!existing && !newCards.has(key)) newCards.set(key, randomUUID());
      const cardId = existing?.id ?? newCards.get(key)!;
      const section = c.sectionId
        ? existing?.sections.find((s) => s.id === c.sectionId)
        : undefined;
      if (c.sectionId && !section) throw new Error("资料分区不存在。");
      if (c.field !== "section" && c.sectionId)
        throw new Error("概述和规则不能携带分区标识。");
      const t: ChangeTarget = {
        type: "setting",
        cardId,
        field: c.field,
        cardKind: c.kind,
        name: existing?.name ?? c.name,
        title: c.title,
        ...(c.field === "section"
          ? { sectionId: section?.id ?? randomUUID() }
          : {}),
      };
      add(
        t,
        c.field === "section"
          ? (section?.content ?? "")
          : (existing?.[c.field] ?? ""),
        c.content,
        c.field === "section" ? section?.title : undefined,
        c.field === "section"
          ? c.title || section?.title || "新增分区"
          : undefined,
      );
    }
  } else if (r.kind === "notes") {
    const selected = r.chapterIds
      ? r.chapterIds.map((id) => d.chapters.find((item) => item.id === id)!)
      : chapter
        ? [chapter]
        : [];
    if (
      !selected.length ||
      selected.some((item) => !item.acceptedRevisionId || item.needsReview)
    )
      throw new Error("记忆来源不可用。");
    const parsed = z
      .object({
        records: z
          .array(
            z
              .object({
                kind: r.chapterIds ? z.literal("summary") : z.enum(memoryKinds),
                content: z.string().min(1).max(3000),
                chapterId: z.string().uuid().optional(),
                revisionId: z.string().uuid().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(r.chapterIds ? r.chapterIds.length * 24 : 24),
      })
      .strict()
      .parse(cleanJSON(text));
    const usedSources = new Set<string>();
    for (const m of parsed.records) {
      const source = m.chapterId
        ? selected.find((item) => item.id === m.chapterId)
        : selected.length === 1
          ? selected[0]
          : undefined;
      if (
        !source?.acceptedRevisionId ||
        source.needsReview ||
        (m.revisionId && m.revisionId !== source.acceptedRevisionId)
      )
        throw new Error("记忆结果引用了未选择或已变化的章节版本。");
      usedSources.add(source.id);
      add(
        {
          type: "memory",
          chapterId: source.id,
          revisionId: source.acceptedRevisionId,
          kind: m.kind,
        },
        "",
        m.content,
      );
    }
    if (r.chapterIds && usedSources.size !== selected.length)
      throw new Error("记忆结果没有覆盖所有选定章节。");
  } else if (r.kind === "memory_tune") {
    const allMemories = new Map(
      d.memories.map((memory) => [memory.id, memory]),
    );
    const chapterById = new Map(d.chapters.map((item) => [item.id, item]));
    const parsed = z
      .object({
        changes: z
          .array(
            z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("add"),
                  chapterId: z.string().uuid(),
                  revisionId: z.string().uuid(),
                  kind: z.enum(memoryKinds),
                  content: z.string().trim().min(1).max(3000),
                  reason: z.string().trim().min(1).max(1000),
                })
                .strict(),
              z
                .object({
                  type: z.literal("replace"),
                  memoryIds: z.array(z.string().uuid()).min(1).max(100),
                  chapterId: z.string().uuid(),
                  revisionId: z.string().uuid(),
                  kind: z.enum(memoryKinds),
                  content: z.string().trim().min(1).max(3000),
                  reason: z.string().trim().min(1).max(1000),
                })
                .strict(),
              z
                .object({
                  type: z.literal("disable"),
                  memoryIds: z.array(z.string().uuid()).min(1).max(100),
                  reason: z.string().trim().min(1).max(1000),
                })
                .strict(),
            ]),
          )
          .max(200),
        manualConflicts: z
          .array(
            z
              .object({
                memoryIds: z.array(z.string().uuid()).min(1).max(100),
                reason: z.string().trim().min(1).max(1000),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .parse(cleanJSON(text));
    const changedIds = new Set<string>();
    warnings.push(
      ...parsed.manualConflicts.map((conflict) => {
        for (const id of conflict.memoryIds) {
          const memory = allMemories.get(id);
          if (!memory?.active || !(memory.manual || !memory.chapterId))
            throw new Error("手工记忆冲突引用无效或已停用。");
        }
        return `${conflict.reason}（手工记忆保持启用）`;
      }),
    );
    for (const change of parsed.changes) {
      const chapter =
        change.type === "disable"
          ? undefined
          : chapterById.get(change.chapterId);
      if (
        change.type !== "disable" &&
        (!chapter ||
          !chapter.acceptedRevisionId ||
          chapter.needsReview ||
          chapter.acceptedRevisionId !== change.revisionId)
      )
        throw new Error("调优结果引用了未采用或已变化的章节版本。");
      if (
        change.type !== "disable" &&
        !d.memories.some(
          (memory) =>
            memory.active &&
            memory.chapterId === chapter!.id &&
            memory.revisionId === change.revisionId,
        )
      )
        throw new Error("调优结果引用了本次输入中不存在的章节记忆来源。");
      const oldMemories = "memoryIds" in change ? change.memoryIds : [];
      if (new Set(oldMemories).size !== oldMemories.length)
        throw new Error("同一记忆不能在单项调优中重复引用。");
      for (const id of oldMemories) {
        if (changedIds.has(id)) throw new Error("同一记忆不能被重复调优。");
        changedIds.add(id);
        const memory = allMemories.get(id);
        if (!memory?.active)
          throw new Error("调优结果引用了不存在或已停用的记忆。");
        if (memory.manual || !memory.chapterId)
          throw new Error("手工记忆不能被自动替换或停用。");
        const source = chapterById.get(memory.chapterId);
        if (
          !source ||
          source.needsReview ||
          source.acceptedRevisionId !== memory.revisionId
        )
          throw new Error("被调整记忆的来源版本已失效。");
        if (change.type === "replace" && source.position > chapter!.position)
          throw new Error("替换记忆不能覆盖来源更晚的章节记录。");
      }
      if (change.type === "disable") {
        add(
          {
            type: "memory-tune",
            operation: "disable",
            memoryIds: change.memoryIds,
          },
          oldMemories.map((id) => allMemories.get(id)!.content).join("\n\n"),
          "停用",
          undefined,
          undefined,
        );
        changes.at(-1)!.reviewNote = change.reason;
      } else {
        const operation = change.type === "add" ? "add" : "replace";
        add(
          {
            type: "memory-tune",
            operation,
            memoryIds: oldMemories,
            chapterId: chapter!.id,
            revisionId: change.revisionId,
            kind: change.kind,
          },
          oldMemories.map((id) => allMemories.get(id)!.content).join("\n\n"),
          change.content,
        );
        changes.at(-1)!.reviewNote = change.reason;
      }
    }
  } else throw new Error("此工具不能生成可写入修改。");
  const keys = changes.map((c) => {
    const t = c.target;
    return t.type === "setting"
      ? t.cardId + ":" + t.field + ":" + t.sectionId
      : t.type === "blueprint"
        ? t.node.id
        : t.type === "project-setting"
          ? t.field
          : c.id;
  });
  if (new Set(keys).size !== keys.length)
    throw new Error("同一目标出现重复修改。");
  if (!changes.length && !warnings?.length)
    throw new Error("模型没有返回可审核修改。");
  return {
    id: randomUUID(),
    projectId: d.project.id,
    ...ids,
    kind: r.kind,
    mode: r.mode,
    basis: base,
    generationStatus: "complete",
    status: "pending",
    title: r.instruction.slice(0, 80) || "创作建议",
    changes,
    ...(warnings?.length ? { warnings } : {}),
    createdAt: new Date().toISOString(),
  };
}
export function applyChangeSet(
  repo: StoryRepository,
  projectId: string,
  id: string,
  inputs: { id: string; after: string; title?: string }[],
) {
  return repo.db.transaction(() => {
    const set = getChangeSet(repo, projectId, id),
      d = repo.getDetail(projectId);
    if (isLegacyPlanning(set))
      throw new Error("这是旧版分层规划建议，请在大纲规划中重新生成后采用。");
    if (set.mode !== d.project.mode)
      throw new Error("请切回生成建议时的创作模式。");
    if (set.basis !== basis(repo, projectId))
      throw new Error("基础资料已变化，请重新生成建议。");
    const row = repo.db
      .prepare(
        "SELECT payload FROM creation_turns WHERE id = ? AND project_id = ?",
      )
      .get(set.turnId, projectId) as { payload: string } | undefined;
    if (
      set.generationStatus !== "complete" ||
      (row && JSON.parse(row.payload).status !== "complete")
    )
      throw new Error("未完成的结果不能采用。");
    const allowed: Partial<Record<ChangeSet["kind"], ChangeTarget["type"][]>> =
      {
        settings: ["setting", "project-setting"],
        blueprint: ["blueprint"],
        outline: ["blueprint"],
        opening: ["prose"],
        continue: ["prose"],
        expand: ["prose"],
        polish: ["prose"],
        notes: ["memory"],
        memory_tune: ["memory-tune"],
        title: ["title"],
      };
    for (const c of set.changes.filter((c) => !c.applied)) {
      if (!allowed[set.kind]?.includes(c.target.type))
        throw new Error("修改目标超出本工具权限。");
      if (
        c.target.type === "blueprint" &&
        ((set.kind === "blueprint" && c.target.node.level !== "section") ||
          (set.kind === "outline" &&
            (d.project.mode !== "novel" || c.target.node.level === "section")))
      )
        throw new Error("规划目标超出本工具权限。");
      if (
        c.target.type === "prose" &&
        c.target.operation !==
          (
            {
              opening: "opening",
              continue: "append",
              expand: "replace",
              polish: "selection",
            } as Record<string, string>
          )[set.kind]
      )
        throw new Error("正文写入动作与工具不匹配。");
      if (
        c.target.type === "memory-tune" &&
        ((c.target.operation === "disable" && !c.target.memoryIds.length) ||
          (c.target.operation === "add" &&
            (c.target.memoryIds.length !== 0 ||
              !c.target.chapterId ||
              !c.target.revisionId ||
              !c.target.kind)) ||
          (c.target.operation === "replace" &&
            (c.target.memoryIds.length === 0 ||
              !c.target.chapterId ||
              !c.target.revisionId ||
              !c.target.kind)))
      )
        throw new Error("记忆调优目标不完整。");
      if (c.targetBase !== fingerprint(currentTarget(d, c.target)))
        throw new Error("原目标已变化，请重新生成，避免覆盖后来的编辑。");
      if (
        set.mode === "explore" &&
        c.target.type === "prose" &&
        c.target.operation === "opening"
      ) {
        const chapterId = c.target.chapterId;
        const source = d.chapters.find(
          (ch) => ch.id === chapterId,
        )?.explorationSource;
        if (source) {
          const previous = d.chapters.find((ch) => ch.id === source.chapterId);
          if (
            !previous ||
            fingerprint(previous.document) !== source.sourceFingerprint ||
            source.basis !== explorationBasis(repo, projectId, previous.id)
          )
            throw new Error(
              "上一章正文或故事依据已变化，请更新走向后重新生成。",
            );
        }
      }
    }
    if (
      !inputs.length ||
      new Set(inputs.map((x) => x.id)).size !== inputs.length
    )
      throw new Error("请选择有效且不重复的修改。");
    const chosen = inputs.map((i) => {
      const c = set.changes.find((c) => c.id === i.id);
      if (!c || c.applied) throw new Error("修改不存在或已采用。");
      if (!i.after.trim() || i.after.length > 500000)
        throw new Error("修改内容为空或过长。");
      if (c.targetBase !== fingerprint(currentTarget(d, c.target)))
        throw new Error("原目标已变化，请重新生成，避免覆盖后来的编辑。");
      if (i.title !== undefined && c.afterTitle === undefined)
        throw new Error("这个目标不包含可编辑名称。");
      const title = i.title ?? c.afterTitle;
      if (title !== undefined && (!title.trim() || title.length > 500))
        throw new Error("目标名称无效。");
      return {
        ...c,
        after: i.after,
        ...(title !== undefined ? { afterTitle: title.trim() } : {}),
      };
    });
    repo.setSetting("review.snapshot." + randomUUID(), {
      projectId,
      createdAt: new Date().toISOString(),
      detail: d,
      changeSetId: id,
    });
    if (chosen.some((c) => c.target.type === "blueprint"))
      snapshotBlueprint(
        repo,
        projectId,
        set.kind === "outline" ? "outline" : "blueprint",
      );
    const checkpointed = new Set<string>();
    for (const c of chosen) {
      const t = c.target;
      if (t.type === "prose" || t.type === "title") {
        const ch = repo.getChapter(t.chapterId);
        if (ch.projectId !== projectId)
          throw new Error("目标章节不属于当前故事。");
        if (!checkpointed.has(ch.id)) {
          repo.checkpoint(ch.id, "采用 AI 修改前");
          checkpointed.add(ch.id);
        }
        if (t.type === "title") {
          if (c.after.length > 100 || /[\r\n\u0000-\u001f]/.test(c.after))
            throw new Error("章节名称无效。");
          repo.updateChapter(ch.id, { title: c.after });
        } else if (t.operation === "opening") {
          if (ch.content.trim()) throw new Error("开篇只能写入空章。");
          repo.updateChapter(ch.id, { document: textToDocument(c.after) });
        } else if (t.operation === "append")
          repo.updateChapter(ch.id, {
            document: appendDocument(ch.document, c.after),
          });
        else if (t.operation === "replace")
          repo.updateChapter(ch.id, { document: textToDocument(c.after) });
        else {
          if (!t.selection) throw new Error("缺少原选区。");
          repo.updateChapter(ch.id, {
            document: replaceSelection(ch.document, t.selection, c.after),
          });
        }
      } else if (t.type === "setting") {
        let card = repo
          .getDetail(projectId)
          .cards.find((x) => x.id === t.cardId);
        const isNew = !card;
        card = card ?? {
          id: t.cardId,
          projectId,
          kind: t.cardKind,
          name: t.name,
          description: "",
          constraints: "",
          sections: [],
          documents: [],
          referenceIds: [],
          updatedAt: "",
        };
        if (t.field === "section") {
          const found = card.sections.some((s) => s.id === t.sectionId);
          card.sections = found
            ? card.sections.map((s) =>
                s.id === t.sectionId
                  ? { ...s, title: c.afterTitle ?? s.title, content: c.after }
                  : s,
              )
            : [
                ...card.sections,
                {
                  id: t.sectionId!,
                  title: c.afterTitle ?? t.title ?? "新增分区",
                  content: c.after,
                  sourceIds: [],
                },
              ];
        } else card[t.field] = c.after;
        repo.saveCard(
          isNew ? { ...card, id: undefined } : card,
          isNew ? t.cardId : undefined,
        );
      } else if (t.type === "project-setting")
        repo.updateProject(projectId, { [t.field]: c.after });
      else if (t.type === "blueprint") {
        const p = repo.getProject(projectId),
          node = {
            ...t.node,
            title: c.afterTitle ?? t.node.title,
            content: c.after,
          };
        const nodes = p.blueprint.nodes.some((n) => n.id === node.id)
          ? p.blueprint.nodes.map((n) => (n.id === node.id ? node : n))
          : [...p.blueprint.nodes, node];
        validateBlueprint(
          { nodes },
          d.chapters.map((c) => c.id),
        );
        repo.updateProject(projectId, { blueprint: { nodes } });
      } else if (t.type === "memory-tune") {
        if (t.operation !== "add") {
          for (const memoryId of t.memoryIds) {
            const memory = repo
              .getDetail(projectId)
              .memories.find((item) => item.id === memoryId);
            if (!memory || !memory.active || memory.manual || !memory.chapterId)
              throw new Error("待调整记忆已停用或不属于章节记忆。");
            repo.db
              .prepare(
                "UPDATE memories SET active = 0, payload = ? WHERE id = ?",
              )
              .run(JSON.stringify({ ...memory, active: false }), memory.id);
          }
        }
        if (t.operation !== "disable") {
          const ch = repo.getChapter(t.chapterId!);
          if (
            ch.projectId !== projectId ||
            ch.acceptedRevisionId !== t.revisionId ||
            ch.needsReview
          )
            throw new Error("记忆来源版本已变化。");
          const memory = {
            id: randomUUID(),
            projectId,
            chapterId: ch.id,
            revisionId: t.revisionId!,
            kind: t.kind!,
            content: c.after,
            manual: false,
            active: true,
            createdAt: new Date().toISOString(),
          };
          repo.db
            .prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)")
            .run(
              memory.id,
              projectId,
              ch.id,
              memory.revisionId,
              1,
              JSON.stringify(memory),
            );
        }
      } else {
        const ch = repo.getChapter(t.chapterId);
        if (
          ch.projectId !== projectId ||
          ch.acceptedRevisionId !== t.revisionId ||
          ch.needsReview
        )
          throw new Error("记忆来源版本已变化。");
        const memory = {
          id: randomUUID(),
          projectId,
          chapterId: ch.id,
          revisionId: t.revisionId,
          kind: t.kind,
          content: c.after,
          manual: false,
          active: true,
          createdAt: new Date().toISOString(),
        };
        repo.db
          .prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            memory.id,
            projectId,
            ch.id,
            t.revisionId,
            1,
            JSON.stringify(memory),
          );
      }
      const stored = set.changes.find((x) => x.id === c.id)!;
      stored.after = c.after;
      if (c.afterTitle !== undefined) stored.afterTitle = c.afterTitle;
      stored.applied = true;
    }
    const updated = repo.getDetail(projectId);
    // Only our committed changes may advance remaining targets' baselines.
    for (const c of set.changes.filter((c) => !c.applied))
      c.targetBase = fingerprint(currentTarget(updated, c.target));
    set.basis = basis(repo, projectId);
    set.status = set.changes.every((c) => c.applied) ? "applied" : "partial";
    saveChangeSet(repo, set);
    if (
      chosen.some(
        (c) =>
          c.target.type === "blueprint" ||
          c.target.type === "setting" ||
          c.target.type === "project-setting",
      )
    ) {
      for (const ch of updated.chapters.filter((c) => c.content.trim())) {
        ch.planningReview = "故事依据已更新，请核对正文。";
        repo.db
          .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
          .run(JSON.stringify(ch), ch.id);
      }
    }
    return { detail: repo.getDetail(projectId), changeSet: set };
  })();
}
