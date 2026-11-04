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
