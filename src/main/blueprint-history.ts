import { randomUUID } from "node:crypto";
import type { StoryRepository } from "./database";
import type { Blueprint } from "../shared/types";
import type { PlanningDomain } from "../shared/blueprint";

export interface BlueprintVersion {
  id: string;
  createdAt: string;
  blueprint: Blueprint;
  domain?: PlanningDomain;
}

// Call inside the same transaction as the blueprint update.
export function snapshotBlueprint(
  repo: StoryRepository,
  projectId: string,
  domain: PlanningDomain = "blueprint",
) {
  const project = repo.getProject(projectId);
  repo.setSetting("blueprint.history." + projectId, [
    {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      blueprint: project.blueprint,
      domain,
    },
    ...repo.getSetting<BlueprintVersion[]>(
      "blueprint.history." + projectId,
      [],
    ),
  ]);
}
