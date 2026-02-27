<template>
  <div class="h-full min-h-0 flex flex-col bg-[var(--panel-bg)]">
    <div v-if="sessions.length === 0" class="h-full min-h-0 flex flex-col items-center justify-center gap-3">
      <div class="text-xs text-[color:var(--text-tertiary)]">{{ t("agent.empty") }}</div>
      <a-button size="small" type="primary" :loading="creating" @click="createOneSession">{{ t("agent.actions.newClient") }}</a-button>
    </div>

    <a-tabs v-else class="agent-tabs h-full" size="small" :animated="false" :activeKey="effectiveActiveKey" @update:activeKey="onChangeTab">
      <template #rightExtra>
        <div class="flex items-center gap-1 pr-1">
          <a-tooltip :title="t('agent.actions.refresh')">
            <a-button size="small" type="text" :loading="loadingSessions" @click="refreshAll">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </a-tooltip>
          <a-tooltip :title="t('agent.actions.minimize')">
            <a-button size="small" type="text" @click="minimizeSelf">
              <template #icon><MinusOutlined /></template>
            </a-button>
          </a-tooltip>
        </div>
      </template>

      <a-tab-pane v-for="(session, index) in sessions" :key="session.id" :tab="tabLabel(session, index)" :forceRender="true">
        <div class="h-full min-h-0">
          <AgentClientPane
            :workspace-id="workspaceId"
            :session-id="session.id"
            :active="effectiveActiveKey === session.id"
            :model-value="selectedAgentBySession[session.id] ?? null"
            :agent-options="agentOptions"
            @update:model-value="(value) => setSessionAgent(session.id, value)"
          />
        </div>
      </a-tab-pane>

      <a-tab-pane key="__agent_add__">
        <template #tab>
          <a-tooltip :title="creating ? t('agent.actions.creating') : t('agent.actions.newClient')">
            <PlusOutlined class="px-2" />
          </a-tooltip>
        </template>
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<script lang="ts">
export default {
  name: "agent"
};
</script>

<script setup lang="ts">
import type { AgentSessionRecord } from "@agent-workbench/shared";
import { MinusOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { createAgentSession, getAgentSettings, listAgentSessions } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import AgentClientPane from "./AgentClientPane.vue";

type AgentOption = {
  value: string;
  label: string;
};

const ADD_TAB_KEY = "__agent_add__";
const ACTIVE_KEY_STORAGE_PREFIX = "agent-workbench.workspace.agent.activeClient";
const AGENT_PICK_STORAGE_PREFIX = "agent-workbench.workspace.agent.pickBySession";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost(props.toolId);
const { t } = useI18n();

const loadingSessions = ref(false);
const creating = ref(false);
const sessions = ref<AgentSessionRecord[]>([]);
const activeKey = ref<string>("");
const selectedAgentBySession = reactive<Record<string, string | null>>({});
const agentOptions = ref<AgentOption[]>([]);

const effectiveActiveKey = computed(() => {
  if (activeKey.value && sessions.value.some((item) => item.id === activeKey.value)) return activeKey.value;
  return sessions.value[0]?.id ?? "";
});

function activeKeyStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${ACTIVE_KEY_STORAGE_PREFIX}.v1`;
  return `${ACTIVE_KEY_STORAGE_PREFIX}.v1.${id}`;
}

function agentPickStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${AGENT_PICK_STORAGE_PREFIX}.v1`;
  return `${AGENT_PICK_STORAGE_PREFIX}.v1.${id}`;
}

function restorePersistedState() {
  try {
    const savedActive = localStorage.getItem(activeKeyStorageKey(props.workspaceId));
    if (savedActive) activeKey.value = savedActive;
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(agentPickStorageKey(props.workspaceId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string | null>;
    for (const [key, value] of Object.entries(parsed)) {
      selectedAgentBySession[key] = typeof value === "string" && value.trim() ? value : null;
    }
  } catch {
    // ignore
  }
}

function persistActiveKey(key: string) {
  try {
    localStorage.setItem(activeKeyStorageKey(props.workspaceId), key);
  } catch {
    // ignore
  }
}

function persistAgentPick() {
  try {
    localStorage.setItem(agentPickStorageKey(props.workspaceId), JSON.stringify(selectedAgentBySession));
  } catch {
    // ignore
  }
}

function tabLabel(session: AgentSessionRecord, index: number) {
  const title = String(session.title || "").trim();
  if (title) return title;
  return t("agent.client.tabLabel", { index: index + 1 });
}

function setSessionAgent(sessionId: string, value: string | null) {
  selectedAgentBySession[sessionId] = value;
  persistAgentPick();
}

async function refreshAgents() {
  try {
    const res = await getAgentSettings();
    agentOptions.value = res.agents.map((agent) => ({
      value: agent.id,
      label: `${agent.name} (${agent.id})`
    }));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function refreshSessions() {
  if (loadingSessions.value) return;
  loadingSessions.value = true;
  try {
    const list = await listAgentSessions(props.workspaceId);
    sessions.value = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    if (effectiveActiveKey.value) {
      activeKey.value = effectiveActiveKey.value;
      persistActiveKey(effectiveActiveKey.value);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loadingSessions.value = false;
  }
}

async function refreshAll() {
  await Promise.all([refreshAgents(), refreshSessions()]);
}

async function createOneSession() {
  if (creating.value) return;
  creating.value = true;
  try {
    const created = await createAgentSession({
      workspaceId: props.workspaceId,
      title: t("agent.client.newTitle", { time: new Date().toLocaleTimeString() })
    });
    await refreshSessions();
    activeKey.value = created.id;
    persistActiveKey(created.id);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    creating.value = false;
  }
}

function onChangeTab(key: string | number) {
  const next = String(key || "");
  if (next === ADD_TAB_KEY) {
    void createOneSession();
    return;
  }
  activeKey.value = next;
  persistActiveKey(next);
}

function minimizeSelf() {
  host.minimizeTool(props.toolId);
}

watch(
  () => props.workspaceId,
  async () => {
    activeKey.value = "";
    sessions.value = [];
    for (const key of Object.keys(selectedAgentBySession)) {
      delete selectedAgentBySession[key];
    }
    restorePersistedState();
    await refreshAll();
    if (sessions.value.length === 0) {
      await createOneSession();
    }
  },
  { immediate: true }
);

onMounted(() => {
  restorePersistedState();
});
</script>

<style scoped>
.agent-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0 !important;
  background: var(--panel-bg-elevated);
}

.agent-tabs :deep(.ant-tabs-content-holder) {
  flex: 1;
  min-height: 0;
}

.agent-tabs :deep(.ant-tabs-content) {
  height: 100%;
}

.agent-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
  padding: 0 !important;
}
</style>
