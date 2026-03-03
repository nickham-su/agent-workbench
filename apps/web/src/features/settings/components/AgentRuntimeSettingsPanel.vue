<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentRuntime.description") }}
      </div>
      <div class="flex items-center gap-2">
        <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentRuntime.saving") }}</div>
        <a-button size="small" :loading="loading" type="text" @click="refresh">
          {{ t("common.refresh") }}
        </a-button>
        <a-button size="small" type="primary" :disabled="loading || saving" @click="save">
          {{ t("common.save") }}
        </a-button>
      </div>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <a-form v-else layout="vertical">
      <a-form-item :label="t('settings.agentRuntime.fields.maxContextTokens.label')">
        <a-input-number v-model:value="maxContextTokens" :min="1" :step="1000" :precision="0" style="max-width: 260px" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.maxContextTokens.help") }}
        </div>
      </a-form-item>

      <a-form-item :label="t('settings.agentRuntime.fields.autoCompactThresholdPct.label')">
        <a-input-number
          v-model:value="autoCompactThresholdPct"
          :min="50"
          :max="90"
          :step="1"
          :precision="0"
          style="max-width: 260px"
        />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.autoCompactThresholdPct.help") }}
        </div>
      </a-form-item>

      <a-form-item :label="t('settings.agentRuntime.fields.modelTotalTimeoutMs.label')">
        <a-input-number v-model:value="modelTotalTimeoutSeconds" :min="0" :step="0.1" :precision="3" style="max-width: 260px" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.modelTotalTimeoutMs.help") }}
        </div>
      </a-form-item>

      <a-form-item :label="t('settings.agentRuntime.fields.modelIdleTimeoutMs.label')">
        <a-input-number v-model:value="modelIdleTimeoutSeconds" :min="0" :step="0.1" :precision="3" style="max-width: 260px" />
        <div class="pt-2 text-xs text-[color:var(--text-tertiary)]">
          {{ t("settings.agentRuntime.fields.modelIdleTimeoutMs.help") }}
        </div>
      </a-form-item>
    </a-form>
  </div>
</template>

<script setup lang="ts">
import { message } from "ant-design-vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AgentRuntimeSettings } from "@agent-workbench/shared";
import { getAgentRuntimeSettings, updateAgentRuntimeSettings } from "@/shared/api";

const { t } = useI18n();

const loading = ref(false);
const saving = ref(false);

const modelIdleTimeoutSeconds = ref<number>(0);
const modelTotalTimeoutSeconds = ref<number>(0);
const maxContextTokens = ref<number>(128000);
const autoCompactThresholdPct = ref<number>(80);

function toSeconds(rawMs: number) {
  const ms = Math.max(0, Number(rawMs || 0));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Number((ms / 1000).toFixed(3));
}

function toMs(rawSeconds: number) {
  const seconds = Math.max(0, Number(rawSeconds || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 1000);
}

function mapFromSettings(settings: AgentRuntimeSettings) {
  modelIdleTimeoutSeconds.value = toSeconds(settings.modelIdleTimeoutMs ?? 0);
  modelTotalTimeoutSeconds.value = toSeconds(settings.modelTotalTimeoutMs ?? 0);
  maxContextTokens.value = Math.max(1, Number(settings.maxContextTokens || 1));
  autoCompactThresholdPct.value = Math.min(90, Math.max(50, Math.floor(Number(settings.autoCompactThresholdPct || 80))));
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await getAgentRuntimeSettings();
    mapFromSettings(res);
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
    const res = await updateAgentRuntimeSettings({
      modelIdleTimeoutMs: toMs(modelIdleTimeoutSeconds.value ?? 0),
      modelTotalTimeoutMs: toMs(modelTotalTimeoutSeconds.value ?? 0),
      maxContextTokens: Math.max(1, Math.floor(Number(maxContextTokens.value || 1))),
      autoCompactThresholdPct: Math.min(90, Math.max(50, Math.floor(Number(autoCompactThresholdPct.value || 80))))
    });
    mapFromSettings(res);
    message.success(t("settings.agentRuntime.saved"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

defineExpose({ refresh });
</script>
