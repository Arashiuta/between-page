<script setup lang="ts">
import { computed, ref } from "vue";
import { NInput } from "naive-ui";
import { BookOpen, Search } from "lucide-vue-next";

const search = ref("");
const sections = [
  { title: "开始使用", body: "页间在本机保存故事、设定和配置。首次使用可在设置中配置兼容 OpenAI 接口的文字模型与插画模型，填写接口地址和密钥，再获取并勾选可用模型。文字模型用于规划、写作和检查；插画模型用于生成图片。也可为不同 AI 职责单独指定文字模型。" },
  { title: "故事书架", body: "在故事书架创建故事，填写名称、最初想法、创作模式与类型。自由探索适合边写边发现；长篇创作适合规划阶段与主线。故事可搜索、归档和恢复。永久删除只对已归档故事开放，确认框会显示故事名称；删除后章节、版本、记忆、故事内资料副本和流程运行记录均被清理。仍被其他资料引用的图片会保留在插画收藏中。" },
  { title: "创作资料与世界人物", body: "创作资料库保存可跨故事复用的 OC、世界观和灵感。角色、世界资料支持分区、约束、原始文档和参考图片。进入故事的「世界与人物」，可按全部、OC 或世界观筛选导入。导入的是独立副本，后续编辑互不影响。" },
  { title: "故事蓝图", body: "蓝图是创作中持续参考的计划与设想，AI 任务会把它作为上下文，但会区分计划和已经发生的事实。分区是作者自定义的整理栏目，可按需要命名、排序与编辑，例如主线、角色弧线、阶段推进、伏笔和待确认事项。AI 规划、灵感整理和诊断结果进入候选区，不会自动覆盖蓝图；选择目标分区后可追加，替换前会显示确认。故事想法、故事世界和写作偏好与蓝图分开保存。" },
  { title: "AI 工作台", body: "正文右侧的工作台提供灵感、策划、正文、润色、检查和插画构思等单项工具。选中工具后可查看用途、所需输入、参考上下文、结果形式和写入目标；生成结果会保留为可编辑草稿，由作者决定是否写入正文、蓝图或记忆。工作台会参考当前故事设定，展开后可查看本次实际使用的职责提示词与参考内容。" },
  { title: "正文、章节与版本", body: "章节列表可新建章节、修改标题和本章计划。右键点击章节可选择删除，确认后删除本章正文、版本记录及关联记忆，插画仍保留在故事中；删除已采用章节后，后续已采用章节需要复核，相关自动记忆会停用。删除无法撤销。正文自动保存为草稿；采用章节表示确认该版本。AI 写入正文前会保存版本快照，支持查看历史并将旧版恢复到草稿。恢复不会自动改变已采用版本。选中文段后可使用改写工具，应用到章节前再次确认目标。" },
  { title: "故事记忆", body: "正式记忆用于保留已发生事实、人物状态、关系、认知和伏笔。作者可手动添加记录。记忆整理只读取已采用正文，结果先以 JSON 契约解析为可审核草稿；确认后才写入正式记忆。记忆保留章节与版本来源，可停用或重新启用。未采用草稿和未来蓝图不会变成正式事实。" },
  { title: "插画与图片", body: "插画面板可输入画面提示词、选择人物参考图并生成插画。AI 插画构思先生成可编辑提示词，作者决定后再送入生成面板。图片保存在本机数据目录，可在插画收藏和故事插画中查看。删除故事时，仍被其他故事或创作资料引用的图片会转为资料库素材。" },
  { title: "AI 职责与提示词", body: "AI 职责页为每类任务提供单独提示词和模型选择，并显示完整生效提示词。职责包含任务目标、边界和产物格式。软件会在可编辑要求之后追加输出约束，要求直接从产物开始，不使用确认、寒暄或导语。记忆与资料整理使用固定 JSON 格式，供软件解析。" },
  { title: "备份、迁移与隐私", body: "设置页可创建完整数据备份、打开数据目录或迁移数据目录。备份包含数据库和图片；建议在更换设备、更新系统或迁移前手动备份，并将备份存放在安全位置。故事、资料、图片和提示词保存在本机。调用外部模型时，本次任务所需的正文、蓝图、记忆和参考资料会发送到你配置的模型服务；服务商的数据处理方式由其自身政策决定。API 密钥存放在本地应用数据中。" },
];
const filtered = computed(() => {
  const term = search.value.trim().toLocaleLowerCase();
  return sections.filter((section) => !term || `${section.title} ${section.body}`.toLocaleLowerCase().includes(term));
});
function jumpTo(index: number) {
  document.getElementById(`help-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<template>
  <main class="page help-page">
    <div class="page-heading help-heading"><div><h1><BookOpen :size="25" />帮助</h1><p>页间功能说明与使用参考</p></div><div class="help-search"><Search :size="16" /><NInput v-model:value="search" clearable placeholder="搜索说明" aria-label="搜索帮助" /></div></div>
    <div class="help-layout">
      <nav class="help-index" aria-label="帮助目录"><strong>目录</strong><button v-for="section in filtered" :key="section.title" type="button" @click="jumpTo(sections.indexOf(section))">{{ section.title }}</button></nav>
      <div class="help-articles">
        <article v-for="section in filtered" :id="`help-${sections.indexOf(section)}`" :key="section.title" class="help-article"><h2>{{ section.title }}</h2><p>{{ section.body }}</p></article>
        <div v-if="!filtered.length" class="inline-empty"><Search :size="24" /><p>没有找到匹配的说明。</p></div>
      </div>
    </div>
  </main>
</template>
