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
import { computed, onActivated, onBeforeUnmount, provide, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ApiError,
  createAgentSession,
  getWorkspaceAgentTabState,
  listAgentSessionModelOverrides,
  listAgentSessions,
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
  mergeStaleProtectedSessionList,
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
  canScheduleRetryRefresh,
  canStartRefresh,
  convergeMutationCache,
  createTitleMutationCache,
  type TitleMutationCacheState
} from "./agentSessionRefreshCoordination";

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
const serverSessions = ref<AgentSessionRecord[]>([]);
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

// 标题手动接管并发防护：
// - 每次成功手动保存提升全局 revision 并缓存完整 API record；
// - 旧列表响应不得用旧字段覆盖 mutation 后的完整 record；
// - workspaceGeneration/disposed 使在途请求在 Workspace 切换或卸载后失效。
const titleMutationCache: TitleMutationCacheState = createTitleMutationCache();
let workspaceGeneration = 0;
let initializationAttemptId = 0;
let disposed = false;
type SessionRefreshToken = { generation: number; workspaceId: string };
let activeSessionRefresh: SessionRefreshToken | null = null;
let sessionRefreshRetry: SessionRefreshToken | null = null;
let activeTitleSave: TitleSaveToken | null = null;
let nextTitleSaveRequestId = 0;
// 当前编辑上下文版本：每次打开弹窗递增，forceReset 再次递增。
// 在途保存响应只能作用于它自己捕获的 token，不能关闭后续重新打开的编辑上下文。
let titleEditingEpoch = 0;
let openParentIntentId = 0;

function invalidateOpenParentIntent() {
  openParentIntentId += 1;
}

const statusStore = createAgentSessionStatusStore();
provide(agentSessionStatusStoreKey, statusStore);

function currentTabVisibilityContext() {
  return { workspaceId: props.workspaceId, workspaceGeneration };
}

function isTabVisibilityContextCurrent(context: { workspaceId: string; workspaceGeneration: number }) {
  return !disposed && context.workspaceId === props.workspaceId && context.workspaceGeneration === workspaceGeneration;
}

const tabVisibilityController = createAgentSessionTabVisibilityController({
  request: setWorkspaceAgentSessionTabVisibility,
  isContextCurrent: isTabVisibilityContextCurrent,
  onMutationError: (_sessionId, error) => {
    message.error(t("agent.client.tabStateUpdateFailed") + (error instanceof Error ? `: ${error.message}` : ""));
  },
  onStateChange: () => reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value }),
  writeStates: tabVisibilityWriteStates
});

const allSessions = computed<AgentSessionTab[]>(() => [...serverSessions.value, ...draftSessions.value]);

const effectiveActiveKey = computed(() => {
  if (activeKey.value && visibleSessions.value.some((item) => item.id === activeKey.value)) return activeKey.value;
  return visibleSessions.value[0]?.id ?? "";
});

const visibleSessions = computed(() => {
  // tabs 的展示顺序按编号从小到大,确保新建 client 出现在最右侧。
  const list = allSessions.value.filter((item) => {
    if (isDraftSession(item)) return draftVisibilityBySession[item.id] ?? true;
    return tabVisibilityController.getEffectiveVisibility(item as AgentSessionTabVisibilitySession);
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

function reconcileTabNoMap(params: { workspaceId: string; sessions: AgentSessionTab[] }) {
  const id = String(params.workspaceId || "").trim();
  if (!id) return;

  // 编号规则参考 TerminalTabs:
  // - 编号绑定到“当前打开的 tab”(在 agent 里即 visibleSessions),而不是绑定到服务端 session 生命周期
  // - 关闭 tab 后会从映射中移除,让 max 回退并复用编号
  // 只对当前 workspace 且当前可见的 session 分配编号,避免 workspace 切换时短暂拿到旧列表导致污染映射。
  const sessionsInWs = params.sessions
    .filter((s) => String(s.workspaceId || "").trim() === id)
    .filter((s) => isDraftSession(s)
      ? (draftVisibilityBySession[s.id] ?? true)
      : tabVisibilityController.getEffectiveVisibility(s as AgentSessionTabVisibilitySession));
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
  return serverSessions.value.some((item) => item.kind === "primary" && item.id !== sessionId);
}

function closeChooseSessionModal() {
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
    titleMutationCache.revision += 1;
    titleMutationCache.revisionBySession.set(sessionId, titleMutationCache.revision);
    titleMutationCache.recordBySession.set(sessionId, record);
    serverSessions.value = serverSessions.value.map((item) => (item.id === sessionId ? record : item));
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

function refreshTabVisibilitySessions() {
  tabVisibilityController.pruneSettledStates(serverSessions.value as AgentSessionTabVisibilitySession[]);
}

async function refreshSessions() {
  // 按 generation/workspace 隔离并发占用：旧 Workspace 的在途请求不得阻止新 Workspace 发起刷新。
  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  const token: SessionRefreshToken = { generation: requestGeneration, workspaceId: requestWorkspaceId };
  if (!canStartRefresh(activeSessionRefresh, requestGeneration, requestWorkspaceId)) {
    return false;
  }
  activeSessionRefresh = token;
  loadingSessions.value = true;
  const requestRevision = titleMutationCache.revision;
  let ok = false;
  let usedRecordProtection = false;
  try {
    const list = await listAgentSessions(requestWorkspaceId);
    if (!isRequestResponseWritable({
      disposed,
      currentGeneration: workspaceGeneration,
      requestGeneration,
      currentWorkspaceId: props.workspaceId,
      requestWorkspaceId
    })) {
      return false;
    }
    let merged = list;
    if (titleMutationCache.revision > requestRevision) {
      // 本次请求开始后有成功的手动标题 mutation：对命中的 Session 完整保留 API record，不拼接字段。
      const result = mergeStaleProtectedSessionList(list, {
        requestRevision,
        mutationRevisionBySession: titleMutationCache.revisionBySession,
        mutationRecordBySession: titleMutationCache.recordBySession
      }, (record) => record.id);
      merged = result.merged;
      usedRecordProtection = result.protectedSessionIds.length > 0;
    }
    // 本次请求不晚于任何成功 mutation 时，服务端 record 为权威：清理已收敛缓存。
    convergeMutationCache(titleMutationCache, requestRevision, new Set(merged.map((record) => record.id)));
    serverSessions.value = [...merged].sort((a, b) => b.updatedAt - a.updatedAt);
    void refreshVisibleSessionModelStates();
    // 普通 Session 刷新只能更新元数据，不能覆盖 controller 的 pending/inFlight 可见性状态。
    refreshTabVisibilitySessions();
    serverSessionsLoaded.value = true;
    reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
    if (effectiveActiveKey.value) {
      activeKey.value = effectiveActiveKey.value;
      persistActiveKey(effectiveActiveKey.value);
    }
    ok = true;
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
  } finally {
    if (activeSessionRefresh === token) {
      activeSessionRefresh = null;
      loadingSessions.value = false;
    }
  }
  if (usedRecordProtection && ok) {
    // 旧响应使用过完整 record 保护：mutation 后去重调度一次 R2，收敛到服务端权威记录。
    // token 按 generation/workspace 隔离：旧 Workspace 的 R2 不得阻塞新 Workspace 的收敛调度。
    if (canScheduleRetryRefresh(sessionRefreshRetry, requestGeneration, requestWorkspaceId) && !disposed) {
      const retryToken: SessionRefreshToken = { generation: requestGeneration, workspaceId: requestWorkspaceId };
      sessionRefreshRetry = retryToken;
      void refreshSessions()
        .catch(() => undefined)
        .finally(() => {
          if (sessionRefreshRetry === retryToken) sessionRefreshRetry = null;
        });
    }
  }
  return ok;
}

function setDraftInitialText(sessionId: string, text: string) {
  const key = String(sessionId || "").trim();
  if (!key) return;
  const next = String(text || "");
  if (draftInitialTextBySession[key] === next) return;
  draftInitialTextBySession[key] = next;
}

function onSessionMetadataUpdated(session: AgentSessionMessageState) {
  if (session.workspaceId !== props.workspaceId) return;
  const protectedRecord = titleMutationCache.recordBySession.get(session.id) as AgentSessionRecord | undefined;
  serverSessions.value = mergeTimelineSessionTitle(
    serverSessions.value,
    session,
    protectedRecord,
  );
}

function requestSessionTitleSync(sessionId: string) {
  const targetSessionId = String(sessionId || "").trim();
  if (!targetSessionId) return;
  const runState = statusStore.runStateOf(targetSessionId);
  const updatedAt = typeof runState.updatedAt === "number" && Number.isFinite(runState.updatedAt) ? runState.updatedAt : 0;
  pendingSessionTitleSyncUpdatedAt[targetSessionId] = updatedAt;
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
      serverSessions.value = [created, ...serverSessions.value.filter((item) => item.id !== created.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt
      );

      // 草稿切换为真实 Session 后，立即开始加载权威模型状态。loadSessionModelStates
      // 会同步标记 loading，避免新 Pane 在首次发送期间把“尚未加载”误显示为“不可用”。
      void loadSessionModelStates(created.id).catch(() => undefined);

      const picked = selectedAgentBySession[sessionId] ?? null;
      selectedAgentBySession[created.id] = picked;
      delete selectedAgentBySession[sessionId];
      persistAgentPick();
      clearSessionModelStates(sessionModelStates, sessionId);
      migrateSessionModelOpenIntent(pendingModelOpenIntentBySession, sessionId, created.id);

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
  const accepted = tabVisibilityController.requestVisibility(
    session as AgentSessionTabVisibilitySession,
    visible,
    currentTabVisibilityContext()
  );
  if (accepted) reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  return accepted;
}

function closeSessionTab(sessionId: string) {
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

  if (initializationState.value === "ready") void createOneSession();
}

async function onSessionForked(sessionId: string) {
  await refreshSessions();
  if (!sessionId) return;
  requestSessionVisibility(sessionId, true);
  invalidateOpenParentIntent();
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  activeKey.value = sessionId;
  statusStore.markSessionSeen(sessionId);
  persistActiveKey(sessionId);
}

async function onOpenSubtask(sessionId: string) {
  if (!sessionId) return;
  // 若当前列表已经包含子任务，先乐观登记意图；否则刷新后再登记。
  const opened = requestSessionVisibility(sessionId, true);
  if (!opened) {
    await refreshSessions();
    requestSessionVisibility(sessionId, true);
  }
  invalidateOpenParentIntent();
  reconcileTabNoMap({ workspaceId: props.workspaceId, sessions: allSessions.value });
  activeKey.value = sessionId;
  statusStore.markSessionSeen(sessionId);
  persistActiveKey(sessionId);
}

function activateParentSessionTab(sessionId: string) {
  // Existing Agent tab visibility is also used for scheduled execution links.
  if (!sessionId) return;
  requestSessionVisibility(sessionId, true);
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
  delete draftVisibilityBySession[fromSessionId];
  requestSessionVisibility(target.id, true);

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
        item.headMessageId !== null &&
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

function isCurrentInitialization(attemptId: number, requestGeneration: number, requestWorkspaceId: string) {
  return !disposed
    && attemptId === initializationAttemptId
    && requestGeneration === workspaceGeneration
    && requestWorkspaceId === props.workspaceId;
}

async function initializeWorkspace() {
  const attemptId = ++initializationAttemptId;
  const requestGeneration = workspaceGeneration;
  const requestWorkspaceId = props.workspaceId;
  initializationState.value = "loading";
  loadingSessions.value = true;
  // Agent options are non-critical: keep their existing independent refresh and
  // never let an options failure hide successfully loaded Session Tabs.
  void refreshAgents();

  try {
    const [sessions, tabState] = await Promise.all([
      listAgentSessions(requestWorkspaceId),
      getWorkspaceAgentTabState(requestWorkspaceId)
    ]);
    if (!isCurrentInitialization(attemptId, requestGeneration, requestWorkspaceId)) return;

    // The two critical reads are committed together. The controller preserves
    // any pending write state should a future initialization race with a PUT.
    serverSessions.value = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    tabVisibilityController.applyInitializationSnapshot(
      serverSessions.value as AgentSessionTabVisibilitySession[],
      tabState
    );
    serverSessionsLoaded.value = true;
    reconcileTabNoMap({ workspaceId: requestWorkspaceId, sessions: allSessions.value });
    if (effectiveActiveKey.value) {
      activeKey.value = effectiveActiveKey.value;
      persistActiveKey(effectiveActiveKey.value);
    }
    statusStore.bindWorkspace(requestWorkspaceId);
    initializationState.value = "ready";

    if (visibleSessions.value.length === 0) {
      await createOneSession();
    }
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
    activeSessionRefresh = null;
    sessionRefreshRetry = null;
    titleMutationCache.revisionBySession.clear();
    titleMutationCache.recordBySession.clear();
    titleMutationCache.revision = 0;
    forceResetTitleModal();
    invalidateOpenParentIntent();
    activeKey.value = "";
    serverSessions.value = [];
    serverSessionsLoaded.value = false;
    draftSessions.value = [];
    const emptyAgentPresentation = createEmptyAgentPresentation();
    agentOptions.value = emptyAgentPresentation.agentOptions;
    subtaskAgentLabels.value = emptyAgentPresentation.subtaskAgentLabels;
    for (const key of Object.keys(draftVisibilityBySession)) delete draftVisibilityBySession[key];
    for (const key of Object.keys(tabVisibilityWriteStates)) delete tabVisibilityWriteStates[key];
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

let lastQueuedOpenSessionSequence: number | null = null;
let openSessionQueue = Promise.resolve();
watch(
  () => [props.openSessionRequest, initializationState.value] as const,
  ([request, state]) => {
    // 首次挂载时 request 已作为 prop 传入；等初始化快照完成后再打开，避免旧 Tab 状态覆盖目标。
    if (!request || state !== "ready" || request.sequence === lastQueuedOpenSessionSequence) return;
    lastQueuedOpenSessionSequence = request.sequence;
    const generation = workspaceGeneration, workspaceId = props.workspaceId;
    openSessionQueue = openSessionQueue.then(async () => {
      if (disposed || generation !== workspaceGeneration || workspaceId !== props.workspaceId || props.openSessionRequest?.sequence !== request.sequence) return;
      // 串行化刷新，连续点击不会因上一请求占用 refreshSessions 而丢失最新目标。
      const ok = await refreshSessions();
      if (disposed || generation !== workspaceGeneration || workspaceId !== props.workspaceId || props.openSessionRequest?.sequence !== request.sequence) return;
      if (!ok || !serverSessions.value.some((session) => session.id === request.sessionId)) {
        message.warning("关联会话已不可用");
        return;
      }
      await onOpenSubtask(request.sessionId);
    }).catch(() => {
      if (!disposed && generation === workspaceGeneration && workspaceId === props.workspaceId && props.openSessionRequest?.sequence === request.sequence) {
        message.warning("关联会话已不可用");
      }
    });
  },
  { immediate: true }
);

onActivated(() => {
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
  void createOneSession();
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
    const requestGeneration = workspaceGeneration;
    const requestWorkspaceId = props.workspaceId;
    delete pendingSessionTitleSyncUpdatedAt[sessionId];
    void refreshSessions().then((ok) => {
      if (ok) return;
      // 失败恢复前校验 generation：Workspace 已切换或组件卸载时不得恢复旧 baseline。
      if (!isRequestResponseWritable({
        disposed,
        currentGeneration: workspaceGeneration,
        requestGeneration,
        currentWorkspaceId: props.workspaceId,
        requestWorkspaceId
      })) {
        return;
      }
      pendingSessionTitleSyncUpdatedAt[sessionId] = retryBaseline ?? baselineUpdatedAt;
    });
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  disposed = true;
  workspaceGeneration += 1;
  activeSessionRefresh = null;
  sessionRefreshRetry = null;
  forceResetTitleModal();
  titleMutationCache.revisionBySession.clear();
  titleMutationCache.recordBySession.clear();
  titleMutationCache.revision = 0;
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
