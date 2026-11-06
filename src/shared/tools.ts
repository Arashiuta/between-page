import type { TaskKind } from "./types";

export const toolCategories = [
  "灵感",
  "策划",
  "正文",
  "润色",
  "检查",
  "插画构思",
];
interface ToolInfo {
  category: string;
  purpose: string;
  input: string;
  context: string;
  result: string;
  target: string;
  output:
    | "prose"
    | "blueprint"
    | "development"
    | "selection"
    | "memory"
    | "illustration"
    | "analysis";
  candidate?: boolean;
}
// Output destinations are shared by the workbench and persistence, so a new tool
// does not need separate, potentially inconsistent allowlists in each view.
export const toolInfo: Record<TaskKind, ToolInfo> = {
  opening: {
    category: "正文",
    purpose: "只给一个角色或世界关键词，直接开始故事，设定可以边写边长出来。",
    input:
      "例如：围绕主角的目标和当前处境写一段开篇，其他细节自由发挥。也可留空，使用故事想法。",
    context: "故事想法、已有设定、创作自由度。",
    result: "直接进入场景的开篇正文。",
    target: "章节草稿。",
    output: "prose",
  },
  chapter: {
    category: "正文",
    purpose: "接着当前处境推进故事；本章计划可选，AI 按创作自由度安排遭遇。",
    input: "可以只说“继续故事”或留空；也可以详细指定事件、人物表现与篇幅。",
    context: "当前章节、此前正文、蓝图、设定与有效记忆。",
    result: "可编辑的正文草稿。",
    target: "章节草稿。",
    output: "prose",
  },
  develop: {
    category: "策划",
    purpose:
      "从零构思，或把写到现在的人物、能力和世界逐步完善，也能分区更新蓝图。",
    input:
      "例如：保留已写剧情，完善主角能力和世界势力设定；只规划近期剧情，不决定结局。留空则从现有故事整理。",
    context:
      "全故事范围的已采用正文、有效记忆、当前草稿与已有资料；逐条标注提炼依据或新增构想。",
    result: "可编辑、可逐项采用的人物、世界与蓝图分区建议。",
    target: "世界与人物 / 故事蓝图；支持撤销本次更新。",
    output: "development",
    candidate: true,
  },
  brainstorm: {
    category: "灵感",
    purpose: "围绕一个核心点发散出不同方向，帮助打开思路。",
    input: "一个画面、人物关系、冲突或问题；可使用故事想法。",
    context: "故事想法、蓝图、人物与世界资料。",
    result: "多个可选方向及其吸引力、代价和冲突。",
    target: "创作候选，可继续发展成蓝图与设定。",
    output: "blueprint",
    candidate: true,
  },
  organize: {
    category: "灵感",
    purpose:
      "忠实整理零碎想法，指出关系、矛盾与空白；需要主动补充时使用“完善设定与蓝图”。",
    input: "随手记录的句子、片段和问题。",
    context: "故事想法、蓝图与创作资料。",
    result: "整理后的主题、片段和待确认事项。",
    target: "蓝图候选。",
    output: "blueprint",
    candidate: true,
  },
  outline: {
    category: "策划",
    purpose: "规划整体剧情，或只安排下一站、近期章节；支持完整大纲和边走边写。",
    input: "希望发生的事件、人物变化、近期方向或结局倾向。",
    context: "已有蓝图、章节计划、故事资料与有效记忆。",
    result: "有因果关系的剧情方案或章节计划。",
    target: "蓝图候选或本章计划，可继续整理成多个分区。",
    output: "blueprint",
    candidate: true,
  },
  adjust: {
    category: "策划",
    purpose: "根据新想法调整后续走向，核对已发生事实与新设定的衔接。",
    input: "要改变的方向及必须保留的内容。",
    context: "既有蓝图、采用章节、人物关系和已埋线索。",
    result: "调整后的后续安排与受影响事项。",
    target: "蓝图候选。",
    output: "blueprint",
    candidate: true,
  },
  scene: {
    category: "正文",
    purpose: "设计或改写一个有目标、阻力、转折的场景。",
    input: "场景目标、出场人物、希望出现的变化。",
    context: "选中文段、章节计划、人物资料与上下文。",
    result: "场景方案或场景正文。",
    target: "章节草稿。",
    output: "prose",
  },
  revise: {
    category: "润色",
    purpose: "按指定方向改写选中的段落，保留其余事实。",
    input: "先在正文选中文段，再写修改方向。",
    context: "选中文段、章节计划、人物资料与上下文。",
    result: "可直接替换选区的文段。",
    target: "选中文段。",
    output: "selection",
  },
  dialogue: {
    category: "润色",
    purpose: "打磨对白语气、节奏和潜台词。",
    input: "对白片段及人物当下的关系或情绪。",
    context: "当前章节、角色资料和故事记忆。",
    result: "对白替换稿或具体打磨建议。",
    target: "章节草稿。",
    output: "prose",
  },
  pacing: {
    category: "检查",
    purpose: "检查推进、重复、信息释放、张弛和章节钩子。",
    input: "检查范围及希望重点关注的问题。",
    context: "章节正文、章节计划和蓝图。",
    result: "有文本依据的节奏诊断与优先调整建议。",
    target: "诊断候选。",
    output: "analysis",
    candidate: true,
  },
  arc: {
    category: "检查",
    purpose: "追踪人物欲望、选择、代价和阶段变化。",
    input: "关注的人物及其预期变化。",
    context: "人物设定、关系、采用章节与蓝图。",
    result: "人物弧线诊断及待补足环节。",
    target: "诊断候选。",
    output: "analysis",
    candidate: true,
  },
  check: {
    category: "检查",
    purpose: "核对时间线、人物认知、设定规则和前后连续性。",
    input: "检查范围或想核对的人物、秘密、线索。",
    context: "采用章节、故事资料与正式记忆。",
    result: "带依据的问题清单和小幅修正选项。",
    target: "检查结果草稿。",
    output: "analysis",
  },
  notes: {
    category: "检查",
    purpose: "从已采用章节提取事实和人物认知，先供作者审核。",
    input: "当前章节必须已经采用。",
    context: "该章节的已采用版本。",
    result: "分类记忆草稿。",
    target: "确认后写入故事记忆。",
    output: "memory",
  },
  prompt: {
    category: "插画构思",
    purpose: "把一个故事瞬间整理成完整的绘图提示词。",
    input: "想绘制的瞬间，也可先选择正文片段。",
    context: "人物当前外观、服装、场景和参考图。",
    result: "可编辑的静态画面提示词。",
    target: "插画生成面板。",
    output: "illustration",
  },
};
