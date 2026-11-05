import type { BlueprintCandidate, BlueprintSection, Project } from "./types";

export const blueprintDefaults: Pick<BlueprintSection, "id" | "title">[] = [
  { id: "core-conflict", title: "核心冲突" },
  { id: "character-arcs", title: "角色弧线" },
  { id: "story-phases", title: "阶段推进" },
  { id: "foreshadowing", title: "伏笔" },
  { id: "open-questions", title: "待确认事项" },
];

export function defaultBlueprintSections(): BlueprintSection[] {
  return blueprintDefaults.map((section) => ({ ...section, content: "" }));
}

export function normalizeProject(project: Project): Project {
  const sections = Array.isArray(project.blueprintSections)
    ? project.blueprintSections.map((section) => ({ ...section }))
    : defaultBlueprintSections();
  const legacy = project.outline?.trim();
  if (legacy) {
    const existing = sections.find((section) => section.title === "整体蓝图");
    if (existing) {
      if (existing.content !== legacy && !existing.content.includes(legacy))
        existing.content = [existing.content.trim(), legacy].filter(Boolean).join("\n\n");
    } else {
      sections.unshift({ id: "legacy-outline", title: "整体蓝图", content: legacy });
    }
  }
  return {
    ...project,
    outline: "",
    blueprintSections: sections,
    blueprintCandidates: project.blueprintCandidates || [],
  };
}

export function appendCandidate(
  sections: BlueprintSection[],
  candidate: BlueprintCandidate,
  sectionId: string,
): BlueprintSection[] {
  return applyBlueprintContent(sections, sectionId, candidate.content, "append");
}

export function applyBlueprintContent(
  sections: BlueprintSection[],
  sectionId: string,
  content: string,
  mode: "append" | "replace",
): BlueprintSection[] {
  return sections.map((section) =>
    section.id === sectionId
      ? {
          ...section,
          content: mode === "replace"
            ? content
            : [section.content.trim(), content.trim()].filter(Boolean).join("\n\n"),
        }
      : section,
  );
}
