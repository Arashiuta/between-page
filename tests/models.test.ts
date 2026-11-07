import { describe, expect, it } from "vitest";
import { modelSelection, resolveTextModel } from "../src/shared/models";
import { defaultRoleSettings } from "../src/shared/roles";
import type { ProviderConfig } from "../src/shared/types";
describe("已选模型", () => {
  it("创作请求选定模型优先于职责与默认模型，并拒绝已移除的模型", () => {
    const config: ProviderConfig = {
      baseUrl: "",
      key: "",
      model: "default",
      selectedModels: ["default", "role", "chosen"],
      availableModels: [],
      capabilities: {},
      hasKey: false,
    };
    const roles = defaultRoleSettings();
    expect(resolveTextModel(config, roles, "brainstorm")).toBe("default");
    roles.roles.find((r) => r.id === "brainstorm")!.model = "role";
    expect(resolveTextModel(config, roles, "brainstorm")).toBe("role");
    expect(resolveTextModel(config, roles, "brainstorm", "chosen")).toBe(
      "chosen",
    );
    expect(() =>
      resolveTextModel(config, roles, "brainstorm", "removed"),
    ).toThrow("选择可用模型");
  });
  it("移除默认模型后改用首个已选项，列表刷新仍保留自定义已选模型", () => {
    expect(
      modelSelection(
        "old",
        [" writer-b ", "writer-a", "writer-b"],
        ["remote-model"],
      ),
    ).toEqual({
      model: "writer-b",
      selectedModels: ["writer-b", "writer-a"],
      availableModels: ["remote-model", "writer-b", "writer-a"],
    });
  });
  it("允许清空所有勾选，不会偷偷重新加入旧默认模型", () => {
    expect(modelSelection("old", [], ["old"])).toEqual({
      model: "",
      selectedModels: [],
      availableModels: ["old"],
    });
  });
});
