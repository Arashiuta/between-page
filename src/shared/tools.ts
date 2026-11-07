import type { Mode, TaskKind } from "./types";
export const toolGroups: { id: string; name: string; kinds: TaskKind[] }[] = [
  { id: "brainstorm", name: "灵感脑暴", kinds: ["brainstorm"] },
  { id: "blueprint", name: "完善蓝图", kinds: ["blueprint"] },
  { id: "writing", name: "正文写作", kinds: ["opening", "continue"] },
  { id: "polish", name: "文段打磨", kinds: ["polish"] },
  { id: "checking", name: "故事检查", kinds: ["check"] },
  { id: "notes", name: "记忆整理", kinds: ["notes"] },
  { id: "prompt", name: "插画构思", kinds: ["prompt"] },
];
export const toolGroupFor = (kind: TaskKind) =>
  toolGroups.find((g) => g.kinds.includes(kind));
export const modeTools = {
  explore: {
    blueprintLevels: ["section"],
    description: "跟随当前处境探索；用自由分区记录近期方向，保留未定空间。",
    writing: "从已有处境开始或继续故事，不预设全书终局。",
    prompts: {
      brainstorm:
        "自由探索聊天：围绕当前故事的可能性、人物选择和未知空间交流，不要求补齐大纲或结局。",
      settings:
        "自由探索设定：只补充本次需要的人物与世界信息，允许保留空白，不强迫建立完整设定表。",
      blueprint:
        "自由探索蓝图：只处理指定自由分区，记录方向、近期安排、伏笔或待定问题，不创建层级大纲。保存的其他层级仍须参考。",
      opening: "自由探索开篇：允许从一个处境、一段关系或一个问题即兴开始。",
      continue:
        "自由探索续写：跟随当前章最后的处境推进，不替作者决定全书结局。",
      polish: "自由探索打磨：参考当前章完整正文与全部有效故事依据，只改选区。",
      check:
        "自由探索检查：检查已写事实、人物和当前方向，不把缺少完整大纲、终局或尚未揭示的秘密列为错误。",
      notes:
        "自由探索记忆：只提取已采用正文明确发生的事实，保留来源，不将探索可能性当事实。",
      prompt: "自由探索插画：从当前场景提炼画面，保留未定义的信息空间。",
      title: "自由探索命名：围绕本章内容或已有方向命名，避免提前揭示未定未来。",
    },
  },
  novel: {
    blueprintLevels: ["section", "synopsis", "volume", "chapter", "scene"],
    description: "从全局约束逐层规划到场景；各层均可留空。",
    writing: "遵循已有蓝图与前文推进，缺少某层规划时正常写作。",
    prompts: {
      brainstorm:
        "长篇创作聊天：围绕全书构想、结构、人物发展和伏笔交流，提供灵感，不进行规划写入。",
      settings:
        "长篇创作设定：完善长期人物约束、世界规则、叙事偏好，结合全书蓝图指出需要协调处。",
      blueprint:
        "长篇创作蓝图：按指定总纲、卷纲、章纲、场景或全局分区修改，遵守上级约束与人物发展因果。规划层级可留空。",
      opening:
        "长篇创作开篇：参考关联章纲和场景细纲及全书安排，未规划处可合理发挥，不要求先补全所有规划。",
      continue:
        "长篇创作续写：从正文结尾推进，兼顾本章阶段、全书伏笔和人物发展，不提前兑现未来计划。",
      polish:
        "长篇创作打磨：完整参考当前章，同时参考关联章纲、场景细纲与上级蓝图，只改选区。",
      check:
        "长篇创作检查：检查正文与全书规划、人物发展、时间与认知的一致性，区分计划与已发生事实。",
      notes:
        "长篇创作记忆：只提取已采用正文，明确章节与采用版本来源，不从未来规划推断事实。",
      prompt:
        "长篇创作插画：结合章节阶段与设定参考图生成画面描述，避免使用角色未来才获得的状态。",
      title: "长篇创作命名：参考本章与关联规划，贴合章节阶段。",
    },
  },
} satisfies Record<
  Mode,
  {
    blueprintLevels: string[];
    description: string;
    writing: string;
    prompts: Record<TaskKind, string>;
  }
>;
export const toolNames: Record<TaskKind, string> = {
  brainstorm: "灵感脑暴",
  settings: "完善设定",
  blueprint: "完善蓝图",
  opening: "开篇",
  continue: "续写",
  polish: "文段打磨",
  check: "故事检查",
  notes: "记忆整理",
  prompt: "插画构思",
  title: "章节命名",
};
export const defaultCapabilities = () => ({
  vision: false,
  contextTokens: 128000,
  outputTokens: 8000,
});
