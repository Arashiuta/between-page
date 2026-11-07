import { z } from "zod";
import type { StoryRepository } from "./database";
import { conversationHandlers } from "./conversations";
import { applyChangeSet, getChangeSet, listChangeSets } from "./changes";
import { planningHandlers } from "./planning";
import { explorationHandlers } from "./exploration";
import { reorderChapters } from "./writing";
import type { DocumentNode } from "../shared/types";
import { storySchema } from "../shared/editor-schema";
import { memoryKinds } from "../shared/types";
const id = z.string().uuid(),
  text = z.string().max(500000),
  short = z.string().trim().min(1).max(500);
const document: z.ZodType<DocumentNode> = z.lazy(() =>
  z
    .object({
      type: z.string().max(40),
      text: text.optional(),
      content: z.array(document).max(10000).optional(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      marks: z
        .array(
          z.object({
            type: z.string(),
            attrs: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    })
    .strict(),
);
export function workspaceHandlers(
  repo: StoryRepository,
): Record<string, (p: any) => unknown> {
  return {
    ...conversationHandlers(repo),
    ...planningHandlers(repo),
    ...explorationHandlers(repo),
    "project:get": (p) => repo.getDetail(id.parse(p)),
    "project:update": (p) => {
      const { id: pid, ...patch } = z
        .object({
          id,
          title: short.optional(),
          premise: text.optional(),
          genre: z.string().max(500).optional(),
          world: text.optional(),
          style: text.optional(),
          mode: z.enum(["novel", "explore"]).optional(),
          creativeFreedom: z.enum(["guided", "balanced", "free"]).optional(),
          archived: z.boolean().optional(),
        })
        .strict()
        .parse(p);
      return repo.updateProject(pid, patch);
    },
    "chapter:create": (p) => repo.createChapter(id.parse(p)),
    "chapter:update": (p) => {
      const { id: cid, ...patch } = z
        .object({ id, title: short.optional(), document: document.optional() })
        .strict()
        .parse(p);
      if (patch.document) storySchema.nodeFromJSON(patch.document).check();
      return repo.updateChapter(cid, patch);
    },
    "chapter:delete": (p) => {
      const v = z.object({ projectId: id, id }).strict().parse(p);
      if (repo.getChapter(v.id).projectId !== v.projectId)
        throw new Error("章节不属于当前故事。");
      return repo.deleteChapter(v.id);
    },
    "chapter:adopt": (p) => repo.adoptChapter(id.parse(p)),
    "chapter:checkpoint": (p) => {
      const v = z.object({ id, label: short.optional() }).parse(p);
      return repo.checkpoint(v.id, v.label);
    },
    "chapter:revisions": (p) => repo.listRevisions(id.parse(p)),
    "chapter:restore": (p) => repo.restoreRevision(id.parse(p)),
    "chapter:reorder": (p) => {
      const v = z
        .object({ projectId: id, ids: z.array(id) })
        .strict()
        .parse(p);
      return reorderChapters(repo, v.projectId, v.ids);
    },
    "chapter:acknowledge": (p) => {
      const c = repo.getChapter(id.parse(p));
      delete c.planningReview;
      repo.db
        .prepare("UPDATE chapters SET payload = ? WHERE id = ?")
        .run(JSON.stringify(c), c.id);
      return c;
    },
    "revision:usage": (p) =>
      repo.revisionUsage(id.parse(p.projectId), id.parse(p.id)),
    "revision:update": (p) =>
      repo.manageRevision(
        id.parse(p.projectId),
        id.parse(p.id),
        short.parse(p.label),
      ),
    "revision:delete": (p) =>
      repo.manageRevision(id.parse(p.projectId), id.parse(p.id)),
    "card:save": (p) => {
      const v = z
        .object({
          id: id.optional(),
          projectId: id.nullable(),
          kind: z.enum(["character", "world", "inspiration"]),
          name: short,
          description: text,
          constraints: text,
          sections: z
            .array(
              z
                .object({
                  id,
                  title: short,
                  content: text,
                  sourceIds: z.array(id),
                })
                .strict(),
            )
            .max(50)
            .default([]),
          documents: z
            .array(
              z
                .object({
                  id,
                  name: short,
                  content: z.string().max(200000),
                  enabled: z.boolean(),
                })
                .strict(),
            )
            .max(12)
            .default([]),
          referenceIds: z.array(id).max(12),
        })
        .strict()
        .parse(p);
      for (const ref of v.referenceIds) {
        const i = repo.getImage(ref);
        if (i.kind === "cover") throw new Error("封面不能作为设定参考图。");
      }
      return repo.saveCard(v);
    },
    "card:copy": (p) =>
      repo.copyCard(id.parse(p.id), id.nullable().parse(p.projectId)),
    "card:delete": (p) => repo.deleteCard(id.parse(p)),
    "memory:add": (p) =>
      repo.addMemory(
        id.parse(p.projectId),
        z
          .enum([
            "fact",
            "state",
            "relationship",
            "knowledge",
            "foreshadow",
            "summary",
          ])
          .parse(p.kind),
        text.trim().min(1).parse(p.content),
      ),
    "memory:toggle": (p) =>
      repo.setMemoryActive(id.parse(p.id), z.boolean().parse(p.active)),
    "memory:update": (p) => {
      const {
        projectId,
        id: memoryId,
        ...patch
      } = z
        .object({
          projectId: id,
          id,
          kind: z.enum(memoryKinds),
          content: text.trim().min(1).max(200000),
        })
        .strict()
        .parse(p);
      return repo.updateMemory(projectId, memoryId, patch);
    },
    "memory:delete": (p) =>
      repo.deleteMemory(id.parse(p.projectId), id.parse(p.id)),
    "changes:list": (p) => listChangeSets(repo, id.parse(p)),
    "changes:get": (p) =>
      getChangeSet(repo, id.parse(p.projectId), id.parse(p.id)),
    "changes:apply": (p) => {
      const v = z
        .object({
          projectId: id,
          id,
          changes: z
            .array(
              z.object({ id, after: text, title: short.optional() }).strict(),
            )
            .min(1),
        })
        .strict()
        .parse(p);
      return applyChangeSet(repo, v.projectId, v.id, v.changes);
    },
    "changes:delete": (p) => {
      const s = getChangeSet(repo, id.parse(p.projectId), id.parse(p.id));
      repo.db.prepare("DELETE FROM change_sets WHERE id = ?").run(s.id);
      return true;
    },
    "ui:get": (p) => {
      repo.getProject(id.parse(p.projectId));
      return repo.getSetting(
        "ui." + p.projectId + "." + short.parse(p.key),
        null,
      );
    },
    "ui:save": (p) => {
      repo.getProject(id.parse(p.projectId));
      if (JSON.stringify(p.value).length > 1000000)
        throw new Error("暂存内容过长。");
      repo.setSetting("ui." + p.projectId + "." + short.parse(p.key), p.value);
      return true;
    },
  };
}
