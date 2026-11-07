<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { NInput, NButton, NSelect, NCollapse, NCollapseItem } from "naive-ui";
import { Check, RotateCcw } from "lucide-vue-next";
import { useWorkspace } from "../stores/workspace";
import {
  defaultRoleSettings,
  roleDefinitions,
  rolePrompt,
} from "../../shared/roles";
import type { RoleId, RoleSettings } from "../../shared/types";
import { toolGroups } from "../../shared/tools";
const groups = [
  ...toolGroups.map((g) => ({
    name: g.name,
    roles: roleDefinitions.filter((r) => g.kinds.includes(r.id as never)),
  })),
  {
    name: "资料导入与章节命名",
    roles: roleDefinitions.filter(
      (r) => r.id === "material" || r.id === "title",
    ),
  },
];
const store = useWorkspace(),
  route = useRoute();
const form = ref<RoleSettings>(JSON.parse(JSON.stringify(store.roles)));
const selected = ref<RoleId>("organize"),
  saving = ref(false);
const current = computed(() =>
  form.value.roles.find((role) => role.id === selected.value)!,
);
const definition = computed(() =>
  roleDefinitions.find((role) => role.id === selected.value)!,
);
const preview = computed(() => rolePrompt(form.value, selected.value));
const modelOptions = computed(() => {
  const models = [...store.settings!.text.selectedModels];
  if (current.value.model && !models.includes(current.value.model))
    models.push(current.value.model);
  return models.map((id) => ({
    label:
      id +
      (store.settings!.text.selectedModels.includes(id) ? "" : "（未勾选）"),
    value: id,
  }));
});
watch(
  () => route.query.role,
  (value) => {
    if (roleDefinitions.some((role) => role.id === value))
      selected.value = value as RoleId;
  },
  { immediate: true },
);
function resetRole() {
  current.value.prompt = definition.value.prompt;
  current.value.model = "";
}
async function save() {
  saving.value = true;
  await store.safe(async () => {
    store.roles = await store.api<RoleSettings>("roles:save", form.value);
    form.value = JSON.parse(JSON.stringify(store.roles));
    store.notify("AI 职责已保存，下次生成使用新设置。");
  });
  saving.value = false;
}
</script>
<template>
  <main class="page roles-page">
    <div class="page-heading">
      <h1>AI 职责</h1>
      <NButton type="primary" :loading="saving" @click="save"
        ><template #icon><Check :size="16" /></template>保存职责设置</NButton
      >
    </div>
    <p class="role-page-help">
      每项任务使用对应职责。可以修改工作要求，并为不同职责选择模型；留空则跟随创作区的当前文字模型。
    </p>
    <section class="settings-card role-common">
      <NCollapse
        ><NCollapseItem title="所有职责共用的要求" name="common">
          <NInput
            v-model:value="form.commonPrompt"
            type="textarea"
            :autosize="{ minRows: 5, maxRows: 12 }"
            :maxlength="20000"
            :disabled="saving"
          />
          <NButton
            text
            @click="form.commonPrompt = defaultRoleSettings().commonPrompt"
            :disabled="saving"
            >恢复默认共用要求</NButton
          >
        </NCollapseItem></NCollapse
      >
    </section>
    <div class="roles-layout">
      <nav class="role-list" aria-label="AI 职责列表">
        <template v-for="group in groups" :key="group.name">
          <h3 class="role-group-heading">{{ group.name }}</h3>
          <button
            v-for="item in group.roles"
            :key="item.id"
            :class="{ active: selected === item.id }"
            :disabled="saving"
            @click="selected = item.id"
          >
            <strong>{{ item.name }}</strong
            ><span>{{ item.description }}</span
            ><small>{{
              form.roles.find((role) => role.id === item.id)?.model ||
              "跟随当前文字模型"
            }}</small>
          </button>
        </template>
      </nav>
      <section class="settings-card role-editor" :key="selected">
        <div class="section-toolbar">
          <div>
            <h2>{{ definition.name }}</h2>
            <p class="field-help">{{ definition.description }}</p>
          </div>
          <NButton size="small" :disabled="saving" @click="resetRole"
            ><template #icon><RotateCcw :size="14" /></template
            >恢复此职责默认值</NButton
          >
        </div>
        <label class="field-label first">指定文字模型</label>
        <NSelect
          :value="current.model || null"
          @update:value="current.model = $event || ''"
          :options="modelOptions"
          filterable
          clearable
          placeholder="跟随当前文字模型"
          :disabled="saving"
        />
        <label class="field-label">详细工作要求 / 系统提示词</label>
        <NInput
          v-model:value="current.prompt"
          type="textarea"
          :autosize="{ minRows: 15, maxRows: 28 }"
          :maxlength="20000"
          :disabled="saving"
        />
        <div v-if="definition.contract" class="role-contract">
          <strong>软件读取的输出格式</strong>
          <p>此段由软件附加，用于读取结果；上方工作要求可自由修改。</p>
          <pre>{{ definition.contract }}</pre>
        </div>
        <NCollapse class="role-preview"
          ><NCollapseItem title="查看完整系统提示词" name="effective">
            <pre class="effective-prompt">{{ preview }}</pre>
          </NCollapseItem></NCollapse
        >
      </section>
    </div>
  </main>
</template>
