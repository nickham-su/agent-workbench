<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 flex-1 text-xs text-[color:var(--text-tertiary)]">
        {{ t("settings.agentMcp.description") }}
      </div>
      <div class="flex items-center gap-2">
        <div v-if="saving" class="text-xs text-[color:var(--text-tertiary)]">{{ t("settings.agentMcp.saving") }}</div>
        <a-button size="small" type="primary" :disabled="loading" @click="openCreateServer">
          {{ t("settings.agentMcp.actions.addServer") }}
        </a-button>
      </div>
    </div>

    <div v-if="loading" class="text-xs text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>

    <div v-else-if="servers.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
      {{ t("settings.agentMcp.empty") }}
    </div>

    <div v-else class="divide-y divide-[var(--border-color-secondary)] border border-[var(--border-color-secondary)] rounded">
      <div
        v-for="server in servers"
        :key="server.id"
        class="group flex items-start justify-between gap-3 px-2 py-2 hover:bg-[var(--panel-bg-elevated)]"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center gap-2">
            <div class="font-semibold text-xs truncate" :title="server.id">{{ server.id }}</div>
            <a-tag color="default" class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0">{{ serverTypeLabel(server) }}</a-tag>
            <a-tag
              :color="server.enabled ? 'blue' : 'default'"
              class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0"
            >
              {{ server.enabled ? t("settings.agentMcp.fields.enabled") : t("settings.agentMcp.fields.disabled") }}
            </a-tag>
          </div>

          <div class="text-[11px] text-[color:var(--text-tertiary)] truncate">
            {{ summaryLabel(server) }}
          </div>
        </div>

        <div class="shrink-0 flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
          <a-button
            size="small"
            type="text"
            @click="openEditServer(server.id)"
            :title="t('settings.agentMcp.actions.edit')"
            :aria-label="t('settings.agentMcp.actions.edit')"
          >
            <template #icon><EditOutlined /></template>
          </a-button>
          <a-button
            size="small"
            type="text"
            danger
            @click="confirmDeleteServer(server.id)"
            :title="t('settings.agentMcp.actions.delete')"
            :aria-label="t('settings.agentMcp.actions.delete')"
          >
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </div>
      </div>
    </div>

    <a-modal
      v-model:open="serverModalOpen"
      :title="serverModalMode === 'create' ? t('settings.agentMcp.serverModal.createTitle') : t('settings.agentMcp.serverModal.editTitle')"
      :maskClosable="false"
      :okText="t('settings.agentMcp.modal.ok')"
      :cancelText="t('settings.agentMcp.modal.cancel')"
      @ok="submitServer"
      @cancel="closeServerModal"
    >
      <a-form layout="vertical">
        <a-form-item :label="t('settings.agentMcp.serverForm.idLabel')" :required="true">
          <a-input v-model:value="serverFormId" :disabled="serverModalMode === 'edit'" />
        </a-form-item>

        <a-form-item :label="t('settings.agentMcp.serverForm.jsonLabel')" :required="true">
          <a-textarea v-model:value="serverFormJson" :auto-size="{ minRows: 8, maxRows: 18 }" class="font-mono text-xs" />
          <div class="pt-1 text-xs text-[color:var(--text-tertiary)]">
            {{ t("settings.agentMcp.serverForm.jsonHelp") }}
          </div>
        </a-form-item>

        <a-form-item>
          <a-checkbox v-model:checked="serverFormEnabled">{{ t("settings.agentMcp.serverForm.enabled") }}</a-checkbox>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import type { AgentMcpServerConfig, AgentMcpSettings, UpdateAgentMcpSettingsRequest } from "@agent-workbench/shared";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { getAgentMcpSettings, updateAgentMcpSettings } from "@/shared/api";

const { t } = useI18n();

type EditingServer = {
  id: string;
  enabled: boolean;
  config: AgentMcpServerConfig;
};

const loading = ref(false);
const saving = ref(false);
const pendingSave = ref(false);
const servers = ref<EditingServer[]>([]);

const serverModalOpen = ref(false);
const serverModalMode = ref<"create" | "edit">("create");
const serverFormId = ref("");
const serverFormEnabled = ref(true);
const serverFormJson = ref("{}");

const canSubmitServer = computed(() => {
  if (!serverFormId.value.trim()) return false;
  if (!serverFormJson.value.trim()) return false;
  return true;
});

function sortServers(list: EditingServer[]) {
  return [...list].sort((a, b) => a.id.localeCompare(b.id));
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseServerJson(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(t("settings.agentMcp.errors.invalidJson"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("settings.agentMcp.errors.invalidJson"));
  }
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  if (type !== "local" && type !== "remote") {
    throw new Error(t("settings.agentMcp.errors.invalidType"));
  }
  return parsed as AgentMcpServerConfig;
}

function mapFromSettings(settings: AgentMcpSettings) {
  servers.value = sortServers(
    settings.servers.map((item) => ({
      id: item.id,
      enabled: item.enabled,
      config: item.config
    }))
  );
}

function toRequestBody() {
  return {
    servers: sortServers(servers.value).map((item) => ({
      id: item.id,
      enabled: item.enabled,
      config: item.config
    }))
  } satisfies UpdateAgentMcpSettingsRequest;
}

function serverTypeLabel(server: EditingServer) {
  return server.config.type;
}

function summaryLabel(server: EditingServer) {
  if (server.config.type === "local") {
    return server.config.command.join(" ");
  }
  return server.config.url;
}

function openCreateServer() {
  serverModalMode.value = "create";
  serverFormId.value = "";
  serverFormEnabled.value = true;
  serverFormJson.value = stringifyPretty({
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
  });
  serverModalOpen.value = true;
}

function openEditServer(serverId: string) {
  const target = servers.value.find((item) => item.id === serverId);
  if (!target) return;
  serverModalMode.value = "edit";
  serverFormId.value = target.id;
  serverFormEnabled.value = target.enabled;
  serverFormJson.value = stringifyPretty(target.config);
  serverModalOpen.value = true;
}

function closeServerModal() {
  serverModalOpen.value = false;
  serverModalMode.value = "create";
  serverFormId.value = "";
  serverFormEnabled.value = true;
  serverFormJson.value = "{}";
}

function submitServer() {
  if (!canSubmitServer.value) {
    message.error(t("settings.agentMcp.errors.invalidForm"));
    return;
  }

  const id = serverFormId.value.trim();
  if (!id) {
    message.error(t("settings.agentMcp.errors.invalidForm"));
    return;
  }

  let config: AgentMcpServerConfig;
  try {
    config = parseServerJson(serverFormJson.value);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    return;
  }

  const payload: EditingServer = {
    id,
    enabled: serverFormEnabled.value,
    config
  };

  if (serverModalMode.value === "create") {
    if (servers.value.some((item) => item.id === id)) {
      message.error(t("settings.agentMcp.errors.duplicateServerId"));
      return;
    }
    servers.value.push(payload);
  } else {
    const idx = servers.value.findIndex((item) => item.id === id);
    if (idx < 0) return;
    servers.value[idx] = payload;
  }

  closeServerModal();
  void persist({ toast: true });
}

function confirmDeleteServer(serverId: string) {
  const target = servers.value.find((item) => item.id === serverId);
  if (!target) return;
  Modal.confirm({
    title: t("settings.agentMcp.deleteServer.title"),
    content: t("settings.agentMcp.deleteServer.content", { id: target.id }),
    okText: t("settings.agentMcp.deleteServer.ok"),
    cancelText: t("settings.agentMcp.deleteServer.cancel"),
    okType: "danger",
    onOk: () => {
      servers.value = servers.value.filter((item) => item.id !== serverId);
      void persist({ toast: true });
    }
  });
}

async function refreshDraft() {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await getAgentMcpSettings();
    mapFromSettings(res);
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
    const res = await updateAgentMcpSettings(body);
    mapFromSettings(res);
    if (params.toast) message.success(t("settings.agentMcp.saved"));
  } catch (err) {
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
