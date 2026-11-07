<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton, NSelect, NInput, NModal, NPopconfirm } from "naive-ui";
import { useWorkspace } from "../stores/workspace";
import { displayReview } from "../../shared/conversations";
import { roleDefinitions } from "../../shared/roles";
const store = useWorkspace();
const renaming = ref(false),
  name = ref("");
const options = computed(() =>
  store.conversations.map((c) => ({
    value: c.id,
    label: `${roleDefinitions.find((r) => r.id === c.target.kind)?.name ?? "创作"} · ${c.title}`,
  })),
);
const status = {
  generating: "生成中",
  complete: "已完成",
  stopped: "已停止",
  error: "生成失败",
  interrupted: "已中断",
};
async function rename() {
  await store.renameConversation(name.value);
  renaming.value = false;
}
</script>

<template>
  <section class="conversation-history" aria-label="创作对话与版本">
    <div class="workbench-section-heading">
      <h3>创作对话</h3>
      <NButton
        size="tiny"
        :disabled="store.busy || store.conversationLoading"
        @click="store.safe(store.newConversation)"
        >新建对话</NButton
      >
    </div>
    <NSelect
      :value="store.conversationId || null"
      :options="options"
      filterable
      placeholder="选择历史对话，或直接生成"
      :disabled="store.busy || store.conversationLoading"
      @update:value="(id) => store.safe(() => store.openConversation(id))"
    />
    <div
      v-if="store.activeConversation"
      class="workbench-actions conversation-management"
    >
      <NButton
        size="tiny"
        :disabled="store.busy"
        @click="
          name = store.activeConversation.title;
          renaming = true;
        "
        >重命名</NButton
      >
      <NPopconfirm
        @positive-click="store.safe(store.deleteConversation)"
        positive-text="删除对话"
        negative-text="取消"
      >
        <template #trigger
          ><NButton size="tiny" :disabled="store.busy"
            >删除对话</NButton
          ></template
        >
        删除此对话及全部版本？已写入故事的内容和已有蓝图候选保留。
      </NPopconfirm>
    </div>
    <p v-if="store.conversationInvalidReason" class="review-banner">
      {{ store.conversationInvalidReason }}
    </p>
    <div v-if="store.turns.length" class="conversation-versions">
      <details
        v-for="turn in store.turns"
        :key="turn.id"
        :class="{ selected: turn.id === store.selectedTurnId }"
      >
        <summary>
          <span
            ><strong>版本 {{ turn.number }}</strong
            ><small v-if="turn.parentTurnId">
              · 基于版本
              {{
                store.turns.find((t) => t.id === turn.parentTurnId)?.number
              }}</small
            ></span
          >
          <small
            >{{ status[turn.status]
            }}{{ turn.applied.length ? " · 已写入" : "" }}</small
          >
        </summary>
        <p class="conversation-instruction">
          <strong>作者要求</strong><br />{{
            turn.instruction || "按当前资料完成任务"
          }}
        </p>
        <pre class="conversation-response">{{
          displayReview(turn.review) || turn.rawResponse || "尚未收到内容"
        }}</pre>
        <p v-if="turn.error" class="field-help">{{ turn.error }}</p>
        <p v-if="turn.invalidReason" class="review-banner">
          {{ turn.invalidReason }}
        </p>
        <p v-if="turn.applied.length" class="field-help">
          {{ turn.applied.join("；") }}
        </p>
        <NButton
          size="small"
          :type="turn.id === store.selectedTurnId ? 'primary' : 'default'"
          :disabled="store.busy || store.conversationLoading"
          @click="store.safe(() => store.selectVersion(turn.id))"
        >
          {{ turn.id === store.selectedTurnId ? "当前选中版本" : "选择此版本" }}
        </NButton>
      </details>
    </div>
    <p v-if="store.selectedTurn" class="field-help" role="status">
      当前选中版本
      {{
        store.selectedTurn.number
      }}。补充要求后将基于此版本生成完整新版；也可在下方审核采用。
    </p>
    <p v-if="store.selectedTurn?.invalidReason" class="review-banner">
      {{ store.selectedTurn.invalidReason }}
    </p>
  </section>
  <NModal
    v-model:show="renaming"
    preset="dialog"
    title="重命名创作对话"
    positive-text="保存"
    negative-text="取消"
    :positive-button-props="{ disabled: !name.trim() }"
    @positive-click="() => store.safe(rename)"
    @negative-click="renaming = false"
  >
    <NInput v-model:value="name" maxlength="200" placeholder="对话名称" />
  </NModal>
</template>
