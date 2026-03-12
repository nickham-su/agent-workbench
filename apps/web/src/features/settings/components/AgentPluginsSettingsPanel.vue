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
          <a-button
            size="small"
            type="text"
            :disabled="saving"
            @click="openConfigModal(plugin.id)"
          >{{ t("settings.agentPlugins.actions.editConfig") }}</a-button>
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

  <a-modal
    v-model:open="configModalOpen"
    :title="t('settings.agentPlugins.configModal.title', { name: configModalPlugin?.manifest?.name || configModalPlugin?.id || '-' })"
    :confirm-loading="saving"
    :ok-button-props="{ disabled: hasJsonError }"
    width="860px"
    @ok="savePluginConfig"
  >
    <div class="space-y-3">
      <div class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentPlugins.configModal.maskedHint") }}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-xs font-semibold">{{ t("settings.agentPlugins.configModal.schemaFieldsTitle") }}</div>
        <a-button size="small" type="default" @click="applyConfigTemplate">
          {{ t("settings.agentPlugins.configModal.actions.generateTemplate") }}
        </a-button>
      </div>

      <div v-if="schemaFields.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentPlugins.configModal.schemaFieldsEmpty") }}
      </div>
      <div v-if="schemaComplexHintVisible" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentPlugins.configModal.schemaComplexHint") }}
      </div>

      <div v-else class="overflow-x-auto border border-[var(--border-color-secondary)] rounded">
        <table class="w-full text-xs">
          <thead class="bg-[var(--panel-bg-elevated)]">
            <tr>
              <th class="text-left px-2 py-1">{{ t("settings.agentPlugins.configModal.schemaTable.field") }}</th>
              <th class="text-left px-2 py-1">{{ t("settings.agentPlugins.configModal.schemaTable.type") }}</th>
              <th class="text-left px-2 py-1">{{ t("settings.agentPlugins.configModal.schemaTable.required") }}</th>
              <th class="text-left px-2 py-1">{{ t("settings.agentPlugins.configModal.schemaTable.description") }}</th>
              <th class="text-left px-2 py-1">{{ t("settings.agentPlugins.configModal.schemaTable.defaultOrExample") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in schemaFields" :key="field.name" class="border-t border-[var(--border-color-secondary)]">
              <td class="px-2 py-1 font-mono">{{ field.name }}</td>
              <td class="px-2 py-1">{{ field.typeLabel }}</td>
              <td class="px-2 py-1">{{ field.required ? t("common.yes") : t("common.no") }}</td>
              <td class="px-2 py-1">{{ field.description || "-" }}</td>
              <td class="px-2 py-1 break-all">{{ field.defaultOrExample || "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <a-collapse ghost>
        <a-collapse-panel key="schema" :header="t('settings.agentPlugins.configModal.rawSchemaTitle')">
          <pre class="text-xs p-2 rounded bg-[var(--panel-bg-elevated)] overflow-auto max-h-56">{{ rawSchemaText }}</pre>
        </a-collapse-panel>
      </a-collapse>

      <div class="space-y-1">
        <div class="text-xs font-semibold">{{ t("settings.agentPlugins.configModal.editorTitle") }}</div>
        <a-textarea
          v-model:value="configEditorText"
          :rows="14"
          class="font-mono text-xs"
          :placeholder="t('settings.agentPlugins.configModal.editorPlaceholder')"
        />
        <div v-if="jsonErrorMessage" class="text-xs text-[color:var(--danger-color)]">{{ jsonErrorMessage }}</div>
      </div>
    </div>
  </a-modal>
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

type SchemaField = {
  name: string;
  typeLabel: string;
  required: boolean;
  description: string;
  defaultOrExample: string;
};

const configModalOpen = ref(false);
const configModalPluginId = ref<string | null>(null);
const configEditorText = ref("{}");

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

const configModalPlugin = computed(() => {
  if (!configModalPluginId.value) return null;
  return plugins.value.find((plugin) => plugin.id === configModalPluginId.value) ?? null;
});

const configSchema = computed<Record<string, unknown> | null>(() => {
  const schema = configModalPlugin.value?.manifest?.configSchema;
  if (!isRecord(schema)) return null;
  return schema;
});

const rawSchemaText = computed(() => {
  if (!configSchema.value) return "{}";
  return JSON.stringify(configSchema.value, null, 2);
});

const schemaFields = computed<SchemaField[]>(() => {
  const schema = configSchema.value;
  if (!schema) return [];
  const requiredSet = new Set(readRequiredKeys(schema));
  const properties = readProperties(schema);
  const rows: SchemaField[] = [];

  for (const [name, def] of Object.entries(properties)) {
    if (!isRecord(def)) {
      rows.push({
        name,
        typeLabel: "-",
        required: requiredSet.has(name),
        description: "",
        defaultOrExample: ""
      });
      continue;
    }
    rows.push({
      name,
      typeLabel: readTypeLabel(def),
      required: requiredSet.has(name),
      description: readString(def.description) || readString(def.title),
      defaultOrExample: readDefaultOrExample(def)
    });
  }

  return rows;
});

const schemaComplexHintVisible = computed(() => {
  return isComplexSchema(configSchema.value);
});

const jsonErrorMessage = computed(() => {
  const text = configEditorText.value.trim();
  if (!text) return t("settings.agentPlugins.configModal.errors.emptyJson");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return t("settings.agentPlugins.configModal.errors.objectExpected");
    }
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : t("settings.agentPlugins.configModal.errors.invalidJson");
  }
});

const hasJsonError = computed(() => jsonErrorMessage.value.length > 0);

function openConfigModal(pluginId: string) {
  configModalPluginId.value = pluginId;
  const plugin = plugins.value.find((item) => item.id === pluginId);
  const sourceConfig = isRecord(plugin?.config) ? plugin?.config : {};
  configEditorText.value = JSON.stringify(sourceConfig, null, 2);
  configModalOpen.value = true;
}

function applyConfigTemplate() {
  const schema = configSchema.value;
  if (!schema) {
    message.info(t("settings.agentPlugins.configModal.schemaFieldsEmpty"));
    return;
  }
  const required = readRequiredKeys(schema);
  const properties = readProperties(schema);
  const template: Record<string, unknown> = {};

  for (const key of required) {
    const def = properties[key];
    template[key] = defaultTemplateValue(def);
  }

  configEditorText.value = JSON.stringify(template, null, 2);
}

async function savePluginConfig() {
  if (!configModalPluginId.value || saving.value) return;
  const parsedConfig = parseConfigEditorValue();
  if (!parsedConfig) {
    message.error(jsonErrorMessage.value || t("settings.agentPlugins.configModal.errors.invalidJson"));
    return;
  }

  saving.value = true;
  try {
    const updated = await savePluginSetting(configModalPluginId.value, {
      config: parsedConfig
    });
    pluginSettings.value = updated;
    const snapshots = await getAgentPluginRuntimeSnapshots();
    pluginSnapshots.value = snapshots.plugins;
    configModalOpen.value = false;
    message.success(t("settings.agentPlugins.saved"));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

function parseConfigEditorValue(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(configEditorText.value) as unknown;
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
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

  if (enabled) {
    const plugin = plugins.value.find((item) => item.id === pluginId);
    const missingFields = getMissingRequiredFields(plugin?.manifest?.configSchema, plugin?.config);
    if (missingFields.length > 0) {
      message.warning(t("settings.agentPlugins.configModal.enableHint", { fields: missingFields.join(", ") }));
      openConfigModal(pluginId);
      return;
    }
  }

  saving.value = true;
  try {
    const updated = await savePluginSetting(pluginId, { enabled });
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

async function savePluginSetting(pluginId: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) {
  const current = pluginSettings.value?.plugins ?? [];
  const matched = current.find((item) => item.id === pluginId);
  const nextItem = {
    id: pluginId,
    enabled: patch.enabled ?? matched?.enabled ?? false,
    ...(patch.config ? { config: patch.config } : matched?.config ? { config: matched.config } : {})
  };
  const next = matched
    ? current.map((item) => item.id === pluginId ? nextItem : item)
    : [...current, nextItem];
  return updateAgentPluginSettings({ plugins: next });
}

function getMissingRequiredFields(schemaInput: unknown, configInput: unknown): string[] {
  if (!isRecord(schemaInput)) return [];
  const required = readRequiredKeys(schemaInput);
  if (required.length === 0) return [];
  const config = isRecord(configInput) ? configInput : {};
  return required.filter((key) => {
    const value = config[key];
    if (typeof value === "string") return value.trim().length === 0;
    return value === undefined || value === null;
  });
}

function readRequiredKeys(schema: Record<string, unknown>): string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (!isRecord(properties)) return {};
  return properties;
}

function readTypeLabel(def: Record<string, unknown>): string {
  const tpe = def.type;
  if (typeof tpe === "string") return tpe;
  if (Array.isArray(tpe)) {
    const labels = tpe.filter((item): item is string => typeof item === "string");
    if (labels.length > 0) return labels.join(" | ");
  }
  const oneOf = def.oneOf;
  if (Array.isArray(oneOf)) return "oneOf";
  const anyOf = def.anyOf;
  if (Array.isArray(anyOf)) return "anyOf";
  return "-";
}

function readDefaultOrExample(def: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(def, "default")) {
    return formatValue(def.default);
  }
  const examples = def.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    return formatValue(examples[0]);
  }
  return "";
}

function defaultTemplateValue(def: unknown): unknown {
  if (!isRecord(def)) return "";
  if (Object.prototype.hasOwnProperty.call(def, "default")) {
    return def.default;
  }
  const examples = def.examples;
  if (Array.isArray(examples) && examples.length > 0) {
    return examples[0];
  }
  const tpe = def.type;
  if (typeof tpe === "string") {
    if (tpe === "boolean") return false;
    if (tpe === "number" || tpe === "integer") return 0;
    if (tpe === "array") return [];
    if (tpe === "object") return {};
  }
  return "";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isComplexSchema(schema: Record<string, unknown> | null): boolean {
  if (!schema) return false;
  const type = schema.type;
  const hasSimpleObjectShape = type === "object" && isRecord(schema.properties);
  if (!hasSimpleObjectShape) {
    return true;
  }
  return hasComplexKeywords(schema);
}

function hasComplexKeywords(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, "oneOf")
    || Object.prototype.hasOwnProperty.call(value, "anyOf")
    || Object.prototype.hasOwnProperty.call(value, "allOf")
    || Object.prototype.hasOwnProperty.call(value, "$ref")
  ) {
    return true;
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      if (child.some((item) => hasComplexKeywords(item))) return true;
      continue;
    }
    if (hasComplexKeywords(child)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

onMounted(() => {
  void refreshDraft();
});

defineExpose({
  refresh: refreshDraft
});
</script>
