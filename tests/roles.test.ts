import { describe, expect, it } from "vitest";
import { defaultRoleSettings, roleDefinitions, rolePrompt } from "../src/shared/roles";

describe("AI 职责输出契约", () => {
  it("每项职责都要求直接从任务产物开始", () => {
    const settings = defaultRoleSettings();
    for (const role of roleDefinitions)
      expect(rolePrompt(settings, role.id)).toContain("不要使用“收到”“好的”“以下是”“当然可以”等确认、寒暄或导语");
  });

  it("记忆与资料整理仍保留机器读取的 JSON 格式", () => {
    const settings = defaultRoleSettings();
    expect(rolePrompt(settings, "notes")).toContain('仅输出 JSON：{"records"');
    expect(rolePrompt(settings, "material")).toContain('仅输出 JSON：{"name"');
  });
});
