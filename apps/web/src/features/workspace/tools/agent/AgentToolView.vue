<template>
  <div class="h-full min-h-0 flex flex-col bg-[var(--panel-bg)]">
    <div v-if="visibleSessions.length === 0" class="h-full min-h-0 flex flex-col items-center justify-center gap-3">
      <div class="text-xs text-[color:var(--text-tertiary)]">{{ allSessions.length === 0 ? t("agent.empty") : t("agent.closedEmpty") }}</div>
      <a-button
        v-if="allSessions.length > 0"
        size="small"
        :disabled="creating"
        @click="reopenAllSessions"
      >
        {{ t("agent.actions.reopenClosed") }}
      </a-button>
      <a-button size="small" type="primary" :loading="creating" @click="createOneSession">{{ t("agent.actions.newClient") }}</a-button>
    </div>

    <a-tabs v-else class="agent-tabs h-full" size="small" :animated="false" :activeKey="effectiveActiveKey" @update:activeKey="onChangeTab">
      <template #rightExtra>
        <div class="flex items-center gap-1 pr-1">
          <a-tooltip :title="t('agent.actions.minimize')">
            <a-button size="small" type="text" @click="minimizeSelf">
              <template #icon><MinusOutlined /></template>
            </a-button>
          </a-tooltip>
        </div>
      </template>

      <a-tab-pane v-for="(session, index) in visibleSessions" :key="session.id">
        <template #tab>
          <span class="agent-tab-label">
            <span>{{ tabLabel(session, index) }}</span>
            <a-tooltip :title="t('agent.actions.closeClient')">
              <CloseOutlined
                class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !mr-0 text-xs"
                @mousedown.stop.prevent
                @click.stop.prevent="closeSessionTab(session.id)"
              />
            </a-tooltip>
          </span>
        </template>
        <div class="h-full min-h-0">
          <AgentClientPane
            :workspace-id="workspaceId"
            :session-id="session.id"
            :session-kind="session.kind"
            :parent-session-id="!isDraftSession(session) ? session.forkedFromSessionId : null"
            :session-ready="!isDraftSession(session)"
            :ensure-session="ensureSessionCreated"
            :poll-hint="sessionPollHints[session.id] ?? 0"
            :can-choose-session="canChooseSessionFrom(session.id)"
            :active="effectiveActiveKey === session.id"
            :model-value="selectedAgentBySession[session.id] ?? null"
            :agent-options="agentOptions"
            @update:model-value="(value) => setSessionAgent(session.id, value)"
            @forked="onSessionForked"
            @open-subtask="onOpenSubtask"
            @open-parent="onOpenParent"
            @choose-session="openChooseSessionModal(session.id)"
            @request-poll-session="onRequestPollSession"
          />
        </div>
      </a-tab-pane>

      <a-tab-pane key="__agent_add__">
        <template #tab>
          <a-tooltip :title="creating ? t('agent.actions.creating') : t('agent.actions.newClient')">
            <PlusOutlined class="agent-tab-add" :class="{ 'is-loading': creating }" />
          </a-tooltip>
        </template>
      </a-tab-pane>
    </a-tabs>

    <a-modal
      v-model:open="chooseSessionModalOpen"
      :title="t('agent.client.chooseSessionTitle')"
      :footer="null"
      :maskClosable="true"
      @cancel="closeChooseSessionModal"
    >
      <div v-if="chooseSessionLoading" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("common.loading") }}
      </div>
      <div v-else-if="chooseSessionItems.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("agent.client.noSessionToChoose") }}
      </div>
      <a-list v-else size="small" bordered :data-source="chooseSessionItems" class="choose-session-list max-h-[360px] overflow-auto">
        <template #renderItem="{ item }">
          <a-list-item class="choose-session-item !px-3 !py-2 cursor-pointer transition-colors" @click="chooseSession(item.id)">
            <div class="w-full min-w-0">
              <div class="text-xs text-[color:var(--text-tertiary)] truncate">{{ item.id }}</div>
              <div class="text-sm truncate">{{ item.preview }}</div>
            </div>
          </a-list-item>
        </template>
      </a-list>
    </a-modal>
  </div>
</template>

<script lang="ts">
export default {
  name: "agent"
};
</script>

<script setup lang="ts">
import type { AgentSessionRecord } from "@agent-workbench/shared";
import { CloseOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, onActivated, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { createAgentSession, getAgentSettings, listAgentSessions } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import AgentClientPane from "./AgentClientPane.vue";

type AgentOption = {
  value: string;
  label: string;
  isDefault?: boolean;
};

type DraftAgentSession = {
  id: string;
  workspaceId: string;
  title: string;
  kind: "primary";
  createdAt: number;
  updatedAt: number;
  isDraft: true;
};

type AgentSessionTab = AgentSessionRecord | DraftAgentSession;

type ChooseSessionItem = {
  id: string;
  preview: string;
  updatedAt: number;
};

const ADD_TAB_KEY = "__agent_add__";
const ACTIVE_KEY_STORAGE_PREFIX = "agent-workbench.workspace.agent.activeClient";
const AGENT_PICK_STORAGE_PREFIX = "agent-workbench.workspace.agent.pickBySession";
const CLOSED_SESSION_STORAGE_PREFIX = "agent-workbench.workspace.agent.closedSessions";
const AGENT_TAB_NO_STORAGE_KEY_PREFIX = "agent-workbench.workspace.agent.tabNoMap";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost(props.toolId);
const { t } = useI18n();

const loadingSessions = ref(false);
const creating = ref(false);
const serverSessions = ref<AgentSessionRecord[]>([]);
const draftSessions = ref<DraftAgentSession[]>([]);
const activeKey = ref<string>("");
const selectedAgentBySession = reactive<Record<string, string | null>>({});
const sessionPollHints = reactive<Record<string, number>>({});
const agentOptions = ref<AgentOption[]>([]);
const closedSessionIds = reactive<Record<string, true>>({});
const tabNoMap = ref<Record<string, number>>({});
const chooseSessionModalOpen = ref(false);
const chooseSessionLoading = ref(false);
const chooseSessionItems = ref<ChooseSessionItem[]>([]);
const chooseSessionSourceId = ref("");
const sessionsInitialized = ref(false);

const suppressTabNoPersist = ref(false);
const draftCreatePromises = new Map<string, Promise<string>>();

const allSessions = computed<AgentSessionTab[]>(() => [...serverSessions.value, ...draftSessions.value]);

const effectiveActiveKey = computed(() => {
  if (activeKey.value && visibleSessions.value.some((item) => item.id === activeKey.value)) return activeKey.value;
  return visibleSessions.value[0]?.id ?? "";
});

const visibleSessions = computed(() => {
  // tabs 的展示顺序按编号从小到大,确保新建 client 出现在最右侧。
  const list = allSessions.value.filter((item) => !closedSessionIds[item.id]);
  return [...list].sort((a, b) => {
    const na = tabNoMap.value[a.id];
    const nb = tabNoMap.value[b.id];
    const va = typeof na === "number" && Number.isFinite(na) ? na : Number.POSITIVE_INFINITY;
    const vb = typeof nb === "number" && Number.isFinite(nb) ? nb : Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    // fallback: 保持稳定
    return a.createdAt - b.createdAt;
  });
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

function closedSessionStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${CLOSED_SESSION_STORAGE_PREFIX}.v1`;
  return `${CLOSED_SESSION_STORAGE_PREFIX}.v1.${id}`;
}

function agentTabNoStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${AGENT_TAB_NO_STORAGE_KEY_PREFIX}.v1`;
  return `${AGENT_TAB_NO_STORAGE_KEY_PREFIX}.v1.${id}`;
}

function restoreTabNoMapFromStorage(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return;
  try {
    const raw = localStorage.getItem(agentTabNoStorageKey(id));
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return;
    const map: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== "string" || !k.trim()) continue;
      const n = typeof v === "number" ? v : Number.NaN;
      if (!Number.isFinite(n) || n <= 0) continue;
      map[k] = Math.floor(n);
    }
    tabNoMap.value = map;
  } catch {
    // ignore
  }
}

function persistTabNoMapToStorage(workspaceId: string, map: Record<string, number>) {
  const id = String(workspaceId || "").trim();
  if (!id) return;
  try {
    localStorage.setItem(agentTabNoStorageKey(id), JSON.stringify(map));
  } catch {
    // ignore
  }
}

function reconcileTabNoMap(params: { workspaceId: string; sessions: AgentSessionTab[] }) {
  const id = String(params.workspaceId || "").trim();
  if (!id) return;

  // 编号规则参考 TerminalTabs:
  // - 编号绑定到“当前打开的 tab”(在 agent 里即 visibleSessions),而不是绑定到服务端 session 生命周期
  // - 关闭 tab 后会从映射中移除,让 max 回退并复用编号
  // 只对当前 workspace 且当前可见的 session 分配编号,避免 workspace 切换时短暂拿到旧列表导致污染映射。
  const sessionsInWs = params.sessions
    .filter((s) => String(s.workspaceId || "").trim() === id)
    .filter((s) => !closedSessionIds[s.id]);
  const present = new Set(sessionsInWs.map((s) => s.id));
  const nextMap: Record<string, number> = { ...tabNoMap.value };

  // prune: 删除已不存在的 sessions
  for (const k of Object.keys(nextMap)) {
    if (!present.has(k)) delete nextMap[k];
  }

  let max = 0;
  for (const n of Object.values(nextMap)) {
    if (Number.isFinite(n) && n > max) max = n;
  }

  for (const sess of sessionsInWs) {
    const existing = nextMap[sess.id];
    if (typeof existing === "number" && Number.isFinite(existing) && existing > 0) continue;
    max += 1;
    nextMap[sess.id] = max;
  }

  tabNoMap.value = nextMap;
  if (suppressTabNoPersist.value) return;
  persistTabNoMapToStorage(id, nextMap);
}

function agentDisplayIndex(sessionId: string, fallback: number) {
  const n = tabNoMap.value[sessionId];
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function persistClosedSessions() {
  const key = closedSessionStorageKey(props.workspaceId);
  const ids = Object.keys(closedSessionIds);
  try {
    if (ids.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // ignore
  }
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
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string | null>;
      for (const [key, value] of Object.entries(parsed)) {
        selectedAgentBySession[key] = typeof value === "string" && value.trim() ? value : null;
      }
    }
  } catch {
    // ignore
  }

  try {
    const raw = localStorage.getItem(closedSessionStorageKey(props.workspaceId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const id of parsed) {
      const sid = String(id || "").trim();
      if (!sid) continue;
      closedSessionIds[sid] = true;
    }
  } catch {
    // ignore
  }

  restoreTabNoMapFromStorage(props.workspaceId);
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

function tabLabel(session: AgentSessionTab, index: number) {
  const displayIndex = agentDisplayIndex(session.id, index + 1);
  return t("agent.client.tabLabel", { index: displayIndex });
}

function isDraftSession(session: AgentSessionTab): session is DraftAgentSession {
  return (session as DraftAgentSession).isDraft === true;
}

function newDraftSessionId() {
  return `draft_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

function canChooseSessionFrom(sessionId: string) {
  const fromDraft = draftSessions.value.some((item) => item.id === sessionId);
  if (!fromDraft) return false;
  return serverSessions.value.some((item) => item.kind === "primary" && item.id !== sessionId);
}

function closeChooseSessionModal() {
  chooseSessionModalOpen.value = false;
  chooseSessionSourceId.value = "";
  chooseSessionItems.value = [];
}

function truncatePreview(text: string, maxLen = 50) {
  const value = text.trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

function setSessionAgent(sessionId: string, value: string | null) {
  selectedAgentBySession[sessionId] = value;
  persistAgentPick();
}

function bumpSessionPollHint(sessionId: string) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  sessionPollHints[id] = (sessionPollHints[id] ?? 0) + 1;
}

function onRequestPollSession(sessionId: string) {
  bumpSessionPollHint(sessionId);
}

async function refreshAgents() {
  try {
    const res = await getAgentSettings();
    const defaultAgentId = res.default?.agentId ?? "";
    agentOptions.value = res.agents.map((agent) => ({
      value: agent.id,
      label: agent.name,
      isDefault: defaultAgentId === agent.id
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
    serverSessions.value = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    // 先根据可见 tabs 做 prune/分配,避免隐藏 tab 让编号一路增长。
    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    const presentIds = new Set(allSessions.value.map((item) => item.id));
    let closedChanged = false;
    for (const id of Object.keys(closedSessionIds)) {
      if (!presentIds.has(id)) {
        delete closedSessionIds[id];
        closedChanged = true;
      }
    }
    for (const id of Object.keys(sessionPollHints)) {
      if (!presentIds.has(id)) {
        delete sessionPollHints[id];
      }
    }
    if (closedChanged) persistClosedSessions();
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
    const now = Date.now();
    const draftId = newDraftSessionId();
    const draft: DraftAgentSession = {
      id: draftId,
      workspaceId: props.workspaceId,
      title: t("agent.client.newTitle", { time: new Date(now).toLocaleTimeString() }),
      kind: "primary",
      createdAt: now,
      updatedAt: now,
      isDraft: true
    };
    draftSessions.value = [...draftSessions.value, draft];
    delete closedSessionIds[draft.id];
    persistClosedSessions();
    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    activeKey.value = draft.id;
    persistActiveKey(draft.id);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    creating.value = false;
  }
}

async function ensureSessionCreated(sessionId: string) {
  const draft = draftSessions.value.find((item) => item.id === sessionId);
  if (!draft) return sessionId;

  const pending = draftCreatePromises.get(sessionId);
  if (pending) return pending;

  const job = (async () => {
    const created = await createAgentSession({
      workspaceId: props.workspaceId,
      title: draft.title
    });

    draftSessions.value = draftSessions.value.filter((item) => item.id !== sessionId);
    serverSessions.value = [created, ...serverSessions.value.filter((item) => item.id !== created.id)].sort(
      (a, b) => b.updatedAt - a.updatedAt
    );

    const picked = selectedAgentBySession[sessionId] ?? null;
    selectedAgentBySession[created.id] = picked;
    delete selectedAgentBySession[sessionId];
    persistAgentPick();

    if (closedSessionIds[sessionId]) {
      closedSessionIds[created.id] = true;
      delete closedSessionIds[sessionId];
      persistClosedSessions();
    }

    if (tabNoMap.value[sessionId]) {
      const nextMap = { ...tabNoMap.value };
      nextMap[created.id] = nextMap[sessionId]!;
      delete nextMap[sessionId];
      tabNoMap.value = nextMap;
      if (!suppressTabNoPersist.value) {
        persistTabNoMapToStorage(props.workspaceId, nextMap);
      }
    }

    if (activeKey.value === sessionId) {
      activeKey.value = created.id;
      persistActiveKey(created.id);
    }

    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    return created.id;
  })()
    .finally(() => {
      draftCreatePromises.delete(sessionId);
    });

  draftCreatePromises.set(sessionId, job);
  return job;
}

function closeSessionTab(sessionId: string) {
  if (!sessionId) return;
  closedSessionIds[sessionId] = true;
  persistClosedSessions();

  // close 语义是“关闭本地 tab”,因此编号映射也应随之移除,让编号可复用。
  if (tabNoMap.value[sessionId]) {
    const nextMap = { ...tabNoMap.value };
    delete nextMap[sessionId];
    tabNoMap.value = nextMap;
    if (!suppressTabNoPersist.value) {
      persistTabNoMapToStorage(props.workspaceId, nextMap);
    }
  }

  if (activeKey.value !== sessionId) return;
  const next = visibleSessions.value.find((item) => item.id !== sessionId)?.id ?? "";
  activeKey.value = next;
  if (next) {
    persistActiveKey(next);
    return;
  }

  // 若关闭后无可见 tab,立即补一个新的草稿会话,避免出现“已全部关闭”空态。
  void createOneSession();
}

function reopenAllSessions() {
  for (const id of Object.keys(closedSessionIds)) {
    delete closedSessionIds[id];
  }
  persistClosedSessions();

  // reopen 后对当前可见 tabs 重新分配/对齐编号
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  const next = visibleSessions.value[0]?.id ?? "";
  activeKey.value = next;
  if (next) {
    persistActiveKey(next);
  }
}

async function onSessionForked(sessionId: string) {
  await refreshSessions();
  if (!sessionId) return;
  delete closedSessionIds[sessionId];
  persistClosedSessions();
  activeKey.value = sessionId;
  persistActiveKey(sessionId);
}

async function onOpenSubtask(sessionId: string) {
  if (!sessionId) return;
  await refreshSessions();
  delete closedSessionIds[sessionId];
  persistClosedSessions();
  activeKey.value = sessionId;
  persistActiveKey(sessionId);
}

async function onOpenParent(sessionId: string) {
  if (!sessionId) return;
  await refreshSessions();
  const target = serverSessions.value.find((item) => item.id === sessionId);
  if (!target) {
    message.warning(t("agent.client.parentSessionMissing"));
    return;
  }
  delete closedSessionIds[sessionId];
  persistClosedSessions();
  activeKey.value = sessionId;
  persistActiveKey(sessionId);
}

function replaceDraftWithSession(params: { fromSessionId: string; targetSessionId: string }) {
  const fromSessionId = params.fromSessionId;
  const targetSessionId = params.targetSessionId;
  const fromDraft = draftSessions.value.find((item) => item.id === fromSessionId);
  if (!fromDraft) return;
  const target = serverSessions.value.find((item) => item.id === targetSessionId && item.kind === "primary");
  if (!target) {
    message.warning(t("agent.client.noSessionToChoose"));
    return;
  }

  draftSessions.value = draftSessions.value.filter((item) => item.id !== fromSessionId);
  delete closedSessionIds[fromSessionId];
  delete closedSessionIds[target.id];
  persistClosedSessions();

  const fromNo = tabNoMap.value[fromSessionId];
  const nextMap = { ...tabNoMap.value };
  if (typeof fromNo === "number" && Number.isFinite(fromNo) && fromNo > 0) {
    nextMap[target.id] = fromNo;
  }
  delete nextMap[fromSessionId];
  tabNoMap.value = nextMap;
  if (!suppressTabNoPersist.value) {
    persistTabNoMapToStorage(props.workspaceId, nextMap);
  }

  delete selectedAgentBySession[fromSessionId];
  persistAgentPick();

  activeKey.value = target.id;
  persistActiveKey(target.id);

  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
}

async function openChooseSessionModal(fromSessionId: string) {
  const fromDraft = draftSessions.value.find((item) => item.id === fromSessionId);
  if (!fromDraft) return;

  chooseSessionSourceId.value = fromSessionId;
  chooseSessionModalOpen.value = true;
  chooseSessionLoading.value = true;

  const candidates = [...serverSessions.value]
    .filter(
      (item) =>
        item.kind === "primary" &&
        item.id !== fromSessionId &&
        item.headItemId !== null &&
        String(item.title || "").trim().length > 0 &&
        String(item.title || "").trim() !== "新会话"
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (candidates.length === 0) {
    chooseSessionItems.value = [];
    chooseSessionLoading.value = false;
    return;
  }

  chooseSessionItems.value = candidates.map((session) => ({
    id: session.id,
    preview: truncatePreview(session.title, 50) || t("agent.client.sessionEmptyPreview"),
    updatedAt: session.updatedAt
  }));
  chooseSessionLoading.value = false;
}

function chooseSession(targetSessionId: string) {
  const fromSessionId = chooseSessionSourceId.value;
  if (!fromSessionId) {
    closeChooseSessionModal();
    return;
  }
  replaceDraftWithSession({ fromSessionId, targetSessionId });
  closeChooseSessionModal();
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
    sessionsInitialized.value = false;
    activeKey.value = "";
    serverSessions.value = [];
    draftSessions.value = [];
    for (const key of Object.keys(closedSessionIds)) {
      delete closedSessionIds[key];
    }
    suppressTabNoPersist.value = true;
    tabNoMap.value = {};
    for (const key of Object.keys(selectedAgentBySession)) {
      delete selectedAgentBySession[key];
    }
    for (const key of Object.keys(sessionPollHints)) {
      delete sessionPollHints[key];
    }
    restorePersistedState();
    await refreshAll();
    suppressTabNoPersist.value = false;
    if (visibleSessions.value.length === 0) {
      await createOneSession();
    }
    sessionsInitialized.value = true;
  },
  { immediate: true }
);

onActivated(() => {
  if (!sessionsInitialized.value) return;
  if (loadingSessions.value || creating.value) return;
  if (visibleSessions.value.length > 0) return;
  void createOneSession();
});

onMounted(() => {
  restorePersistedState();
});
</script>

<style scoped>
.agent-tabs {
  flex: 1;
  min-height: 0;
  height: 100%;
  background: var(--panel-bg);
}

.agent-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
}

.agent-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0 !important;
  background: var(--panel-bg-elevated);
}

.agent-tabs :deep(.ant-tabs-content-holder) {
  flex: 1;
  min-height: 0;
  padding: 0 !important;
}

.agent-tabs :deep(.ant-tabs-content) {
  height: 100%;
}

.agent-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
  padding: 0 !important;
}

.agent-tabs :deep(.ant-tabs-tab) {
  margin-left: 0 !important;
}

.agent-tab-add {
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
}

.agent-tab-add.is-loading {
  opacity: 0.6;
}

:deep(.choose-session-item:hover) {
  background: rgba(59, 130, 246, 0.12) !important;
}

</style>
