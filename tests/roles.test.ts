import { describe, it, expect } from "vitest";
import {
  defaultRoleSettings,
  rolePrompt,
  foundationPolicy,
} from "../src/shared/roles";
import { modeTools } from "../src/shared/tools";
import { taskKinds } from "../src/shared/types";
describe("职责与模式规则", () => {
  it.each(taskKinds)("%s 自定义要求之后仍有不可省略的故事依据规则", (kind) => {
    const roles = defaultRoleSettings();
    roles.commonPrompt = "自定义";
    roles.roles.find((r) => r.id === kind)!.prompt = "作者工作要求";
    const p = rolePrompt(roles, kind);
    expect(p).toContain("作者工作要求");
    expect(p.endsWith(foundationPolicy)).toBe(true);
  });
  it.each(taskKinds)("%s 在两种模式有不同工作要求", (kind) =>
    expect(modeTools.explore.prompts[kind]).not.toBe(
      modeTools.novel.prompts[kind],
    ),
  );
});
