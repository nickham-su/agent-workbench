<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentRuntime.description") }}
      </div>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <a-form v-else layout="vertical">
      <a-form-item :label="t('settings.agentRuntime.fields.autoCompactThresholdPct.label')">
        <a-input-number
          v-model:value="autoCompactThresholdPct"
          :min="50"
          :max="99"
          :step="1"
          :precision="0"
          style="max-width: 260px"
        />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.autoCompactThresholdPct.help") }}
        </div>
      </a-form-item>

      <a-form-item :label="t('settings.agentRuntime.fields.compactionModel.label')">
        <a-cascader
          v-model:value="compactionModelPath"
          :options="visionModelCascaderOptions"
          :placeholder="t('settings.agentRuntime.fields.compactionModel.placeholder')"
          :show-search="true"
          :allow-clear="true"
          expand-trigger="hover"
        />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.compactionModel.help") }}
        </div>
      </a-form-item>

      <a-divider class="!my-2" />

      <a-form-item :label="t('settings.agentRuntime.fields.modelTotalTimeoutMs.label')">
        <a-input-number v-model:value="modelTotalTimeoutSeconds" :min="0" :step="1" :precision="0" style="max-width: 260px" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.modelTotalTimeoutMs.help") }}
        </div>
      </a-form-item>

      <a-form-item :label="t('settings.agentRuntime.fields.modelIdleTimeoutMs.label')">
        <a-input-number v-model:value="modelIdleTimeoutSeconds" :min="0" :step="1" :precision="0" style="max-width: 260px" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.modelIdleTimeoutMs.help") }}
        </div>
      </a-form-item>

      <a-form-item :label="t('settings.agentRuntime.fields.modelRequestMaxRetries.label')">
        <a-input-number v-model:value="modelRequestMaxRetries" :min="0" :max="100" :step="1" :precision="0" style="max-width: 260px" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.modelRequestMaxRetries.help") }}
        </div>
      </a-form-item>

      <a-divider class="!my-2" />

      <a-form-item :label="t('settings.agentRuntime.fields.visionModel.label')">
        <a-cascader
          v-model:value="visionModelPath"
          :options="visionModelCascaderOptions"
          :placeholder="t('settings.agentRuntime.fields.visionModel.placeholder')"
          :show-search="true"
          :allow-clear="true"
          expand-trigger="hover"
        />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.visionModel.help") }}
        </div>
      </a-form-item>

      <a-divider class="!my-2" />

      <a-form-item :label="t('settings.agentRuntime.fields.sessionTerminalSoundEnabled.label')">
        <a-switch v-model:checked="sessionTerminalSoundEnabled" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.sessionTerminalSoundEnabled.help") }}
        </div>
      </a-form-item>

      <a-divider class="!my-2" />

      <a-form-item class="!mb-0">
        <div class="flex items-center gap-2">
          <a-button type="primary" :disabled="loading || saving" @click="save">
            {{ t("common.save") }}
          </a-button>
          <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentRuntime.saving") }}</div>
        </div>
      </a-form-item>
    </a-form>
  </div>
</template>

<script setup lang="ts">
import { message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AgentRuntimeSettings } from "@agent-workbench/shared";
import { getAgentProvidersSettings, getAgentRuntimeSettings, updateAgentRuntimeSettings } from "@/shared/api";
import { modelPathFromReference, modelReferenceFromPath } from "./agentRuntimeSettings";

const { t } = useI18n();

type AgentProvidersSettings = Awaited<ReturnType<typeof getAgentProvidersSettings>>;

const loading = ref(false);
const saving = ref(false);

const modelIdleTimeoutSeconds = ref<number>(0);
const modelTotalTimeoutSeconds = ref<number>(0);
const modelRequestMaxRetries = ref<number>(5);
const autoCompactThresholdPct = ref<number>(80);
const sessionTerminalSoundEnabled = ref(true);

const providersSettings = ref<AgentProvidersSettings | null>(null);
const visionModelPath = ref<string[]>([]);
const compactionModelPath = ref<string[]>([]);

function toSeconds(rawMs: number) {
  const ms = Math.max(0, Number(rawMs || 0));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 1000);
}

function toMs(rawSeconds: number) {
  const seconds = Math.max(0, Number(rawSeconds || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds) * 1000;
}

const visionModelCascaderOptions = computed(() => {
  const providers = providersSettings.value?.providers ?? [];
  return providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: provider.name,
      value: provider.id,
      children: provider.models.map((model) => ({
        label: model.name,
        value: model.id
      }))
    }));
});

function findModel(providerId: string, modelId: string) {
  const provider = providersSettings.value?.providers.find((item) => item.id === providerId);
  if (!provider) return null;
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) return null;
  return { provider, model };
}

function toVisionModelFromPath(path: string[]) {
  return modelReferenceFromPath(path, (providerId, modelId) => findModel(providerId, modelId) !== null);
}

function mapFromSettings(settings: AgentRuntimeSettings) {
  modelIdleTimeoutSeconds.value = toSeconds(settings.modelIdleTimeoutMs ?? 0);
  modelTotalTimeoutSeconds.value = toSeconds(settings.modelTotalTimeoutMs ?? 0);
  modelRequestMaxRetries.value = Math.min(100, Math.max(0, Math.floor(Number(settings.modelRequestMaxRetries ?? 5))));
  autoCompactThresholdPct.value = Math.min(99, Math.max(50, Math.floor(Number(settings.autoCompactThresholdPct || 80))));
  sessionTerminalSoundEnabled.value = settings.sessionTerminalSoundEnabled !== false;
  visionModelPath.value = modelPathFromReference(settings.visionModel);
  compactionModelPath.value = modelPathFromReference(settings.compactionModel);
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [runtimeRes, providersRes] = await Promise.all([
      getAgentRuntimeSettings(),
      getAgentProvidersSettings()
    ]);
    providersSettings.value = providersRes;
    mapFromSettings(runtimeRes);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    const visionModel = toVisionModelFromPath(visionModelPath.value);
    if (visionModel === undefined) {
      message.error(t("settings.agentRuntime.errors.visionModelInvalid"));
      return;
    }
    const compactionModel = toVisionModelFromPath(compactionModelPath.value);
    if (compactionModel === undefined) {
      message.error(t("settings.agentRuntime.errors.compactionModelInvalid"));
      return;
    }
    const res = await updateAgentRuntimeSettings({
      modelIdleTimeoutMs: toMs(modelIdleTimeoutSeconds.value ?? 0),
      modelTotalTimeoutMs: toMs(modelTotalTimeoutSeconds.value ?? 0),
      modelRequestMaxRetries: Math.min(100, Math.max(0, Math.floor(Number(modelRequestMaxRetries.value || 0)))),
      autoCompactThresholdPct: Math.min(99, Math.max(50, Math.floor(Number(autoCompactThresholdPct.value || 80)))),
      sessionTerminalSoundEnabled: !!sessionTerminalSoundEnabled.value,
      visionModel,
      compactionModel
    });
    mapFromSettings(res);
    window.dispatchEvent(new CustomEvent("awb:agent-runtime-settings-updated"));
    message.success(t("settings.agentRuntime.saved"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void refresh();
});

defineExpose({ refresh });
</script>
