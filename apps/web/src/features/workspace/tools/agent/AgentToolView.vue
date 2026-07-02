<template>
  <div class="h-full min-h-0 flex flex-col bg-[var(--panel-bg)]">
    <div v-if="visibleSessions.length === 0" class="h-full min-h-0 flex flex-col items-center justify-center gap-3">
      <div class="text-[0.9em] text-[color:var(--text-tertiary)]">{{ allSessions.length === 0 ? t("agent.empty") : t("agent.closedEmpty") }}</div>
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
            <span class="agent-tab-title-wrap">
              <span>{{ tabLabel(session, index) }}</span>
              <component
                :is="statusStore.iconComponentOf(session.id)"
                v-if="statusStore.indicatorOf(session.id).icon"
                class="agent-tab-status-icon shrink-0 !m-0"
                :class="statusStore.indicatorOf(session.id).iconClass"
                :spin="statusStore.indicatorOf(session.id).spin"
              />
              <span v-if="statusStore.indicatorOf(session.id).showDot" class="agent-tab-terminal-dot" />
            </span>
            <a-tooltip :title="t('agent.actions.closeClient')">
              <CloseOutlined
                class="cursor-pointer text-[color:var(--text-tertiary)] hover:text-[color:var(--text-secondary)] !mr-0 text-[0.9em]"
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
            :session-title="session.title"
            :session-ready="!isDraftSession(session)"
            :ensure-session="ensureSessionCreated"
             :can-choose-session="canChooseSessionFrom(session.id)"
             :active="effectiveActiveKey === session.id"
             :model-value="selectedAgentBySession[session.id] ?? null"
             :tool-id="toolId"
             :agent-options="agentOptions"
              @update:model-value="(value) => setSessionAgent(session.id, value)"
               @forked="onSessionForked"
              @open-subtask="onOpenSubtask"
                @open-parent="(parentSessionId) => onOpenParent(session.id, parentSessionId)"
                @session-title-sync-needed="requestSessionTitleSync"
                @choose-session="openChooseSessionModal(session.id)"
                @agent-settings-updated="onAgentSettingsUpdated"
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
      <div class="agent-choose-session-modal" :style="{ fontSize: 'var(--agent-font-size, 13px)' }">
        <div v-if="chooseSessionLoading" class="text-[0.9em] text-[color:var(--text-tertiary)]">
          {{ t("common.loading") }}
        </div>
        <div v-else-if="chooseSessionItems.length === 0" class="text-[0.9em] text-[color:var(--text-tertiary)]">
          {{ t("agent.client.noSessionToChoose") }}
        </div>
        <a-list v-else size="small" bordered :data-source="chooseSessionItems" class="choose-session-list max-h-[360px] overflow-auto">
          <template #renderItem="{ item }">
            <a-list-item class="choose-session-item !px-3 !py-2 cursor-pointer transition-colors" @click="chooseSession(item.id)">
              <div class="w-full min-w-0">
                <div class="text-[0.85em] text-[color:var(--text-tertiary)] truncate">{{ item.id }}</div>
                <div class="text-[0.95em] truncate">{{ item.preview }}</div>
              </div>
            </a-list-item>
          </template>
        </a-list>
      </div>
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
import { computed, onActivated, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { createAgentSession, listAgentSessions, listWorkspaceAvailableAgents } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import AgentClientPane from "./AgentClientPane.vue";
import { agentSessionStatusStoreKey, createAgentSessionStatusStore } from "./useAgentSessionStatusStore";

type AgentOption = {
  value: string;
  label: string;
  resolvedModel?: {
    providerId: string;
    contextWindowTokens: number;
    providerName: string;
    modelId: string;
    modelName: string;
  } | null;
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
const OPENED_SUBTASK_SESSION_STORAGE_PREFIX = "agent-workbench.workspace.agent.openedSubtaskSessions";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost(props.toolId);
const { t } = useI18n();

const loadingSessions = ref(false);
const creating = ref(false);
const serverSessions = ref<AgentSessionRecord[]>([]);
const draftSessions = ref<DraftAgentSession[]>([]);
const activeKey = ref<string>("");
const selectedAgentBySession = reactive<Record<string, string | null>>({});
const agentOptions = ref<AgentOption[]>([]);
const closedSessionIds = reactive<Record<string, true>>({});
const openedSubtaskSessionIds = reactive<Record<string, true>>({});
const tabNoMap = ref<Record<string, number>>({});
const chooseSessionModalOpen = ref(false);
const chooseSessionLoading = ref(false);
const chooseSessionItems = ref<ChooseSessionItem[]>([]);
const chooseSessionSourceId = ref("");
const sessionsInitialized = ref(false);
const serverSessionsLoaded = ref(false);
const pendingSessionTitleSyncUpdatedAt = reactive<Record<string, number>>({});
const draftCreatePromises = new Map<string, Promise<string>>();
let openParentIntentId = 0;

function invalidateOpenParentIntent() {
  openParentIntentId += 1;
}

const statusStore = createAgentSessionStatusStore();
provide(agentSessionStatusStoreKey, statusStore);

const allSessions = computed<AgentSessionTab[]>(() => [...serverSessions.value, ...draftSessions.value]);

const effectiveActiveKey = computed(() => {
  if (activeKey.value && visibleSessions.value.some((item) => item.id === activeKey.value)) return activeKey.value;
  return visibleSessions.value[0]?.id ?? "";
});

const visibleSessions = computed(() => {
  // tabs 的展示顺序按编号从小到大,确保新建 client 出现在最右侧。
  const list = allSessions.value.filter((item) => {
    if (closedSessionIds[item.id]) return false;
    if (item.kind === "subtask") return !!openedSubtaskSessionIds[item.id];
    return true;
  });
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

function openedSubtaskSessionStorageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  if (!id) return `${OPENED_SUBTASK_SESSION_STORAGE_PREFIX}.v1`;
  return `${OPENED_SUBTASK_SESSION_STORAGE_PREFIX}.v1.${id}`;
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
    .filter((s) => !closedSessionIds[s.id])
    .filter((s) => s.kind !== "subtask" || !!openedSubtaskSessionIds[s.id]);
  const present = new Set(sessionsInWs.map((s) => s.id));
  const nextMap: Record<string, number> = { ...tabNoMap.value };

  // prune: 删除已不存在的 sessions
  for (const k of Object.keys(nextMap)) {
    if (!present.has(k)) delete nextMap[k];
  }

  const used = new Set<number>();
  let max = 0;

  // 先保留当前可见 tabs 中有效且不冲突的已有编号
  for (const sess of sessionsInWs) {
    const existing = nextMap[sess.id];
    if (typeof existing !== "number" || !Number.isFinite(existing) || existing <= 0) {
      delete nextMap[sess.id];
      continue;
    }
    const normalized = Math.floor(existing);
    if (used.has(normalized)) {
      delete nextMap[sess.id];
      continue;
    }
    nextMap[sess.id] = normalized;
    used.add(normalized);
    if (normalized > max) max = normalized;
  }

  // 对缺失/冲突项按当前 max+1 分配
  for (const sess of sessionsInWs) {
    const existing = nextMap[sess.id];
    if (typeof existing === "number" && Number.isFinite(existing) && existing > 0) continue;
    max += 1;
    while (used.has(max)) max += 1;
    nextMap[sess.id] = max;
    used.add(max);
  }

  tabNoMap.value = nextMap;
}

function agentDisplayIndex(sessionId: string, index: number) {
  const n = tabNoMap.value[sessionId];
  if (Number.isFinite(n) && n > 0) return n;
  // 无映射时用 "当前已分配最大编号 + 当前序位" 兜底，避免同屏显示重复 1。
  let max = 0;
  for (const value of Object.values(tabNoMap.value)) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + Math.max(1, index + 1);
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

function persistOpenedSubtaskSessions() {
  const key = openedSubtaskSessionStorageKey(props.workspaceId);
  const ids = Object.keys(openedSubtaskSessionIds).sort((a, b) => a.localeCompare(b));
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
    const raw = localStorage.getItem(openedSubtaskSessionStorageKey(props.workspaceId));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          const sid = String(id || "").trim();
          if (!sid) continue;
          openedSubtaskSessionIds[sid] = true;
        }
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
  const displayIndex = agentDisplayIndex(session.id, index);
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

async function refreshAgents() {
  try {
    const res = await listWorkspaceAvailableAgents(props.workspaceId, "user");
    agentOptions.value = res.agents
      .map((agent) => ({
        value: agent.id,
        label: agent.name,
        resolvedModel: agent.resolvedModel ?? null
      }));
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function onAgentSettingsUpdated() {
  void refreshAgents();
}

function pruneOpenedSubtaskSessions() {
  const presentIds = new Set(
    serverSessions.value
      .filter((item) => item.kind === "subtask" && String(item.workspaceId || "").trim() === String(props.workspaceId || "").trim())
      .map((item) => item.id)
  );
  let changed = false;
  for (const id of Object.keys(openedSubtaskSessionIds)) {
    if (presentIds.has(id)) continue;
    delete openedSubtaskSessionIds[id];
    changed = true;
  }
  if (changed) persistOpenedSubtaskSessions();
}

async function refreshSessions() {
  if (loadingSessions.value) return false;
  loadingSessions.value = true;
  let ok = false;
  try {
    const list = await listAgentSessions(props.workspaceId);
    serverSessions.value = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    pruneOpenedSubtaskSessions();
    // 先根据可见 tabs 做 prune/分配,避免隐藏 tab 让编号一路增长。
    serverSessionsLoaded.value = true;
    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    const presentIds = new Set(allSessions.value.map((item) => item.id));
    let closedChanged = false;
    for (const id of Object.keys(closedSessionIds)) {
      if (!presentIds.has(id)) {
        delete closedSessionIds[id];
        closedChanged = true;
      }
    }
    if (closedChanged) persistClosedSessions();
    if (effectiveActiveKey.value) {
      activeKey.value = effectiveActiveKey.value;
      persistActiveKey(effectiveActiveKey.value);
    }
    ok = true;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loadingSessions.value = false;
  }
  return ok;
}

async function refreshAll() {
  await Promise.all([refreshAgents(), refreshSessions()]);
}

function requestSessionTitleSync(sessionId: string) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return;
  const runState = statusStore.runStateOf(targetSessionId);
  const updatedAt = typeof runState.updatedAt === "number" && Number.isFinite(runState.updatedAt) ? runState.updatedAt : 0;
  pendingSessionTitleSyncUpdatedAt[targetSessionId] = updatedAt;
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
      title: t("agent.client.newTitle"),
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
    }

    if (activeKey.value === sessionId) {
      activeKey.value = created.id;
      persistActiveKey(created.id);
    }

    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });

    // 新会话首条消息: draft pane 可能在发送期间被卸载,导致其 emit 的 poll hint 丢失。
    // 这里在创建成功后主动 bump 一次,确保新 pane 至少会做一次刷新+短轮询兜底。
    requestSessionTitleSync(created.id);
    statusStore.bumpPollHint(created.id, { immediate: true, warmup: true });
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
  }

  if (activeKey.value !== sessionId) return;
  const next = visibleSessions.value.find((item) => item.id !== sessionId)?.id ?? "";
  invalidateOpenParentIntent();
  activeKey.value = next;
  statusStore.markSessionSeen(next);
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
  invalidateOpenParentIntent();
  const next = visibleSessions.value[0]?.id ?? "";
  activeKey.value = next;
  statusStore.markSessionSeen(next);
  if (next) {
    persistActiveKey(next);
  }
}

async function onSessionForked(sessionId: string) {
  await refreshSessions();
  if (!sessionId) return;
  delete closedSessionIds[sessionId];
  persistClosedSessions();
  invalidateOpenParentIntent();
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  activeKey.value = sessionId;
  statusStore.markSessionSeen(sessionId);
  persistActiveKey(sessionId);
}

async function onOpenSubtask(sessionId: string) {
  if (!sessionId) return;
  openedSubtaskSessionIds[sessionId] = true;
  persistOpenedSubtaskSessions();
  await refreshSessions();
  delete closedSessionIds[sessionId];
  persistClosedSessions();
  invalidateOpenParentIntent();
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  activeKey.value = sessionId;
  statusStore.markSessionSeen(sessionId);
  persistActiveKey(sessionId);
}

function activateParentSessionTab(sessionId: string) {
  if (!sessionId) return;
  delete closedSessionIds[sessionId];
  persistClosedSessions();
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  activeKey.value = sessionId;
  statusStore.markSessionSeen(sessionId);
  persistActiveKey(sessionId);
}

async function onOpenParent(sourceSessionId: string, sessionId: string) {
  if (!sessionId) return;
  const localTarget = serverSessions.value.find((item) => item.id === sessionId && item.kind === "primary");
  if (localTarget) {
    const intentId = ++openParentIntentId;
    activateParentSessionTab(sessionId);
    if (sourceSessionId && sourceSessionId !== sessionId) {
      closeSessionTab(sourceSessionId);
    }
    void refreshSessions().then((ok) => {
      if (!ok) return;
      if (intentId !== openParentIntentId) return;
      const refreshedTarget = serverSessions.value.find((item) => item.id === sessionId);
      if (refreshedTarget) return;
      const fallback = effectiveActiveKey.value || visibleSessions.value[0]?.id || "";
      if (fallback) {
        activeKey.value = fallback;
        statusStore.markSessionSeen(fallback);
        persistActiveKey(fallback);
      } else {
        void createOneSession();
      }
      if (activeKey.value !== fallback && activeKey.value !== sessionId) return;
      message.warning(t("agent.client.parentSessionMissing"));
    });
    return;
  }
  const intentId = ++openParentIntentId;
  await refreshSessions();
  if (intentId !== openParentIntentId) return;
  const target = serverSessions.value.find((item) => item.id === sessionId);
  if (!target) {
    message.warning(t("agent.client.parentSessionMissing"));
    return;
  }
  activateParentSessionTab(sessionId);
  if (sourceSessionId && sourceSessionId !== sessionId) {
    closeSessionTab(sourceSessionId);
  }
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

  delete selectedAgentBySession[fromSessionId];
  persistAgentPick();

  invalidateOpenParentIntent();
  activeKey.value = target.id;
  statusStore.markSessionSeen(target.id);
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
    invalidateOpenParentIntent();
    void createOneSession();
    return;
  }
  invalidateOpenParentIntent();
  activeKey.value = next;
  statusStore.markSessionSeen(next);
  persistActiveKey(next);
}

function minimizeSelf() {
  host.minimizeTool(props.toolId);
}

watch(
  () => props.workspaceId,
  async () => {
    sessionsInitialized.value = false;
    invalidateOpenParentIntent();
    activeKey.value = "";
    serverSessions.value = [];
    serverSessionsLoaded.value = false;
    draftSessions.value = [];
    for (const key of Object.keys(closedSessionIds)) {
      delete closedSessionIds[key];
    }
    for (const key of Object.keys(openedSubtaskSessionIds)) {
      delete openedSubtaskSessionIds[key];
    }
    tabNoMap.value = {};
    for (const key of Object.keys(selectedAgentBySession)) {
      delete selectedAgentBySession[key];
    }
    for (const key of Object.keys(pendingSessionTitleSyncUpdatedAt)) {
      delete pendingSessionTitleSyncUpdatedAt[key];
    }
    restorePersistedState();
    await refreshAll();
    statusStore.bindWorkspace(props.workspaceId);
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
  statusStore.syncSessions({
    activeSessionId: effectiveActiveKey.value || null,
    visibleSessionIds: visibleSessions.value.map((item) => item.id),
    registeredSessionIds: serverSessions.value.map((item) => item.id),
    sessionKinds: Object.fromEntries(serverSessions.value.map((item) => [item.id, item.kind]))
  });
  void createOneSession();
});

onMounted(() => {
  restorePersistedState();
});

watch(
  () => [props.workspaceId, effectiveActiveKey.value, visibleSessions.value.map((item) => item.id).join("|"), serverSessions.value.map((item) => item.id).join("|")] as const,
  () => {
    statusStore.bindWorkspace(props.workspaceId);
    statusStore.syncSessions({
      activeSessionId: effectiveActiveKey.value || null,
      visibleSessionIds: visibleSessions.value.map((item) => item.id),
      sessionKinds: Object.fromEntries(serverSessions.value.map((item) => [item.id, item.kind])),
      ...(serverSessionsLoaded.value ? { registeredSessionIds: serverSessions.value.map((item) => item.id) } : {})
    });
  },
  { immediate: true }
);

watch(
  () => {
    const sessionId = effectiveActiveKey.value;
    const baselineUpdatedAt = sessionId ? (pendingSessionTitleSyncUpdatedAt[sessionId] ?? null) : null;
    const runState = sessionId ? statusStore.runStateOf(sessionId) : null;
    return [sessionId, baselineUpdatedAt, runState?.status ?? "", runState?.updatedAt ?? 0, loadingSessions.value] as const;
  },
  ([sessionId, baselineUpdatedAt, status, updatedAt, loading]) => {
    if (!sessionId || baselineUpdatedAt == null || loading) return;
    if (status !== "idle") return;
    const nextUpdatedAt = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : 0;
    if (nextUpdatedAt <= baselineUpdatedAt) return;
    const retryBaseline = pendingSessionTitleSyncUpdatedAt[sessionId];
    delete pendingSessionTitleSyncUpdatedAt[sessionId];
    void refreshSessions().then((ok) => {
      if (ok) return;
      pendingSessionTitleSyncUpdatedAt[sessionId] = retryBaseline ?? baselineUpdatedAt;
    });
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  statusStore.dispose();
});
</script>

<style scoped>
.agent-tabs {
  flex: 1;
  min-height: 0;
  height: 100%;
  background: var(--panel-bg);
}

.agent-tab-title-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.agent-tab-status-icon {
  font-size: 0.9em;
}

.agent-tab-terminal-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--danger-color);
  flex: 0 0 auto;
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
