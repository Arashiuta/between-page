import type { Mode, TaskKind } from "./types";
export const toolGroups: { id: string; name: string; kinds: TaskKind[] }[] = [
  { id: "brainstorm", name: "灵感脑暴", kinds: ["brainstorm"] },
  { id: "blueprint", name: "完善额外设定", kinds: ["blueprint"] },
  { id: "outline", name: "大纲规划", kinds: ["outline"] },
  { id: "writing", name: "正文写作", kinds: ["opening", "continue", "expand"] },
  { id: "polish", name: "文段打磨", kinds: ["polish"] },
  { id: "checking", name: "故事检查", kinds: ["check"] },
  { id: "prompt", name: "插画构思", kinds: ["prompt"] },
];
export const toolGroupFor = (kind: TaskKind) =>
  toolGroups.find((g) => g.kinds.includes(kind));
export const modeTools = {
  explore: {
    blueprintLevels: ["section"],
    description:
      "跟随当前处境写作，选择下一章走向；全程遵守额外设定、资料与有效记忆，不参考保留的大纲。",
    writing: "从已有处境开始或继续故事，不预设全书终局。",
    prompts: {
      brainstorm:
        "自由探索聊天：围绕当前故事的可能性、人物选择和未知空间交流，不要求补齐大纲或结局。",
      settings:
        "自由探索设定：只补充本次需要的人物与世界信息，允许保留空白，不强迫建立完整设定表。",
      blueprint:
        "自由探索额外设定：按作者要求新增或完善自定义特殊要求与故事约束，供后续创作持续参考，如视角限制、能力代价、感情线边界。分类自由，不自行生成章纲、剧情梗概或逐章安排，不修改资料与正文。",
      outline: "自由探索不使用大纲规划。",
      directions:
        "自由探索剧情走向：基于当前章完整正文、全部额外设定、世界与人物、引入资料和有效记忆，提出不同的下一章可能走向。不得违背已写事实、人物认知和约束。走向只是候选，不是已发生事实。",
      opening: "自由探索开篇：允许从一个处境、一段关系或一个问题即兴开始。",
      continue:
        "自由探索续写：只在当前章节内，从最后的处境继续推进；不得转入下一章、另写新章或替作者决定全书结局。",
      expand:
        "自由探索扩写：在不改变已发生事实、人物认知和章节结尾的前提下，扩充当前章已有场景与细节，输出当前章完整扩写稿，不推进到下一章。",
      polish: "自由探索打磨：参考当前章完整正文与全部有效故事依据，只改选区。",
      check:
        "自由探索检查：检查已写事实、人物和当前方向，不把缺少完整大纲、终局或尚未揭示的秘密列为错误。",
      notes:
        "自由探索记忆：只提取已采用正文明确发生的事实，保留来源，不将探索可能性当事实。",
      memory_tune:
        "自由探索记忆调优：只分析当前启用记忆，按章节顺序处理冲突，以较新章节事实覆盖较早记录；闭环伏笔可整理为已发生事实。手工记忆冲突只标记审核，不自动改写或停用。",
      prompt: "自由探索插画：从当前场景提炼画面，保留未定义的信息空间。",
      title: "自由探索命名：围绕本章内容或已有方向命名，避免提前揭示未定未来。",
    },
  },
  novel: {
    blueprintLevels: ["section"],
    description:
      "遵守额外设定、资料与有效记忆，按大纲规划逐章推进；各层大纲均可留空。",
    writing:
      "参考全部额外设定、资料、有效记忆与大纲，按本章规划推进，缺少规划时正常写作。",
    prompts: {
      brainstorm:
        "长篇创作聊天：围绕全书构想、结构、人物发展和伏笔交流，提供灵感，不进行规划写入。",
      settings:
        "长篇创作设定：完善长期人物约束、世界规则、叙事偏好，结合全书额外设定指出需要协调处。",
      blueprint:
        "长篇创作额外设定：按作者要求新增或完善自定义特殊要求与故事约束，供后续创作持续参考，如视角限制、能力代价、感情线边界。分类自由，已有大纲仅作背景参考，不能作为输出模板；不自行生成章纲、剧情梗概或逐章安排，不修改大纲、资料与正文。",
      outline:
        "长篇大纲规划：按指定总纲、卷纲、章纲或场景细纲修改。参考全部额外设定、资料与有效记忆，遵守上级规划和人物发展因果。各层可留空，未来计划不得冒充已发生事实。",
      directions: "长篇模式不生成探索走向，请使用大纲规划。",
      opening:
        "长篇创作开篇：参考关联章纲和场景细纲及全书安排，未规划处可合理发挥，不要求先补全所有规划。",
      continue:
        "长篇创作续写：只在当前章节内从正文结尾继续，兼顾本章阶段、全书伏笔和人物发展；不得跳转到下一章或提前兑现未来计划。",
      expand:
        "长篇创作扩写：在不改变已发生事实、人物认知、本章规划和章节结尾的前提下，扩充当前章已有场景与细节，输出当前章完整扩写稿，不推进到下一章。",
      polish:
        "长篇创作打磨：完整参考当前章，同时参考关联章纲、场景细纲与所属卷纲，只改选区。",
      check:
        "长篇创作检查：检查正文与全书规划、人物发展、时间与认知的一致性，区分计划与已发生事实。",
      notes:
        "长篇创作记忆：只提取已采用正文，明确章节与采用版本来源，不从未来规划推断事实。",
      memory_tune:
        "长篇记忆调优：只分析当前启用记忆，按章节顺序处理冲突，以较新章节事实覆盖较早记录；闭环伏笔可整理为已发生事实。手工记忆冲突只标记审核，不自动改写或停用。",
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
  blueprint: "完善额外设定",
  outline: "大纲规划",
  directions: "下一章走向",
  opening: "开篇",
  continue: "续写",
  expand: "扩写",
  polish: "文段打磨",
  check: "故事检查",
  notes: "记忆整理",
  memory_tune: "记忆调优",
  prompt: "插画构思",
  title: "章节命名",
};
export const defaultCapabilities = () => ({
  vision: false,
  contextTokens: 128000,
  outputTokens: 8000,
});
