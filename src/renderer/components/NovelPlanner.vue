<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton, NInput, NInputNumber, NModal, NSelect } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import type {
  PlanningTarget,
  ProjectDetail,
  PlanningVersion,
  PlanningMove,
  PlanningMovePreview,
} from "../../shared/types";
import { chapterPlan, planningHints, planStatus } from "../../shared/planning";
import { effectiveRole } from "../../shared/roles";
import type { PlanBlock } from "../../shared/types";
import PlanEditor from "./PlanEditor.vue";
import PlanningTree from "./PlanningTree.vue";
import VersionActions from "./VersionActions.vue";
const props = defineProps<{
  overview?: boolean;
  entry?: PlanningTarget["level"];
}>();
const emit = defineEmits<{
  navigate: [tab: string, level?: PlanningTarget["level"]];
}>();
const store = useWorkspace();
const moveBusy = ref(false);
const pendingMove = ref<{
  projectId: string;
  move: PlanningMove;
  preview: PlanningMovePreview;
} | null>(null);
const structureLocked = computed(
  () => store.busy || store.imageBusy || moveBusy.value || !!pendingMove.value,
);
const target = ref<PlanningTarget>({ level: "synopsis" });
const count = ref(3),
  history = ref<PlanningVersion[]>([]),
  showHistory = ref(false);
const viewingVersion = ref<PlanningVersion | null>(null);
const showNewChapter = ref(false),
  newChapterTitle = ref(""),
  newChapterContent = ref(""),
  newChapterVolume = ref<string | null>(null),
  creatingChapter = ref(false);
const plan = computed(() => store.detail!.project.novelPlan!);
const chapter = computed(() =>
  store.detail?.chapters.find(
    (c) =>
      c.id ===
      (target.value.level === "chapter"
        ? target.value.id
        : target.value.parentId),
  ),
);
const volume = computed(() =>
  plan.value.volumes.find((v) => v.id === target.value.id),
);
const scene = computed(() =>
  chapter.value?.scenes?.find((s) => s.id === target.value.id),
);
const block = computed(() =>
  target.value.level === "synopsis"
    ? plan.value.synopsis
    : target.value.level === "volume"
      ? volume.value?.plan
      : target.value.level === "chapter"
        ? chapter.value && chapterPlan(chapter.value)
        : scene.value?.plan,
);
const title = computed(() =>
  target.value.level === "synopsis"
    ? "全书总纲"
    : target.value.level === "volume"
      ? volume.value?.title
      : target.value.level === "chapter"
        ? chapter.value?.title
        : scene.value?.title,
);
const stages = computed(() => [
  {
    title: "完善设定",
    description: "人物、动机与关系，世界规则与能力边界",
    ready: !!store.detail?.cards.length || !!store.detail?.project.world.trim(),
    tab: "cards",
  },
  {
    title: "总纲",
    description: "主题、主线、核心冲突与结局方向",
    ready: planStatus(plan.value.synopsis) === "已确认",
    tab: "planning",
  },
  {
    title: "分卷大纲（可选）",
    description: "阶段目标和转折，可选",
    ready: plan.value.volumes.some((v) => planStatus(v.plan) === "已确认"),
    tab: "planning",
  },
  {
    title: "章纲（可选）",
    description: "本章目标、冲突、转折和结束位置",
    ready: store.detail!.chapters.some(
      (c) => planStatus(chapterPlan(c)) === "已确认",
    ),
    tab: "planning",
  },
  {
    title: "场景细纲（可选）",
    description: "行动、对白、信息释放与伏笔，可选",
    ready: store.detail!.chapters.some((c) =>
      c.scenes?.some((s) => planStatus(s.plan) === "已确认"),
    ),
    tab: "planning",
  },
  {
    title: "正文",
    description: "依据已有设定、可用规划和前文创作",
    ready: store.detail!.chapters.some((c) => c.content.trim()),
    tab: "text",
  },
]);
async function add(level: PlanningTarget["level"]) {
  if (level === "chapter") {
    newChapterVolume.value =
      target.value.level === "volume"
        ? (target.value.id ?? plan.value.volumes[0]?.id ?? null)
        : (chapter.value?.volumeId ?? plan.value.volumes[0]?.id ?? null);
    showNewChapter.value = true;
    return;
  }
  await store.flush();
  const next: PlanningTarget = {
    level,
    ...(level === "scene" ? { parentId: chapter.value?.id } : {}),
  };
  const result = await store.api<{
    detail: ProjectDetail;
    target: PlanningTarget;
  }>("planning:save", {
    projectId: store.detail!.project.id,
    target: next,
    content: "",
  });
  store.detail = result.detail;
  target.value = result.target;
}
async function confirmNewChapter(confirm = false) {
  if (creatingChapter.value || (confirm && !newChapterContent.value.trim()))
    return;
  creatingChapter.value = true;
  try {
    await store.flush();
    const result = await store.api<{
      detail: ProjectDetail;
      target: PlanningTarget;
    }>("planning:save", {
      projectId: store.detail!.project.id,
      target: {
        level: "chapter",
        parentId: newChapterVolume.value ?? undefined,
      },
      title: newChapterTitle.value.trim() || undefined,
      content: newChapterContent.value,
      confirm,
    });
    store.detail = result.detail;
    target.value = result.target;
    showNewChapter.value = false;
    newChapterTitle.value = "";
    newChapterContent.value = "";
    store.notify(
      confirm
        ? "章纲已确认，已创建对应空章。"
        : "章节已创建，章纲可稍后补充或确认。",
    );
  } finally {
    creatingChapter.value = false;
  }
}
async function generateChildren() {
  const next: PlanningTarget =
    target.value.level === "synopsis"
      ? { level: "volume", count: count.value }
      : target.value.level === "volume"
        ? { level: "chapter", parentId: target.value.id, count: count.value }
        : { level: "scene", parentId: chapter.value!.id, count: count.value };
  store.planningTarget = next;
  store.instruction =
    "依据当前上层规划展开下一层，每一项都保留清晰的目标和因果关系。";
  await store.runTask("outline", { planningTarget: next });
}
async function historyOpen() {
  await store.flush();
  history.value = await store.api("planning:history", store.detail!.project.id);
  viewingVersion.value = null;
  showHistory.value = true;
}
async function restore(id: string) {
  await store.flush();
  store.detail = await store.api("planning:restore", {
    projectId: store.detail!.project.id,
    versionId: id,
  });
  showHistory.value = false;
}
async function organize(volumeId: string | null, sceneIds?: string[]) {
  if (sceneIds) {
    const previous = chapter.value!.scenes!.map((s) => s.id);
    const changed = sceneIds.findIndex((id, i) => id !== previous[i]);
    if (changed < 0) return;
    await requestMove({
      source: {
        level: "scene",
        id: sceneIds[changed],
        parentId: chapter.value!.id,
      },
      target: {
        level: "scene",
        id: previous[changed],
        parentId: chapter.value!.id,
      },
      placement: "before",
    });
  } else if ((chapter.value!.volumeId ?? null) !== volumeId) {
    await requestMove({
      source: { level: "chapter", id: chapter.value!.id },
      target: volumeId
        ? { level: "volume", id: volumeId }
        : { level: "unassigned" },
      placement: "inside",
    });
  }
}
function moveScene(id: string, delta: number) {
  const ids = chapter.value!.scenes!.map((s) => s.id),
    index = ids.indexOf(id),
    next = index + delta;
  if (next < 0 || next >= ids.length) return;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  return organize(chapter.value!.volumeId ?? null, ids);
}
const showLegacyConfirm = ref(false),
  legacyProjectId = ref(""),
  convertingLegacy = ref(false);
const legacyModel = computed(
  () =>
    effectiveRole(store.roles, "outline").model ||
    store.settings?.text.model ||
    "当前模型",
);
function requestLegacyConversion() {
  legacyProjectId.value = store.detail!.project.id;
  showLegacyConfirm.value = true;
}
async function convertLegacy() {
  if (convertingLegacy.value || !showLegacyConfirm.value) return;
  const projectId = legacyProjectId.value;
  convertingLegacy.value = true;
  try {
    await store.flush();
    if (store.detail?.project.id !== projectId) return;
    if (store.busy || store.imageBusy)
      throw new Error("请先停止或等待当前生成任务完成。");
    showLegacyConfirm.value = false;
    store.planningTarget = { level: "synopsis" };
    store.instruction =
      "根据已有故事蓝图和设定整理全书总纲；保留未定事项，不把未来安排当作已发生事实。";
    await store.runTask("outline", { planningTarget: { level: "synopsis" } });
  } finally {
    convertingLegacy.value = false;
  }
}
async function commitMove(
  projectId: string,
  move: PlanningMove,
  preview: PlanningMovePreview,
  confirmNormalization = false,
) {
  await store.flush();
  if (store.detail?.project.id !== projectId) return;
  const detail = await store.api<ProjectDetail>("planning:move", {
    projectId,
    ...move,
    base: preview.base,
    confirmNormalization,
  });
  if (store.detail?.project.id !== projectId) return;
  store.detail = detail;
  pendingMove.value = null;
  store.notify("顺序已更新；受影响的已采用章节将提示复核。");
}
async function requestMove(move: PlanningMove) {
  if (structureLocked.value) return;
  const projectId = store.detail!.project.id;
  moveBusy.value = true;
  try {
    await store.flush();
    if (store.detail?.project.id !== projectId) return;
    const preview = await store.api<PlanningMovePreview>(
      "planning:move:preview",
      { projectId, ...move },
    );
    if (store.detail?.project.id !== projectId || !preview.changed) return;
    if (preview.requiresNormalization)
      pendingMove.value = { projectId, move, preview };
    else await commitMove(projectId, move, preview);
  } finally {
    moveBusy.value = false;
  }
}
async function confirmMove() {
  const item = pendingMove.value;
  if (!item || moveBusy.value) return;
  moveBusy.value = true;
  try {
    await commitMove(item.projectId, item.move, item.preview, true);
  } finally {
    moveBusy.value = false;
  }
}
function orderLabel(id: string) {
  const c = store.detail!.chapters.find((c) => c.id === id);
  return c?.title ?? "已移除章节";
}
watch(
  () => store.detail?.project.id,
  () => {
    pendingMove.value = null;
    showLegacyConfirm.value = false;
  },
);
const removing = ref<{
  target: PlanningTarget;
  label: string;
  wholeChapter?: boolean;
} | null>(null);
const removalBusy = ref(false);
function requestRemove(value: PlanningTarget, label: string, key: string) {
  target.value = value;
  removing.value = {
    target: value,
    label,
    wholeChapter: key === "delete-chapter",
  };
}
async function remove() {
  if (!removing.value || removalBusy.value) return;
  removalBusy.value = true;
  try {
    await store.flush();
    const item = removing.value;
    if (item.wholeChapter) await store.deleteChapter(item.target.id!);
    else await store.removePlanning(item.target);
    target.value =
      item.target.level === "scene"
        ? { level: "chapter", id: item.target.parentId }
        : { level: "synopsis" };
    removing.value = null;
    store.notify("已完成操作；已有正文仅在删除整章时移除。");
  } finally {
    removalBusy.value = false;
  }
}
function selectLevel(level?: PlanningTarget["level"]) {
  if (!level) return;
  const c =
    store.detail?.chapters.find((c) => c.id === store.chapterId) ??
    store.detail?.chapters[0];
  target.value =
    level === "synopsis"
      ? { level }
      : level === "volume"
        ? { level, id: plan.value.volumes[0]?.id }
        : level === "chapter"
          ? { level, id: c?.id }
          : { level, id: c?.scenes?.[0]?.id, parentId: c?.id };
}
watch(() => props.entry, selectLevel, { immediate: true });
const stageLevels: (PlanningTarget["level"] | undefined)[] = [
  undefined,
  "synopsis",
  "volume",
  "chapter",
  "scene",
  undefined,
];
function stageStatus(index: number) {
  const blocks: PlanBlock[] =
    index === 1
      ? [plan.value.synopsis]
      : index === 2
        ? plan.value.volumes.map((v) => v.plan)
        : index === 3
          ? store.detail!.chapters.map(chapterPlan)
          : index === 4
            ? store.detail!.chapters.flatMap((c) =>
                (c.scenes ?? []).map((s) => s.plan),
              )
            : [];
  const states = blocks.map(planStatus);
  return states.includes("待核对")
    ? "待核对"
    : states.includes("草拟")
      ? "草拟"
      : states.includes("已确认")
        ? "已确认"
        : [1, 2, 3, 4].includes(index)
          ? "按需添加"
          : stages.value[index].ready
            ? "已有内容"
            : "按需添加";
}
async function startWriting() {
  if (!store.detail?.chapters.length) await store.newChapter();
  emit("navigate", "text");
}
</script>
<template>
  <section v-if="store.detail" class="tab-content novel-workspace">
    <template v-if="overview">
      <div class="content-heading">
        <h2>作品概览</h2>
        <p>
          按需要使用设定和各层规划。只写总纲也可以直接创作正文，随时补充或调整。
        </p>
      </div>
      <div class="novel-stage-grid">
        <button
          v-for="(stage, index) in stages"
          :key="stage.title"
          class="novel-stage"
          @click="emit('navigate', stage.tab, stageLevels[index])"
        >
          <small>{{ stageStatus(index) }}</small
          ><strong>{{ stage.title }}</strong
          ><span>{{ stage.description }}</span>
        </button>
      </div>
      <div class="workbench-actions">
        <NButton @click="emit('navigate', 'planning', 'synopsis')"
          >开始规划小说</NButton
        ><NButton type="primary" @click="store.safe(startWriting)">{{
          store.detail.chapters.some((c) => c.content.trim())
            ? "继续写作"
            : "开始写作"
        }}</NButton>
      </div>
      <p class="field-help">
        已写
        {{ store.detail.chapters.filter((c) => c.content.trim()).length }} /
        {{ store.detail.chapters.length }} 章 ·
        {{ store.detail.chapters.filter((c) => c.planningReview).length }}
        章因规划变化待核对
      </p>
    </template>
    <template v-else>
      <div class="content-heading">
        <h2>总纲与章节规划</h2>
        <p>
          选定层级后单独编辑或生成。分卷、章纲与细纲均可选；章节可直接开始写作。
        </p>
      </div>
      <div class="workbench-actions">
        <NButton
          :disabled="structureLocked"
          @click="store.safe(() => add('volume'))"
          >新增分卷</NButton
        ><NButton
          :disabled="structureLocked"
          @click="store.safe(() => add('chapter'))"
          >新增章节</NButton
        ><NButton @click="store.safe(historyOpen)">规划版本</NButton
        ><NButton
          @click="
            store.safe(async () => {
              await store.flush();
              await store.api('planning:snapshot', store.detail!.project.id);
              store.notify('已保存规划版本。');
            })
          "
          >保存版本</NButton
        ><NButton
          :disabled="structureLocked || convertingLegacy"
          @click="requestLegacyConversion"
          >整理旧蓝图为总纲</NButton
        >
      </div>
      <div class="planning-layout">
        <PlanningTree
          :detail="store.detail"
          :target="target"
          :disabled="structureLocked"
          @select="(value) => (target = value)"
          @move="(value) => store.safe(() => requestMove(value))"
          @action="requestRemove"
        />
        <div v-if="block && title" class="planning-detail">
          <PlanEditor
            :key="`${target.level}:${target.id}`"
            :block="block"
            :target="target"
            :title="title"
            :disabled="moveBusy || !!pendingMove"
          />
          <template
            v-if="chapter && ['chapter', 'scene'].includes(target.level)"
          >
            <label class="field-label">章节所属分卷</label
            ><NSelect
              :disabled="structureLocked"
              :value="chapter.volumeId"
              :options="
                plan.volumes.map((v) => ({ label: v.title, value: v.id }))
              "
              placeholder="选择分卷"
              @update:value="(value) => store.safe(() => organize(value))"
            />
            <div class="workbench-actions">
              <NButton
                :disabled="structureLocked"
                @click="store.safe(() => add('scene'))"
                >新增场景细纲</NButton
              ><NButton
                @click="
                  store.safe(async () => {
                    await store.switchChapter(chapter!.id);
                    emit('navigate', 'text');
                  })
                "
                >写这一章</NButton
              >
            </div>
            <div v-for="s in chapter.scenes" :key="s.id" class="scene-order">
              <span>{{ s.title }}</span
              ><NButton
                size="tiny"
                :disabled="structureLocked || chapter.scenes?.[0]?.id === s.id"
                @click="
                  store.safe(async () => {
                    await moveScene(s.id, -1);
                  })
                "
                >上移</NButton
              ><NButton
                size="tiny"
                :disabled="
                  structureLocked || chapter.scenes?.at(-1)?.id === s.id
                "
                @click="
                  store.safe(async () => {
                    await moveScene(s.id, 1);
                  })
                "
                >下移</NButton
              >
            </div>
          </template>
          <div v-if="target.level !== 'scene'" class="generate-next-level">
            <label class="field-label"
              >逐层展开
              {{
                target.level === "synopsis"
                  ? "分卷大纲"
                  : target.level === "volume"
                    ? "章纲"
                    : "场景细纲"
              }}</label
            ><NInputNumber v-model:value="count" :min="1" :max="30" /><NButton
              :disabled="structureLocked"
              @click="store.safe(generateChildren)"
              >生成 {{ count }} 项供审核</NButton
            >
          </div>
          <NButton
            v-if="target.level === 'synopsis'"
            :disabled="structureLocked"
            @click="
              store.safe(() =>
                store.runTask('outline', {
                  planningTarget: { level: 'chapter', count },
                }),
              )
            "
            >直接生成 {{ count }} 章</NButton
          >
        </div>
        <div v-else class="planning-detail inline-empty">
          <p>
            {{
              target.level === "volume"
                ? "卷纲可留空，使用默认第一卷即可直接写作。"
                : target.level === "scene"
                  ? "场景细纲按需使用，无需填写也能正常写作。"
                  : "尚无章节，可直接创建空章开始写作。"
            }}
          </p>
          <NButton
            :disabled="store.busy || (target.level === 'scene' && !chapter)"
            @click="store.safe(() => add(target.level))"
            >{{
              target.level === "volume"
                ? "新增分卷"
                : target.level === "scene"
                  ? "新增场景细纲"
                  : "新增章节"
            }}</NButton
          >
          <NButton @click="store.safe(startWriting)">开始写作</NButton>
        </div>
      </div>
    </template>
    <NModal
      :show="showLegacyConfirm"
      @update:show="
        (value) => {
          if (!convertingLegacy) showLegacyConfirm = value;
        }
      "
      preset="card"
      title="整理旧蓝图为总纲？"
      :style="{ width: '560px' }"
      :closable="!convertingLegacy"
      :mask-closable="!convertingLegacy"
    >
      <p>
        将使用当前文字模型「{{
          legacyModel
        }}」，根据已有故事蓝图和设定生成总纲候选。
      </p>
      <p>
        旧蓝图会保留。生成结果先进入审核区，由你编辑、确认采用后才更新总纲。
      </p>
      <template #footer
        ><div class="modal-footer">
          <NButton
            :disabled="convertingLegacy"
            @click="showLegacyConfirm = false"
            >取消</NButton
          >
          <NButton
            type="primary"
            :disabled="structureLocked"
            :loading="convertingLegacy"
            @click="store.safe(convertLegacy)"
            >确认生成候选</NButton
          >
        </div></template
      >
    </NModal>
    <NModal
      :show="!!pendingMove"
      @update:show="
        (value) => {
          if (!value && !moveBusy) pendingMove = null;
        }
      "
      preset="card"
      title="整理历史章节顺序？"
      :style="{ width: '720px' }"
      :closable="!moveBusy"
      :mask-closable="!moveBusy"
    >
      <p>
        现有章节在不同分卷之间交错排列。此次移动将同时按各卷及其章节整理正式顺序，正文列表、AI
        前文参考和导出会同步更新。
      </p>
      <div v-if="pendingMove" class="planning-order-preview">
        <section>
          <h4>当前顺序</h4>
          <ol>
            <li
              v-for="id in pendingMove.preview.beforeOrder"
              :key="id"
              :class="{
                'order-changed':
                  pendingMove.preview.beforeOrder.indexOf(id) !==
                  pendingMove.preview.afterOrder.indexOf(id),
              }"
            >
              {{ orderLabel(id) }}
            </li>
          </ol>
        </section>
        <section>
          <h4>调整后顺序</h4>
          <ol>
            <li
              v-for="id in pendingMove.preview.afterOrder"
              :key="id"
              :class="{
                'order-changed':
                  pendingMove.preview.beforeOrder.indexOf(id) !==
                  pendingMove.preview.afterOrder.indexOf(id),
              }"
            >
              {{ orderLabel(id) }}
            </li>
          </ol>
        </section>
      </div>
      <p class="field-help">
        标色章节的位置将变化。操作前保存规划快照；正文内容保留，受影响的已采用章节和自动记忆按连续性规则处理。
      </p>
      <template #footer
        ><div class="modal-footer">
          <NButton :disabled="moveBusy" @click="pendingMove = null"
            >取消</NButton
          >
          <NButton
            type="primary"
            :disabled="store.busy || store.imageBusy"
            :loading="moveBusy"
            @click="store.safe(confirmMove)"
            >确认调整顺序</NButton
          >
        </div></template
      >
    </NModal>
    <NModal
      v-model:show="showNewChapter"
      preset="card"
      title="新增章节"
      class="form-modal"
      :style="{ width: '620px' }"
    >
      <p class="field-help">
        章纲可留空，直接创建空章开始写作。填写的章纲默认保存为草稿，也可立即确认。
      </p>
      <label class="field-label">章节名称（可选）</label
      ><NInput v-model:value="newChapterTitle" placeholder="留空自动命名" />
      <label class="field-label">所属分卷</label
      ><NSelect
        v-model:value="newChapterVolume"
        :options="plan.volumes.map((v) => ({ label: v.title, value: v.id }))"
        placeholder="默认第一卷"
      />
      <label class="field-label">章纲（可选）</label
      ><NInput
        v-model:value="newChapterContent"
        type="textarea"
        :autosize="{ minRows: 7, maxRows: 18 }"
        :placeholder="planningHints.chapter"
      />
      <template #footer
        ><div class="modal-footer">
          <NButton @click="showNewChapter = false">稍后继续</NButton
          ><NButton
            :disabled="store.busy"
            :loading="creatingChapter"
            @click="store.safe(() => confirmNewChapter())"
            >{{
              newChapterContent.trim() ? "创建章节并保存章纲草稿" : "创建空章"
            }}</NButton
          ><NButton
            type="primary"
            :loading="creatingChapter"
            :disabled="!newChapterContent.trim() || store.busy"
            @click="store.safe(() => confirmNewChapter(true))"
            >确认章纲并创建空章</NButton
          >
        </div></template
      >
    </NModal>
    <NModal
      v-model:show="showHistory"
      preset="card"
      title="规划版本"
      class="form-modal"
      :style="{ width: '680px' }"
      ><p v-if="!history.length">暂无保存的规划版本。</p>
      <article v-for="v in history" :key="v.id" class="planning-version">
        <span>{{ v.label }} · {{ new Date(v.createdAt).toLocaleString() }}</span
        ><NButton @click="viewingVersion = v">查看</NButton
        ><NButton @click="store.safe(() => restore(v.id))">恢复规划</NButton>
        <VersionActions
          :id="v.id"
          :label="v.label"
          planning
          @changed="
            store.safe(async () => {
              viewingVersion = null;
              history = await store.api(
                'planning:history',
                store.detail!.project.id,
              );
            })
          "
        />
      </article>
      <p class="field-help">
        恢复更新规划及版本记录的章节顺序，不删除或改写正文。顺序变化按连续性规则复核；旧版本未记录顺序时保留当前章序。
      </p>
      <section v-if="viewingVersion">
        <h3>{{ viewingVersion.label }}</h3>
        <label class="field-label">总纲</label
        ><NInput
          :value="viewingVersion.novelPlan.synopsis.content"
          type="textarea"
          readonly
          :autosize="{ minRows: 3, maxRows: 10 }"
        />
        <article v-for="v in viewingVersion.novelPlan.volumes" :key="v.id">
          <h4>{{ v.title }}</h4>
          <NInput
            :value="v.plan.content"
            type="textarea"
            readonly
            :autosize="{ minRows: 2, maxRows: 8 }"
          />
        </article>
        <article v-for="c in viewingVersion.chapters" :key="c.id">
          <h4>
            {{
              c.title ||
              store.detail.chapters.find((item) => item.id === c.id)?.title ||
              "历史章节"
            }}
          </h4>
          <NInput
            :value="c.plan"
            type="textarea"
            readonly
            :autosize="{ minRows: 2, maxRows: 8 }"
          />
          <p v-for="s in c.scenes" :key="s.id">
            {{ s.title }}：{{ s.plan.content }}
          </p>
        </article>
      </section>
    </NModal>
    <NModal
      :show="!!removing"
      @update:show="
        (v) => {
          if (!v && !removalBusy) removing = null;
        }
      "
      preset="card"
      :title="removing?.wholeChapter ? '删除整章？' : '清空或删除规划？'"
      :style="{ width: '560px' }"
    >
      <p>对象：{{ removing?.label }}</p>
      <p v-if="removing?.wholeChapter">
        本章正文、版本和关联记忆将删除，插画保留。后续已采用章节可能需要复核。此操作无法撤销。
      </p>
      <p v-else-if="removing?.target.level === 'volume'">
        删除此分卷后，章节归入剩余第一卷；没有其他分卷时显示空白的第一卷。章节顺序和正文保留，操作前保存规划快照。
      </p>
      <p v-else-if="removing?.target.level === 'chapter'">
        清空章纲及其确认内容，保留正文和场景细纲。操作前保存规划快照。
      </p>
      <p v-else>移除此项规划内容，已有正文保留。操作前保存规划快照。</p>
      <p v-if="!removing?.wholeChapter">
        已确认规划发生变化时，仅标记关联规划和正文待核对，正式记忆保持有效。
      </p>
      <template #footer
        ><div class="modal-footer">
          <NButton :disabled="removalBusy" @click="removing = null"
            >取消</NButton
          ><NButton
            type="error"
            :disabled="store.busy || store.imageBusy"
            :loading="removalBusy"
            @click="store.safe(remove)"
            >确认操作</NButton
          >
        </div></template
      >
    </NModal>
  </section>
</template>
