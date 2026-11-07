import type { ProviderConfig, RoleId, RoleSettings } from "./types";
import { effectiveRole } from "./roles";

export function modelSelection(
  model: string,
  selectedModels: string[] = model ? [model] : [],
  availableModels: string[] = [],
) {
  const clean = (values: string[]) => [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  const selected = clean(selectedModels);
  return {
    model: selected.includes(model.trim()) ? model.trim() : selected[0] || "",
    selectedModels: selected,
    availableModels: clean([...availableModels, ...selected]),
  };
}
export function resolveTextModel(
  config: ProviderConfig,
  roles: RoleSettings,
  role: RoleId,
  override?: string,
) {
  const model = override || effectiveRole(roles, role).model || config.model;
  if (!model || !config.selectedModels.includes(model))
    throw new Error("请在设置中勾选文字模型，或重新选择可用模型。");
  return model;
}
