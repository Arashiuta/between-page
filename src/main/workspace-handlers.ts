import { z } from "zod";
import type { StoryRepository } from "./database";
import { conversationHandlers } from "./conversations";
import { applyChangeSet, getChangeSet, listChangeSets } from "./changes";
import { blueprintNodeSchema } from "../shared/requests";
import { validateBlueprint } from "../shared/blueprint";
import { fingerprint } from "./context";
import { reorderChapters } from "./writing";
import type { DocumentNode, Project } from "../shared/types";
import { storySchema } from "../shared/editor-schema";
import { snapshotBlueprint } from "./blueprint-history";
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
  const blueprintCommit = (pid: string, nodes: Project["blueprint"]["nodes"]) =>
    repo.db.transaction(() => {
      validateBlueprint(
        { nodes },
        repo.getDetail(pid).chapters.map((c) => c.id),
      );
      snapshotBlueprint(repo, pid);
      return repo.updateProject(pid, { blueprint: { nodes } });
    })();
  return {
    ...conversationHandlers(repo),
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
    "blueprint:save": (p) => {
      const v = z
        .object({
          projectId: id,
          node: blueprintNodeSchema,
          base: blueprintNodeSchema.nullable(),
        })
        .strict()
        .parse(p);
      return repo.db.transaction(() => {
        const pr = repo.getProject(v.projectId),
          old = pr.blueprint.nodes.find((n) => n.id === v.node.id);
        if (
          (old ? fingerprint(old) : null) !==
          (v.base ? fingerprint(v.base) : null)
        )
          throw new Error("蓝图已被其他操作修改，请刷新后重试。");
        return blueprintCommit(
          pr.id,
          old
            ? pr.blueprint.nodes.map((n) => (n.id === v.node.id ? v.node : n))
            : [...pr.blueprint.nodes, v.node],
        );
      })();
    },
    "blueprint:remove": (p) => {
      const pr = repo.getProject(id.parse(p.projectId)),
        nodeId = id.parse(p.id),
        ids = new Set([nodeId]);
      for (let i = 0; i < pr.blueprint.nodes.length; i++)
        for (const n of pr.blueprint.nodes)
          if (n.parentId && ids.has(n.parentId)) ids.add(n.id);
      return blueprintCommit(
        pr.id,
        pr.blueprint.nodes.filter((n) => !ids.has(n.id)),
      );
    },
    "blueprint:move": (p) => {
      const pr = repo.getProject(id.parse(p.projectId)),
        a = pr.blueprint.nodes.findIndex((n) => n.id === p.id),
        step = z.union([z.literal(-1), z.literal(1)]).parse(p.step);
      if (a < 0) throw new Error("蓝图节点不存在。");
      const nodes = [...pr.blueprint.nodes];
      let b = a + step;
      while (
        b >= 0 &&
        b < nodes.length &&
        nodes[b].parentId !== nodes[a].parentId
      )
        b += step;
      if (b < 0 || b >= nodes.length) return pr;
      [nodes[a], nodes[b]] = [nodes[b], nodes[a]];
      return blueprintCommit(pr.id, nodes);
    },
    "blueprint:history": (p) =>
      repo.getSetting("blueprint.history." + id.parse(p), []),
    "blueprint:restore": (p) => {
      const pid = id.parse(p.projectId),
        version = repo
          .getSetting<any[]>("blueprint.history." + pid, [])
          .find((v) => v.id === p.id);
      if (!version) throw new Error("蓝图版本不存在。");
      const ids = new Set(repo.getDetail(pid).chapters.map((c) => c.id));
      return blueprintCommit(
        pid,
        version.blueprint.nodes.map((n: any) => ({
          ...n,
          chapterId: ids.has(n.chapterId) ? n.chapterId : null,
        })),
      );
    },
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
