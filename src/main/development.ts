import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  Card,
  DevelopmentChange,
  ProjectDetail,
  StoryDevelopmentDraft,
} from "../shared/types";
import {
  developmentContentSchema,
  developmentDraftSchema,
} from "../shared/development";
import { materialLimits } from "../shared/materials";

export interface DevelopmentSnapshot {
  detail: ProjectDetail;
  sources: { revisionId: string; title: string; content: string }[];
}

export function buildDevelopmentContext(
  repo: StoryRepository,
  detail: ProjectDetail,
) {
  const eligible = detail.chapters.filter(
    (chapter) => chapter.acceptedRevisionId && !chapter.needsReview,
  );
  const chapters = eligible.slice(-60);
  const budget = Math.min(
    6000,
    Math.floor(36000 / Math.max(1, chapters.length)),
  );
  const sources = chapters.map((chapter) => {
    const revision = repo.getRevision(chapter.acceptedRevisionId!);
    const content =
      revision.content.length <= budget
        ? revision.content
        : `${revision.content.slice(0, Math.floor(budget / 2))}\n[中段省略，不能据此推断未提供内容]\n${revision.content.slice(-Math.floor(budget / 2))}`;
    return { revisionId: revision.id, title: revision.title, content };
  });
  const registry = {
    blueprint: detail.project.blueprintSections.map((section) => ({
      id: section.id,
      title: section.title,
    })),
    cards: detail.cards.map((card) => ({
      id: card.id,
      kind: card.kind,
      name: card.name,
      sections: card.sections.map((section) => ({
        id: section.id,
        title: section.title,
      })),
    })),
  };
  const drafts = detail.chapters
    .filter((chapter) => chapter.dirty && chapter.content.trim())
    .slice(-6)
    .map(
      (chapter) =>
        `【草稿：${chapter.title}，未作为已采用正文证据】\n${chapter.content.slice(-2000)}`,
    )
    .join("\n\n");
  return {
    snapshot: { detail, sources } satisfies DevelopmentSnapshot,
    text: `【可更新的蓝图与资料分区 ID】\n${JSON.stringify(registry)}\n\n【设定提炼的正文来源：已采用版本，含当前章，不含未采用修改】\n${eligible.length > chapters.length ? `较早的 ${eligible.length - chapters.length} 章未装入全文，仅参考有效记忆；不得声称已检查整本。\n` : ""}${sources.map((source) => `【${source.title}｜revisionId=${source.revisionId}】\n${source.content}`).join("\n\n") || "暂无已采用正文。可以从作者想法构思，但所有新增内容标为 proposal。"}${drafts ? `\n\n【未采用草稿，可帮助发展设定，只能作为 proposal，不能引用为已采用事实】\n${drafts}` : ""}`,
  };
}

function baseForChange(
  detail: ProjectDetail,
  change: Pick<DevelopmentChange, "target" | "targetId" | "sectionId">,
): string | null {
  if (change.target === "blueprint") {
    if (change.sectionId) throw new Error("蓝图使用 targetId 定位分区。");
    if (!change.targetId) return null;
    const section = detail.project.blueprintSections.find(
      (item) => item.id === change.targetId,
    );
    if (!section) throw new Error("目标蓝图分区不存在。");
    return fingerprint(section);
  }
  if (!change.targetId) {
    if (change.sectionId) throw new Error("新增资料不能引用已有分区。");
    return null;
  }
  const card = detail.cards.find(
    (item) => item.id === change.targetId && item.kind === change.target,
  );
  if (!card) throw new Error("目标资料不属于当前故事，或类型不符。");
  if (
    change.sectionId &&
    !card.sections.some((item) => item.id === change.sectionId)
  )
    throw new Error("目标资料分区不存在。");
  // Include the whole card so later rule edits cannot be silently overwritten by an old proposal.
  return fingerprint({ ...card, updatedAt: "" });
}

export function parseDevelopment(
  text: string,
  snapshot: DevelopmentSnapshot,
): StoryDevelopmentDraft {
  try {
    const parsed = z
      .object({
        summary: z.string().max(4000),
        changes: z.array(developmentContentSchema).min(1).max(30),
        warnings: z.array(z.string().max(2000)).max(20).default([]),
      })
      .parse(
        JSON.parse(
          text
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, ""),
        ),
      );
    const targets = new Set<string>();
    const changes = parsed.changes.map((value) => {
      if (value.target !== "blueprint" && !value.name)
        throw new Error("资料名称不能为空。");
      const key = `${value.target}:${value.targetId || value.name}:${value.sectionId || (value.target === "blueprint" && value.targetId ? "" : value.title)}`;
      if (targets.has(key)) throw new Error("同一分区出现多次。");
      targets.add(key);
      if (value.basis === "established" && !value.sources.length)
        throw new Error("提炼内容缺少正文证据。");
      for (const source of value.sources) {
        const original = snapshot.sources.find(
          (item) => item.revisionId === source.revisionId,
        );
        if (!original || !original.content.includes(source.quote))
          throw new Error("正文引用无法核对。");
      }
      return {
        ...value,
        id: randomUUID(),
        base: baseForChange(snapshot.detail, value),
      };
    });
    return {
      id: randomUUID(),
      projectId: snapshot.detail.project.id,
      summary: parsed.summary,
      changes,
      warnings: parsed.warnings,
      appliedIds: [],
    };
  } catch (error) {
    throw new Error(
      `设定与蓝图结果无法应用：${error instanceof Error && !(error instanceof z.ZodError) && !(error instanceof SyntaxError) ? error.message : "模型返回的结构格式不正确。"}原有内容未修改，可重试或调整此职责。`,
    );
  }
}

interface DevelopmentUndo {
  id: string;
  blueprintBefore: ProjectDetail["project"]["blueprintSections"];
  blueprintAfter: ProjectDetail["project"]["blueprintSections"];
  blueprintChanged: boolean;
  cardsBefore: Card[];
  cardsAfter: Card[];
  draftBefore: StoryDevelopmentDraft;
  appliedBefore: string[];
}

export function applyDevelopment(
  repo: StoryRepository,
  projectId: string,
  input: StoryDevelopmentDraft,
  selectedIds: string[],
) {
  const draft = developmentDraftSchema.parse(input);
  if (draft.projectId !== projectId) throw new Error("方案不属于当前故事。");
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length)
    throw new Error("请选择要采用的分区。");
  const selected = selectedIds.map((id) => {
    const change = draft.changes.find((item) => item.id === id);
    if (!change || draft.appliedIds.includes(id))
      throw new Error("分区不存在或已采用。");
    return change;
  });
  return repo.db.transaction(() => {
    const detail = repo.getDetail(projectId);
    const ledgerKey = `development.applied.${projectId}.${draft.id}`;
    const previous = repo.getSetting<string[]>(ledgerKey, []);
    if (selectedIds.some((id) => previous.includes(id)))
      throw new Error("这些分区已经采用，请勿重复写入。");
    for (const change of selected) {
      if (baseForChange(detail, change) !== change.base)
        throw new Error(
          "相关蓝图或资料已修改，请重新生成建议，保留你后来的编辑。",
        );
      if (change.basis === "established" && !change.sources.length)
        throw new Error("提炼内容缺少正文证据。");
      for (const source of change.sources) {
        const revision = repo.getRevision(source.revisionId);
        const chapter = detail.chapters.find(
          (item) => item.id === revision.chapterId,
        );
        if (
          !chapter ||
          chapter.needsReview ||
          chapter.acceptedRevisionId !== revision.id ||
          !revision.content.includes(source.quote)
        )
          throw new Error("引用的采用版本已变化，请重新提炼设定。");
      }
    }
    const blueprintBefore = structuredClone(detail.project.blueprintSections);
    let sections = structuredClone(blueprintBefore);
    const cards = new Map<string, Card>();
    const cardsBefore = new Map<string, Card>();
    const newCards = new Map<string, Card>();
    for (const change of selected) {
      if (change.target === "blueprint") {
        const section = sections.find((item) => item.id === change.targetId);
        if (section) {
          section.content =
            change.mode === "replace"
              ? change.content
              : joinContent(section.content, change.content);
        } else {
          if (sections.some((item) => item.title === change.title))
            throw new Error(
              `蓝图已有「${change.title}」，请重新生成并定位已有分区。`,
            );
          sections.push({
            id: randomUUID(),
            title: change.title,
            content: change.content,
          });
        }
        continue;
      }
      let card: Card;
      if (change.targetId) {
        const original = detail.cards.find(
          (item) => item.id === change.targetId,
        )!;
        cardsBefore.set(original.id, original);
        card = cards.get(original.id) ?? structuredClone(original);
      } else {
        const key = `${change.target}:${change.name}`;
        if (
          detail.cards.some(
            (item) => item.kind === change.target && item.name === change.name,
          )
        )
          throw new Error(
            `已有资料「${change.name}」，请重新生成并定位已有资料。`,
          );
        card = newCards.get(key) ?? {
          id: randomUUID(),
          projectId,
          kind: change.target,
          name: change.name,
          description: "",
          constraints: "",
          sections: [],
          documents: [],
          referenceIds: [],
          updatedAt: "",
        };
        newCards.set(key, card);
      }
      const section = card.sections.find(
        (item) => item.id === change.sectionId,
      );
      if (section)
        section.content =
          change.mode === "replace"
            ? change.content
            : joinContent(section.content, change.content);
      else {
        if (card.sections.some((item) => item.title === change.title))
          throw new Error(
            `「${card.name}」已有「${change.title}」分区，请重新生成并定位已有分区。`,
          );
        card.sections.push({
          id: randomUUID(),
          title: change.title,
          content: change.content,
          alwaysInclude: true,
          sourceIds: [],
        });
      }
      if (card.sections.length > materialLimits.sections)
        throw new Error("资料分区已满，请合并已有分区后再完善。");
      cards.set(card.id, card);
    }
    if (sections.length > 50)
      throw new Error("蓝图最多包含 50 个分区，请先合并部分内容。");
    // Keep content changes and their undo record in the same SQLite transaction.
    const cardsAfter = [...cards.values()].map((card) => {
      if (cardsBefore.has(card.id)) return repo.saveCard(card);
      // saveCard checks existing IDs; newly allocated cards are inserted first without an ID.
      return repo.saveCard({ ...card, id: undefined });
    });
    const blueprintChanged = selected.some(
      (change) => change.target === "blueprint",
    );
    if (blueprintChanged)
      repo.updateProject(projectId, { blueprintSections: sections });
    const undo: DevelopmentUndo = {
      id: randomUUID(),
      blueprintBefore,
      blueprintAfter: sections,
      blueprintChanged,
      cardsBefore: [...cardsBefore.values()],
      cardsAfter,
      draftBefore: draft,
      appliedBefore: previous,
    };
    repo.setSetting(`development.undo.${projectId}`, undo);
    const appliedIds = [
      ...new Set([...previous, ...draft.appliedIds, ...selectedIds]),
    ];
    repo.setSetting(ledgerKey, appliedIds);
    const after = repo.getDetail(projectId);
    const updated: StoryDevelopmentDraft = {
      ...draft,
      appliedIds,
      // Unselected changes may share a card with selected ones; rebase them for later adoption.
      changes: draft.changes.map((change) => {
        if (appliedIds.includes(change.id) || change.target === "blueprint")
          return change;
        if (cardsBefore.has(change.targetId))
          return { ...change, base: baseForChange(after, change) };
        if (
          !change.targetId &&
          newCards.has(`${change.target}:${change.name}`)
        ) {
          const card = cardsAfter.find(
            (item) => item.kind === change.target && item.name === change.name,
          )!;
          const rebased = { ...change, targetId: card.id };
          return { ...rebased, base: baseForChange(after, rebased) };
        }
        return change;
      }),
    };
    const candidates = repo
      .getProject(projectId)
      .blueprintCandidates.map((candidate) =>
        candidate.development?.id === draft.id
          ? { ...candidate, development: updated }
          : candidate,
      );
    repo.updateProject(projectId, { blueprintCandidates: candidates });
    return {
      detail: repo.getDetail(projectId),
      draft: updated,
      undoId: undo.id,
    };
  })();
}

export function undoDevelopment(
  repo: StoryRepository,
  projectId: string,
  undoId: string,
) {
  return repo.db.transaction(() => {
    const undo = repo.getSetting<DevelopmentUndo | null>(
      `development.undo.${projectId}`,
      null,
    );
    if (!undo || undo.id !== undoId)
      throw new Error("没有可撤销的本次设定更新。");
    const detail = repo.getDetail(projectId);
    if (
      undo.blueprintChanged &&
      JSON.stringify(detail.project.blueprintSections) !==
        JSON.stringify(undo.blueprintAfter)
    )
      throw new Error("蓝图已有后续编辑，请手动调整以保留这些修改。");
    for (const card of undo.cardsAfter)
      if (
        JSON.stringify(detail.cards.find((item) => item.id === card.id)) !==
        JSON.stringify(card)
      )
        throw new Error("资料已有后续编辑，请手动调整以保留这些修改。");
    if (undo.blueprintChanged)
      repo.updateProject(projectId, {
        blueprintSections: undo.blueprintBefore,
      });
    for (const card of undo.cardsAfter) {
      const before = undo.cardsBefore.find((item) => item.id === card.id);
      if (before) repo.saveCard(before);
      else repo.deleteCard(card.id);
    }
    repo.setSetting(`development.undo.${projectId}`, null);
    repo.setSetting(
      `development.applied.${projectId}.${undo.draftBefore.id}`,
      undo.appliedBefore,
    );
    repo.updateProject(projectId, {
      blueprintCandidates: repo
        .getProject(projectId)
        .blueprintCandidates.map((candidate) =>
          candidate.development?.id === undo.draftBefore.id
            ? { ...candidate, development: undo.draftBefore }
            : candidate,
        ),
    });
    return { detail: repo.getDetail(projectId), draft: undo.draftBefore };
  })();
}

function joinContent(before: string, after: string): string {
  return before.trim() === after.trim()
    ? before
    : [before.trim(), after.trim()].filter(Boolean).join("\n\n");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
