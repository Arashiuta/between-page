import type { Card, CardInput } from "./types";
export const materialLimits = {
  document: 200_000,
  card: 400_000,
  documents: 12,
  sections: 50,
};
export const referenceImageLimits = {
  maxEdge: 2048,
  perImageBytes: 1_000_000,
  totalBytes: 3_000_000,
};
export const normalizeCard = (card: Card): Card => card;
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
      (n, s) => n + s.title.length + s.content.length,
      0,
    ) +
    (card.documents ?? []).reduce((n, d) => n + d.content.length, 0)
  );
}
