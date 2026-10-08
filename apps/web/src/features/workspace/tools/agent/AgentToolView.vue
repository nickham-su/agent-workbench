<template>
  <div class="h-full min-h-0 flex flex-col bg-[var(--panel-bg)]">
    <div v-if="initializationState === 'loading'" data-testid="agent-tab-state-loading" class="h-full min-h-0 flex flex-col items-center justify-center gap-3">
      <div class="text-[0.9em] text-[color:var(--text-tertiary)]">{{ t("agent.client.tabStateLoading") }}</div>
    </div>

    <div v-else-if="initializationState === 'error'" data-testid="agent-tab-state-error" class="h-full min-h-0 flex flex-col items-center justify-center gap-3">
      <div class="text-[0.9em] text-[color:var(--text-tertiary)]">{{ t("agent.client.tabStateLoadFailed") }}</div>
      <a-button size="small" type="primary" @click="retryInitialization">{{ t("agent.client.retryTabStateLoad") }}</a-button>
    </div>

    <div v-else-if="visibleSessions.length === 0" data-testid="agent-session-empty" class="h-full min-h-0 flex flex-col items-center justify-center gap-3">
      <div class="text-[0.9em] text-[color:var(--text-tertiary)]">{{ t("agent.empty") }}</div>
      <a-button size="small" type="primary" :loading="creating" @click="createOneSession">{{ t("agent.actions.newClient") }}</a-button>
    </div>

    <a-tabs v-else class="agent-tabs h-full" size="small" :animated="false" :activeKey="effectiveActiveKey" @update:activeKey="onChangeTab">
      <template #rightExtra>
        <div class="flex items-center gap-1 pr-1">
          <a-button size="small" data-testid="agent-tabs-reload" :loading="reloadingTabs" @click="reloadTabsSnapshot">{{ t("agent.client.reloadTabs") }}</a-button>
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
            :initial-draft="draftInitialTextBySession[session.id] ?? ''"
            :ensure-session="ensureSessionCreated"
            :can-choose-session="canChooseSessionFrom(session.id)"
            :active="effectiveActiveKey === session.id"
            :model-value="selectedAgentBySession[session.id] ?? null"
            :tool-id="toolId"
            :agent-options="agentOptions"
            :subtask-agent-labels="subtaskAgentLabels"
            :session-model-states="sessionModelStates[session.id] ?? {}"
            :session-model-state-loading="!!sessionModelStateLoads[session.id]"
            :session-model-mutation-pending="!!sessionModelMutationPending[session.id]"
            :model-open-intent="pendingModelOpenIntentBySession[session.id] ?? null"
            @update:model-value="(value) => setSessionAgent(session.id, value)"
            @forked="onSessionForked"
            @open-subtask="onOpenSubtask"
            @open-title-setting="openTitleModal(session)"
            @open-parent="(parentSessionId) => onOpenParent(session.id, parentSessionId)"
            @session-title-sync-needed="requestSessionTitleSync"
            @session-metadata-updated="onSessionMetadataUpdated"
            @choose-session="openChooseSessionModal(session.id)"
            @agent-settings-updated="onAgentSettingsUpdated"
            @request-session-model-open="onRequestSessionModelOpen"
            @session-model-open-consumed="onSessionModelOpenConsumed"
            @session-model-state-updated="onSessionModelStateUpdated"
            @session-model-mutation-pending="onSessionModelMutationPending"
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

    <div v-if="targetOpeningSessionId" data-testid="agent-target-loading" class="text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>
    <a-button v-if="failedSessionTitleSync[effectiveActiveKey]" size="small" @click="syncSessionTitle(effectiveActiveKey)">{{ t("agent.client.retryTitleSync") }}</a-button>

    <a-modal
      v-model:open="chooseSessionModalOpen"
      :title="t('agent.client.chooseSessionTitle')"
      :footer="null"
      :maskClosable="true"
      @cancel="closeChooseSessionModal"
    >
      <div class="agent-choose-session-modal" :style="{ fontSize: 'var(--agent-font-size, 13px)' }">
        <div class="flex gap-2 mb-2">
          <a-button data-testid="agent-picker-refresh" @click="loadChooseSessionPage(true)">{{ t("agent.client.refreshSessionList") }}</a-button>
        </div>
        <div v-if="chooseSessionLoading && !chooseSessionHasPage" data-testid="agent-picker-loading">{{ t("common.loading") }}</div>
        <div v-if="chooseSessionPageError" data-testid="agent-picker-page-error">
          {{ t(chooseSessionPageError === "cursor" ? "agent.client.sessionListExpired" : "agent.client.sessionListFailed") }}
          <a-button data-testid="agent-picker-page-retry" @click="loadChooseSessionPage(!chooseSessionHasPage || chooseSessionPageError === 'cursor')">{{ t("agent.client.retryTabStateLoad") }}</a-button>
        </div>
        <div v-else-if="chooseSessionHasPage && chooseSessionItems.length === 0" data-testid="agent-picker-empty">{{ t("agent.client.noSessionToChoose") }}</div>
        <div v-if="chooseSessionSelecting" class="text-[color:var(--text-tertiary)]">{{ t("common.loading") }}</div>
        <a-button v-if="failedPickerSelection" data-testid="agent-picker-retry" @click="chooseSession(failedPickerSelection.targetId, true)">{{ t("agent.client.retrySessionSelection") }}</a-button>
        <a-list v-if="chooseSessionItems.length" size="small" bordered :data-source="chooseSessionItems" class="choose-session-list max-h-[360px] overflow-auto">
          <template #renderItem="{ item }">
            <a-list-item class="choose-session-item !px-3 !py-2 cursor-pointer transition-colors" @click="chooseSession(item.id)">
              <div class="w-full min-w-0">
                <div class="text-[0.85em] text-[color:var(--text-tertiary)] truncate">{{ item.id }}</div>
                <div class="text-[0.95em] truncate">{{ item.preview }}</div>
              </div>
            </a-list-item>
          </template>
        </a-list>
        <a-button v-if="chooseSessionNextCursor" data-testid="agent-picker-more" :disabled="chooseSessionLoading || chooseSessionPageError === 'cursor'" :loading="chooseSessionLoading" @click="loadChooseSessionPage()">{{ t("agent.client.loadMoreSessions") }}</a-button>
      </div>
    </a-modal>

    <a-modal
      :open="titleModalOpen"
      :title="t('agent.titleSetting.modalTitle')"
      :ok-text="t('agent.titleSetting.save')"
      :cancel-text="t('agent.titleSetting.cancel')"
      :confirm-loading="titleSaving"
      :closable="!titleSaving"
      :mask-closable="!titleSaving"
      :keyboard="!titleSaving"
      :ok-button-props="{ disabled: !canSaveTitle }"
      :cancel-button-props="{ disabled: titleSaving }"
      @ok="saveTitle"
      @update:open="onTitleModalUpdateOpen"
      @cancel="closeTitleModal"
    >
      <div class="flex flex-col gap-2" :style="{ fontSize: 'var(--agent-font-size, 13px)' }">
        <div class="text-[0.9em] text-[color:var(--text-tertiary)]">{{ t("agent.titleSetting.permanentNotice") }}</div>
        <a-input
          v-model:value="titleInput"
          :placeholder="t('agent.titleSetting.inputPlaceholder')"
          :aria-label="t('agent.titleSetting.inputLabel')"
          :status="titleFieldError ? 'error' : ''"
          @press-enter="canSaveTitle && !titleSaving ? saveTitle() : undefined"
        />
        <div v-if="titleFieldError" class="text-[0.85em] text-[color:var(--danger-color)]">{{ titleFieldErrorText }}</div>
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
import type { AgentSessionAgentModelState, AgentSessionMessageState, AgentSessionRecord } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { CloseOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, onActivated, onBeforeUnmount, onDeactivated, provide, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ApiError,
  createAgentSession,
  getAgentTabsSnapshot,
  getAgentContinuableSessions,
  listAgentSessionModelOverrides,

  getAgentSessionRecord,
  listWorkspaceAvailableAgents,
  setWorkspaceAgentSessionTabVisibility,
  updateAgentSessionTitle
} from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import AgentClientPane from "./AgentClientPane.vue";
import {
  createEmptyAgentPresentation,
  splitAvailableAgents,
  type AgentSelectionOption,
} from "./agentAvailableAgentPresentation";
import {
  clearSessionModelStates,
  replaceSessionModelStates,
  setSessionAgentModelState,
  type SessionModelStateCache
} from "./agentSessionModelState";
import {
  consumeSessionModelOpenIntent,
  migrateSessionModelOpenIntent,
  type SessionModelOpenIntentCache
} from "./agentSessionModelIntent";
import { requestSessionModelOpen } from "./agentSessionModelOpenFlow";
import { agentSessionStatusStoreKey, createAgentSessionStatusStore } from "./useAgentSessionStatusStore";
import {
  isRequestResponseWritable,
  mergeTimelineSessionTitle,
  resolveTitleSaveResponseAction,
  shouldAllowTitleModalClose,
  shouldReleaseTitleSavingByToken,
  titleErrorCodeToFieldError,
  validateManualTitleInput,
  type ManualTitleValidationError,
  type TitleSaveToken
} from "./agentSessionTitle";
import {
  createAgentSessionTabVisibilityController,
  type AgentSessionTabVisibilitySession,
  type SessionWriteState
} from "./agentSessionTabVisibilityState";


import {
  agentSessionMetadataReadContextKey, createAgentSessionMetadataReads,
  isContinuableSession, sameContinuationQualification,
  type TimelineMetadataEvent
} from "./agentSessionMetadataReadContext";
import { createAgentSessionTargetLoader, isCompleteSessionRecord, type TargetReadOutcome } from "./agentSessionTargetLoader";
import type { VisibilityIntentReceipt } from "./agentSessionTabVisibilityState";

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

const props = defineProps<{ workspaceId: string; toolId: string; openSessionRequest?: { sessionId: string; sequence: number } | null }>();
const host = useWorkspaceHost(props.toolId);
const { t } = useI18n();

const loadingSessions = ref(false);
const initializationState = ref<"loading" | "ready" | "error">("loading");
const creating = ref(false);
// Loaded metadata is a cache, not the full workspace inventory.
const serverSessions = ref<AgentSessionRecord[]>([]);
const visibleServerSessionIds = ref(new Set<string>());
const reloadingTabs = ref(false);
let activeSnapshotAbort: AbortController | null = null;
const draftSessions = ref<DraftAgentSession[]>([]);
const activeKey = ref<string>("");
const selectedAgentBySession = reactive<Record<string, string | null>>({});
const agentOptions = ref<AgentSelectionOption[]>([]);
const subtaskAgentLabels = ref<Record<string, string>>({});
const draftVisibilityBySession = reactive<Record<string, boolean>>({});
const tabVisibilityWriteStates = reactive<Record<string, SessionWriteState>>({});
const tabNoMap = ref<Record<string, number>>({});
const chooseSessionModalOpen = ref(false);
const draftInitialTextBySession = reactive<Record<string, string>>({});
const chooseSessionLoading = ref(false);
const chooseSessionPageError = ref<"load" | "cursor" | null>(null);
const chooseSessionNextCursor = ref<string | null>(null);
const chooseSessionHasPage = ref(false);
let pickerPageRequestSeq = 0;
let pickerPageAbort: AbortController | null = null;
const chooseSessionItems = ref<ChooseSessionItem[]>([]);
const chooseSessionSourceId = ref("");
const serverSessionsLoaded = ref(false);
const pendingSessionTitleSyncUpdatedAt = reactive<Record<string, number>>({});
const draftCreatePromises = new Map<string, Promise<string>>();
const sessionModelStates = reactive<SessionModelStateCache>({});
const sessionModelStateLoads = reactive<Record<string, true>>({});
const sessionModelStateLoadPromises = new Map<string, Promise<void>>();
const sessionModelMutationPending = reactive<Record<string, true>>({});
const pendingModelOpenIntentBySession = reactive<SessionModelOpenIntentCache>({});
let nextModelOpenIntentId = 0;
const titleModalOpen = ref(false);
const titleEditingSessionId = ref("");
const titleInput = ref("");
const titleSaving = ref(false);
const titleServerError = ref<ManualTitleValidationError | null>(null);

// Metadata read watermarks outlive each converged record until this Workspace ends.
let workspaceGeneration = 0;
let initializationAttemptId = 0;
let disposed = false;
let activeTitleSave: TitleSaveToken | null = null;
let nextTitleSaveRequestId = 0;
// 当前编辑上下文版本：每次打开弹窗递增，forceReset 再次递增。
// 在途保存响应只能作用于它自己捕获的 token，不能关闭后续重新打开的编辑上下文。
let titleEditingEpoch = 0;
let openParentIntentId = 0;
let lastQueuedOpenSessionSequence: number | null = null;

const targetOpeningSessionId = ref("");
let activeOpenAbort: AbortController | null = null;
let activeOpenReceipt: VisibilityIntentReceipt | null = null;
function invalidateOpenParentIntent() {
  if (pickerSelection || failedPickerSelection.value) closeChooseSessionModal();
  openParentIntentId += 1;
  targetOpeningSessionId.value = "";
  activeOpenAbort?.abort();
  activeOpenAbort = null;
  activeOpenReceipt?.cancel();
  activeOpenReceipt = null;
}

const unavailableSessionIds = reactive(new Set<string>());
const metadataReads = createAgentSessionMetadataReads(() => disposed ? null : currentTabVisibilityContext());
provide(agentSessionMetadataReadContextKey, {
  captureReadToken: metadataReads.captureReadToken,
  captureActivationGuard: () => {
    const context = currentTabVisibilityContext();
    const intent = openParentIntentId;
    return () => isTabVisibilityContextCurrent(context) && openParentIntentId === intent;
  }
});

function upsertSession(record: AgentSessionRecord) {
  unavailableSessionIds.delete(record.id);
  serverSessions.value = [record, ...serverSessions.value.filter((item) => item.id !== record.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}
function applyLocalSession(record: AgentSessionRecord) {
  upsertSession(record);
  metadataReads.mutation(record.id);
}

const targetLoader = createAgentSessionTargetLoader({
  context: () => disposed ? null : currentTabVisibilityContext(),
  capture: (sessionId) => metadataReads.captureReadToken(props.workspaceId, sessionId),
  request: (token, signal) => getAgentSessionRecord(token.workspaceId, token.sessionId, signal),
  accept: (token) => metadataReads.accept(token),
  epoch: (sessionId) => metadataReads.epoch(sessionId),
  confirmationEpoch: (sessionId) => tabVisibilityController.getState(sessionId)?.confirmationEpoch ?? 0,
  commit: (record) => {
    upsertSession(record);
  }
});

const statusStore = createAgentSessionStatusStore();
provide(agentSessionStatusStoreKey, statusStore);

function currentTabVisibilityContext() {
  return { workspaceId: props.workspaceId, workspaceGeneration };
}

function isTabVisibilityContextCurrent(context: { workspaceId: string; workspaceGeneration: number }) {
  return !disposed && context.workspaceId === props.workspaceId && context.workspaceGeneration === workspaceGeneration;
}

const pickerToolActive = ref(true);
let pickerToolGeneration = 0;
type VisibilityOperationOrigin = {
  intentSeq: number;
  prompted: boolean;
  kind: "opening" | "picker" | "compensation";
  isCurrent(): boolean;
};
const visibilityOperationOrigins = new Map<string, VisibilityOperationOrigin>();
const pickerCompensations = new Set<VisibilityIntentReceipt>();
function registerVisibilityReceipt(
  record: AgentSessionRecord,
  context: ReturnType<typeof currentTabVisibilityContext>,
  kind: VisibilityOperationOrigin["kind"] = "opening",
  isCurrent = () => isTabVisibilityContextCurrent(context)
) {
  visibleServerSessionIds.value.add(record.id);
  const receipt = tabVisibilityController.requestVisibilityWithResult(record, true, context);
  visibilityOperationOrigins.set(record.id, { intentSeq: receipt.intentSeq, prompted: false, kind, isCurrent });
  return receipt;
}
function notifyVisibilityTimeout(sessionId: string, receipt: VisibilityIntentReceipt) {
  const origin = visibilityOperationOrigins.get(sessionId);
  if (origin?.intentSeq === receipt.intentSeq) {
    if (origin.prompted || !origin.isCurrent()) return;
    origin.prompted = true;
  }
  message.warning(t("agent.client.sessionLoadFailed"));
}
function notifyPickerVisibilityUncertain(origin: VisibilityOperationOrigin) {
  if (origin.prompted || !origin.isCurrent()) return;
  origin.prompted = true;
  message.warning(t("agent.client.sessionRestoreUnconfirmed"));
}

const tabVisibilityController = createAgentSessionTabVisibilityController({
  request: setWorkspaceAgentSessionTabVisibility,
  isContextCurrent: isTabVisibilityContextCurrent,
  onMutationError: (sessionId, error) => {
    const origin = visibilityOperationOrigins.get(sessionId);
    // Picker receipts own their uncertainty feedback, including a late PUT failure.
    if (origin && (origin.kind !== "opening" || !origin.isCurrent() || origin.prompted)) return;
    if (origin) origin.prompted = true;
    message.error(t("agent.client.tabStateUpdateFailed") + (error instanceof Error ? `: ${error.message}` : ""));
  },
  onStateChange: () => {
    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    queueMicrotask(() => {
      for (const [id, origin] of visibilityOperationOrigins) {
        const state = tabVisibilityController.getState(id);
        if (!state || state.nextIntentSeq !== origin.intentSeq || (!state.desired && !state.inFlight)) visibilityOperationOrigins.delete(id);
      }
    });
  },
  writeStates: tabVisibilityWriteStates
});

const allSessions = computed<AgentSessionTab[]>(() => [...serverSessions.value, ...draftSessions.value]);

const effectiveActiveKey = computed(() => {
  if (activeKey.value && visibleSessions.value.some((item) => item.id === activeKey.value)) return activeKey.value;
  return visibleSessions.value[0]?.id ?? "";
});

function isSessionTabVisible(item: AgentSessionTab) {
  if (isDraftSession(item)) return draftVisibilityBySession[item.id] ?? true;
  return visibleServerSessionIds.value.has(item.id) && !unavailableSessionIds.has(item.id)
    && tabVisibilityController.getEffectiveVisibility(item as AgentSessionTabVisibilitySession);
}

const visibleSessions = computed(() => {
  // Display and numbering share exactly the same partial-cache membership rule.
  const list = allSessions.value.filter(isSessionTabVisible);
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

watch(
  () => [props.workspaceId, allSessions.value.filter(isSessionTabVisible).map((item) => item.id).join("|")] as const,
  () => reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value })
);

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

function reconcileTabNoMap(params: { workspaceId: string; sessions: AgentSessionTab[] }) {
  const id = String(params.workspaceId || "").trim();
  if (!id) return;

  // 编号规则参考 TerminalTabs:
  // - 编号绑定到“当前打开的 tab”(在 agent 里即 visibleSessions),而不是绑定到服务端 session 生命周期
  // - 关闭 tab 后会从映射中移除,让 max 回退并复用编号
  // 只对当前 workspace 且当前可见的 session 分配编号,避免 workspace 切换时短暂拿到旧列表导致污染映射。
  const sessionsInWs = params.sessions
    .filter((s) => String(s.workspaceId || "").trim() === id)
    .filter(isSessionTabVisible);
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
  return (draftVisibilityBySession[sessionId] ?? true) && !draftCreatePromises.has(sessionId);
}

function closeChooseSessionModal() {
  pickerGeneration += 1;
  pickerPageRequestSeq += 1;
  pickerPageAbort?.abort();
  pickerPageAbort = null;
  chooseSessionLoading.value = false;
  chooseSessionPageError.value = null;
  chooseSessionNextCursor.value = null;
  chooseSessionHasPage.value = false;
  cancelPickerSelection();
  chooseSessionModalOpen.value = false;
  chooseSessionSourceId.value = "";
  chooseSessionItems.value = [];
}

function openTitleModal(session: AgentSessionTab) {
  if (isDraftSession(session)) return;
  // 进入新的编辑上下文：旧请求捕获的 token 因 epoch 不匹配而失效，
  // 其响应不能关闭/改动这个新弹窗。
  titleEditingEpoch += 1;
  titleEditingSessionId.value = session.id;
  // 完整回填当前标题：不规范化、不截断、不替换禁止字符，历史不合规值直接展示。
  titleInput.value = session.title;
  titleServerError.value = null;
  titleModalOpen.value = true;
}

/** 单向绑定下的统一关闭守卫：保存中拒绝一切用户关闭途径。 */
function onTitleModalUpdateOpen(nextOpen: boolean) {
  if (nextOpen) {
    if (!titleModalOpen.value) titleModalOpen.value = true;
    return;
  }
  if (!shouldAllowTitleModalClose({ saving: titleSaving.value, forceReset: false })) return;
  closeTitleModal();
}

function closeTitleModal() {
  if (titleSaving.value) return;
  resetTitleModal();
}

/** 强制清空弹窗状态，供 Workspace 切换/组件卸载使用（不受保存中限制）。 */
function forceResetTitleModal() {
  titleEditingEpoch += 1;
  activeTitleSave = null;
  titleSaving.value = false;
  resetTitleModal();
}

function resetTitleModal() {
  titleModalOpen.value = false;
  titleEditingSessionId.value = "";
  titleInput.value = "";
  titleServerError.value = null;
}

// 用户修改输入后清除服务端返回的字段错误，避免“有错误又可保存”的矛盾状态。
watch(titleInput, () => {
  if (titleServerError.value) titleServerError.value = null;
});

const titleValidationError = computed<ManualTitleValidationError | null>(() => {
  if (titleServerError.value) return titleServerError.value;
  const result = validateManualTitleInput(titleInput.value);
  return result.ok ? null : result.error;
});

const titleFieldError = computed(() => titleModalOpen.value && titleValidationError.value);

const titleFieldErrorText = computed(() => {
  const error = titleValidationError.value;
  if (!error) return "";
  if (error === "raw_too_long") return t("agent.titleSetting.rawTooLong");
  if (error === "empty") return t("agent.titleSetting.empty");
  if (error === "too_long") return t("agent.titleSetting.tooLong");
  return t("agent.titleSetting.invalidCharacters");
});

const canSaveTitle = computed(() => titleModalOpen.value && validateManualTitleInput(titleInput.value).ok);

async function saveTitle() {
  if (!canSaveTitle.value || titleSaving.value) return;
  const validation = validateManualTitleInput(titleInput.value);
  if (!validation.ok) return;
  const sessionId = titleEditingSessionId.value;
  if (!sessionId) return;
  // 重新确认目标仍是真实 Session。
  const target = serverSessions.value.find((item) => item.id === sessionId);
  if (!target) {
    forceResetTitleModal();
    return;
  }
  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  const normalizedTitle = validation.title;
  // 组件级保存 token：同时捕获编辑上下文 epoch 与请求 id，
  // 旧请求（重新打开弹窗/切换 Workspace 后）的任何路径都不得作用于新上下文。
  const saveToken: TitleSaveToken = {
    generation: requestGeneration,
    workspaceId: requestWorkspaceId,
    sessionId,
    requestId: ++nextTitleSaveRequestId,
    epoch: titleEditingEpoch
  };
  activeTitleSave = saveToken;
  titleSaving.value = true;
  try {
    const record = await updateAgentSessionTitle(sessionId, { workspaceId: requestWorkspaceId, title: normalizedTitle });
    const action = resolveTitleSaveResponseAction({
      requestToken: saveToken,
      activeToken: activeTitleSave,
      currentEditingEpoch: titleEditingEpoch,
      editingSessionId: titleEditingSessionId.value,
      responseWritable: isRequestResponseWritable({
        disposed,
        currentGeneration: workspaceGeneration,
        requestGeneration,
        currentWorkspaceId: props.workspaceId,
        requestWorkspaceId
      }),
      succeeded: true
    });
    if (action === "ignore") return;
    // 这里 action === "apply-close"：当前编辑上下文就是本请求的目标。
    applyLocalSession(record);
    // 成功关闭后结束当前编辑上下文：若仍有迟到的在途响应（理论上极小窗口），
    // 不得作用于之后重新打开的弹窗。
    titleEditingEpoch += 1;
    resetTitleModal();
  } catch (err) {
    const action = resolveTitleSaveResponseAction({
      requestToken: saveToken,
      activeToken: activeTitleSave,
      currentEditingEpoch: titleEditingEpoch,
      editingSessionId: titleEditingSessionId.value,
      responseWritable: isRequestResponseWritable({
        disposed,
        currentGeneration: workspaceGeneration,
        requestGeneration,
        currentWorkspaceId: props.workspaceId,
        requestWorkspaceId
      }),
      succeeded: false
    });
    if (action === "ignore") return;
    // 这里 action === "apply-keep-open"：保留弹窗，向当前编辑上下文展示服务端字段错误/通用错误。
    const fieldError = err instanceof ApiError ? titleErrorCodeToFieldError(err.code) : null;
    if (fieldError) {
      titleServerError.value = fieldError;
    } else {
      message.error(t("agent.titleSetting.saveFailed") + (err instanceof Error ? `: ${err.message}` : ""));
    }
  } finally {
    // 仅当仍是当前活动保存 token 时清理 saving；旧请求的 finally 不得影响新请求。
    if (shouldReleaseTitleSavingByToken({ activeToken: activeTitleSave, requestToken: saveToken })) {
      activeTitleSave = null;
      titleSaving.value = false;
    }
  }
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
  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  try {
    const res = await listWorkspaceAvailableAgents(requestWorkspaceId, "all");
    if (!isRequestResponseWritable({
      disposed,
      currentGeneration: workspaceGeneration,
      requestGeneration,
      currentWorkspaceId: props.workspaceId,
      requestWorkspaceId
    })) {
      return;
    }
    const presentation = splitAvailableAgents(res.agents);
    agentOptions.value = presentation.agentOptions;
    subtaskAgentLabels.value = presentation.subtaskAgentLabels;
  } catch (err) {
    if (isRequestResponseWritable({
      disposed,
      currentGeneration: workspaceGeneration,
      requestGeneration,
      currentWorkspaceId: props.workspaceId,
      requestWorkspaceId
    })) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }
}

function onAgentSettingsUpdated() {
  void refreshAgents().then(() => refreshVisibleSessionModelStates(true));
}

function isPrimaryServerSessionId(sessionId: string) {
  return serverSessions.value.some((session) => session.id === sessionId && session.kind === "primary");
}

async function loadSessionModelStates(sessionId: string, force = false) {
  if (!isPrimaryServerSessionId(sessionId)) return;
  if (!force && sessionModelStates[sessionId]) return;
  const pending = sessionModelStateLoadPromises.get(sessionId);
  if (pending) return pending;

  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  sessionModelStateLoads[sessionId] = true;
  const job = listAgentSessionModelOverrides(sessionId, requestWorkspaceId)
    .then((response) => {
      if (!isRequestResponseWritable({
        disposed,
        currentGeneration: workspaceGeneration,
        requestGeneration,
        currentWorkspaceId: props.workspaceId,
        requestWorkspaceId
      })) {
        return;
      }
      replaceSessionModelStates(sessionModelStates, response);
    })
    .finally(() => {
      if (sessionModelStateLoadPromises.get(sessionId) !== job) return;
      delete sessionModelStateLoads[sessionId];
      sessionModelStateLoadPromises.delete(sessionId);
    });
  sessionModelStateLoadPromises.set(sessionId, job);
  return job;
}

async function refreshVisibleSessionModelStates(force = false) {
  await Promise.all(
    visibleSessions.value
      .filter((session) => session.kind === "primary")
      .map((session) => loadSessionModelStates(session.id, force).catch(() => undefined))
  );
}

async function onRequestSessionModelOpen(params: { sessionId: string; agentId: string }) {
  const agentId = String(params.agentId || "").trim();
  if (!agentId || !agentOptions.value.some((agent) => agent.value === agentId)) return;
  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  const sourceSessionId = params.sessionId;
  const requestId = ++nextModelOpenIntentId;
  // A draft must retain the intent across its Pane replacement. A real Pane
  // must not consume it until the authoritative GET has completed. Replacing
  // the prior intent also makes a double click resolve to one modal opening.
  try {
    await requestSessionModelOpen({
      intents: pendingModelOpenIntentBySession,
      sourceSessionId,
      agentId,
      requestId,
      isPrimaryServerSessionId,
      ensureSessionCreated,
      loadSessionModelStates: (sessionId) => loadSessionModelStates(sessionId, true)
    });
  } catch (err) {
    if (!isRequestResponseWritable({
      disposed,
      currentGeneration: workspaceGeneration,
      requestGeneration,
      currentWorkspaceId: props.workspaceId,
      requestWorkspaceId
    })) {
      return;
    }
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function onSessionModelOpenConsumed(params: { sessionId: string; requestId: number }) {
  consumeSessionModelOpenIntent(pendingModelOpenIntentBySession, params.sessionId, params.requestId);
}

function onSessionModelStateUpdated(state: AgentSessionAgentModelState) {
  setSessionAgentModelState(sessionModelStates, state);
}

function onSessionModelMutationPending(params: { sessionId: string; pending: boolean }) {
  if (params.pending) sessionModelMutationPending[params.sessionId] = true;
  else delete sessionModelMutationPending[params.sessionId];
}

function setDraftInitialText(sessionId: string, text: string) {
  const key = String(sessionId || "").trim();
  if (!key) return;
  const next = String(text || "");
  if (draftInitialTextBySession[key] === next) return;
  draftInitialTextBySession[key] = next;
}

function onSessionMetadataUpdated(event: TimelineMetadataEvent) {
  if (event.session.workspaceId !== props.workspaceId || event.session.id !== event.readToken.sessionId) return;
  if (metadataReads.accept(event.readToken) !== "accepted") return;
  const current = serverSessions.value.find((item) => item.id === event.session.id);
  if (!current || current.title === event.session.title) return;
  serverSessions.value = mergeTimelineSessionTitle(serverSessions.value, event.session);
  metadataReads.mutation(event.session.id);
}

function requestSessionTitleSync(sessionId: string) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return;
  const runState = statusStore.runStateOf(targetSessionId);
  const updatedAt = typeof runState.updatedAt === "number" && Number.isFinite(runState.updatedAt) ? runState.updatedAt : 0;
  pendingSessionTitleSyncUpdatedAt[targetSessionId] = updatedAt;
}


const failedSessionTitleSync = reactive<Record<string, true>>({});
const titleSyncJobs = new Map<string, { dirty: boolean }>();
async function syncSessionTitle(sessionId: string) {
  const existing = titleSyncJobs.get(sessionId);
  if (existing) { existing.dirty = true; return; }
  const context = currentTabVisibilityContext();
  const job = { dirty: false };
  titleSyncJobs.set(sessionId, job);
  delete failedSessionTitleSync[sessionId];
  const valid = () => isTabVisibilityContextCurrent(context) && titleSyncJobs.get(sessionId) === job;
  try {
    do {
      job.dirty = false;
      const result = await readFreshTarget(sessionId, valid, new AbortController().signal);
      if (!valid()) return;
      if (result.status !== "accepted") {
        failedSessionTitleSync[sessionId] = true;
        if (effectiveActiveKey.value === sessionId && result.status !== "contextInvalidated" && result.status !== "cancelled") {
          showTargetFailure(result, sessionId);
        }
        break; // Never replay a failed event from an idle watcher.
      }
    } while (job.dirty && valid()); // Only a distinct business event can queue another pass.
  } finally {
    if (titleSyncJobs.get(sessionId) === job) titleSyncJobs.delete(sessionId);
  }
}

/** One zero-visible policy for snapshots, activation and open terminal states. */
function ensureVisibleSessionFallback(
  context = currentTabVisibilityContext(),
  intent = openParentIntentId
) {
  const request = props.openSessionRequest;
  const hasQueuedExternalOpen = !!request?.sessionId && request.sequence !== lastQueuedOpenSessionSequence;
  if (!isTabVisibilityContextCurrent(context) || intent !== openParentIntentId
    || initializationState.value !== "ready" || creating.value
    || hasQueuedExternalOpen || targetOpeningSessionId.value || visibleSessions.value.length > 0) return;
  return createOneSession();
}

async function createOneSession() {
  if (initializationState.value !== "ready") return;
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
    draftVisibilityBySession[draft.id] = true;
    setDraftInitialText(draft.id, "");
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

  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  const pending = draftCreatePromises.get(sessionId);
  if (pending) return pending;

  const isResponseWritable = () => isRequestResponseWritable({
    disposed,
    currentGeneration: workspaceGeneration,
    requestGeneration,
    currentWorkspaceId: props.workspaceId,
    requestWorkspaceId
  });

  if (chooseSessionSourceId.value === sessionId) closeChooseSessionModal();

  const job = (async (): Promise<string> => {
    try {
      const created = await createAgentSession({
        workspaceId: requestWorkspaceId,
        title: draft.title
      });
      // A late create response has no right to migrate a draft or register a
      // Session in a different Workspace (or after component disposal).
      if (!isResponseWritable()) return created.id;

      const draftVisible = draftVisibilityBySession[sessionId] ?? true;
      draftSessions.value = draftSessions.value.filter((item) => item.id !== sessionId);
      delete draftVisibilityBySession[sessionId];
      delete draftInitialTextBySession[sessionId];
      applyLocalSession(created);

      // 草稿切换为真实 Session 后，立即开始加载权威模型状态。loadSessionModelStates
      // 会同步标记 loading，避免新 Pane 在首次发送期间把“尚未加载”误显示为“不可用”。
      void loadSessionModelStates(created.id).catch(() => undefined);

      const picked = selectedAgentBySession[sessionId] ?? null;
      selectedAgentBySession[created.id] = picked;
      delete selectedAgentBySession[sessionId];
      persistAgentPick();
      clearSessionModelStates(sessionModelStates, sessionId);
      migrateSessionModelOpenIntent(pendingModelOpenIntentBySession, sessionId, created.id);

      if (draftVisible) visibleServerSessionIds.value.add(created.id);
      tabVisibilityController.transferDraftVisibility(created as AgentSessionTabVisibilitySession, draftVisible, currentTabVisibilityContext());

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

      reconcileTabNoMap({ workspaceId: requestWorkspaceId, sessions: allSessions.value });

      // 新会话首条消息: draft pane 可能在发送期间被卸载,导致其 emit 的 poll hint 丢失。
      // 这里在创建成功后主动 bump 一次,确保新 pane 至少会做一次刷新+短轮询兜底。
      requestSessionTitleSync(created.id);
      statusStore.bumpPollHint(created.id, { immediate: true, warmup: true });
      return created.id;
    } catch (error) {
      // The old Pane may still be awaiting this promise, but it must not
      // surface an error into a newer Workspace or a disposed component.
      if (!isResponseWritable()) return sessionId;
      throw error;
    }
  })();

  draftCreatePromises.set(sessionId, job);
  void job.then(
    () => {
      if (draftCreatePromises.get(sessionId) === job) draftCreatePromises.delete(sessionId);
    },
    () => {
      if (draftCreatePromises.get(sessionId) === job) draftCreatePromises.delete(sessionId);
    }
  );
  return job;
}

function requestSessionVisibility(sessionId: string, visible: boolean) {
  const session = serverSessions.value.find((item) => item.id === sessionId);
  if (!session) return false;
  if (visible) visibleServerSessionIds.value.add(sessionId);
  visibilityOperationOrigins.delete(sessionId); // Independent user intent, not old-operation compensation.
  const accepted = tabVisibilityController.requestVisibility(
    session as AgentSessionTabVisibilitySession,
    visible,
    currentTabVisibilityContext()
  );
  if (accepted) reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  return accepted;
}

function closeSessionTab(sessionId: string, userIntent = true) {
  if (userIntent) invalidateOpenParentIntent();
  if (chooseSessionSourceId.value === sessionId) closeChooseSessionModal();
  if (!sessionId) return;
  const draft = draftSessions.value.find((item) => item.id === sessionId);
  if (draft) draftVisibilityBySession[sessionId] = false;
  else requestSessionVisibility(sessionId, false);
  clearSessionModelStates(sessionModelStates, sessionId);
  delete pendingModelOpenIntentBySession[sessionId];

  // close 只隐藏入口，不会取消、删除或终止服务端 Session。
  if (tabNoMap.value[sessionId]) {
    const nextMap = { ...tabNoMap.value };
    delete nextMap[sessionId];
    tabNoMap.value = nextMap;
  }
  delete draftInitialTextBySession[sessionId];

  if (activeKey.value !== sessionId) return;
  const next = visibleSessions.value.find((item) => item.id !== sessionId)?.id ?? "";
  invalidateOpenParentIntent();
  activeKey.value = next;
  statusStore.markSessionSeen(next);
  if (next) {
    persistActiveKey(next);
    return;
  }

  void ensureVisibleSessionFallback();
}

function onSessionForked(record: AgentSessionRecord, mayActivate = true) {
  if (record.workspaceId !== props.workspaceId || disposed) return;
  applyLocalSession(record);
  if (!mayActivate) return;
  invalidateOpenParentIntent();
  requestSessionVisibility(record.id, true);
  activateSession(record.id);
}

function activateSession(sessionId: string) {
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  activeKey.value = sessionId;
  statusStore.markSessionSeen(sessionId);
  persistActiveKey(sessionId);
}

async function readFreshTarget(sessionId: string, valid: () => boolean, signal: AbortSignal): Promise<TargetReadOutcome> {
  // One fresh follow-up after a protected read; no recursive or full-list retry.
  let outcome = await targetLoader.read(sessionId, { valid, signal });
  if (valid() && !signal.aborted && (outcome.status === "protected" || outcome.status === "supersededRead")) {
    outcome = await targetLoader.read(sessionId, { valid, signal });
  }
  return outcome;
}

function showTargetFailure(outcome: TargetReadOutcome, sessionId: string) {
  if (outcome.status === "cancelled" || outcome.status === "contextInvalidated") return;
  if (outcome.status === "failed" && outcome.classification === "unauthorized") return; // auth interceptor owns the prompt
  if (outcome.status === "failed" && outcome.classification === "sessionNotFound") {
    unavailableSessionIds.add(sessionId);
    if (pickerSelection?.targetId === sessionId) cancelPickerSelection();
    chooseSessionItems.value = chooseSessionItems.value.filter((item) => item.id !== sessionId);
    if (failedPickerSelection.value?.targetId === sessionId) failedPickerSelection.value = null;
    if (activeKey.value === sessionId) {
      const fallback = visibleSessions.value[0]?.id;
      if (fallback) activateSession(fallback);
      else activeKey.value = "";
    }
    message.warning(t("agent.client.sessionUnavailable"));
  } else if (outcome.status === "failed" && outcome.classification === "workspaceNotFound") {
    message.warning(t("agent.client.workspaceUnavailable"));
  } else message.error(t("agent.client.sessionLoadFailed"));
}

async function openTargetSession(sessionId: string, sourceSessionId?: string) {
  if (!sessionId || initializationState.value !== "ready") return;
  invalidateOpenParentIntent();
  const intent = openParentIntentId;
  const previousActiveKey = effectiveActiveKey.value;
  const context = currentTabVisibilityContext();
  const abort = new AbortController();
  activeOpenAbort = abort;
  const valid = () => isTabVisibilityContextCurrent(context) && intent === openParentIntentId;
  targetOpeningSessionId.value = sessionId;
  try {
    const outcome = await readFreshTarget(sessionId, valid, abort.signal);
    if (!valid()) return;
    if (outcome.status !== "accepted") { showTargetFailure(outcome, sessionId); return; }
    const receipt = registerVisibilityReceipt(outcome.record, context);
    activeOpenReceipt = receipt;
    activateSession(sessionId);
    const confirmation = await receipt.result;
    if (!valid() || receipt.intentSeq !== tabVisibilityController.getState(sessionId)?.nextIntentSeq) return;
    if (confirmation.status !== "confirmed") {
      if (activeKey.value === sessionId) {
        const fallback = [sourceSessionId, previousActiveKey].find((id) => id && visibleSessions.value.some((item) => item.id === id))
          ?? visibleSessions.value[0]?.id;
        if (fallback) activateSession(fallback);
        else activeKey.value = "";
      }
      if (confirmation.status === "uiTimeout") notifyVisibilityTimeout(sessionId, receipt);
      return;
    }
    if (sourceSessionId && sourceSessionId !== sessionId) closeSessionTab(sourceSessionId, false);
  } finally {
    if (valid()) {
      // Opening spans the accepted GET and its visibility receipt, not just HTTP.
      targetOpeningSessionId.value = "";
      await ensureVisibleSessionFallback(context, intent);
    }
  }
}

async function onOpenSubtask(sessionId: string) { await openTargetSession(sessionId); }
async function onOpenParent(sourceSessionId: string, sessionId: string) { await openTargetSession(sessionId, sourceSessionId); }

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
  delete draftVisibilityBySession[fromSessionId];
  // Visibility was already confirmed by this selection before replacing the source.

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
  if (!pickerToolActive.value || !canChooseSessionFrom(fromSessionId)) return;
  closeChooseSessionModal();
  chooseSessionSourceId.value = fromSessionId;
  chooseSessionModalOpen.value = true;
  await loadChooseSessionPage(true);
}

async function loadChooseSessionPage(reset = false) {
  if (!chooseSessionModalOpen.value || !canChooseSessionFrom(chooseSessionSourceId.value)) return;
  if (!reset && (chooseSessionLoading.value || chooseSessionNextCursor.value === null || chooseSessionPageError.value === "cursor")) return;
  if (reset) {
    cancelPickerSelection();
    pickerGeneration += 1;
    pickerPageAbort?.abort();
    chooseSessionItems.value = [];
    chooseSessionNextCursor.value = null;
    chooseSessionHasPage.value = false;
  }
  const requestSeq = ++pickerPageRequestSeq;
  const generation = pickerGeneration;
  const sourceId = chooseSessionSourceId.value;
  const context = currentTabVisibilityContext();
  const abort = new AbortController();
  pickerPageAbort = abort;
  const valid = () => requestSeq === pickerPageRequestSeq && generation === pickerGeneration
    && chooseSessionModalOpen.value && chooseSessionSourceId.value === sourceId
    && isTabVisibilityContextCurrent(context) && canChooseSessionFrom(sourceId)
    && effectiveActiveKey.value === sourceId;
  chooseSessionLoading.value = true;
  chooseSessionPageError.value = null;
  try {
    const page = await getAgentContinuableSessions(context.workspaceId, {
      ...(reset ? {} : { cursor: chooseSessionNextCursor.value ?? undefined }), signal: abort.signal
    });
    if (!valid()) return;
    if (page.scope !== "continuable" || !Array.isArray(page.items) || page.items.length > 50
      || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length > 0))
      || page.items.some((record) => !isCompleteSessionRecord(record) || record.workspaceId !== context.workspaceId || !isContinuableSession(record))) {
      throw new Error("invalid candidate page response");
    }
    const items = new Map(chooseSessionItems.value.map((item) => [item.id, item]));
    for (const record of page.items) {
      if (unavailableSessionIds.has(record.id)) continue;
      items.set(record.id, { id: record.id, preview: truncatePreview(record.title, 50), updatedAt: record.updatedAt });
    }
    chooseSessionItems.value = [...items.values()];
    chooseSessionNextCursor.value = page.nextCursor;
    chooseSessionHasPage.value = true;
  } catch (error) {
    if (valid()) chooseSessionPageError.value = error instanceof ApiError && error.code === "AGENT_SESSION_CURSOR_INVALID" ? "cursor" : "load";
  } finally {
    if (valid()) {
      chooseSessionLoading.value = false;
      if (pickerPageAbort === abort) pickerPageAbort = null;
    }
  }
}

type PickerIdentity = {
  sourceId: string; targetId: string; context: ReturnType<typeof currentTabVisibilityContext>; generation: number; toolGeneration: number;
};
type PickerSelection = PickerIdentity & {
  abort: AbortController; receipt?: VisibilityIntentReceipt; visibilityOrigin?: VisibilityOperationOrigin; openingIntent: number; committed: boolean;
};
let pickerGeneration = 0;
let pickerSelection: PickerSelection | null = null;
// Retry identity owns no transport or receipt and survives cancellation/compensation.
const failedPickerSelection = ref<PickerIdentity | null>(null);
const chooseSessionSelecting = ref(false);
const chooseSessionSelectionFailed = computed(() => failedPickerSelection.value !== null);

function isPickerIdentityCurrent(identity: PickerIdentity) {
  return pickerToolActive.value && identity.toolGeneration === pickerToolGeneration
    && identity.generation === pickerGeneration && chooseSessionModalOpen.value
    && isTabVisibilityContextCurrent(identity.context) && chooseSessionSourceId.value === identity.sourceId
    && effectiveActiveKey.value === identity.sourceId && !draftCreatePromises.has(identity.sourceId)
    && draftSessions.value.some((item) => item.id === identity.sourceId && (draftVisibilityBySession[item.id] ?? true));
}

function recordPickerFailure(selection: PickerSelection) {
  failedPickerSelection.value = {
    sourceId: selection.sourceId, targetId: selection.targetId, context: selection.context, generation: selection.generation, toolGeneration: selection.toolGeneration
  };
  chooseSessionSelecting.value = false;
}

function cancelPickerSelection(options: { notifyUncertainty?: boolean } = {}) {
  const selection = pickerSelection;
  pickerSelection = null;
  chooseSessionSelecting.value = false;
  failedPickerSelection.value = null;
  if (!selection) return;
  selection.abort.abort();
  selection.receipt?.cancel();
  if (!selection.committed && selection.receipt && isTabVisibilityContextCurrent(selection.context)
    && !selection.receipt.previousEffectiveVisibility
    && selection.receipt.intentSeq === tabVisibilityController.getState(selection.targetId)?.nextIntentSeq) {
    const record = serverSessions.value.find((item) => item.id === selection.targetId);
    if (record) {
      // Restoring visibility uses the same write queue, but owns a separate bounded UI receipt.
      const receipt = tabVisibilityController.requestVisibilityWithResult(record, false, selection.context);
      const origin = selection.visibilityOrigin ?? {
        intentSeq: receipt.intentSeq, prompted: false, kind: "compensation" as const, isCurrent: () => false
      };
      origin.intentSeq = receipt.intentSeq;
      origin.kind = "compensation";
      origin.isCurrent = () => pickerToolActive.value && pickerToolGeneration === selection.toolGeneration
        && isTabVisibilityContextCurrent(selection.context) && openParentIntentId === selection.openingIntent
        && tabVisibilityController.getState(record.id)?.nextIntentSeq === receipt.intentSeq;
      visibilityOperationOrigins.set(record.id, origin);
      pickerCompensations.add(receipt);
      if (options.notifyUncertainty) notifyPickerVisibilityUncertain(origin);
      void receipt.result.then((outcome) => {
        if (outcome.status === "failed" || outcome.status === "uiTimeout") notifyPickerVisibilityUncertain(origin);
      }).finally(() => {
        pickerCompensations.delete(receipt);
        const state = tabVisibilityController.getState(record.id);
        if (visibilityOperationOrigins.get(record.id) === origin && (!state?.desired && !state?.inFlight)) {
          visibilityOperationOrigins.delete(record.id);
        }
      });
      if (!pickerToolActive.value) receipt.cancel();
      return;
    }
  }
  if (options.notifyUncertainty && selection.receipt) notifyVisibilityTimeout(selection.targetId, selection.receipt);
}

async function chooseSession(targetSessionId: string, retry = false) {
  if (chooseSessionSelecting.value || unavailableSessionIds.has(targetSessionId)) return;
  const fromSessionId = chooseSessionSourceId.value;
  const identity: PickerIdentity = { sourceId: fromSessionId, targetId: targetSessionId, context: currentTabVisibilityContext(), generation: pickerGeneration, toolGeneration: pickerToolGeneration };
  if (!fromSessionId || !isPickerIdentityCurrent(identity)) return;
  const failure = failedPickerSelection.value;
  const sameFailure = failure?.targetId === targetSessionId && isPickerIdentityCurrent(failure);
  if ((sameFailure && !retry) || (retry && !sameFailure)) return;
  cancelPickerSelection();
  invalidateOpenParentIntent();
  const intent = openParentIntentId;
  const selection: PickerSelection = { ...identity, abort: new AbortController(), openingIntent: intent, committed: false };
  pickerSelection = selection;
  chooseSessionSelecting.value = true;
  const valid = () => pickerSelection === selection && openParentIntentId === intent && isPickerIdentityCurrent(selection);
  const deadline = performance.now() + 30000;
  const timer = setTimeout(() => selection.abort.abort(), 30000);
  const outcome = await readFreshTarget(targetSessionId, valid, selection.abort.signal);
  clearTimeout(timer);
  if (!valid()) return;
  const timedOut = performance.now() >= deadline || outcome.status === "cancelled";
  if (timedOut || outcome.status !== "accepted") {
    cancelPickerSelection();
    const failure: TargetReadOutcome = timedOut
      ? { status: "failed", classification: "transportTimeout", error: new Error("verification timed out") }
      : outcome;
    if (!(failure.status === "failed" && failure.classification === "sessionNotFound")) recordPickerFailure(selection);
    showTargetFailure(failure, targetSessionId);
    return;
  }
  if (!isContinuableSession(outcome.record)) {
    chooseSessionItems.value = chooseSessionItems.value.filter((item) => item.id !== targetSessionId);
    cancelPickerSelection();
    message.warning(t("agent.client.noSessionToChoose"));
    return;
  }
  const receipt = registerVisibilityReceipt(outcome.record, selection.context, "picker", valid);
  selection.receipt = receipt;
  selection.visibilityOrigin = visibilityOperationOrigins.get(targetSessionId);
  const confirmation = await receipt.result;
  const current = serverSessions.value.find((item) => item.id === targetSessionId);
  if (!valid()) return;
  if (confirmation.status !== "confirmed" || receipt.intentSeq !== tabVisibilityController.getState(targetSessionId)?.nextIntentSeq
    || !current || metadataReads.epoch(targetSessionId) !== outcome.acceptedMutationEpoch || !sameContinuationQualification(current, outcome.record)) {
    // Finish source submission, but compensate a now-invalid selection only if still its last intent.
    if (confirmation.status === "confirmed" || confirmation.status === "uiTimeout") {
      cancelPickerSelection({ notifyUncertainty: confirmation.status === "uiTimeout" });
    } else if (confirmation.status === "failed" && selection.visibilityOrigin) {
      notifyPickerVisibilityUncertain(selection.visibilityOrigin);
    }
    recordPickerFailure(selection);
    return;
  }
  selection.committed = true;
  replaceDraftWithSession({ fromSessionId, targetSessionId });
  closeChooseSessionModal();
}

watch(() => [effectiveActiveKey.value, chooseSessionSourceId.value, chooseSessionModalOpen.value] as const, ([active, source, open]) => {
  if (open && active !== source) closeChooseSessionModal();
});

function onChangeTab(key: string | number) {
  if (chooseSessionModalOpen.value) closeChooseSessionModal();
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

function isCurrentInitialization(attemptId: number, requestGeneration: number, requestWorkspaceId: string) {
  return !disposed
    && attemptId === initializationAttemptId
    && requestGeneration === workspaceGeneration
    && requestWorkspaceId === props.workspaceId;
}

function commitTabsSnapshot(
  snapshot: Awaited<ReturnType<typeof getAgentTabsSnapshot>>,
  readSnapshot: ReturnType<typeof metadataReads.captureSnapshot>,
  visibilitySnapshot: ReturnType<typeof tabVisibilityController.captureSnapshot>,
  workspaceId: string
) {
  if (snapshot.scope !== "tabs" || !Array.isArray(snapshot.items) || !snapshot.tabState
    || snapshot.tabState.workspaceId !== workspaceId
    || !Array.isArray(snapshot.tabState.closedSessionIds) || !Array.isArray(snapshot.tabState.openedSubtaskSessionIds)
    || [...snapshot.tabState.closedSessionIds, ...snapshot.tabState.openedSubtaskSessionIds].some((id) => typeof id !== "string" || !id)
    || snapshot.items.some((record) => !isCompleteSessionRecord(record) || record.workspaceId !== workspaceId)) {
    throw new Error("invalid tabs snapshot response");
  }
  for (const record of snapshot.items) {
    if (readSnapshot && metadataReads.accept(readSnapshot(record.id)) === "accepted") upsertSession(record);
  }
  const members = new Set(snapshot.items.map((record) => record.id));
  for (const record of serverSessions.value) {
    if (tabVisibilityController.isSnapshotProtected(record.id, visibilitySnapshot)) members.add(record.id);
  }
  // Only actual snapshot members can install default visibility. The cache is
  // partial: omission cannot reset an absent Session's settled confirmation.
  tabVisibilityController.applyInitializationSnapshot(snapshot.items, snapshot.tabState, visibilitySnapshot);
  visibleServerSessionIds.value = members;
}

async function reloadTabsSnapshot() {
  if (initializationState.value !== "ready" || reloadingTabs.value) return;
  const context = currentTabVisibilityContext();
  const readSnapshot = metadataReads.captureSnapshot();
  const visibilitySnapshot = tabVisibilityController.captureSnapshot();
  const abort = new AbortController();
  activeSnapshotAbort = abort;
  reloadingTabs.value = true;
  try {
    const snapshot = await getAgentTabsSnapshot(context.workspaceId, abort.signal);
    if (!isTabVisibilityContextCurrent(context) || activeSnapshotAbort !== abort) return;
    commitTabsSnapshot(snapshot, readSnapshot, visibilitySnapshot, context.workspaceId);
    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    await ensureVisibleSessionFallback(context);
  } catch {
    if (isTabVisibilityContextCurrent(context) && activeSnapshotAbort === abort) message.warning(t("agent.client.tabStateLoadFailed"));
  } finally {
    if (isTabVisibilityContextCurrent(context) && activeSnapshotAbort === abort) { reloadingTabs.value = false; activeSnapshotAbort = null; }
  }
}

async function initializeWorkspace() {
  const attemptId = ++initializationAttemptId;
  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  initializationState.value = "loading";
  loadingSessions.value = true;
  activeSnapshotAbort?.abort();
  activeSnapshotAbort = new AbortController();
  const readSnapshot = metadataReads.captureSnapshot();
  const visibilitySnapshot = tabVisibilityController.captureSnapshot();
  // Agent options are non-critical: keep their existing independent refresh and
  // never let an options failure hide successfully loaded Session Tabs.
  void refreshAgents();

  try {
    const snapshot = await getAgentTabsSnapshot(requestWorkspaceId, activeSnapshotAbort?.signal);
    if (!isCurrentInitialization(attemptId, requestGeneration, requestWorkspaceId)) return;
    commitTabsSnapshot(snapshot, readSnapshot, visibilitySnapshot, requestWorkspaceId);
    serverSessionsLoaded.value = true;
    reconcileTabNoMap({ workspaceId: requestWorkspaceId, sessions: allSessions.value });
    if (effectiveActiveKey.value) {
      activeKey.value = effectiveActiveKey.value;
      persistActiveKey(effectiveActiveKey.value);
    }
    statusStore.bindWorkspace(requestWorkspaceId);
    initializationState.value = "ready";

    await ensureVisibleSessionFallback({ workspaceId: requestWorkspaceId, workspaceGeneration: requestGeneration });
  } catch {
    if (!isCurrentInitialization(attemptId, requestGeneration, requestWorkspaceId)) return;
    initializationState.value = "error";
  } finally {
    if (isCurrentInitialization(attemptId, requestGeneration, requestWorkspaceId)) {
      loadingSessions.value = false;
    }
  }
}

function retryInitialization() {
  if (initializationState.value === "loading") return;
  void initializeWorkspace();
}

watch(
  () => props.workspaceId,
  () => {
    // Make old Workspace requests inert before resetting reactive state.
    workspaceGeneration += 1;
    lastQueuedOpenSessionSequence = null;
    targetLoader.reset();
    titleSyncJobs.clear();
    for (const id of Object.keys(failedSessionTitleSync)) delete failedSessionTitleSync[id];
    metadataReads.reset();
    unavailableSessionIds.clear();
    tabVisibilityController.invalidateContext();
    visibilityOperationOrigins.clear();
    closeChooseSessionModal();
    forceResetTitleModal();
    invalidateOpenParentIntent();
    activeKey.value = "";
    serverSessions.value = [];
    visibleServerSessionIds.value.clear();
    activeSnapshotAbort?.abort();
    activeSnapshotAbort = null;
    reloadingTabs.value = false;
    serverSessionsLoaded.value = false;
    draftSessions.value = [];
    const emptyAgentPresentation = createEmptyAgentPresentation();
    agentOptions.value = emptyAgentPresentation.agentOptions;
    subtaskAgentLabels.value = emptyAgentPresentation.subtaskAgentLabels;
    for (const key of Object.keys(draftVisibilityBySession)) delete draftVisibilityBySession[key];
    tabNoMap.value = {};
    for (const key of Object.keys(selectedAgentBySession)) delete selectedAgentBySession[key];
    for (const key of Object.keys(pendingSessionTitleSyncUpdatedAt)) delete pendingSessionTitleSyncUpdatedAt[key];
    for (const key of Object.keys(sessionModelStates)) clearSessionModelStates(sessionModelStates, key);
    for (const key of Object.keys(sessionModelStateLoads)) delete sessionModelStateLoads[key];
    sessionModelStateLoadPromises.clear();
    for (const key of Object.keys(sessionModelMutationPending)) delete sessionModelMutationPending[key];
    draftCreatePromises.clear();
    for (const key of Object.keys(pendingModelOpenIntentBySession)) delete pendingModelOpenIntentBySession[key];
    restorePersistedState();
    void initializeWorkspace();
  },
  { immediate: true }
);

watch(
  () => [props.openSessionRequest, initializationState.value] as const,
  ([request, state]) => {
    if (!request || state !== "ready" || request.sequence === lastQueuedOpenSessionSequence) return;
    lastQueuedOpenSessionSequence = request.sequence;
    if (chooseSessionModalOpen.value) closeChooseSessionModal();
    void openTargetSession(request.sessionId);
  },
  { immediate: true }
);

onActivated(() => {
  pickerToolActive.value = true;
  // KeepAlive reactivation must not implicitly re-read the backend Tab state.
  if (initializationState.value === "error") {
    void initializeWorkspace();
    return;
  }
  if (initializationState.value !== "ready" || creating.value || visibleSessions.value.length > 0) return;
  statusStore.syncSessions({
    activeSessionId: effectiveActiveKey.value || null,
    visibleSessionIds: visibleSessions.value.map((item) => item.id),
    registeredSessionIds: serverSessions.value.map((item) => item.id),
    sessionKinds: Object.fromEntries(serverSessions.value.map((item) => [item.id, item.kind]))
  });
  void ensureVisibleSessionFallback();
});

onDeactivated(() => {
  pickerToolActive.value = false;
  pickerToolGeneration += 1;
  closeChooseSessionModal();
  // Ending an interaction does not terminate its already-sent write queue.
  for (const receipt of pickerCompensations) receipt.cancel();
});

// Derive convergence from existing intent/visibility state. In particular, a
// late PUT failure after its UI receipt timed out can make the Workspace empty.
// No detached "skip draft" flag is left behind when an opening is terminated.
watch(
  () => [props.workspaceId, initializationState.value, props.openSessionRequest,
    targetOpeningSessionId.value, visibleSessions.value.map((item) => item.id).join("|")] as const,
  () => { void ensureVisibleSessionFallback(); }
);

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
    delete pendingSessionTitleSyncUpdatedAt[sessionId];
    // Failure stops this sync event; a later business event or explicit action may retry.
    void syncSessionTitle(sessionId);

  },
  { immediate: true }
);

onBeforeUnmount(() => {
  disposed = true;
  activeSnapshotAbort?.abort();
  workspaceGeneration += 1;
  targetLoader.reset();
  titleSyncJobs.clear();
  metadataReads.reset();
  tabVisibilityController.invalidateContext();
  visibilityOperationOrigins.clear();
  closeChooseSessionModal();
  forceResetTitleModal();
  for (const key of Object.keys(pendingSessionTitleSyncUpdatedAt)) {
    delete pendingSessionTitleSyncUpdatedAt[key];
  }
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
