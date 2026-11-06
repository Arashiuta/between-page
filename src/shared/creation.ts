import type { CreativeFreedom, Project, TaskKind } from "./types";

export const freedomOptions: {
  value: CreativeFreedom;
  label: string;
  description: string;
}[] = [
  {
    value: "free",
    label: "自由发挥",
    description:
      "只给一点想法也能开始；AI 自行安排剧情，补充需要的人物与世界细节。",
  },
  {
    value: "balanced",
    label: "适度补全",
    description: "沿着已有方向推进，补足场景和必要细节，重大新设定留作建议。",
  },
  {
    value: "guided",
    label: "遵循设定",
    description: "按你的设定与计划写作，重大空白保留，不自行决定新的核心规则。",
  },
];

export function creativeFreedom(
  project: Pick<Project, "creativeFreedom">,
): CreativeFreedom {
  return project.creativeFreedom ?? "balanced";
}

export function creationPolicy(project: Project, kind: TaskKind): string {
  if (
    [
      "notes",
      "organize",
      "check",
      "revise",
      "dialogue",
      "prompt",
      "pacing",
      "arc",
    ].includes(kind)
  )
    return "";
  const freedom = creativeFreedom(project);
  const instructions: Record<CreativeFreedom, string> = {
    free: "作者授权你主动构思剧情，并补足尚未定义的人物、能力用法、地点、世界细节和遭遇。只有关键词、没有完整设定或本章计划也应直接创作，自行选择一个合理方向，不用问卷或待办清单要求作者先完成构思。冒险、公路片和日常可以逐站展开，只补充眼前需要的内容，保留远方世界、身世和结局的未知，不强行预设终局。",
    balanced:
      "沿着作者的想法、蓝图与人物动机主动推进。没有本章计划也可根据当前处境安排下一事件，补足场景和必要细节；涉及新增核心能力、世界底层规则或改变主线的内容，在策划任务中作为候选，不擅自覆盖已有设定。",
    guided:
      "遵循作者提供的设定与计划，可补充行动、对白和环境细节；不自行决定未定义的核心能力、重大身世或世界底层规则。材料不足时围绕已有条件写一个局部场景，确实影响创作的空白在策划结果中保留。",
  };
  return `【本次创作自由度：${freedomOptions.find((item) => item.value === freedom)!.label}】\n${instructions[freedom]}\n这项授权明确了职责里默认保守补充要求的适用范围。所有自由度都必须遵守作者明确指定的人物、能力边界、固定规则、叙述偏好与已发生事实；后续新增的明确设定也须约束未来创作。角色只能知道自己获得的信息。新构思采用后可成为计划或设定，不能冒充已经发生的事件。`;
}
