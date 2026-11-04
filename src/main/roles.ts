import type { StoryRepository } from "./database";
import type { RoleSettings } from "../shared/types";
import { defaultRoleSettings } from "../shared/roles";

export function roleSettings(repo: StoryRepository): RoleSettings {
  const defaults = defaultRoleSettings();
  const saved = repo.getSetting<Partial<RoleSettings>>("ai.roles", {});
  return {
    commonPrompt: saved.commonPrompt ?? defaults.commonPrompt,
    roles: defaults.roles.map((role) => {
      const override = saved.roles?.find((value) => value.id === role.id);
      return override ? { ...role, ...override } : role;
    }),
  };
}
