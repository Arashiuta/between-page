import { describe, expect, it } from "vitest";
import { modelSelection } from "../src/shared/models";
describe("已选模型", () => {
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
