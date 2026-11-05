import type { TaskKind, WorkflowTemplate } from "./types";

const step = (kind: TaskKind, title: string, instruction = "") => ({
  id: `${kind}-${title}`,
  kind,
  title,
  instruction,
});

export const builtinWorkflowTemplates: WorkflowTemplate[] = [
  {
    id: "builtin-idea-to-blueprint",
    name: "灵感到蓝图",
    description: "先发散和归纳，再形成可评审的故事方向。",
    builtin: true,
    steps: [
      step("brainstorm", "发散故事方向"),
      step("organize", "整理确认点与空白"),
      step("outline", "形成故事蓝图"),
    ],
  },
  {
    id: "builtin-chapter-to-prose",
    name: "章节规划到正文",
    description: "先明确章节目标与转折，再根据审核后的计划写作。",
    builtin: true,
    steps: [
      step("outline", "拟定章节计划", "聚焦当前章节，不重复整本故事蓝图。"),
      step("chapter", "根据审核结果写作正文"),
    ],
  },
  {
    id: "builtin-scene-polish",
    name: "场景打磨与检查",
    description: "改善场景表现，再检查修改后的连续性。",
    builtin: true,
    steps: [
      step("scene", "打磨场景"),
      step("dialogue", "检查对白与潜台词"),
      step("check", "检查连续性"),
    ],
  },
];

