import type { CreativeFreedom, Project } from "./types";
export const freedomOptions = [
  { label: "遵循设定", value: "guided" },
  { label: "平衡发挥", value: "balanced" },
  { label: "自由发挥", value: "free" },
];
export const creativeFreedom = (p: Project): CreativeFreedom =>
  p.creativeFreedom;
export const creationPolicy = (p: Project) =>
  `创作自由度：${p.creativeFreedom === "free" ? "可主动补充未定义的局部细节和遭遇" : p.creativeFreedom === "balanced" ? "沿作者方向补足必要细节" : "紧贴已有资料，只补充场景行动、对白与环境"}。任何自由度都须遵守已有额外设定和设定，不授权改变明确规则。`;
