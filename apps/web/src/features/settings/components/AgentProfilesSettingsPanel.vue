<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentProfiles.description") }}
      </div>
      <div class="flex items-center gap-2">
        <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentProfiles.saving") }}</div>
        <a-button size="small" type="primary" :disabled="loading" @click="openCreateAgent">
          {{ t("settings.agentProfiles.actions.addAgent") }}
        </a-button>
      </div>
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

          <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
            {{ t("settings.agentProfiles.fields.summary") }}: {{ agent.summary || "-" }}
          </div>

          <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
            {{ t("settings.agentProfiles.fields.globalPrompts") }}: {{ globalPromptSummary(agent.globalPromptIds) }}
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

        <a-form-item :label="t('settings.agentProfiles.agentForm.summaryLabel')">
          <a-textarea
            v-model:value="agentFormSummary"
            :auto-size="{ minRows: 2, maxRows: 4 }"
            :maxlength="160"
            :placeholder="t('settings.agentProfiles.agentForm.summaryPlaceholder')"
          />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentProfiles.agentForm.summaryHelp") }}
          </div>
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.agentForm.promptLabel')">
          <a-textarea
            v-model:value="agentFormPrompt"
            :auto-size="{ minRows: 4, maxRows: 12 }"
            :placeholder="t('settings.agentProfiles.agentForm.promptPlaceholder')"
          />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentProfiles.agentForm.promptBytesHelp", { maxKb: AGENT_PROMPT_MAX_BYTES / 1024, bytes: agentPromptBytes }) }}
          </div>
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.globalPrompts')">
          <a-select
            v-model:value="agentFormGlobalPromptIds"
            mode="multiple"
            :options="globalPromptOptions"
            :placeholder="t('settings.agentProfiles.agentForm.globalPromptsPlaceholder')"
          />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentProfiles.agentForm.globalPromptsHelp") }}
          </div>
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.tools')">
          <a-select v-model:value="agentFormTools" mode="multiple" :options="toolOptions" />
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.mcpServers')">
          <a-select
            v-model:value="agentFormMcpServers"
            mode="multiple"
            :options="mcpServerOptions"
            :placeholder="t('settings.agentProfiles.agentForm.mcpServersPlaceholder')"
          />
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.permissions')">
          <a-space direction="vertical" size="small">
            <a-checkbox v-model:checked="agentFormAllowRead">{{ t("settings.agentProfiles.permissions.allowRead") }}</a-checkbox>
            <a-checkbox v-model:checked="agentFormAllowWrite">{{ t("settings.agentProfiles.permissions.allowWrite") }}</a-checkbox>
            <a-checkbox v-model:checked="agentFormAllowBash">{{ t("settings.agentProfiles.permissions.allowBash") }}</a-checkbox>
          </a-space>
        </a-form-item>

        <a-form-item :label="t('settings.agentProfiles.fields.defaultModel')">
          <a-cascader
            v-model:value="agentFormDefaultModelPath"
            :options="defaultModelCascaderOptions"
            :placeholder="t('settings.agentProfiles.agentForm.defaultModelCascaderPlaceholder')"
            :show-search="true"
            expand-trigger="hover"
          />
        </a-form-item>

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
  AgentGlobalPromptSettings,
  AgentMcpSettings,
  AgentProvidersSettingsView,
  AgentSettings,
  AgentToolName,
  UpdateAgentSettingsRequest
} from "@agent-workbench/shared";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import {
  getAgentGlobalPromptSettings,
  getAgentMcpSettings,
  getAgentProvidersSettings,
  getAgentSettings,
  updateAgentSettings
} from "@/shared/api";

const { t } = useI18n();

type EditingAgent = {
  id: string;
  name: string;
  summary: string;
  prompt: string;
  globalPromptIds: string[];
  tools: AgentToolName[];
  mcpServers: string[];
  permissions: {
    allowRead: boolean;
    allowWrite: boolean;
    allowBash: boolean;
  };
  defaultModel: AgentDefaultModel;
};

const GLOBAL_DEFAULT_MODEL_PATH = "__global__";
const AGENT_PROMPT_MAX_BYTES = 32 * 1024;
const RESERVED_GLOBAL_SYSTEM_PROMPT_ID = "global_system_prompt";

const DEFAULT_TOOLS: AgentToolName[] = [
  "bash",
  "read",
  "write",
  "apply_patch",
  "todolist",
  "subtask",
  "archive_search",
  "archive_read"
];

const toolOptions = computed(() => [
  { label: t("settings.agentProfiles.tools.bash"), value: "bash" },
  { label: t("settings.agentProfiles.tools.read"), value: "read" },
  { label: t("settings.agentProfiles.tools.write"), value: "write" },
  { label: t("settings.agentProfiles.tools.applyPatch"), value: "apply_patch" },
  { label: t("settings.agentProfiles.tools.todolist"), value: "todolist" },
  { label: t("settings.agentProfiles.tools.subtask"), value: "subtask" },
  { label: t("settings.agentProfiles.tools.archiveSearch"), value: "archive_search" },
  { label: t("settings.agentProfiles.tools.archiveRead"), value: "archive_read" }
]);

const loading = ref(false);
const saving = ref(false);
const pendingSave = ref(false);

const providersSettings = ref<AgentProvidersSettingsView | null>(null);
const mcpSettings = ref<AgentMcpSettings | null>(null);
const globalPromptSettings = ref<AgentGlobalPromptSettings | null>(null);
const agents = ref<EditingAgent[]>([]);
const selectedDefaultAgentId = ref<string | null>(null);

const agentModalOpen = ref(false);
const agentModalMode = ref<"create" | "edit">("create");
const agentFormId = ref("");
const agentFormName = ref("");
const agentFormSummary = ref("");
const agentFormPrompt = ref("");
const agentFormGlobalPromptIds = ref<string[]>([]);
const agentFormTools = ref<AgentToolName[]>([...DEFAULT_TOOLS]);
const agentFormMcpServers = ref<string[]>([]);
const agentFormAllowRead = ref(true);
const agentFormAllowWrite = ref(true);
const agentFormAllowBash = ref(true);
const agentFormDefaultModelPath = ref<string[]>([GLOBAL_DEFAULT_MODEL_PATH]);
const agentFormSetAsDefault = ref(false);

const defaultModelCascaderOptions = computed(() => {
  const providers = providersSettings.value?.providers ?? [];
  return [
    {
      label: t("settings.agentProfiles.fields.useGlobalDefault"),
      value: GLOBAL_DEFAULT_MODEL_PATH
    },
    ...providers
      .filter((provider) => provider.models.length > 0)
      .map((provider) => ({
        label: provider.name,
        value: provider.id,
        children: provider.models.map((model) => ({
          label: model.name,
          value: model.id
        }))
      }))
  ];
});

const mcpServerOptions = computed(() => {
  const servers = mcpSettings.value?.servers ?? [];
  return servers.map((server) => ({
    label: server.id,
    value: server.id
  }));
});

const globalPromptOptions = computed(() => {
  const items = globalPromptSettings.value?.items ?? [];
  return items.filter((item) => item.id !== RESERVED_GLOBAL_SYSTEM_PROMPT_ID).map((item) => ({
    label: item.title,
    value: item.id
  }));
});

const agentPromptBytes = computed(() => new TextEncoder().encode(agentFormPrompt.value).length);

const canSubmitAgent = computed(() => {
  if (!agentFormId.value.trim()) return false;
  if (!agentFormName.value.trim()) return false;
  if (agentFormTools.value.length === 0) return false;
  if (toDefaultModelFromPath(agentFormDefaultModelPath.value) === undefined) return false;
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
    if (
      item !== "bash" &&
      item !== "read" &&
      item !== "write" &&
      item !== "apply_patch" &&
      item !== "todolist" &&
      item !== "subtask" &&
      item !== "archive_search" &&
      item !== "archive_read"
    ) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : [...DEFAULT_TOOLS];
}

function normalizeMcpServers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const available = new Set((mcpSettings.value?.servers ?? []).map((item) => item.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!value || seen.has(value) || !available.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeGlobalPromptIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const available = new Set(
    (globalPromptSettings.value?.items ?? []).filter((item) => item.id !== RESERVED_GLOBAL_SYSTEM_PROMPT_ID).map((item) => item.id)
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = typeof item === "string" ? item.trim() : "";
    if (!value || seen.has(value) || !available.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function mapFromSettings(
  settings: AgentSettings,
  providers: AgentProvidersSettingsView,
  mcp: AgentMcpSettings,
  globalPrompts: AgentGlobalPromptSettings
) {
  providersSettings.value = providers;
  mcpSettings.value = mcp;
  globalPromptSettings.value = globalPrompts;
  agents.value = settings.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    summary: agent.summary,
    prompt: agent.prompt,
    globalPromptIds: normalizeGlobalPromptIds(agent.globalPromptIds),
    tools: normalizeTools(agent.tools),
    mcpServers: normalizeMcpServers(agent.mcpServers),
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

function toDefaultModelFromPath(pathRaw: unknown): AgentDefaultModel | undefined {
  const path = Array.isArray(pathRaw)
    ? pathRaw.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
    : [];
  if (path.length === 1 && path[0] === GLOBAL_DEFAULT_MODEL_PATH) return null;
  if (path.length !== 2) return undefined;
  const [providerId, modelId] = path;
  if (!providerId || !modelId) return undefined;
  const found = findModel(providerId, modelId);
  if (!found) return undefined;
  return { providerId, modelId };
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
  if (tool === "write") return t("settings.agentProfiles.tools.write");
  if (tool === "apply_patch") return t("settings.agentProfiles.tools.applyPatch");
  if (tool === "todolist") return t("settings.agentProfiles.tools.todolist");
  if (tool === "subtask") return t("settings.agentProfiles.tools.subtask");
  if (tool === "archive_search") return t("settings.agentProfiles.tools.archiveSearch");
  if (tool === "archive_read") return t("settings.agentProfiles.tools.archiveRead");
  return tool;
}

function globalPromptLabel(id: string) {
  if (id === RESERVED_GLOBAL_SYSTEM_PROMPT_ID) return "";
  const item = globalPromptSettings.value?.items.find((entry) => entry.id === id);
  return item?.title || id;
}

function globalPromptSummary(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) return "-";
  const labels = ids.map((id) => globalPromptLabel(id)).filter((item) => item.trim().length > 0);
  if (labels.length === 0) return "-";
  return labels.join(", ");
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
      summary: agent.summary.trim(),
      prompt: agent.prompt,
      globalPromptIds: normalizeGlobalPromptIds(agent.globalPromptIds),
      tools: normalizeTools(agent.tools),
      mcpServers: normalizeMcpServers(agent.mcpServers),
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
  agentFormSummary.value = "";
  agentFormPrompt.value = "";
  agentFormGlobalPromptIds.value = [];
  agentFormTools.value = [...DEFAULT_TOOLS];
  agentFormMcpServers.value = [];
  agentFormAllowRead.value = true;
  agentFormAllowWrite.value = true;
  agentFormAllowBash.value = true;
  agentFormDefaultModelPath.value = [GLOBAL_DEFAULT_MODEL_PATH];
  agentFormSetAsDefault.value = false;
  agentModalOpen.value = true;
}

function openEditAgent(agentId: string) {
  const target = agents.value.find((item) => item.id === agentId);
  if (!target) return;
  agentModalMode.value = "edit";
  agentFormId.value = target.id;
  agentFormName.value = target.name;
  agentFormSummary.value = target.summary;
  agentFormPrompt.value = target.prompt;
  agentFormGlobalPromptIds.value = normalizeGlobalPromptIds(target.globalPromptIds);
  agentFormTools.value = normalizeTools(target.tools);
  agentFormMcpServers.value = normalizeMcpServers(target.mcpServers);
  agentFormAllowRead.value = target.permissions.allowRead;
  agentFormAllowWrite.value = target.permissions.allowWrite;
  agentFormAllowBash.value = target.permissions.allowBash;
  agentFormDefaultModelPath.value = target.defaultModel
    ? [target.defaultModel.providerId, target.defaultModel.modelId]
    : [GLOBAL_DEFAULT_MODEL_PATH];

  agentFormSetAsDefault.value = isDefaultAgent(target.id);
  agentModalOpen.value = true;
}

function closeAgentModal() {
  agentModalOpen.value = false;
  agentModalMode.value = "create";
  agentFormId.value = "";
  agentFormName.value = "";
  agentFormSummary.value = "";
  agentFormPrompt.value = "";
  agentFormGlobalPromptIds.value = [];
  agentFormTools.value = [...DEFAULT_TOOLS];
  agentFormMcpServers.value = [];
  agentFormAllowRead.value = true;
  agentFormAllowWrite.value = true;
  agentFormAllowBash.value = true;
  agentFormDefaultModelPath.value = [GLOBAL_DEFAULT_MODEL_PATH];
  agentFormSetAsDefault.value = false;
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

  const defaultModel = toDefaultModelFromPath(agentFormDefaultModelPath.value);
  if (defaultModel === undefined) {
    message.error(t("settings.agentProfiles.errors.defaultModelInvalid"));
    return;
  }
  if (agentPromptBytes.value > AGENT_PROMPT_MAX_BYTES) {
    message.error(t("settings.agentProfiles.errors.promptTooLong", { maxKb: AGENT_PROMPT_MAX_BYTES / 1024 }));
    return;
  }

  const payload: EditingAgent = {
    id,
    name,
    summary: agentFormSummary.value.trim(),
    prompt: agentFormPrompt.value,
    globalPromptIds: normalizeGlobalPromptIds(agentFormGlobalPromptIds.value),
    tools: normalizeTools(agentFormTools.value),
    mcpServers: normalizeMcpServers(agentFormMcpServers.value),
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
    const [agentSettings, providerSettings, mcp, globalPrompts] = await Promise.all([
      getAgentSettings(),
      getAgentProvidersSettings(),
      getAgentMcpSettings(),
      getAgentGlobalPromptSettings()
    ]);
    mapFromSettings(agentSettings, providerSettings, mcp, globalPrompts);
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
    mapFromSettings(
      res,
      providersSettings.value ?? { default: null, providers: [], updatedAt: 0 },
      mcpSettings.value ?? { servers: [], updatedAt: 0 },
      globalPromptSettings.value ?? { items: [], updatedAt: 0 }
    );
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
