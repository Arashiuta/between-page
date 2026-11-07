import { randomUUID } from "node:crypto";
import type { StoryRepository } from "./database";
import type { Blueprint } from "../shared/types";

export interface BlueprintVersion {
  id: string;
  createdAt: string;
  blueprint: Blueprint;
}

// Call inside the same transaction as the blueprint update.
export function snapshotBlueprint(repo: StoryRepository, projectId: string) {
  const project = repo.getProject(projectId);
  repo.setSetting("blueprint.history." + projectId, [
    {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      blueprint: project.blueprint,
    },
    ...repo.getSetting<BlueprintVersion[]>(
      "blueprint.history." + projectId,
      [],
    ),
  ]);
}
