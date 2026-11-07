<script setup lang="ts">
import { computed, h, ref, watch } from "vue";
import { NButton, NTree, type TreeOption } from "naive-ui";
import { GripVertical } from "lucide-vue-next";
import type {
  PlanningMove,
  PlanningTarget,
  PlanningTreeRef,
  ProjectDetail,
} from "../../shared/types";
import { chapterPlan, planStatus } from "../../shared/planning";
import { planningNodeKey, validPlanningDrop } from "../../shared/planning-tree";
import ItemActions from "./ItemActions.vue";

const props = defineProps<{
  detail: ProjectDetail;
  target: PlanningTarget;
  disabled: boolean;
}>();
const emit = defineEmits<{
  select: [target: PlanningTarget];
  move: [move: PlanningMove];
  action: [target: PlanningTarget, label: string, key: string];
}>();
type Node = TreeOption & {
  key: string;
  node: PlanningTreeRef;
  label: string;
  status: string;
  children?: Node[];
};
const data = computed<Node[]>(() => {
  const { chapters, project } = props.detail,
    plan = project.novelPlan!;
  const children = (volumeId: string): Node[] =>
    chapters
      .filter((c) => c.volumeId === volumeId)
      .map((c) => ({
        key: planningNodeKey({ level: "chapter", id: c.id }),
        label: `${c.position} · ${c.title}`,
        node: { level: "chapter", id: c.id },
        status: planStatus(chapterPlan(c)),
        children: (c.scenes ?? []).map((s) => ({
          key: planningNodeKey({ level: "scene", id: s.id }),
          label: s.title,
          node: { level: "scene", id: s.id, parentId: c.id },
          status: planStatus(s.plan),
          isLeaf: true,
        })),
      }));
  return [
    {
      key: "synopsis:root",
      label: "全书总纲",
      status: planStatus(plan.synopsis),
      node: { level: "synopsis" },
      isLeaf: true,
    },
    ...plan.volumes.map((v): Node => ({
      key: planningNodeKey({ level: "volume", id: v.id }),
      label: v.title,
      status: planStatus(v.plan),
      node: { level: "volume", id: v.id },
      children: children(v.id),
      isLeaf: false,
    })),
  ];
});
const expanded = ref<string[]>([]),
  dragging = ref<PlanningTreeRef | null>(null);
const storageKey = () => `planning-tree.expanded.${props.detail.project.id}`;
const expandable = () =>
  data.value
    .flatMap((n) => [n, ...(n.children ?? [])])
    .filter(
      (n) => !n.isLeaf && (n.children?.length || n.node.level !== "chapter"),
    )
    .map((n) => n.key);
function setExpanded(keys: (string | number)[]) {
  expanded.value = keys.map(String);
  try {
    localStorage.setItem(storageKey(), JSON.stringify(expanded.value));
  } catch {
    /* View preferences do not block writing. */
  }
}
watch(
  () => props.detail.project.id,
  () => {
    let saved: unknown;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey()) ?? "null");
    } catch {
      /* Use the default groups. */
    }
    expanded.value =
      Array.isArray(saved) && saved.every((v) => typeof v === "string")
        ? saved
        : data.value.filter((n) => n.children).map((n) => n.key);
  },
  { immediate: true },
);
const ancestors = computed(() => {
  const c = props.detail.chapters.find(
    (c) =>
      c.id ===
      (props.target.level === "chapter"
        ? props.target.id
        : props.target.parentId),
  );
  if (!c) return [];
  const volume = props.detail.project.novelPlan!.volumes.find(
    (v) => v.id === c.volumeId,
  );
  return [
    ...(volume ? [`volume:${volume.id}`] : []),
    ...(props.target.level === "scene" ? [`chapter:${c.id}`] : []),
  ];
});
watch(
  () =>
    `${props.detail.project.id}:${planningNodeKey(props.target)}:${ancestors.value.join(",")}`,
  () => {
    if (ancestors.value.length)
      setExpanded([...new Set([...expanded.value, ...ancestors.value])]);
  },
  { immediate: true },
);
function select(node: Node) {
  emit("select", node.node as PlanningTarget);
}
const renderLabel = ({ option }: { option: TreeOption }) => {
  const n = option as Node;
  return h("span", { class: "planning-node-label", title: n.label }, [
    h("span", n.label),
    h("small", n.status),
  ]);
};
const renderPrefix = ({ option }: { option: TreeOption }) =>
  (option as Node).node.level === "synopsis"
    ? null
    : h(GripVertical, {
        size: 13,
        class: "planning-drag-grip",
        "aria-hidden": "true",
      });
const renderSuffix = ({ option }: { option: TreeOption }) => {
  const n = option as Node;
  const target = n.node as PlanningTarget;
  return h(ItemActions, {
    label: n.label,
    disabled: props.disabled,
    actions:
      n.node.level === "synopsis"
        ? [{ key: "clear", label: "清空总纲" }]
        : n.node.level === "volume"
          ? [{ key: "delete", label: "删除分卷，保留章节" }]
          : n.node.level === "chapter"
            ? [
                { key: "clear", label: "清空章纲，保留正文和细纲" },
                { key: "delete-chapter", label: "删除整章（含正文）" },
              ]
            : [{ key: "delete", label: "删除场景细纲" }],
    onEdit: () => emit("select", target),
    onAction: (key: string) => emit("action", target, n.label, key),
  });
};
function nodeProps({ option }: { option: TreeOption }) {
  const n = option as Node;
  return {
    "data-planning-node": n.key,
    class: [
      "planning-tree-node",
      {
        "planning-fixed-node": n.node.level === "synopsis",
        "planning-drop-before":
          dropMark.value?.key === n.key &&
          dropMark.value.placement === "before",
        "planning-drop-after":
          dropMark.value?.key === n.key && dropMark.value.placement === "after",
        "planning-drop-inside":
          dropMark.value?.key === n.key &&
          dropMark.value.placement === "inside",
      },
    ],
    onDragstartCapture: (event: DragEvent) => {
      event.stopImmediatePropagation();
      if (
        props.disabled ||
        n.node.level === "synopsis" ||
        (event.target instanceof Element &&
          event.target.closest(".item-actions"))
      ) {
        event.preventDefault();
        return;
      }
      dragging.value = n.node;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", n.key);
      }
    },
    // NTree's generic DnD rewrites boundary drops to the previous descendant.
    // Keep this domain-specific drop attached to the row under the pointer.
    onDragoverCapture: (event: DragEvent) => {
      event.stopImmediatePropagation();
      const move = dropAt(event, n);
      dropMark.value = move ? { key: n.key, placement: move.placement } : null;
      if (move) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      }
    },
    onDropCapture: (event: DragEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
      const move = dropAt(event, n);
      dragging.value = null;
      dropMark.value = null;
      if (move) emit("move", move);
    },
    onDragendCapture: () => {
      dragging.value = null;
      dropMark.value = null;
    },
    onDragleaveCapture: (event: DragEvent) => {
      if (
        !(event.relatedTarget instanceof Element) ||
        !(event.currentTarget as HTMLElement).contains(event.relatedTarget)
      )
        dropMark.value = null;
    },
  };
}
const dropMark = ref<{
  key: string;
  placement: PlanningMove["placement"];
} | null>(null);
function dropAt(event: DragEvent, n: Node): PlanningMove | null {
  if (props.disabled || !dragging.value) return null;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const placement =
    dragging.value.level === "chapter" && n.node.level === "volume"
      ? "inside"
      : event.clientY < bounds.top + bounds.height / 2
        ? "before"
        : "after";
  const move: PlanningMove = {
    source: dragging.value,
    target: n.node,
    placement,
  };
  return validPlanningDrop(move) ? move : null;
}
</script>
<template>
  <nav class="planning-tree" aria-label="分层大纲">
    <div class="planning-tree-toolbar">
      <NButton size="tiny" @click="setExpanded(expandable())">全部展开</NButton>
      <NButton size="tiny" @click="setExpanded([])">全部收起</NButton>
    </div>
    <NTree
      :data="data"
      :expanded-keys="expanded"
      :selected-keys="[planningNodeKey(target)]"
      :draggable="!disabled"
      :block-line="true"
      :expand-on-click="false"
      :indent="16"
      show-line
      :render-label="renderLabel"
      :render-prefix="renderPrefix"
      :render-suffix="renderSuffix"
      :node-props="nodeProps"
      @update:expanded-keys="setExpanded"
      @update:selected-keys="
        (_keys, options) => {
          if (options[0]) select(options[0] as Node);
        }
      "
    />
    <p class="field-help planning-tree-hint">
      拖动调整顺序；章节可跨卷，场景仅在本章内排序。
    </p>
  </nav>
</template>
