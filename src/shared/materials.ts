import type { Card, CardInput, MaterialDraft } from "./types";

export const materialLimits = {
  document: 200_000,
  card: 400_000,
  organize: 60_000,
  documents: 12,
  sections: 50,
};
export function normalizeCard(card: Card): Card {
  return {
    ...card,
    sections: card.sections ?? [],
    documents: card.documents ?? [],
  };
}
export function materialLength(
  card: Pick<
    CardInput,
    "description" | "constraints" | "sections" | "documents"
  >,
) {
  return (
    card.description.length +
    card.constraints.length +
    (card.sections ?? []).reduce(
      (sum, section) => sum + section.content.length + section.title.length,
      0,
    ) +
    (card.documents ?? []).reduce((sum, doc) => sum + doc.content.length, 0)
  );
}
export function applyMaterialDraft(
  card: CardInput,
  draft: MaterialDraft,
  append: boolean,
  createId: () => string,
): CardInput {
  const join = (a: string, b: string) =>
    !a.trim() ? b : !b.trim() || a.trim() === b.trim() ? a : a + "\n\n" + b;
  return {
    ...card,
    name: card.name.trim() ? card.name : draft.name,
    description: append
      ? join(card.description, draft.description)
      : draft.description,
    constraints: append
      ? join(card.constraints, draft.constraints)
      : draft.constraints,
    sections: [
      ...(append ? (card.sections ?? []) : []),
      ...draft.sections.map((section) => ({
        ...section,
        sourceIds: [...section.sourceIds],
        id: createId(),
      })),
    ],
  };
}
