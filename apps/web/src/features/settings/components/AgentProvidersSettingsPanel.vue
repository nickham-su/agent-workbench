<template>
  <div class="space-y-3">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentProviders.description") }}
        </div>
        <div class="flex items-center gap-2">
          <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentProviders.saving") }}</div>
        </div>
      </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <div v-else class="flex gap-3">
      <!-- Left: Provider list -->
      <div class="shrink-0 w-80">
        <div class="border border-[var(--border-color-secondary)] rounded overflow-hidden">
          <div class="divide-y divide-[var(--border-color-secondary)]">
            <div v-if="providers.length === 0" class="px-3 py-3 text-xs text-[color:var(--text-tertiary)]">
              {{ t("settings.agentProviders.empty") }}
            </div>

            <div
              v-for="provider in providers"
              :key="provider.id"
              class="group flex items-start justify-between gap-3 px-3 py-2 cursor-pointer"
              :class="provider.id === activeProviderId ? 'bg-[var(--panel-bg-elevated)]' : 'hover:bg-[var(--panel-bg-elevated)]'"
              @click="setActiveProvider(provider.id)"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <div class="font-semibold text-xs truncate" :title="provider.name">{{ provider.name }}</div>
                  <a-tag
                    v-if="isDefaultProvider(provider.id)"
                    color="blue"
                    class="!text-[10px] !leading-[16px] !px-1 !py-0"
                  >
                    {{ t("common.default") }}
                  </a-tag>
                  <a-tag v-if="provider.npm" color="default" class="!text-[10px] !leading-[16px] !px-1 !py-0">{{ provider.npm }}</a-tag>
                </div>
                <div class="mt-0.5 text-[11px] text-[color:var(--text-tertiary)] truncate" :title="provider.id">{{ provider.id }}</div>
              </div>

              <div
                class="shrink-0 self-center flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity"
              >
                <a-button
                  size="small"
                  type="text"
                  @click.stop="openEditProvider(provider.id)"
                  :title="t('settings.agentProviders.actions.edit')"
                  :aria-label="t('settings.agentProviders.actions.edit')"
                >
                  <template #icon><EditOutlined /></template>
                </a-button>
                <a-button
                  size="small"
                  type="text"
                  danger
                  @click.stop="confirmDeleteProvider(provider.id)"
                  :title="t('settings.agentProviders.actions.delete')"
                  :aria-label="t('settings.agentProviders.actions.delete')"
                >
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </div>
            </div>

            <div class="px-3 py-2">
              <a-button type="dashed" size="small" style="width: 100%" @click="openCreateProvider">
                {{ t('settings.agentProviders.actions.addProvider') }}
              </a-button>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: Model list -->
      <div class="min-w-0 flex-1">
        <div class="border border-[var(--border-color-secondary)] rounded overflow-hidden">
          <div v-if="providers.length === 0" class="px-3 py-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentProviders.empty") }}
          </div>
          <div v-else-if="!activeProvider" class="px-3 py-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentProviders.selectProviderHint") }}
          </div>
          <div v-else-if="sortedActiveModels.length === 0" class="px-3 py-3 text-xs text-[color:var(--text-tertiary)]">
            {{ t('settings.agentProviders.modelManager.empty') }}
          </div>
          <div v-else class="divide-y divide-[var(--border-color-secondary)]">
            <div v-for="model in sortedActiveModels" :key="model.id" class="flex items-center justify-between gap-2 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <div class="text-left text-xs font-semibold truncate">
                    {{ model.name }}
                  </div>
                  <a-tag
                    v-if="isDefaultModel(activeProviderId, model.id)"
                    color="blue"
                    class="!text-[10px] !leading-[16px] !px-1 !py-0"
                  >
                    {{ t("common.default") }}
                  </a-tag>
                </div>
                <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
                  {{ t('settings.agentProviders.modelForm.idLabel') }}: {{ model.id }}
                </div>
                <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
                  {{ t('settings.agentProviders.modelForm.providerModelIdLabel') }}: {{ model.providerModelId }}
                </div>
                <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
                  {{ t('settings.agentProviders.modelForm.contextWindowTokensLabel') }}: {{ model.contextWindowTokens }}
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-1">
                <a-button
                  v-if="activeProvider && !isDefaultModel(activeProviderId, model.id)"
                  size="small"
                  type="text"
                  @click="setDefaultModel(activeProviderId, model.id, true)"
                >
                  {{ t('settings.agentProviders.actions.setDefault') }}
                </a-button>
                <a-button size="small" type="text" @click="openEditModel(activeProviderId, model.id)">
                  {{ t('settings.agentProviders.actions.edit') }}
                </a-button>
                <a-button size="small" type="text" @click="copyModel(activeProviderId, model.id)">
                  {{ t('settings.agentProviders.actions.copy') }}
                </a-button>
                <a-button size="small" type="text" danger @click="confirmDeleteModel(activeProviderId, model.id)">
                  {{ t('settings.agentProviders.actions.delete') }}
                </a-button>
              </div>
            </div>
          </div>

          <div class="px-3 py-2 border-t border-[var(--border-color-secondary)]">
            <a-button
              type="dashed"
              size="small"
              style="width: 100%"
              :disabled="!activeProvider"
              @click="activeProvider && openAddModel(activeProvider.id)"
            >
              {{ t('settings.agentProviders.actions.addModel') }}
            </a-button>
          </div>
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
        <a-form-item
          v-if="providerFormNpm === '@ai-sdk/openai'"
          :label="t('settings.agentProviders.providerForm.apiModeLabel')"
          :required="true"
        >
          <a-select
            v-model:value="providerFormApiMode"
            :options="providerApiModeOptions"
          />
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
           <a-input
             v-model:value="modelFormId"
             @input="onModelIdInput"
             @blur="onModelIdBlur"
           />
           <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
             {{ t('settings.agentProviders.modelForm.idHelp') }}
           </div>
         </a-form-item>
         <a-form-item :label="t('settings.agentProviders.modelForm.providerModelIdLabel')" :required="true">
           <a-select
             v-model:value="modelFormProviderModelId"
             show-search
             :filter-option="filterProviderModelIdOption"
             mode="combobox"
             :options="providerModelIdOptions"
             :loading="providerModelIdOptionsLoading"
             :not-found-content="providerModelIdOptionsLoading ? t('common.loading') : undefined"
             @search="onProviderModelIdSearch"
             @change="onProviderModelIdChange"
           />
           <div v-if="providerModelIdOptionsWarning" class="pt-1 text-xs text-[color:var(--text-tertiary)]">
             {{ providerModelIdOptionsWarning }}
           </div>
         </a-form-item>
         <a-form-item v-if="modelModalMode === 'edit' && renameReferenceError" :label="t('settings.agentProviders.modelForm.renameGuardLabel')">
           <a-alert
             type="warning"
            :message="renameReferenceError"
            show-icon
          />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.modelForm.nameLabel')" :required="true">
          <a-input v-model:value="modelFormName" />
        </a-form-item>
        <a-form-item :label="t('settings.agentProviders.modelForm.contextWindowTokensLabel')" :required="true">
          <a-input-number
            v-model:value="modelFormContextWindowTokens"
            :min="1"
            :max="10000000"
            :step="1000"
            :precision="0"
            style="width: 100%"
          />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t('settings.agentProviders.modelForm.contextWindowTokensHelp') }}
          </div>
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
  AgentProviderModelsListItem,
  AgentProvidersSettingsView,
  AgentProviderOpenAiApiMode,
  AgentSettingsView,
  UpdateAgentProvidersSettingsRequest
} from "@agent-workbench/shared";
import { Modal, message, type SelectProps } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import {
  ApiError,
  getAgentProviderModels,
  getAgentProvidersSettings,
  getAgentSettings,
  updateAgentProvidersSettings
} from "@/shared/api";

const { t } = useI18n();

type ApiKeyState = "keep" | "set" | "clear";

type JsonMap = Record<string, unknown>;

type EditingModel = {
  id: string;
  providerModelId: string;
  name: string;
  contextWindowTokens: number;
  options: JsonMap;
};

type EditingProvider = {
  id: string;
  name: string;
  npm: AgentProviderNpm;
  baseURL: string;
  apiKeyInput: string;
  apiKeyState: ApiKeyState;
  apiMode: AgentProviderOpenAiApiMode;
  apiKeyMasked: string | null;
  models: EditingModel[];
};

type ProviderDefaultRef = {
  providerId: string;
  modelId: string;
};

const DEFAULT_PROVIDER_NPM: AgentProviderNpm = "@ai-sdk/openai";
const MODEL_EDITOR_Z_INDEX = 1100;

const AI_SDK_SETTINGS_DOC_URL = "https://ai-sdk.dev/docs/ai-sdk-core/settings";
const DEFAULT_OPENAI_API_MODE: AgentProviderOpenAiApiMode = "responses";

const providerNpmOptions: Array<{ value: AgentProviderNpm; label: string }> = [
  { value: "@ai-sdk/openai", label: "OpenAI (@ai-sdk/openai)" },
  { value: "@ai-sdk/anthropic", label: "Anthropic (@ai-sdk/anthropic)" }
];

const loading = ref(false);
const providerApiModeOptions: Array<{ value: AgentProviderOpenAiApiMode; label: string }> = [
  { value: "responses", label: "Responses API (/v1/responses)" },
  { value: "chatCompletions", label: "Chat Completions API (/v1/chat/completions)" }
];

const saving = ref(false);
const providers = ref<EditingProvider[]>([]);
const selectedDefault = ref<ProviderDefaultRef | null>(null);

const activeProviderId = ref("");

const providerModalOpen = ref(false);
const providerModalMode = ref<"create" | "edit">("create");
const providerFormId = ref("");
const providerFormName = ref("");
const providerFormNpm = ref<AgentProviderNpm>(DEFAULT_PROVIDER_NPM);
const providerFormBaseURL = ref("");
const providerFormApiKey = ref("");
const providerFormClearApiKey = ref(false);
const providerFormApiMode = ref<AgentProviderOpenAiApiMode>(DEFAULT_OPENAI_API_MODE);
const providerFormHasApiKey = ref(false);

const modelModalOpen = ref(false);
const modelModalMode = ref<"create" | "edit">("create");
const modelFormProviderId = ref("");
const modelFormOriginalId = ref("");
const modelFormId = ref("");
const modelFormProviderModelId = ref("");
const modelFormName = ref("");
const modelFormContextWindowTokens = ref<number>(128000);
const modelFormAiSdkJson = ref("{}");
const modelFormProviderOptionsJson = ref("{}");
const modelFormDefault = ref(false);
const modelFormAutoId = ref("");

const providerModelIdInputSearch = ref("");
const providerModelIdOptionsLoading = ref(false);
const providerModelIdOptionsWarning = ref("");
const providerModelIdOptions = ref<Array<{ value: string; label: string }>>([]);
const providerModelIdRemoteItems = ref<AgentProviderModelsListItem[]>([]);
const providerModelIdOptionsRequestSeq = ref(0);
const agentsSnapshot = ref<AgentSettingsView["agents"]>([]);
const renameReferenceError = ref("");

const activeProvider = computed(() => getProvider(activeProviderId.value));

const sortedActiveModels = computed(() => {
  const provider = activeProvider.value;
  if (!provider) return [];

  const defaultModelId = selectedDefault.value?.providerId === provider.id ? selectedDefault.value?.modelId ?? null : null;
  const models = [...provider.models];
  models.sort((a, b) => {
    const aIsDefault = defaultModelId ? a.id === defaultModelId : false;
    const bIsDefault = defaultModelId ? b.id === defaultModelId : false;
    if (aIsDefault && !bIsDefault) return -1;
    if (!aIsDefault && bIsDefault) return 1;

    const aName = a.name?.trim() || a.id;
    const bName = b.name?.trim() || b.id;
    return aName.localeCompare(bName, undefined, { sensitivity: "base" });
  });
  return models;
});
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
  const contextWindowTokens = Number(modelFormContextWindowTokens.value || 0);
  if (!Number.isFinite(contextWindowTokens) || Math.floor(contextWindowTokens) < 1) return false;
  const provider = getProvider(modelFormProviderId.value);
  if (!provider) return false;
  const nextId = modelFormId.value.trim();
  const duplicate = provider.models.some((item) => item.id === nextId && item.id !== modelFormOriginalId.value.trim());
  if (duplicate) return false;
  if (modelModalMode.value === "edit" && renameReferenceError.value) return false;
  return true;
});

const filterProviderModelIdOption: SelectProps["filterOption"] = (input, option) => {
  const candidate = typeof option?.label === "string"
    ? option.label
    : typeof option?.value === "string"
      ? option.value
      : "";
  return candidate.toLowerCase().includes((input ?? "").toLowerCase());
};

function rebuildProviderModelIdOptions() {
  const seen = new Set<string>();
  const candidates: string[] = [
    ...providerModelIdRemoteItems.value.map((item) => item.id),
    providerModelIdInputSearch.value.trim(),
    modelFormProviderModelId.value.trim()
  ]
    .filter((item) => Boolean(item));
  providerModelIdOptions.value = candidates.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((id) => ({ value: id, label: id }));
}

function maybeSyncModelIdFromProviderModelId(nextProviderModelId: string) {
  if (modelModalMode.value !== "create") return;
  const value = nextProviderModelId.trim();
  if (!value) return;

  // optional enhancement: if modelFormId is still the auto-generated temp id, overwrite it with selected providerModelId.
  if (modelFormAutoId.value && modelFormId.value.trim() === modelFormAutoId.value.trim()) {
    modelFormId.value = value;
  }
}

function onModelIdInput() {
  updateRenameReferenceError();
}

function onModelIdBlur() {
  modelFormId.value = modelFormId.value.trim();
  updateRenameReferenceError();
}

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

function sanitizeActiveProviderId(nextProviders: EditingProvider[]) {
  if (nextProviders.length === 0) return "";

  const current = activeProviderId.value;
  if (current && nextProviders.some((p) => p.id === current)) return current;

  const defaultProviderId = selectedDefault.value?.providerId;
  if (defaultProviderId && nextProviders.some((p) => p.id === defaultProviderId)) return defaultProviderId;

  return nextProviders[0]?.id ?? "";
}

function setActiveProvider(providerId: string) {
  activeProviderId.value = providerId;
}

function mapFromSettings(view: AgentProvidersSettingsView) {
  const nextProviders = view.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    npm: provider.npm,
    baseURL: provider.options.baseURL,
    apiKeyInput: "",
    apiKeyState: "keep" as const,
    apiMode: provider.options.apiMode ?? DEFAULT_OPENAI_API_MODE,
    apiKeyMasked: provider.options.apiKeyMasked,
    models: provider.models.map((model) => ({
      id: model.id,
      providerModelId:
        typeof model.providerModelId === "string" && model.providerModelId.trim() ? model.providerModelId.trim() : model.id,
      name: model.name,
      contextWindowTokens: Math.max(1, Math.floor(Number(model.contextWindowTokens || 1))),
      options: toJsonRecord(model.options)
    }))
  }));

  providers.value = nextProviders;
  selectedDefault.value = sanitizeDefault(view.default, nextProviders);
  activeProviderId.value = sanitizeActiveProviderId(nextProviders);
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
  if (nextNpm !== "@ai-sdk/openai") {
    providerFormApiMode.value = DEFAULT_OPENAI_API_MODE;
  }
}

function openCreateProvider() {
  providerModalMode.value = "create";
  providerFormId.value = newLocalId("provider");
  providerFormName.value = "";
  providerFormNpm.value = DEFAULT_PROVIDER_NPM;
  providerFormBaseURL.value = defaultBaseURLForNpm(DEFAULT_PROVIDER_NPM);
  providerFormApiKey.value = "";
  providerFormClearApiKey.value = false;
  providerFormApiMode.value = DEFAULT_OPENAI_API_MODE;
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
  providerFormApiMode.value = provider.apiMode ?? DEFAULT_OPENAI_API_MODE;
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
  providerFormApiMode.value = DEFAULT_OPENAI_API_MODE;
  providerFormHasApiKey.value = false;
}

// NOTE: model list is now shown in the right panel (no longer in a dedicated modal).

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
  const nextApiMode = nextNpm === "@ai-sdk/openai" ? providerFormApiMode.value : DEFAULT_OPENAI_API_MODE;

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
      apiMode: nextApiMode,
      apiKeyMasked: maskApiKey(nextApiKey),
      models: []
    });

    activeProviderId.value = nextId;
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
    provider.apiMode = nextApiMode;
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
      const nextProviders = providers.value.filter((item) => item.id !== providerId);
      providers.value = nextProviders;
      if (selectedDefault.value?.providerId === providerId) selectedDefault.value = null;
      if (activeProviderId.value === providerId) {
        // keep selection stable: if deleting active provider, switch to next available
        activeProviderId.value = sanitizeActiveProviderId(nextProviders);
      }
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
  modelFormAutoId.value = modelFormId.value;
  modelFormProviderModelId.value = "";
  modelFormName.value = "";
  modelFormContextWindowTokens.value = 128000;
  modelFormAiSdkJson.value = "{}";
  modelFormProviderOptionsJson.value = "{}";
  modelFormDefault.value = false;
  renameReferenceError.value = "";
  providerModelIdInputSearch.value = "";
  providerModelIdRemoteItems.value = [];
  rebuildProviderModelIdOptions();
  modelModalOpen.value = true;
  void loadProviderModelOptions(provider.id);
}

async function openEditModel(providerId: string, modelId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) return;

  modelModalMode.value = "edit";
  modelFormProviderId.value = provider.id;
  modelFormOriginalId.value = model.id;
  modelFormId.value = model.id;
  modelFormAutoId.value = "";
  modelFormProviderModelId.value = model.providerModelId;
  modelFormName.value = model.name;
  modelFormContextWindowTokens.value = Math.max(1, Math.floor(Number(model.contextWindowTokens || 1)));
  const options = toJsonRecord(model.options);
  const aiSdk = toJsonRecord(options.aiSdk);
  const providerOptionsByKey = toJsonRecord(options.providerOptionsByKey);
  const providerKey = providerOptionsKeyForNpm(provider.npm);
  const providerOptions = toJsonRecord(providerOptionsByKey[providerKey]);
  modelFormAiSdkJson.value = stringifyPretty(aiSdk);
  modelFormProviderOptionsJson.value = stringifyPretty(providerOptions);
  modelFormDefault.value = isDefaultModel(provider.id, model.id);
  renameReferenceError.value = "";
  providerModelIdInputSearch.value = "";
  providerModelIdRemoteItems.value = [];
  rebuildProviderModelIdOptions();
  modelModalOpen.value = true;
  await refreshAgentsSnapshot();
  updateRenameReferenceError();
  void loadProviderModelOptions(provider.id);
}

async function loadProviderModelOptions(providerId: string) {
  const seq = ++providerModelIdOptionsRequestSeq.value;
  const shouldApply = () => {
    return (
      seq === providerModelIdOptionsRequestSeq.value &&
      modelModalOpen.value === true &&
      providerId === modelFormProviderId.value
    );
  };

  providerModelIdOptionsLoading.value = true;
  providerModelIdOptionsWarning.value = "";
  try {
    const res = await getAgentProviderModels(providerId);

    if (!shouldApply()) return;

    providerModelIdRemoteItems.value = Array.isArray(res.items) ? res.items : [];
    providerModelIdOptionsWarning.value = res.warning ?? "";
    rebuildProviderModelIdOptions();
  } catch (err) {
    if (!shouldApply()) return;

    providerModelIdRemoteItems.value = [];
    providerModelIdOptionsWarning.value = t("settings.agentProviders.errors.modelListLoadFailed");
    rebuildProviderModelIdOptions();
  } finally {
    if (!shouldApply()) return;
    providerModelIdOptionsLoading.value = false;
  }
}

function onProviderModelIdSearch(value: string) {
  providerModelIdInputSearch.value = value;
  if (!modelFormProviderModelId.value.trim() && value.trim()) {
    modelFormProviderModelId.value = value.trim();
  }
  rebuildProviderModelIdOptions();
  updateRenameReferenceError();
}

function onProviderModelIdChange(value: string) {
  modelFormProviderModelId.value = typeof value === "string" ? value.trim() : "";
  maybeSyncModelIdFromProviderModelId(modelFormProviderModelId.value);
  updateRenameReferenceError();
}

async function refreshAgentsSnapshot() {
  try {
    const res = await getAgentSettings();
    agentsSnapshot.value = res.agents;
  } catch {
    agentsSnapshot.value = [];
  }
}

function updateRenameReferenceError() {
  renameReferenceError.value = "";
  if (modelModalMode.value !== "edit") return;
  const providerId = modelFormProviderId.value.trim();
  const oldId = modelFormOriginalId.value.trim();
  const nextId = modelFormId.value.trim();
  if (!providerId || !oldId || !nextId || oldId === nextId) return;

  const refs: string[] = [];
  if (selectedDefault.value?.providerId === providerId && selectedDefault.value?.modelId === oldId) {
    refs.push(t("settings.agentProviders.errors.renameBlockedGlobalDefault"));
  }
  for (const agent of agentsSnapshot.value) {
    if (agent.defaultModel?.providerId === providerId && agent.defaultModel?.modelId === oldId) {
      refs.push(t("settings.agentProviders.errors.renameBlockedAgent", { id: agent.id }));
    }
  }
  if (refs.length > 0) {
    renameReferenceError.value = t("settings.agentProviders.errors.renameBlocked", { refs: refs.join("; ") });
  }
}

function copyModel(providerId: string, modelId: string) {
  const provider = getProvider(providerId);
  if (!provider) return;
  const source = provider.models.find((item) => item.id === modelId);
  if (!source) return;

  const clone = {
    id: newLocalId(`${provider.id}-model`),
    providerModelId: source.providerModelId,
    name: `${source.name} copy`,
    contextWindowTokens: Math.max(1, Math.floor(Number(source.contextWindowTokens || 1))),
    options: toJsonRecord(JSON.parse(JSON.stringify(source.options ?? {})))
  };
  provider.models.push(clone);
  void persist({ toast: true });
}

function closeModelModal() {
  modelModalOpen.value = false;
  modelModalMode.value = "create";
  modelFormProviderId.value = "";
  modelFormOriginalId.value = "";
  modelFormId.value = "";
  modelFormProviderModelId.value = "";
  modelFormName.value = "";
  modelFormContextWindowTokens.value = 128000;
  modelFormAiSdkJson.value = "{}";
  modelFormProviderOptionsJson.value = "{}";
  modelFormDefault.value = false;
  modelFormAutoId.value = "";

  // make any in-flight provider model list request stale
  providerModelIdOptionsRequestSeq.value += 1;
  providerModelIdOptionsLoading.value = false;

  providerModelIdInputSearch.value = "";
  providerModelIdOptionsWarning.value = "";
  providerModelIdRemoteItems.value = [];
  providerModelIdOptions.value = [];
  renameReferenceError.value = "";
}

function submitModel() {
  updateRenameReferenceError();
  if (!canSubmitModel.value) {
    message.error(renameReferenceError.value || t("settings.agentProviders.errors.invalidModelForm"));
    return;
  }

  const provider = getProvider(modelFormProviderId.value);
  if (!provider) return;

  const nextId = modelFormId.value.trim();
  const nextProviderModelId = modelFormProviderModelId.value.trim();
  const nextName = modelFormName.value.trim();
  const nextContextWindowTokens = Math.max(1, Math.floor(Number(modelFormContextWindowTokens.value || 1)));
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
    contextWindowTokens: nextContextWindowTokens,
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
      } as { baseURL: string; apiKey?: string | null; apiMode?: AgentProviderOpenAiApiMode };

      if (provider.apiKeyState === "set") {
        const next = provider.apiKeyInput.trim();
        options.apiKey = next ? next : null;
      }
      if (provider.npm === "@ai-sdk/openai") {
        options.apiMode = provider.apiMode ?? DEFAULT_OPENAI_API_MODE;
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
          contextWindowTokens: Math.max(1, Math.floor(Number(model.contextWindowTokens || 1))),
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
    if (modelModalMode.value === "edit") {
      void refreshAgentsSnapshot();
    }
    if (params.toast) message.success(t("settings.agentProviders.saved"));
  } catch (err) {
    if (err instanceof ApiError && err.code === "AGENT_PROVIDER_MODEL_RENAME_REFERENCED") {
      message.error(err.message || t("settings.agentProviders.errors.renameBlockedGeneric"));
      return;
    }
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
