<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentProviders.description") }}
      </div>
      <div class="flex items-center gap-2">
        <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentProviders.saving") }}</div>
        <a-button size="small" type="primary" :disabled="loading" @click="openCreateProvider">
          {{ t("settings.agentProviders.actions.addProvider") }}
        </a-button>
      </div>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <div v-else-if="providers.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
      {{ t("settings.agentProviders.empty") }}
    </div>

    <div v-else class="divide-y divide-[var(--border-color-secondary)] border border-[var(--border-color-secondary)] rounded">
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="group flex items-start justify-between gap-3 px-2 py-2 hover:bg-[var(--panel-bg-elevated)]"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <div class="font-semibold text-xs truncate" :title="provider.name">{{ provider.name }}</div>
            <div class="text-xs text-[color:var(--text-tertiary)] truncate">{{ provider.id }}</div>
            <a-tag v-if="isDefaultProvider(provider.id)" color="blue" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ t("common.default") }}</a-tag>
            <a-tag v-if="provider.npm" color="default" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ provider.npm }}</a-tag>
          </div>

          <div class="mt-2">
            <div class="flex flex-wrap gap-1">
              <template v-if="provider.models.length === 0">
                <span class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentProviders.fields.noModels") }}</span>
              </template>

              <template v-else>
                <div v-for="model in provider.models" :key="model.id" class="inline-flex items-center gap-1">
                  <a-tag
                    class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0"
                    :color="isDefaultModel(provider.id, model.id) ? 'blue' : undefined"
                  >
                    {{ model.name }}
                  </a-tag>
                </div>
              </template>
            </div>
          </div>
        </div>

        <div class="shrink-0 flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
          <a-button
            size="small"
            type="text"
            @click="openManageModels(provider.id)"
            :title="t('settings.agentProviders.actions.manageModels')"
            :aria-label="t('settings.agentProviders.actions.manageModels')"
          >
            <template #icon><UnorderedListOutlined /></template>
          </a-button>
          <a-button
            size="small"
            type="text"
            @click="openEditProvider(provider.id)"
            :title="t('settings.agentProviders.actions.edit')"
            :aria-label="t('settings.agentProviders.actions.edit')"
          >
            <template #icon><EditOutlined /></template>
          </a-button>
          <a-button
            size="small"
            type="text"
            danger
            @click="confirmDeleteProvider(provider.id)"
            :title="t('settings.agentProviders.actions.delete')"
            :aria-label="t('settings.agentProviders.actions.delete')"
          >
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
      </div>
    </div>

    <a-modal
      v-model:open="providerModalOpen"
      :title="providerModalMode === 'create' ? t('settings.agentProviders.providerModal.createTitle') : t('settings.agentProviders.providerModal.editTitle')"
      :maskClosable="false"
      :okText="t('settings.agentProviders.modal.ok')"
      :cancelText="t('settings.agentProviders.modal.cancel')"
      @ok="submitProvider"
      @cancel="closeProviderModal"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('settings.agentProviders.providerForm.idLabel')" :required="true">
          <a-input v-model:value="providerFormId" disabled />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.providerForm.nameLabel')" :required="true">
          <a-input v-model:value="providerFormName" />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.providerForm.npmLabel')" :required="true">
          <a-select v-model:value="providerFormNpm" :options="providerNpmOptions" @change="onProviderNpmChange" />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.providerForm.baseUrlLabel')" :required="true">
          <a-input v-model:value="providerFormBaseURL" />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.providerForm.apiKeyLabel')">
          <a-input-password
            v-model:value="providerFormApiKey"
            :placeholder="providerModalMode === 'create' ? t('settings.agentProviders.providerForm.apiKeyPlaceholder') : t('settings.agentProviders.providerForm.apiKeyEditPlaceholder')"
          />
          <div v-if="providerModalMode === 'create'" class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t('settings.agentProviders.providerForm.apiKeyCreateHelp') }}
          </div>
          <div v-else class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t('settings.agentProviders.providerForm.apiKeyEditHelp') }}
          </div>
          <a-checkbox
            v-if="providerModalMode === 'edit' && providerFormHasApiKey"
            v-model:checked="providerFormClearApiKey"
            class="pt-2"
          >
            {{ t('settings.agentProviders.providerForm.clearApiKey') }}
          </a-checkbox>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="modelManagerOpen"
      :title="t('settings.agentProviders.modelManager.title', { name: modelManagerProviderName })"
      :maskClosable="false"
      :zIndex="MODEL_MANAGER_Z_INDEX"
      :footer="null"
      @cancel="closeModelManager"
    >
      <div class="space-y-2">
        <div class="flex items-center justify-end">
          <a-button size="small" type="primary" @click="openAddModel(modelManagerProviderId)">
            {{ t('settings.agentProviders.actions.addModel') }}
          </a-button>
        </div>

        <div v-if="modelManagerModels.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
          {{ t('settings.agentProviders.modelManager.empty') }}
        </div>

        <div v-else class="divide-y divide-[var(--border-color-secondary)] border border-[var(--border-color-secondary)] rounded">
          <div
            v-for="model in modelManagerModels"
            :key="model.id"
            class="flex items-center justify-between gap-2 px-2 py-2"
          >
            <div class="min-w-0 flex-1">
              <div class="text-left text-xs font-semibold truncate">
                {{ model.name }}
              </div>
              <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">{{ model.providerModelId }}</div>
            </div>
            <div class="shrink-0 flex items-center gap-1">
              <a-tag v-if="isDefaultModel(modelManagerProviderId, model.id)" color="blue" class="!text-[10px] !leading-[16px] !px-1 !py-0">
                {{ t("common.default") }}
              </a-tag>
              <a-button size="small" type="text" @click="openEditModel(modelManagerProviderId, model.id)">
                {{ t('settings.agentProviders.actions.edit') }}
              </a-button>
              <a-button
                v-if="!isDefaultModel(modelManagerProviderId, model.id)"
                size="small"
                type="text"
                @click="setDefaultModel(modelManagerProviderId, model.id, true)"
              >
                {{ t('settings.agentProviders.actions.setDefault') }}
              </a-button>
              <a-button size="small" type="text" danger @click="confirmDeleteModel(modelManagerProviderId, model.id)">
                {{ t('settings.agentProviders.actions.delete') }}
              </a-button>
            </div>
          </div>
        </div>
      </div>
    </a-modal>

    <a-modal
      v-model:open="modelModalOpen"
      :title="modelModalMode === 'create' ? t('settings.agentProviders.modelModal.createTitle') : t('settings.agentProviders.modelModal.editTitle')"
      :maskClosable="false"
      :zIndex="MODEL_EDITOR_Z_INDEX"
      @cancel="closeModelModal"
    >
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <a-button @click="closeModelModal">{{ t('settings.agentProviders.modal.cancel') }}</a-button>
          <a-button type="primary" :disabled="!canSubmitModel" @click="submitModel">
            {{ t('settings.agentProviders.modal.ok') }}
          </a-button>
        </div>
      </template>
      <a-form layout="vertical">
        <a-form-item :label="t('settings.agentProviders.modelForm.idLabel')" :required="true">
          <a-input v-model:value="modelFormId" disabled />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.modelForm.providerModelIdLabel')" :required="true">
          <a-input v-model:value="modelFormProviderModelId" />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.modelForm.nameLabel')" :required="true">
          <a-input v-model:value="modelFormName" />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.modelForm.aiSdkLabel')">
          <a-textarea v-model:value="modelFormAiSdkJson" :auto-size="{ minRows: 5, maxRows: 12 }" class="font-mono text-xs" />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            <span>{{ t('settings.agentProviders.modelForm.aiSdkHelp') }}</span>
            <span> </span>
            <a
              :href="AI_SDK_SETTINGS_DOC_URL"
              target="_blank"
              rel="noreferrer"
              class="underline"
            >
              {{ t('settings.agentProviders.modelForm.aiSdkDocsLink') }}
            </a>
          </div>
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.modelForm.providerOptionsLabel', { key: modelFormProviderOptionsKey })">
          <a-textarea v-model:value="modelFormProviderOptionsJson" :auto-size="{ minRows: 5, maxRows: 12 }" class="font-mono text-xs" />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            <span>{{ t('settings.agentProviders.modelForm.providerOptionsHelp', { key: modelFormProviderOptionsKey }) }}</span>
            <span> </span>
            <a
              :href="providerDocsUrlForNpm(getProvider(modelFormProviderId)?.npm ?? DEFAULT_PROVIDER_NPM)"
              target="_blank"
              rel="noreferrer"
              class="underline"
            >
              {{ t('settings.agentProviders.modelForm.providerDocsLink') }}
            </a>
          </div>
        </a-form-item>
        <a-form-item>
          <a-checkbox v-model:checked="modelFormDefault">{{ t('settings.agentProviders.modelForm.setAsDefault') }}</a-checkbox>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import type {
  AgentProviderNpm,
  AgentProvidersSettingsView,
  UpdateAgentProvidersSettingsRequest
} from "@agent-workbench/shared";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { DeleteOutlined, EditOutlined, UnorderedListOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { getAgentProvidersSettings, updateAgentProvidersSettings } from "@/shared/api";

const { t } = useI18n();

type ApiKeyState = "keep" | "set" | "clear";

type JsonMap = Record<string, unknown>;

type EditingModel = {
  id: string;
  providerModelId: string;
  name: string;
  options: JsonMap;
};

type EditingProvider = {
  id: string;
  name: string;
  npm: AgentProviderNpm;
  baseURL: string;
  apiKeyInput: string;
  apiKeyState: ApiKeyState;
  apiKeyMasked: string | null;
  models: EditingModel[];
};

type ProviderDefaultRef = {
  providerId: string;
  modelId: string;
};

const DEFAULT_PROVIDER_NPM: AgentProviderNpm = "@ai-sdk/openai";
const MODEL_MANAGER_Z_INDEX = 1000;
const MODEL_EDITOR_Z_INDEX = 1100;

const AI_SDK_SETTINGS_DOC_URL = "https://ai-sdk.dev/docs/ai-sdk-core/settings";

const providerNpmOptions: Array<{ value: AgentProviderNpm; label: string }> = [
  { value: "@ai-sdk/openai", label: "OpenAI (@ai-sdk/openai)" },
  { value: "@ai-sdk/anthropic", label: "Anthropic (@ai-sdk/anthropic)" }
];

const loading = ref(false);
const saving = ref(false);
const providers = ref<EditingProvider[]>([]);
const selectedDefault = ref<ProviderDefaultRef | null>(null);

const providerModalOpen = ref(false);
const providerModalMode = ref<"create" | "edit">("create");
const providerFormId = ref("");
const providerFormName = ref("");
const providerFormNpm = ref<AgentProviderNpm>(DEFAULT_PROVIDER_NPM);
const providerFormBaseURL = ref("");
const providerFormApiKey = ref("");
const providerFormClearApiKey = ref(false);
const providerFormHasApiKey = ref(false);

const modelModalOpen = ref(false);
const modelModalMode = ref<"create" | "edit">("create");
const modelFormProviderId = ref("");
const modelFormOriginalId = ref("");
const modelFormId = ref("");
const modelFormProviderModelId = ref("");
const modelFormName = ref("");
const modelFormAiSdkJson = ref("{}");
const modelFormProviderOptionsJson = ref("{}");
const modelFormDefault = ref(false);

const modelManagerOpen = ref(false);
const modelManagerProviderId = ref("");

const modelManagerProvider = computed(() => getProvider(modelManagerProviderId.value));
const modelManagerProviderName = computed(() => modelManagerProvider.value?.name ?? "");
const modelManagerModels = computed(() => modelManagerProvider.value?.models ?? []);
const modelFormProviderOptionsKey = computed(() => {
  const provider = getProvider(modelFormProviderId.value);
  return provider ? providerOptionsKeyForNpm(provider.npm) : providerOptionsKeyForNpm(DEFAULT_PROVIDER_NPM);
});

const canSubmitProvider = computed(() => {
  if (!providerFormId.value.trim()) return false;
  if (!providerFormName.value.trim()) return false;
  if (!providerFormNpm.value) return false;
  if (!providerFormBaseURL.value.trim()) return false;
  return true;
});

const canSubmitModel = computed(() => {
  if (!modelFormId.value.trim()) return false;
  if (!modelFormProviderModelId.value.trim()) return false;
  if (!modelFormName.value.trim()) return false;
  const provider = getProvider(modelFormProviderId.value);
  if (!provider) return false;
  if (modelModalMode.value === "edit") return true;
  return !provider.models.some((item) => item.id === modelFormId.value.trim());
});

function getProvider(providerId: string) {
  return providers.value.find((item) => item.id === providerId) ?? null;
}

function sanitizeDefault(selection: ProviderDefaultRef | null, providerList: EditingProvider[]) {
  if (!selection) return null;
  const provider = providerList.find((item) => item.id === selection.providerId);
  if (!provider) return null;
  if (!provider.models.some((model) => model.id === selection.modelId)) return null;
  return selection;
}

function syncDefaultWithProviders() {
  selectedDefault.value = sanitizeDefault(selectedDefault.value, providers.value);
}

function mapFromSettings(view: AgentProvidersSettingsView) {
  const nextProviders = view.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    npm: provider.npm,
    baseURL: provider.options.baseURL,
    apiKeyInput: "",
    apiKeyState: "keep" as const,
    apiKeyMasked: provider.options.apiKeyMasked,
    models: provider.models.map((model) => ({
      id: model.id,
      providerModelId:
        typeof model.providerModelId === "string" && model.providerModelId.trim() ? model.providerModelId.trim() : model.id,
      name: model.name,
      options: toJsonRecord(model.options)
    }))
  }));

  providers.value = nextProviders;
  selectedDefault.value = sanitizeDefault(view.default, nextProviders);
}

const isDefaultProvider = (providerId: string) => selectedDefault.value?.providerId === providerId;

const isDefaultModel = (providerId: string, modelId: string) => {
  return selectedDefault.value?.providerId === providerId && selectedDefault.value?.modelId === modelId;
};

function providerOptionsKeyForNpm(npm: AgentProviderNpm) {
  return npm === "@ai-sdk/anthropic" ? "anthropic" : "openai";
}

function providerDocsUrlForNpm(npm: AgentProviderNpm) {
  if (npm === "@ai-sdk/anthropic") return "https://ai-sdk.dev/providers/ai-sdk-providers/anthropic";
  return "https://ai-sdk.dev/providers/ai-sdk-providers/openai";
}

function toJsonRecord(raw: unknown): JsonMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: JsonMap = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    out[key] = value;
  }
  return out;
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(text: string, errorKey: string) {
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(t(errorKey));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t(errorKey));
  }
  return toJsonRecord(parsed);
}

function newLocalId(prefix: string) {
  const ts = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}${random}`;
}

function providerApiKeyLabel(provider: EditingProvider) {
  if (provider.apiKeyState === "clear") return t("settings.agentProviders.fields.apiKeyNotSet");
  if (provider.apiKeyState === "set" && provider.apiKeyInput) {
    return t("settings.agentProviders.fields.apiKeySet");
  }
  if (provider.apiKeyState === "set" && !provider.apiKeyInput) return t("settings.agentProviders.fields.apiKeyKeep");
  if (provider.apiKeyMasked) return provider.apiKeyMasked;
  return t("settings.agentProviders.fields.apiKeyNotSet");
}

function maskApiKey(raw: string) {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

function defaultBaseURLForNpm(npm: AgentProviderNpm) {
  if (npm === "@ai-sdk/anthropic") return "https://api.anthropic.com/v1";
  return "https://api.openai.com/v1";
}

function onProviderNpmChange(nextNpm: AgentProviderNpm) {
  if (providerModalMode.value !== "create") return;
  providerFormBaseURL.value = defaultBaseURLForNpm(nextNpm);
}

function openCreateProvider() {
  providerModalMode.value = "create";
  providerFormId.value = newLocalId("provider");
  providerFormName.value = "";
  providerFormNpm.value = DEFAULT_PROVIDER_NPM;
  providerFormBaseURL.value = defaultBaseURLForNpm(DEFAULT_PROVIDER_NPM);
  providerFormApiKey.value = "";
  providerFormClearApiKey.value = false;
  providerFormHasApiKey.value = false;
  providerModalOpen.value = true;
}

function openEditProvider(providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  providerModalMode.value = "edit";
  providerFormId.value = provider.id;
  providerFormName.value = provider.name;
  providerFormNpm.value = provider.npm;
  providerFormBaseURL.value = provider.baseURL;
  providerFormApiKey.value = "";
  providerFormClearApiKey.value = false;
  providerFormHasApiKey.value = Boolean(provider.apiKeyMasked);
  providerModalOpen.value = true;
}

function closeProviderModal() {
  providerModalOpen.value = false;
  providerModalMode.value = "create";
  providerFormId.value = "";
  providerFormName.value = "";
  providerFormNpm.value = DEFAULT_PROVIDER_NPM;
  providerFormBaseURL.value = "";
  providerFormApiKey.value = "";
  providerFormClearApiKey.value = false;
  providerFormHasApiKey.value = false;
}

function openManageModels(providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  modelManagerProviderId.value = provider.id;
  modelManagerOpen.value = true;
}

function closeModelManager() {
  modelManagerOpen.value = false;
  modelManagerProviderId.value = "";
}

function submitProvider() {
  if (!canSubmitProvider.value) {
    message.error(t("settings.agentProviders.errors.invalidProviderForm"));
    return;
  }

  const nextId = providerFormId.value.trim();
  const nextName = providerFormName.value.trim();
  const nextNpm = providerFormNpm.value;
  const nextBaseURL = providerFormBaseURL.value.trim();
  const nextApiKey = providerFormApiKey.value.trim();

  if (providerModalMode.value === "create") {
    if (providers.value.some((item) => item.id === nextId)) {
      message.error(t("settings.agentProviders.errors.duplicateProviderId"));
      return;
    }
    providers.value.push({
      id: nextId,
      name: nextName,
      npm: nextNpm,
      baseURL: nextBaseURL,
      apiKeyInput: nextApiKey,
      apiKeyState: nextApiKey ? "set" : "clear",
      apiKeyMasked: maskApiKey(nextApiKey),
      models: []
    });
  } else {
    const provider = getProvider(nextId);
    if (!provider) return;
    const prevProviderKey = providerOptionsKeyForNpm(provider.npm);
    const nextProviderKey = providerOptionsKeyForNpm(nextNpm);
    provider.name = nextName;
    provider.npm = nextNpm;
    provider.baseURL = nextBaseURL;
    provider.apiKeyInput = nextApiKey;
    provider.apiKeyState = nextApiKey ? "set" : providerFormClearApiKey.value ? "clear" : "keep";
    if (provider.apiKeyState === "set") {
      provider.apiKeyMasked = nextApiKey ? maskApiKey(nextApiKey) : provider.apiKeyMasked;
    } else if (provider.apiKeyState === "clear") {
      provider.apiKeyMasked = null;
    }

    if (prevProviderKey !== nextProviderKey) {
      for (const model of provider.models) {
        const options = toJsonRecord(model.options);
        const byKey = toJsonRecord(options.providerOptionsByKey);
        const prevOptions = toJsonRecord(byKey[prevProviderKey]);
        const nextOptions = toJsonRecord(byKey[nextProviderKey]);
        if (Object.keys(nextOptions).length === 0 && Object.keys(prevOptions).length > 0) {
          byKey[nextProviderKey] = prevOptions;
        }
        model.options = {
          ...options,
          providerOptionsByKey: byKey
        };
      }
    }
  }

  closeProviderModal();
  void persist({ toast: true });
}

function confirmDeleteProvider(providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  Modal.confirm({
    title: t("settings.agentProviders.deleteProvider.title"),
    content: t("settings.agentProviders.deleteProvider.content", { name: provider.name }),
    okText: t("settings.agentProviders.deleteProvider.ok"),
    cancelText: t("settings.agentProviders.deleteProvider.cancel"),
    okType: "danger",
    onOk: () => {
      providers.value = providers.value.filter((item) => item.id !== providerId);
      if (selectedDefault.value?.providerId === providerId) selectedDefault.value = null;
      if (modelManagerProviderId.value === providerId) closeModelManager();
      syncDefaultWithProviders();
      void persist({ toast: true });
    }
  });
}

function openAddModel(providerId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  modelModalMode.value = "create";
  modelFormProviderId.value = provider.id;
  modelFormOriginalId.value = "";
  modelFormId.value = newLocalId(`${provider.id}-model`);
  modelFormProviderModelId.value = "";
  modelFormName.value = "";
  modelFormAiSdkJson.value = "{}";
  modelFormProviderOptionsJson.value = "{}";
  modelFormDefault.value = false;
  modelModalOpen.value = true;
}

function openEditModel(providerId: string, modelId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) return;

  modelModalMode.value = "edit";
  modelFormProviderId.value = provider.id;
  modelFormOriginalId.value = model.id;
  modelFormId.value = model.id;
  modelFormProviderModelId.value = model.providerModelId;
  modelFormName.value = model.name;
  const options = toJsonRecord(model.options);
  const aiSdk = toJsonRecord(options.aiSdk);
  const providerOptionsByKey = toJsonRecord(options.providerOptionsByKey);
  const providerKey = providerOptionsKeyForNpm(provider.npm);
  const providerOptions = toJsonRecord(providerOptionsByKey[providerKey]);
  modelFormAiSdkJson.value = stringifyPretty(aiSdk);
  modelFormProviderOptionsJson.value = stringifyPretty(providerOptions);
  modelFormDefault.value = isDefaultModel(provider.id, model.id);
  modelModalOpen.value = true;
}

function closeModelModal() {
  modelModalOpen.value = false;
  modelModalMode.value = "create";
  modelFormProviderId.value = "";
  modelFormOriginalId.value = "";
  modelFormId.value = "";
  modelFormProviderModelId.value = "";
  modelFormName.value = "";
  modelFormAiSdkJson.value = "{}";
  modelFormProviderOptionsJson.value = "{}";
  modelFormDefault.value = false;
}

function submitModel() {
  if (!canSubmitModel.value) {
    message.error(t("settings.agentProviders.errors.invalidModelForm"));
    return;
  }

  const provider = getProvider(modelFormProviderId.value);
  if (!provider) return;

  const nextId = modelFormId.value.trim();
  const nextProviderModelId = modelFormProviderModelId.value.trim();
  const nextName = modelFormName.value.trim();
  let aiSdk: JsonMap;
  let providerOptions: JsonMap;
  try {
    aiSdk = parseJsonObject(modelFormAiSdkJson.value, "settings.agentProviders.errors.invalidAiSdkJson");
    providerOptions = parseJsonObject(
      modelFormProviderOptionsJson.value,
      "settings.agentProviders.errors.invalidProviderOptionsJson"
    );
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    return;
  }

  const providerKey = providerOptionsKeyForNpm(provider.npm);
  const modelPayload = {
    id: nextId,
    providerModelId: nextProviderModelId,
    name: nextName,
    options: {
      aiSdk,
      providerOptionsByKey: {
        [providerKey]: providerOptions
      }
    }
  };

  if (modelModalMode.value === "create") {
    provider.models.push(modelPayload);
    if (modelFormDefault.value) {
      selectedDefault.value = { providerId: provider.id, modelId: nextId };
    }
  } else {
    const idx = provider.models.findIndex((item) => item.id === modelFormOriginalId.value);
    if (idx < 0) return;
    provider.models[idx] = modelPayload;

    if (modelFormDefault.value) {
      selectedDefault.value = { providerId: provider.id, modelId: nextId };
    } else if (isDefaultModel(provider.id, modelFormOriginalId.value)) {
      selectedDefault.value = null;
    }
  }

  syncDefaultWithProviders();
  closeModelModal();
  void persist({ toast: true });
}

function confirmDeleteModel(providerId: string, modelId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;

  const target = provider.models.find((item) => item.id === modelId);
  if (!target) return;

  Modal.confirm({
    title: t("settings.agentProviders.deleteModel.title"),
    content: t("settings.agentProviders.deleteModel.content", { name: target.name }),
    okText: t("settings.agentProviders.deleteModel.ok"),
    cancelText: t("settings.agentProviders.deleteModel.cancel"),
    okType: "danger",
    onOk: () => {
      provider.models = provider.models.filter((item) => item.id !== modelId);
      if (isDefaultModel(provider.id, modelId)) selectedDefault.value = null;
      syncDefaultWithProviders();
      void persist({ toast: true });
    }
  });
}

function setDefaultModel(providerId: string, modelId: string, toast = false) {
  selectedDefault.value = { providerId, modelId };
  void persist({ toast });
}

function toDraft() {
  syncDefaultWithProviders();
  return {
    default: selectedDefault.value,
    providers: providers.value.map((provider) => {
      const options = {
        baseURL: provider.baseURL.trim()
      } as { baseURL: string; apiKey?: string | null };

      if (provider.apiKeyState === "set") {
        const next = provider.apiKeyInput.trim();
        options.apiKey = next ? next : null;
      }
      if (provider.apiKeyState === "clear") {
        options.apiKey = null;
      }

      const models = provider.models.map((model) => {
        const modelId = model.id.trim();
        const providerModelId = model.providerModelId.trim() || modelId;
        const modelName = model.name.trim() || modelId;
        const modelOptions = toJsonRecord(model.options);

        return {
          id: modelId,
          providerModelId,
          name: modelName,
          options: modelOptions
        };
      });

      return {
        id: provider.id,
        name: provider.name.trim() || provider.id,
        npm: provider.npm,
        options,
        models
      };
    })
  } satisfies UpdateAgentProvidersSettingsRequest;
}

async function refreshDraft() {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await getAgentProvidersSettings();
    mapFromSettings(res);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

const pendingSave = ref(false);

async function persist(params: { toast: boolean }) {
  if (saving.value) {
    pendingSave.value = true;
    return;
  }
  saving.value = true;
  try {
    const body = toDraft();
    const res = await updateAgentProvidersSettings(body);
    mapFromSettings(res);
    if (params.toast) message.success(t("settings.agentProviders.saved"));
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
