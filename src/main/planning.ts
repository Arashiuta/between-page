import { z } from "zod";
import type { StoryRepository } from "./database";
import type { BlueprintNode, Chapter, Project } from "../shared/types";
import {
  inPlanningDomain,
  validateBlueprint,
  relocateOutline,
} from "../shared/blueprint";
import { blueprintNodeSchema } from "../shared/requests";
import { fingerprint } from "./context";
import { snapshotBlueprint, type BlueprintVersion } from "./blueprint-history";

const id = z.string().uuid();
const target = z.object({ projectId: id, id }).strict();

export function planningHandlers(
  repo: StoryRepository,
): Record<string, (p: any) => unknown> {
  const handlers: Record<string, (p: any) => unknown> = {};
  for (const domain of ["blueprint", "outline"] as const) {
    const label = domain === "blueprint" ? "额外设定" : "大纲";
    const project = (pid: string) => {
      const p = repo.getProject(pid);
      if (domain === "outline" && p.mode !== "novel")
        throw new Error("请切换到长篇模式使用大纲规划。");
      return p;
    };
    const check = (n: BlueprintNode | undefined) => {
      if (!n || !inPlanningDomain(n, domain))
        throw new Error(`目标不属于${label}。`);
      return n;
    };
    const commit = (p: Project, nodes: BlueprintNode[]) => {
      validateBlueprint(
        { nodes },
        repo.getDetail(p.id).chapters.map((c) => c.id),
      );
      snapshotBlueprint(repo, p.id, domain);
      return repo.updateProject(p.id, { blueprint: { nodes } });
    };
    handlers[`${domain}:save`] = (input) =>
      repo.db.transaction(() => {
        const v = z
          .object({
            projectId: id,
            node: blueprintNodeSchema,
            base: blueprintNodeSchema.nullable(),
          })
          .strict()
          .parse(input);
        const p = project(v.projectId),
          old = p.blueprint.nodes.find((n) => n.id === v.node.id);
        check(v.node);
        if (old) {
          check(old);
          if (old.level !== v.node.level)
            throw new Error("已有节点不能更改层级。");
        }
        if (
          (old ? fingerprint(old) : null) !==
          (v.base ? fingerprint(v.base) : null)
        )
          throw new Error(`${label}已被其他操作修改，请刷新后重试。`);
        return commit(
          p,
          old
            ? p.blueprint.nodes.map((n) => (n.id === old.id ? v.node : n))
            : [...p.blueprint.nodes, v.node],
        );
      })();
    handlers[`${domain}:remove`] = (input) =>
      repo.db.transaction(() => {
        const v = target.parse(input),
          p = project(v.projectId);
        check(p.blueprint.nodes.find((n) => n.id === v.id));
        const ids = new Set([v.id]);
        for (let i = 0; i < p.blueprint.nodes.length; i++)
          for (const n of p.blueprint.nodes)
            if (n.parentId && ids.has(n.parentId)) ids.add(n.id);
        return commit(
          p,
          p.blueprint.nodes.filter((n) => !ids.has(n.id)),
        );
      })();
    handlers[`${domain}:move`] = (input) =>
      repo.db.transaction(() => {
        const v = target
          .extend({ step: z.union([z.literal(-1), z.literal(1)]) })
          .parse(input);
        const p = project(v.projectId),
          nodes = [...p.blueprint.nodes],
          a = nodes.findIndex((n) => n.id === v.id);
        const n = check(nodes[a]);
        const siblings = nodes.filter(
          (x) =>
            inPlanningDomain(x, domain) &&
            x.parentId === n.parentId &&
            x.level === n.level,
        );
        const next =
          siblings[siblings.findIndex((x) => x.id === n.id) + v.step];
        if (!next) return p;
        const b = nodes.findIndex((x) => x.id === next.id);
        [nodes[a], nodes[b]] = [nodes[b], nodes[a]];
        return commit(p, nodes);
      })();
    handlers[`${domain}:history`] = (input) => {
      const pid = id.parse(input);
      project(pid);
      // Old snapshots contain both domains. Their views and restores remain domain-scoped.
      return repo
        .getSetting<BlueprintVersion[]>("blueprint.history." + pid, [])
        .filter((v) => !v.domain || v.domain === domain)
        .map((v) => ({
          ...v,
          blueprint: {
            nodes: v.blueprint.nodes.filter((n) => inPlanningDomain(n, domain)),
          },
        }));
    };
    handlers[`${domain}:restore`] = (input) =>
      repo.db.transaction(() => {
        const v = target.parse(input),
          p = project(v.projectId);
        const version = repo
          .getSetting<BlueprintVersion[]>("blueprint.history." + p.id, [])
          .find((x) => x.id === v.id && (!x.domain || x.domain === domain));
        if (!version) throw new Error(`${label}版本不存在。`);
        const chapterIds = new Set(
          repo.getDetail(p.id).chapters.map((c) => c.id),
        );
        const restored = version.blueprint.nodes
          .filter((n) => inPlanningDomain(n, domain))
          .map((n) => ({
            ...n,
            chapterId: chapterIds.has(n.chapterId!) ? n.chapterId : null,
          }));
        return commit(p, [
          ...p.blueprint.nodes.filter((n) => !inPlanningDomain(n, domain)),
          ...restored,
        ]);
      })();
  }
  handlers["outline:relocate"] = (input) =>
    repo.db.transaction(() => {
      const v = target
        .extend({
          targetId: id,
          position: z.enum(["before", "inside", "after"]),
        })
        .parse(input);
      const p = repo.getProject(v.projectId);
      if (p.mode !== "novel") throw new Error("请切换到长篇模式使用大纲规划。");
      const nodes = relocateOutline(
        p.blueprint.nodes,
        v.id,
        v.targetId,
        v.position,
      );
      if (nodes === p.blueprint.nodes) return p;
      validateBlueprint(
        { nodes },
        repo.getDetail(p.id).chapters.map((c) => c.id),
      );
      snapshotBlueprint(repo, p.id, "outline");
      return repo.updateProject(p.id, { blueprint: { nodes } });
    })();
  handlers["outline:create-chapter"] = (input) =>
    repo.db.transaction(() => {
      const v = target.parse(input),
        p = repo.getProject(v.projectId);
      if (p.mode !== "novel") throw new Error("请切换到长篇模式。");
      const node = p.blueprint.nodes.find(
        (n) => n.id === v.id && n.level === "chapter",
      );
      if (!node) throw new Error("章纲不存在。");
      if (node.chapterId) return repo.getChapter(node.chapterId);
      const chapter: Chapter = repo.createChapter(p.id);
      repo.updateChapter(chapter.id, { title: node.title });
      snapshotBlueprint(repo, p.id, "outline");
      repo.updateProject(p.id, {
        blueprint: {
          nodes: p.blueprint.nodes.map((n) =>
            n.id === node.id ? { ...n, chapterId: chapter.id } : n,
          ),
        },
      });
      return repo.getChapter(chapter.id);
    })();
  return handlers;
}
