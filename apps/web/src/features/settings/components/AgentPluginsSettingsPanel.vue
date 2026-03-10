<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentPlugins.description") }}
      </div>
      <div class="flex items-center gap-2">
        <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentPlugins.saving") }}</div>
        <a-button size="small" type="text" :loading="loading" @click="refreshDraft">
          {{ t("settings.agentPlugins.actions.refresh") }}
        </a-button>
      </div>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <div v-else-if="plugins.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
      {{ t("settings.agentPlugins.empty") }}
    </div>

    <div v-else class="divide-y divide-[var(--border-color-secondary)] border border-[var(--border-color-secondary)] rounded">
      <div
        v-for="plugin in plugins"
        :key="plugin.id"
        class="flex items-start justify-between gap-3 px-3 py-3 hover:bg-[var(--panel-bg-elevated)]"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <div class="font-semibold text-xs truncate" :title="plugin.manifest?.name || plugin.id">{{ plugin.manifest?.name || plugin.id }}</div>
            <div class="text-xs text-[color:var(--text-tertiary)] truncate">{{ plugin.id }}</div>
            <a-tag
              :color="plugin.state === 'ready' ? 'green' : plugin.state === 'disabled' ? 'default' : 'orange'"
              class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0"
            >
              {{ stateLabel(plugin.state) }}
            </a-tag>
            <a-tag v-if="plugin.enabled" color="blue" class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0">
              {{ t("settings.agentPlugins.fields.enabled") }}
            </a-tag>
          </div>

          <div v-if="plugin.manifest?.description" class="text-[11px] text-[color:var(--text-tertiary)]">
            {{ plugin.manifest.description }}
          </div>

          <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
            {{ t("settings.agentPlugins.fields.entry") }}: {{ plugin.manifest?.entry || "-" }}
          </div>

          <div v-if="(plugin.capabilities.tools ?? []).length > 0" class="flex flex-wrap gap-1 pt-1">
            <a-tag
              v-for="tool in plugin.capabilities.tools ?? []"
              :key="tool.canonicalName"
              color="default"
              class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0"
            >
              {{ tool.shortName }}
            </a-tag>
          </div>

          <div v-if="plugin.diagnostics.length > 0" class="pt-1 space-y-1">
            <div
              v-for="diag in plugin.diagnostics"
              :key="`${plugin.id}-${diag.code}-${diag.message}`"
              class="text-[11px]"
              :class="diag.severity === 'error' ? 'text-[color:var(--danger-color)]' : 'text-[color:var(--text-tertiary)]'"
            >
              {{ diag.message }}
            </div>
          </div>
        </div>

        <div class="shrink-0 flex items-center gap-2">
          <a-switch
            :checked="plugin.enabled"
            :disabled="saving"
            size="small"
            @change="onPluginSwitchChange(plugin.id, $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AgentPluginSettings, PluginRuntimeSnapshot } from "@agent-workbench/shared";
import { message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getAgentPluginRuntimeSnapshots, getAgentPluginSettings, updateAgentPluginSettings } from "@/shared/api";
import { toPluginRows } from "./agentPluginViewModel";

const { t } = useI18n();

const loading = ref(false);
const saving = ref(false);
const pluginSettings = ref<AgentPluginSettings | null>(null);
const pluginSnapshots = ref<PluginRuntimeSnapshot[]>([]);

const plugins = computed(() => toPluginRows({ settings: pluginSettings.value, snapshots: pluginSnapshots.value }));

function stateLabel(state: string) {
  if (state === "ready") return t("settings.agentPlugins.state.ready");
  if (state === "disabled") return t("settings.agentPlugins.state.disabled");
  if (state === "invalid_manifest") return t("settings.agentPlugins.state.invalidManifest");
  if (state === "incompatible") return t("settings.agentPlugins.state.incompatible");
  if (state === "config_invalid") return t("settings.agentPlugins.state.configInvalid");
  if (state === "load_failed") return t("settings.agentPlugins.state.loadFailed");
  if (state === "manifest_mismatch") return t("settings.agentPlugins.state.manifestMismatch");
  return state;
}

async function refreshDraft() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [settings, snapshots] = await Promise.all([
      getAgentPluginSettings(),
      getAgentPluginRuntimeSnapshots()
    ]);
    pluginSettings.value = settings;
    pluginSnapshots.value = snapshots.plugins;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function onPluginSwitchChange(pluginId: string, checked: boolean) {
  void togglePlugin(pluginId, checked);
}

async function togglePlugin(pluginId: string, enabled: boolean) {
  if (saving.value) return;
  saving.value = true;
  try {
    const current = pluginSettings.value?.plugins ?? [];
    const next = current.some((item) => item.id === pluginId)
      ? current.map((item) => item.id === pluginId ? { ...item, enabled } : item)
      : [...current, { id: pluginId, enabled }];
    const updated = await updateAgentPluginSettings({ plugins: next });
    pluginSettings.value = updated;
    const snapshots = await getAgentPluginRuntimeSnapshots();
    pluginSnapshots.value = snapshots.plugins;
    message.success(t("settings.agentPlugins.saved"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void refreshDraft();
});

defineExpose({
  refresh: refreshDraft
});
</script>
