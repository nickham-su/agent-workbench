<template>
  <div class="space-y-3">
    <div class="text-xs text-[color:var(--text-tertiary)]">
      {{ t("settings.agentProfiles.description") }}
    </div>

    <div class="flex items-center justify-end gap-2">
      <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentProfiles.saving") }}</div>
      <a-button size="small" type="primary" :disabled="loading" @click="openCreateAgent">
        {{ t("settings.agentProfiles.actions.addAgent") }}
      </a-button>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <div v-else-if="agents.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
      {{ t("settings.agentProfiles.empty") }}
    </div>

    <div v-else class="divide-y divide-[var(--border-color-secondary)] border border-[var(--border-color-secondary)] rounded">
      <div
        v-for="agent in agents"
        :key="agent.id"
        class="group flex items-start justify-between gap-3 px-2 py-2 hover:bg-[var(--panel-bg-elevated)]"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center gap-2">
            <div class="font-semibold text-xs truncate" :title="agent.name">{{ agent.name }}</div>
            <div class="text-xs text-[color:var(--text-tertiary)] truncate">{{ agent.id }}</div>
            <a-tag v-if="isDefaultAgent(agent.id)" color="blue" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ t("common.default") }}</a-tag>
          </div>

          <div class="flex flex-wrap gap-1">
            <a-tag
              v-for="tool in agent.tools"
              :key="`${agent.id}-${tool}`"
              color="default"
              class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0"
            >
              {{ toolLabel(tool) }}
            </a-tag>
          </div>

          <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
            {{ t("settings.agentProfiles.fields.defaultModel") }}: {{ defaultModelLabel(agent.defaultModel) }}
          </div>
        </div>

        <div class="shrink-0 flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
          <a-button
            v-if="!isDefaultAgent(agent.id)"
            size="small"
            type="text"
            @click="setDefaultAgent(agent.id)"
            :title="t('settings.agentProfiles.actions.setDefault')"
            :aria-label="t('settings.agentProfiles.actions.setDefault')"
          >
            {{ t("settings.agentProfiles.actions.setDefault") }}
          </a-button>
          <a-button
            size="small"
            type="text"
            @click="openEditAgent(agent.id)"
            :title="t('settings.agentProfiles.actions.edit')"
            :aria-label="t('settings.agentProfiles.actions.edit')"
          >
            <template #icon><EditOutlined /></template>
          </a-button>
          <a-button
            size="small"
            type="text"
            danger
            @click="confirmDeleteAgent(agent.id)"
            :title="t('settings.agentProfiles.actions.delete')"
            :aria-label="t('settings.agentProfiles.actions.delete')"
          >
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
      </div>
    </div>

    <a-modal
      v-model:open="agentModalOpen"
      :title="agentModalMode === 'create' ? t('settings.agentProfiles.agentModal.createTitle') : t('settings.agentProfiles.agentModal.editTitle')"
      :maskClosable="false"
      :okText="t('settings.agentProfiles.modal.ok')"
      :cancelText="t('settings.agentProfiles.modal.cancel')"
      @ok="submitAgent"
      @cancel="closeAgentModal"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('settings.agentProfiles.agentForm.idLabel')" :required="true">
          <a-input v-model:value="agentFormId" disabled />
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.agentForm.nameLabel')" :required="true">
          <a-input v-model:value="agentFormName" />
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.agentForm.promptLabel')">
          <a-textarea
            v-model:value="agentFormPrompt"
            :auto-size="{ minRows: 4, maxRows: 12 }"
            :placeholder="t('settings.agentProfiles.agentForm.promptPlaceholder')"
          />
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.tools')">
          <a-checkbox-group v-model:value="agentFormTools" :options="toolOptions" />
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.permissions')">
          <a-space direction="vertical" size="small">
            <a-checkbox v-model:checked="agentFormAllowRead">{{ t("settings.agentProfiles.permissions.allowRead") }}</a-checkbox>
            <a-checkbox v-model:checked="agentFormAllowWrite">{{ t("settings.agentProfiles.permissions.allowWrite") }}</a-checkbox>
            <a-checkbox v-model:checked="agentFormAllowBash">{{ t("settings.agentProfiles.permissions.allowBash") }}</a-checkbox>
          </a-space>
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.agentForm.defaultModelModeLabel')">
          <a-radio-group v-model:value="agentFormDefaultModelMode">
            <a-radio value="global">{{ t("settings.agentProfiles.fields.useGlobalDefault") }}</a-radio>
            <a-radio value="custom">{{ t("settings.agentProfiles.fields.customDefaultModel") }}</a-radio>
          </a-radio-group>
        </a-form-item>

        <template v-if="agentFormDefaultModelMode === 'custom'">
          <a-form-item :label="t('settings.agentProfiles.agentForm.defaultProviderLabel')" :required="true">
            <a-select
              v-model:value="agentFormDefaultProviderId"
              :options="providerSelectOptions"
              :placeholder="t('settings.agentProfiles.agentForm.defaultProviderPlaceholder')"
              @change="onAgentDefaultProviderChange"
            />
          </a-form-item>

          <a-form-item :label="t('settings.agentProfiles.agentForm.defaultModelLabel')" :required="true">
            <a-select
              v-model:value="agentFormDefaultModelId"
              :options="currentProviderModelOptions"
              :placeholder="t('settings.agentProfiles.agentForm.defaultModelPlaceholder')"
            />
          </a-form-item>
        </template>

        <a-form-item>
          <a-checkbox v-model:checked="agentFormSetAsDefault">{{ t("settings.agentProfiles.agentForm.setAsDefault") }}</a-checkbox>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import type {
  AgentDefaultModel,
  AgentProvidersSettingsView,
  AgentSettings,
  AgentToolName,
  UpdateAgentSettingsRequest
} from "@agent-workbench/shared";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { getAgentProvidersSettings, getAgentSettings, updateAgentSettings } from "@/shared/api";

const { t } = useI18n();

type EditingAgent = {
  id: string;
  name: string;
  prompt: string;
  tools: AgentToolName[];
  permissions: {
    allowRead: boolean;
    allowWrite: boolean;
    allowBash: boolean;
  };
  defaultModel: AgentDefaultModel;
};

type DefaultModelMode = "global" | "custom";

const DEFAULT_TOOLS: AgentToolName[] = ["bash", "read", "write"];

const toolOptions = computed(() => [
  { label: t("settings.agentProfiles.tools.bash"), value: "bash" },
  { label: t("settings.agentProfiles.tools.read"), value: "read" },
  { label: t("settings.agentProfiles.tools.write"), value: "write" }
]);

const loading = ref(false);
const saving = ref(false);
const pendingSave = ref(false);

const providersSettings = ref<AgentProvidersSettingsView | null>(null);
const agents = ref<EditingAgent[]>([]);
const selectedDefaultAgentId = ref<string | null>(null);

const agentModalOpen = ref(false);
const agentModalMode = ref<"create" | "edit">("create");
const agentFormId = ref("");
const agentFormName = ref("");
const agentFormPrompt = ref("");
const agentFormTools = ref<AgentToolName[]>([...DEFAULT_TOOLS]);
const agentFormAllowRead = ref(true);
const agentFormAllowWrite = ref(true);
const agentFormAllowBash = ref(true);
const agentFormDefaultModelMode = ref<DefaultModelMode>("global");
const agentFormDefaultProviderId = ref("");
const agentFormDefaultModelId = ref("");
const agentFormSetAsDefault = ref(false);

const providerSelectOptions = computed(() => {
  const providers = providersSettings.value?.providers ?? [];
  return providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: provider.name,
      value: provider.id
    }));
});

const currentProviderModelOptions = computed(() => {
  const provider = getProviderById(agentFormDefaultProviderId.value);
  if (!provider) return [];
  return provider.models.map((model) => ({
    label: model.name,
    value: model.id
  }));
});

const canSubmitAgent = computed(() => {
  if (!agentFormId.value.trim()) return false;
  if (!agentFormName.value.trim()) return false;
  if (agentFormTools.value.length === 0) return false;
  if (agentFormDefaultModelMode.value === "custom") {
    if (!agentFormDefaultProviderId.value.trim()) return false;
    if (!agentFormDefaultModelId.value.trim()) return false;
  }
  return true;
});

function newLocalId(prefix: string) {
  const ts = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}${random}`;
}

function normalizeTools(raw: AgentToolName[]) {
  const out: AgentToolName[] = [];
  const seen = new Set<AgentToolName>();
  for (const item of raw) {
    if (item !== "bash" && item !== "read" && item !== "write") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : [...DEFAULT_TOOLS];
}

function mapFromSettings(settings: AgentSettings, providers: AgentProvidersSettingsView) {
  providersSettings.value = providers;
  agents.value = settings.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    prompt: agent.prompt,
    tools: normalizeTools(agent.tools),
    permissions: {
      allowRead: agent.permissions.allowRead,
      allowWrite: agent.permissions.allowWrite,
      allowBash: agent.permissions.allowBash
    },
    defaultModel: agent.defaultModel
  }));

  const candidate = settings.default?.agentId?.trim() || null;
  selectedDefaultAgentId.value = candidate && agents.value.some((item) => item.id === candidate) ? candidate : null;
}

function getProviderById(providerId: string) {
  return providersSettings.value?.providers.find((item) => item.id === providerId) ?? null;
}

function findModel(providerId: string, modelId: string) {
  const provider = getProviderById(providerId);
  if (!provider) return null;
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) return null;
  return { provider, model };
}

function defaultModelLabel(defaultModel: AgentDefaultModel) {
  if (!defaultModel) return t("settings.agentProfiles.fields.useGlobalDefault");
  const found = findModel(defaultModel.providerId, defaultModel.modelId);
  if (!found) {
    return `${defaultModel.providerId}/${defaultModel.modelId}`;
  }
  return `${found.provider.name} / ${found.model.name}`;
}

function toolLabel(tool: AgentToolName) {
  if (tool === "bash") return t("settings.agentProfiles.tools.bash");
  if (tool === "read") return t("settings.agentProfiles.tools.read");
  return t("settings.agentProfiles.tools.write");
}

function isDefaultAgent(agentId: string) {
  return selectedDefaultAgentId.value === agentId;
}

function syncDefaultAgent() {
  if (!selectedDefaultAgentId.value) return;
  if (!agents.value.some((agent) => agent.id === selectedDefaultAgentId.value)) {
    selectedDefaultAgentId.value = null;
  }
}

function toRequestBody() {
  syncDefaultAgent();
  return {
    default: selectedDefaultAgentId.value ? { agentId: selectedDefaultAgentId.value } : null,
    agents: agents.value.map((agent) => ({
      id: agent.id,
      name: agent.name.trim() || agent.id,
      prompt: agent.prompt,
      tools: normalizeTools(agent.tools),
      permissions: {
        allowRead: agent.permissions.allowRead,
        allowWrite: agent.permissions.allowWrite,
        allowBash: agent.permissions.allowBash
      },
      defaultModel: agent.defaultModel
    }))
  } satisfies UpdateAgentSettingsRequest;
}

function openCreateAgent() {
  agentModalMode.value = "create";
  agentFormId.value = newLocalId("agent");
  agentFormName.value = "";
  agentFormPrompt.value = "";
  agentFormTools.value = [...DEFAULT_TOOLS];
  agentFormAllowRead.value = true;
  agentFormAllowWrite.value = true;
  agentFormAllowBash.value = true;
  agentFormDefaultModelMode.value = "global";
  agentFormDefaultProviderId.value = "";
  agentFormDefaultModelId.value = "";
  agentFormSetAsDefault.value = false;
  agentModalOpen.value = true;
}

function openEditAgent(agentId: string) {
  const target = agents.value.find((item) => item.id === agentId);
  if (!target) return;
  agentModalMode.value = "edit";
  agentFormId.value = target.id;
  agentFormName.value = target.name;
  agentFormPrompt.value = target.prompt;
  agentFormTools.value = normalizeTools(target.tools);
  agentFormAllowRead.value = target.permissions.allowRead;
  agentFormAllowWrite.value = target.permissions.allowWrite;
  agentFormAllowBash.value = target.permissions.allowBash;

  if (target.defaultModel) {
    agentFormDefaultModelMode.value = "custom";
    agentFormDefaultProviderId.value = target.defaultModel.providerId;
    agentFormDefaultModelId.value = target.defaultModel.modelId;
  } else {
    agentFormDefaultModelMode.value = "global";
    agentFormDefaultProviderId.value = "";
    agentFormDefaultModelId.value = "";
  }

  agentFormSetAsDefault.value = isDefaultAgent(target.id);
  agentModalOpen.value = true;
}

function closeAgentModal() {
  agentModalOpen.value = false;
  agentModalMode.value = "create";
  agentFormId.value = "";
  agentFormName.value = "";
  agentFormPrompt.value = "";
  agentFormTools.value = [...DEFAULT_TOOLS];
  agentFormAllowRead.value = true;
  agentFormAllowWrite.value = true;
  agentFormAllowBash.value = true;
  agentFormDefaultModelMode.value = "global";
  agentFormDefaultProviderId.value = "";
  agentFormDefaultModelId.value = "";
  agentFormSetAsDefault.value = false;
}

function onAgentDefaultProviderChange(nextProviderId: string) {
  const provider = getProviderById(nextProviderId);
  if (!provider || provider.models.length === 0) {
    agentFormDefaultModelId.value = "";
    return;
  }
  if (provider.models.some((item) => item.id === agentFormDefaultModelId.value)) return;
  agentFormDefaultModelId.value = provider.models[0]!.id;
}

function submitAgent() {
  if (!canSubmitAgent.value) {
    message.error(t("settings.agentProfiles.errors.invalidAgentForm"));
    return;
  }

  const id = agentFormId.value.trim();
  const name = agentFormName.value.trim();
  if (!id || !name) {
    message.error(t("settings.agentProfiles.errors.invalidAgentForm"));
    return;
  }

  const defaultModel =
    agentFormDefaultModelMode.value === "custom"
      ? {
          providerId: agentFormDefaultProviderId.value.trim(),
          modelId: agentFormDefaultModelId.value.trim()
        }
      : null;

  if (agentFormDefaultModelMode.value === "custom") {
    const found = findModel(defaultModel!.providerId, defaultModel!.modelId);
    if (!found) {
      message.error(t("settings.agentProfiles.errors.defaultModelInvalid"));
      return;
    }
  }

  const payload: EditingAgent = {
    id,
    name,
    prompt: agentFormPrompt.value,
    tools: normalizeTools(agentFormTools.value),
    permissions: {
      allowRead: agentFormAllowRead.value,
      allowWrite: agentFormAllowWrite.value,
      allowBash: agentFormAllowBash.value
    },
    defaultModel
  };

  if (agentModalMode.value === "create") {
    if (agents.value.some((item) => item.id === id)) {
      message.error(t("settings.agentProfiles.errors.duplicateAgentId"));
      return;
    }
    agents.value.push(payload);
  } else {
    const idx = agents.value.findIndex((item) => item.id === id);
    if (idx < 0) return;
    agents.value[idx] = payload;
  }

  if (agentFormSetAsDefault.value) {
    selectedDefaultAgentId.value = id;
  } else if (selectedDefaultAgentId.value === id && agentModalMode.value === "edit") {
    selectedDefaultAgentId.value = null;
  }

  closeAgentModal();
  void persist({ toast: true });
}

function setDefaultAgent(agentId: string) {
  selectedDefaultAgentId.value = agentId;
  void persist({ toast: false });
}

function confirmDeleteAgent(agentId: string) {
  const target = agents.value.find((item) => item.id === agentId);
  if (!target) return;
  Modal.confirm({
    title: t("settings.agentProfiles.deleteAgent.title"),
    content: t("settings.agentProfiles.deleteAgent.content", { name: target.name }),
    okText: t("settings.agentProfiles.deleteAgent.ok"),
    cancelText: t("settings.agentProfiles.deleteAgent.cancel"),
    okType: "danger",
    onOk: () => {
      agents.value = agents.value.filter((item) => item.id !== agentId);
      if (selectedDefaultAgentId.value === agentId) {
        selectedDefaultAgentId.value = null;
      }
      void persist({ toast: true });
    }
  });
}

async function refreshDraft() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [agentSettings, providerSettings] = await Promise.all([getAgentSettings(), getAgentProvidersSettings()]);
    mapFromSettings(agentSettings, providerSettings);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function persist(params: { toast: boolean }) {
  if (saving.value) {
    pendingSave.value = true;
    return;
  }
  saving.value = true;
  try {
    const body = toRequestBody();
    const res = await updateAgentSettings(body);
    mapFromSettings(res, providersSettings.value ?? { default: null, providers: [], updatedAt: 0 });
    if (params.toast) message.success(t("settings.agentProfiles.saved"));
  } catch (err) {
    // 自动保存失败时保留本地改动, 后续操作会再次触发 persist
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
    if (pendingSave.value) {
      pendingSave.value = false;
      void persist({ toast: false });
    }
  }
}

onMounted(() => {
  void refreshDraft();
});

defineExpose({
  refresh: refreshDraft
});
</script>
