<template>
  <div class="h-full min-h-0 flex flex-col">
    <div
      v-if="isSubtaskSession"
      class="px-3 py-2 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] text-[0.9em] text-[color:var(--text-tertiary)]"
    >
      <div :style="{ fontSize: 'var(--agent-font-size, 13px)' }">
        <div class="flex items-center gap-2">
          <a-button
            v-if="props.parentSessionId"
            type="link"
            size="small"
            class="!px-0"
            @click="onOpenParent"
          >
            {{ t("agent.client.backToParent") }}
          </a-button>
          <span>{{ t("agent.client.readonlySubtaskHint") }}</span>
        </div>
      </div>
    </div>

    <div
      ref="scrollEl"
      class="agent-message-list relative flex-1 min-h-0 overflow-auto p-3 bg-[var(--panel-bg)]"
      :style="{ fontSize: 'var(--agent-font-size, 13px)' }"
      @scroll.passive="onMessageListScroll"
      @wheel.passive="onMessageListWheel"
    >
      <!--
        顶部提示条固定占位高度,避免 loadingEarlier/reachedTop 在插入/移除时改变滚动内容高度,
        导致 prepend 历史消息时出现额外的 scrollTop 跳动.
      -->
      <div v-if="displayItems.length > 0" class="pt-1 pb-1 flex items-center gap-2" style="height: 1.7em;">
        <template v-if="loadingEarlier || showReachedTopNotice">
          <div class="h-px flex-1 bg-blue-500/40" />
          <div class="text-[0.9em] text-blue-600 whitespace-nowrap">
            {{ loadingEarlier ? t("common.loading") : t("agent.client.reachedTop") }}
          </div>
          <div class="h-px flex-1 bg-blue-500/40" />
        </template>
      </div>
      <div v-if="displayItems.length === 0" class="h-full flex flex-col items-center justify-center gap-3 text-[color:var(--text-tertiary)]">
        <div>{{ t("agent.client.welcome") }}</div>
        <a-button v-if="props.canChooseSession" type="link" size="small" class="!px-0" @click="onChooseSession">
          {{ t("agent.client.chooseSession") }}
        </a-button>
      </div>
      <div v-else class="agent-virtual-list" :style="{ height: `${virtualTotalSize}px` }">
        <div
          v-for="row in virtualRows"
          :key="row.key"
          class="agent-virtual-row"
          :style="{ transform: `translateY(${row.start}px)` }"
          >
             <div
               :data-index="row.index"
               :data-msg-id="row.kind === 'message' ? row.msg.id : ''"
               class="agent-virtual-row-inner"
               :style="{ paddingTop: `${row.gapTop}px` }"
               :ref="onVirtualRowMounted"
             >
                <div v-if="row.kind === 'spacer'" :style="{ height: `${row.spacerHeight}px` }" />
                <div v-else>
                  <div v-if="row.msg.boundaryReason" class="pb-1 flex items-center gap-2">
                    <div class="h-px flex-1 bg-blue-500/40" />
                    <div class="text-[0.9em] text-blue-600 whitespace-nowrap">{{ t("agent.client.contextBoundary") }}</div>
                    <div class="h-px flex-1 bg-blue-500/40" />
                  </div>

                  <div
                    class="agent-message-item relative rounded p-2"
                    :class="[
                      row.msg.role === 'tool'
                        ? isRichToolCard(row.msg)
                          ? 'is-tool-message border-0 bg-transparent px-0 py-0'
                          : 'is-tool-message border-0 bg-transparent pl-2 pr-0 py-0.5'
                        : '',
                      row.msg.role === 'user' ? 'is-user-message border border-blue-500/60 bg-blue-500/20' : 'border-0',
                      row.msg.role === 'assistant' ? 'is-assistant-message bg-[var(--panel-bg)]' : '',
                      row.msg.role === 'system' ? 'is-system-message bg-[var(--panel-bg)]' : '',
                      row.msg.role === 'user' && row.msg.tone === 'error' ? '!border-red-500/70 !bg-red-500/10' : '',
                      row.msg.role !== 'user' && row.msg.role !== 'tool' && row.msg.tone === 'error' ? 'bg-red-500/5' : '',
                      isTextMessageClamped(row.msg.id)
                        ? 'is-text-clamped border border-[var(--border-color-secondary)] bg-transparent'
                        : ''
                    ]"
                  >
                    <div
                      v-if="
                        (row.msg.role === 'user'
                          || (row.msg.role === 'assistant' && isTerminalStatus(row.msg.status) && row.msg.text.trim().length > 0))
                        && !isSubtaskSession
                      "
                      class="message-controls absolute right-2 top-1.5 z-10 flex items-center gap-1"
                    >
                      <span class="message-id">#{{ row.msg.id }}</span>
                      <a-tooltip :title="t('agent.client.fork')" placement="top">
                        <a-button
                          size="small"
                          type="text"
                          :loading="actionLoading === 'fork' && actionTargetId === row.msg.id"
                          :aria-label="t('agent.client.fork')"
                          @click="onForkFromMessage(row.msg.id)"
                        >
                          <template #icon><ForkOutlined /></template>
                        </a-button>
                      </a-tooltip>
                      <a-tooltip v-if="row.msg.archiveAt == null" :title="t('agent.client.revert')" placement="top">
                        <a-button
                          size="small"
                          type="text"
                          :disabled="row.msg.role === 'user' ? row.msg.prevId == null : false"
                          :loading="actionLoading === 'revert' && actionTargetId === row.msg.id"
                          :aria-label="t('agent.client.revert')"
                          @click="onRevertToMessage(row.msg.id)"
                        >
                          <template #icon><RollbackOutlined /></template>
                        </a-button>
                      </a-tooltip>
                    </div>

                    <div
                      v-if="isSubtaskCard(row.msg)"
                 class="subtask-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2"
                 :class="[
                   row.msg.subtaskSessionId ? 'is-clickable' : 'is-disabled',
                   row.msg.tone === 'error' ? 'border-red-500/40 bg-red-500/5' : ''
                 ]"
                 @click="onOpenSubtask(row.msg.subtaskSessionId)"
               >
                <div class="flex items-center gap-2">
                  <div class="font-semibold">
                    <DoubleRightOutlined class="subtask-title-icon mr-0.5 text-blue-500" />
                    {{ t("agent.client.subtaskCardTitle") }}: {{ row.msg.subtaskDescription || "-" }}
                  </div>
                  <component
                    :is="subtaskStatusIcon(row.msg.status)"
                    class="shrink-0"
                    :class="subtaskStatusIconClass(row.msg.status)"
                    :spin="subtaskStatusSpin(row.msg.status)"
                  />
                </div>
                <div class="pt-0.5 text-[color:var(--text-secondary)]">
                  {{ t("agent.client.subtaskAgent") }}: {{ row.msg.subtaskAgentName || row.msg.subtaskAgentId || "-" }}
                  <span class="inline-block w-3" />
                  {{ t("agent.client.subtaskMode") }}: {{ formatSubtaskMode(row.msg.subtaskMode) }}
                </div>
                <div class="pt-0.5 text-[color:var(--text-secondary)]">
                  {{ t("agent.client.subtaskSessionId") }}: {{ row.msg.subtaskSessionId || "-" }}
                </div>
                <div v-if="row.msg.toolError" class="pt-1 text-red-500">
                  Error: {{ row.msg.toolError }}
                </div>
              </div>
              <AgentTodoListCard
                v-else-if="isTodolistCard(row.msg) && row.msg.todoList"
                :collapsed="isTodoCollapsed(row.msg.id)"
                :summary="row.msg.todoList.summary"
                :todos="row.msg.todoList.todos"
                :error-text="row.msg.toolError"
                @toggle-collapse="onToggleTodoCollapse(row.msg.id)"
              />
               <AgentApplyPatchCard
                 v-else-if="isApplyPatchCard(row.msg) && row.msg.applyPatch"
                 :workspace-id="props.workspaceId"
                 :session-id="props.sessionId"
                 :item-id="row.msg.id"
                 :tool-call-id="row.msg.toolCallId"
                 :summary="row.msg.applyPatch.summary"
                 :files="row.msg.applyPatch.files"
                 :omitted-files="row.msg.applyPatch.omittedFiles"
                 :error-text="row.msg.toolError"
                 @request-measure="onRequestVirtualMeasure(row.msg.id)"
               />
              <AgentWriteCard
                v-else-if="isWriteCard(row.msg) && row.msg.writeResult"
                :workspace-id="props.workspaceId"
                :session-id="props.sessionId"
                :item-id="row.msg.id"
                :tool-call-id="row.msg.toolCallId"
                :summary="row.msg.writeResult"
                :error-text="row.msg.toolError"
                  @request-measure="onRequestVirtualMeasure(row.msg.id)"
                />
                    <div v-else-if="row.msg.role === 'assistant'" class="flex flex-col gap-1">
                      <AssistantMarkdownMessage
                        v-if="row.msg.text.trim().length > 0"
                        :class="isTerminalStatus(row.msg.status) ? 'pr-24' : ''"
                        :text="row.msg.text"
                        :message-id="row.msg.id"
                        :streaming="!isTerminalStatus(row.msg.status)"
                        :tone="row.msg.tone"
                      />
                      <div v-if="!isTerminalStatus(row.msg.status)" class="flex items-center gap-2 text-[0.9em] text-[color:var(--text-tertiary)]">
                        <LoadingOutlined spin />
                      </div>
                    </div>
                    <AgentUserMessage
                      v-else-if="row.msg.role === 'user'"
                      :text="row.msg.text"
                      :tone="row.msg.tone"
                    />
                    <AgentTextMessage
                      v-else-if="row.msg.role === 'tool' || row.msg.role === 'system'"
                      :text="row.msg.text"
                      :message-id="row.msg.id"
                      :expanded="isTextMessageExpanded(row.msg.id)"
                      :max-height-px="100"
                      :tone="row.msg.tone"
                      @toggle="(expanded) => onToggleTextMessageExpanded(row.msg.id, expanded)"
                      @request-measure="(messageId) => onRequestVirtualMeasure(messageId)"
                      @clamp-change="(clamped) => onTextMessageClampChange(row.msg.id, clamped)"
                    />
                    <div
                      v-else
                      class="whitespace-pre-wrap break-words"
                      :class="[
                        'pr-24',
                        row.msg.tone === 'error' ? 'text-red-500' : ''
                      ]"
                    >
                      {{ row.msg.text }}
                    </div>

                    <div
                      v-if="row.msg.role === 'tool' && row.msg.status === 'awaiting_permission'"
                      class="pt-2 flex items-center gap-1"
                    >
                      <a-button
                        size="small"
                        :loading="actionLoading === 'approve' && actionTargetId === row.msg.id"
                        @click="onToolPermission(row.msg.id, 'approve')"
                      >
                        {{ t("agent.client.approve") }}
                      </a-button>
                      <a-button
                        size="small"
                        danger
                        :loading="actionLoading === 'deny' && actionTargetId === row.msg.id"
                        @click="onToolPermission(row.msg.id, 'deny')"
                      >
                        {{ t("agent.client.deny") }}
                      </a-button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
      </div>
    </div>

    <div v-if="runNoticeText" class="px-3 py-2 border-t border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <div :style="{ fontSize: 'var(--agent-font-size, 13px)' }">
        <div
          class="text-[0.9em] text-amber-600 whitespace-nowrap overflow-hidden text-ellipsis"
          :title="runNoticeText"
        >
          {{ runNoticeText }}
        </div>
      </div>
    </div>

    <div
      v-if="!isSubtaskSession"
      class="p-3 border-t border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]"
      :style="{ fontSize: 'var(--agent-font-size, 13px)' }"
    >
      <div
        v-if="slashCommandHint.visible"
        class="mb-2"
      >
        <div class="flex flex-col gap-1">
          <button
            v-for="cmd in slashCommandHint.commands"
            :key="cmd.name"
            type="button"
            class="slash-command-item w-full rounded border border-transparent px-2 py-1 text-left"
            :class="cmd.name === slashCommandHint.activeCommand ? 'is-active border-blue-500/40 bg-blue-500/10' : ''"
            @click="onPickSlashCommand(cmd.name)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-mono text-[0.9em] whitespace-nowrap">{{ cmd.usage }}</span>
              <span class="text-[0.9em] text-[color:var(--text-secondary)] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ t(cmd.summaryKey) }}</span>
              <span v-if="cmd.strictOnly" class="text-[0.85em] text-[color:var(--text-tertiary)] whitespace-nowrap">{{ t("agent.client.slashCommandHintStrictOnly") }}</span>
            </div>
          </button>
          <div v-if="slashCommandHint.commands.length === 0" class="px-2 py-1 text-[0.9em] text-[color:var(--text-tertiary)]">
            {{ t("agent.client.slashCommandHintNoMatch", { query: slashCommandHint.query }) }}
          </div>
        </div>
      </div>

      <div class="flex items-end gap-2">
        <a-textarea
          ref="inputEl"
          v-model:value="draft"
          class="agent-input-textarea"
          :style="{ fontSize: 'var(--agent-font-size, 13px)' }"
          :disabled="!hasAvailableAgents"
          :auto-size="{ minRows: 2, maxRows: 6 }"
          :placeholder="hasAvailableAgents ? t('agent.client.inputPlaceholder') : t('agent.client.inputPlaceholderNoAgent')"
          @keydown="onInputKeydown"
        />
      </div>
      <div class="pt-2">
        <div class="flex items-center justify-between gap-2">
          <div v-if="hasAvailableAgents" class="flex items-center gap-2 min-w-0">
           <a-select
             :value="effectiveAgentId"
             :options="props.agentOptions"
             size="small"
             style="min-width: 180px; max-width: 320px"
             @update:value="onAgentChange"
           />
          </div>
          <div v-else class="flex items-center gap-2 text-[0.9em] text-[color:var(--text-tertiary)]">
            <span>{{ t("agent.client.noAgentHint") }}</span>
            <a-button type="link" size="small" class="!px-0" @click="goAgentProfiles">
              {{ t("agent.client.goCreateAgent") }}
            </a-button>
          </div>
          <div class="text-[0.9em] text-[color:var(--text-tertiary)] whitespace-nowrap">
            {{ t("agent.client.lastTotalTokens") }}: {{ formattedLastTotalTokens }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AgentContextItemRecord, AgentSessionRunState } from "@agent-workbench/shared";
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DoubleRightOutlined,
  ExclamationCircleOutlined,
  ForkOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  QuestionCircleOutlined,
  RollbackOutlined
} from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import { computed, nextTick, onActivated, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import AgentApplyPatchCard from "./AgentApplyPatchCard.vue";
import AgentTextMessage from "./AgentTextMessage.vue";
import AgentUserMessage from "./AgentUserMessage.vue";
import AssistantMarkdownMessage from "./AssistantMarkdownMessage.vue";
import AgentTodoListCard from "./AgentTodoListCard.vue";
import AgentWriteCard from "./AgentWriteCard.vue";
import {
  ApiError,
  cancelAgentSession,
  clearAgentSession,
  compactAgentSession,
  decideAgentToolPermission,
  forkAgentSession,
  getAgentContextItem,
  getAgentContextItems,
  getAgentRunState,
  revertAgentSession,
  sendAgentMessage
} from "@/shared/api";

type AgentOption = {
  value: string;
  label: string;
  isDefault?: boolean;
};

type ApplyPatchDisplayFile = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  additions: number;
  deletions: number;
};

type ApplyPatchDisplay = {
  text: string;
  summary: {
    fileCount: number;
    additions: number;
    deletions: number;
  };
  files: ApplyPatchDisplayFile[];
  omittedFiles: number;
};

type TodoListDisplay = {
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  };
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
};

type WriteDisplay = {
  summary: string;
  filePath: string;
  bytesWritten: number;
  existedBefore: boolean;
};

type DisplayItem = {
  id: number;
  prevId: number | null;
  archiveAt: number | null;
  boundaryReason: string | null;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  status: AgentContextItemRecord["status"];
  toolName?: string;
  toolCallId?: string;
  toolError?: string;
  subtaskSessionId?: string;
  subtaskDescription?: string;
  subtaskMode?: "new" | "existing" | "fork" | string;
  subtaskAgentId?: string;
  subtaskAgentName?: string;
  todoList?: TodoListDisplay;
  applyPatch?: ApplyPatchDisplay;
  writeResult?: WriteDisplay;
  tone?: "normal" | "error";
};

type VirtualDisplayRow = {
  key: string | number;
  index: number;
  start: number;
  gapTop: number;
  kind: "message" | "spacer";
  msg: DisplayItem;
  spacerHeight: number;
};

const MESSAGE_GAP_DEFAULT = 12;
const MESSAGE_GAP_PREV_TOOL = 8;
const MESSAGE_GAP_CUR_TOOL = 6;
const MESSAGE_GAP_TOOL_TOOL = 2;
const BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const MESSAGE_LIST_BOTTOM_SPACER_PX = 16;
const INITIAL_TAIL_LIMIT = 100;
const REACHED_TOP_NOTICE_MIN_ITEMS = 50;
const HISTORY_PAGE_LIMIT = 100;
const TOP_LOAD_THRESHOLD_PX = 80;
const POLL_RUNNING_MS = 850;
const POLL_LOCAL_NON_TERMINAL_MS = 700;
const POLL_SETTLE_MS = 520;
const POLL_ERROR_RETRY_MS = 1400;
const POLL_IMMEDIATE_REFRESH_MS = 420;

const props = defineProps<{
  workspaceId: string;
  sessionId: string;
  sessionKind: "primary" | "subtask";
  parentSessionId?: string | null;
  sessionReady: boolean;
  ensureSession?: (sessionId: string) => Promise<string>;
  pollHint?: number;
  canChooseSession?: boolean;
  active: boolean;
  modelValue?: string | null;
  agentOptions: AgentOption[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
  forked: [sessionId: string];
  "open-subtask": [sessionId: string];
  "open-parent": [sessionId: string];
  "choose-session": [];
  "request-poll-session": [sessionId: string];
}>();

const { t } = useI18n();
const router = useRouter();

const loading = ref(false);
const loadingEarlier = ref(false);
const reachedTop = ref(false);
const atTop = ref(false);
const sending = ref(false);
const draft = ref("");
const runState = ref<AgentSessionRunState>({
  sessionId: props.sessionId,
  status: "idle",
  activeRunId: null,
  activeAssistantItemId: null,
  waitingToolItemId: null,
  lastResponseTotalTokens: null,
  runNoticeText: "",
  nonTerminalItemIds: [],
  updatedAt: 0,
  appliedItemId: 0
});
const runNoticeText = computed(() => String(runState.value.runNoticeText || "").trim());
const lastKnownHeadItemId = ref<number | null>(null);
const items = ref<AgentContextItemRecord[]>([]);
const expandedTextMessageIds = ref<Set<number>>(new Set());
const clampedTextMessageIds = ref<Set<number>>(new Set());
const collapsedTodoItemIds = ref<Set<number>>(new Set());
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<{ focus?: () => void } | null>(null);
const stickToBottom = ref(true);
const userUnfollowed = ref(false);
const forcedBottomOnFirstActive = ref(false);
let scrollToBottomSeq = 0;
let loadEarlierSeq = 0;

// 吸底稳定锁: 用于处理“单次大段输出”导致的虚拟列表高度延迟测量。
// 典型场景: 压缩(compaction)结果一次性写入一大段文本,首次 scrollToBottom 基于估高执行,
// 随后真实高度测量完成后 scrollHeight 突增,若不补滚动会表现为吸底失效。
const followBottomLockRemaining = ref(0);
let followBottomLockSeq = 0;
let followBottomLockInFlight = false;
let followBottomLockTimer: number | null = null;
const FOLLOW_BOTTOM_LOCK_MAX_ATTEMPTS = 6;
const FOLLOW_BOTTOM_LOCK_TIMEOUT_MS = 1400;

// 仅用于判断用户是否在主动向上滚动(一旦向上滚,立刻取消吸底,避免被自动 scrollToBottom 抢回去)。
let lastKnownScrollTop = 0;

const actionLoading = ref<"cancel" | "fork" | "revert" | "approve" | "deny" | null>(null);
const actionTargetId = ref<number | null>(null);

let pollTimer: number | null = null;
let pollHintRefreshSeq = 0;
let settlePollRemaining = 0;
let warmupPollRemaining = 0;
// pollHint 可能在 pane 尚未 active 时到达(新会话首条消息的典型竞态),需要暂存到激活后再补一次刷新+短轮询。
const pendingPollHint = ref(false);
const terminalStatuses = new Set<AgentContextItemRecord["status"]>(["completed", "failed", "denied", "cancelled"]);
const isSubtaskSession = computed(() => props.sessionKind === "subtask");

// 兼容中文输入法习惯: 用户输入首字符为“、”时,自动替换为“/”。
watch(
  draft,
  (next) => {
    if (typeof next !== "string" || next.length === 0) return;
    if (next[0] !== "、") return;
    draft.value = `/${next.slice(1)}`;
  },
  { flush: "sync" }
);

type SlashCommandAction = "compact" | "clear";

type SlashCommandDefinition = {
  name: string;
  usage: string;
  summaryKey: string;
  strictOnly: boolean;
  action: SlashCommandAction;
};

const slashCommands: SlashCommandDefinition[] = [
  {
    name: "compact",
    usage: "/compact",
    summaryKey: "agent.client.slashCommands.compact.summary",
    strictOnly: true,
    action: "compact"
  },
  {
    name: "clear",
    usage: "/clear",
    summaryKey: "agent.client.slashCommands.clear.summary",
    strictOnly: true,
    action: "clear"
  }
];

const slashCommandMap = new Map(slashCommands.map((item) => [item.name, item] as const));
const slashCommandSelection = ref("");

const slashCommandHint = computed(() => {
  const text = draft.value.trimStart();
  if (!text.startsWith("/")) {
    return {
      visible: false,
      query: "",
      commands: [] as SlashCommandDefinition[],
      activeCommand: ""
    };
  }
  const normalized = text.trim().toLowerCase();
  for (const item of slashCommands) {
    if (normalized === item.usage) {
      return {
        visible: false,
        query: "",
        commands: [] as SlashCommandDefinition[],
        activeCommand: ""
      };
    }
  }
  const query = text.slice(1).split(/\s+/, 1)[0]?.toLowerCase() || "";
  const commands = slashCommands.filter((item) => !query || item.name.startsWith(query));
  const active = commands.some((item) => item.name === slashCommandSelection.value)
    ? slashCommandSelection.value
    : (commands[0]?.name || "");
  return {
    visible: true,
    query,
    commands,
    activeCommand: active
  };
});

function toRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNonNegativeInt(value: unknown) {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function toFileType(value: unknown): ApplyPatchDisplayFile["type"] {
  if (value === "add" || value === "update" || value === "delete" || value === "move") {
    return value;
  }
  return "update";
}

function parseApplyPatchDisplay(value: unknown): ApplyPatchDisplay | null {
  const source = toRecord(value);
  if (!source) return null;
  const filesRaw = Array.isArray(source.files) ? source.files : [];
  const files: ApplyPatchDisplayFile[] = [];

  for (const item of filesRaw) {
    const file = toRecord(item);
    if (!file) continue;
    const path = String(file.path || file.relativePath || file.filePath || "").trim();
    if (!path) continue;
    const fromPath = String(file.fromPath || file.moveFromPath || "").trim();
    files.push({
      type: toFileType(file.type),
      path,
      ...(fromPath ? { fromPath } : {}),
      additions: toNonNegativeInt(file.additions),
      deletions: toNonNegativeInt(file.deletions)
    });
  }

  const summaryRaw = toRecord(source.summary);
  const fileCount = toNonNegativeInt(summaryRaw?.fileCount ?? files.length);
  const additions = toNonNegativeInt(summaryRaw?.additions ?? files.reduce((sum, file) => sum + file.additions, 0));
  const deletions = toNonNegativeInt(summaryRaw?.deletions ?? files.reduce((sum, file) => sum + file.deletions, 0));
  const omittedFiles = Math.max(0, fileCount - files.length);

  return {
    text: typeof source.text === "string" ? source.text : "",
    summary: {
      fileCount,
      additions,
      deletions
    },
    files,
    omittedFiles
  };
}

function toTodoStatus(value: unknown): "pending" | "in_progress" | "completed" | "cancelled" | null {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled") {
    return value;
  }
  return null;
}

function parseTodoListDisplay(value: unknown): TodoListDisplay | null {
  const source = toRecord(value);
  if (!source) return null;
  const todosRaw = Array.isArray(source.todos) ? source.todos : [];
  const todos: TodoListDisplay["todos"] = [];
  for (const item of todosRaw) {
    const row = toRecord(item);
    if (!row) continue;
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) continue;
    const status = toTodoStatus(row.status);
    if (!status) continue;
    todos.push({ content, status });
  }

  const summaryRaw = toRecord(source.summary);
  return {
    summary: {
      total: toNonNegativeInt(summaryRaw?.total ?? todos.length),
      pending: toNonNegativeInt(summaryRaw?.pending ?? todos.filter((item) => item.status === "pending").length),
      inProgress: toNonNegativeInt(
        summaryRaw?.inProgress ?? summaryRaw?.in_progress ?? todos.filter((item) => item.status === "in_progress").length
      ),
      completed: toNonNegativeInt(summaryRaw?.completed ?? todos.filter((item) => item.status === "completed").length),
      cancelled: toNonNegativeInt(summaryRaw?.cancelled ?? todos.filter((item) => item.status === "cancelled").length)
    },
    todos
  };
}

function parseWriteDisplay(value: unknown): WriteDisplay | null {
  const source = toRecord(value);
  if (!source) return null;
  const filePath = typeof source.filePath === "string"
    ? source.filePath.trim()
    : typeof source.path === "string"
      ? source.path.trim()
      : "";
  if (!filePath) return null;
  const summary = typeof source.summary === "string" && source.summary.trim()
    ? source.summary
    : `写入文件 ${filePath}`;
  return {
    summary,
    filePath,
    bytesWritten: toNonNegativeInt(source.bytesWritten ?? source.bytes),
    existedBefore: source.existedBefore === true
  };
}

function resolveAgentName(agentId: string) {
  const target = props.agentOptions.find((item) => item.value === agentId);
  return target?.label || "";
}

const hasAvailableAgents = computed(() => props.agentOptions.length > 0);

const fallbackAgentId = computed(() => {
  const defaultOption = props.agentOptions.find((item) => item.isDefault);
  if (defaultOption) return defaultOption.value;
  return props.agentOptions[0]?.value ?? "";
});

const effectiveAgentId = computed(() => {
  const raw = String(props.modelValue || "").trim();
  if (raw && props.agentOptions.some((item) => item.value === raw)) {
    return raw;
  }
  return fallbackAgentId.value;
});

const formattedLastTotalTokens = computed(() => {
  const value = runState.value.lastResponseTotalTokens;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  return new Intl.NumberFormat().format(Math.floor(value));
});

const showReachedTopNotice = computed(() => {
  return reachedTop.value && displayItems.value.length >= REACHED_TOP_NOTICE_MIN_ITEMS;
});

const displayItems = computed<DisplayItem[]>(() => {
  const mapped = items.value.map<DisplayItem>((item) => {
    const archiveAt = typeof item.archiveAt === "number" && Number.isFinite(item.archiveAt) ? item.archiveAt : null;
    const boundaryReason =
      typeof item.boundaryReason === "string" && item.boundaryReason.trim() ? item.boundaryReason.trim() : null;
    if (item.kind === "user" && item.output.type === "user_text") {
      return {
        id: item.id,
        prevId: item.prevId,
        archiveAt,
        boundaryReason,
        role: "user",
        text: item.output.text,
        status: item.status
      };
    }
    if (item.kind === "assistant" && item.output.type === "assistant_text") {
      return {
        id: item.id,
        prevId: item.prevId,
        archiveAt,
        boundaryReason,
        role: "assistant",
        text: item.output.text,
        status: item.status,
        tone: item.status === "failed" ? "error" : "normal"
      };
    }
    if (item.kind === "tool" && item.output.type === "tool") {
      const argsText = formatToolArgs(item.output.args);
      const callText = `${item.output.toolName}(${argsText})`;
      // 文本型工具消息默认不展示 [completed],仅在失败/拒绝/取消等异常状态时展示状态。
      const showStatus = item.status === "failed" || item.status === "denied" || item.status === "cancelled";
      const statusText = showStatus ? `[${item.status}]` : "";
      const headText = statusText ? `${callText} ${statusText}` : callText;
      const toolCallId = typeof item.output.toolCallId === "string" && item.output.toolCallId.trim()
        ? item.output.toolCallId.trim()
        : undefined;
      const resultObj = toRecord(item.output.result);
      const subtaskSessionId =
        typeof resultObj?.subtaskSessionId === "string" && resultObj.subtaskSessionId.trim()
          ? resultObj.subtaskSessionId.trim()
          : undefined;
      const errorText = item.output.error ? truncateText(item.output.error, 220) : undefined;
      if (item.output.toolName === "apply_patch") {
        const applyPatch = parseApplyPatchDisplay(item.output.result);
        if (!applyPatch) {
          let line = headText;
          if (errorText) {
            line += `\nerror: ${errorText}`;
          }
          return {
            id: item.id,
            prevId: item.prevId,
            archiveAt,
            boundaryReason,
            role: "tool",
            text: line,
            status: item.status,
            toolName: item.output.toolName,
            ...(toolCallId ? { toolCallId } : {}),
            tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
          };
        }
        return {
          id: item.id,
          prevId: item.prevId,
          archiveAt,
          boundaryReason,
          role: "tool",
          text: headText,
          status: item.status,
          toolName: item.output.toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(errorText ? { toolError: errorText } : {}),
          ...(applyPatch ? { applyPatch } : {}),
          tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
        };
      }
      if (item.output.toolName === "todolist") {
        const todoList = parseTodoListDisplay(item.output.result) || parseTodoListDisplay(item.output.args);
        if (!todoList) {
          let line = headText;
          if (errorText) {
            line += `\nerror: ${errorText}`;
          }
          return {
            id: item.id,
            prevId: item.prevId,
            archiveAt,
            boundaryReason,
            role: "tool",
            text: line,
            status: item.status,
            toolName: item.output.toolName,
            ...(toolCallId ? { toolCallId } : {}),
            tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
          };
        }
        return {
          id: item.id,
          prevId: item.prevId,
          archiveAt,
          boundaryReason,
          role: "tool",
          text: headText,
          status: item.status,
          toolName: item.output.toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(errorText ? { toolError: errorText } : {}),
          todoList,
          tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
        };
      }
      if (item.output.toolName === "write") {
        const writeResult = parseWriteDisplay(item.output.result);
        if (!writeResult) {
          let line = headText;
          if (errorText) {
            line += `\nerror: ${errorText}`;
          }
          return {
            id: item.id,
            prevId: item.prevId,
            archiveAt,
            boundaryReason,
            role: "tool",
            text: line,
            status: item.status,
            toolName: item.output.toolName,
            ...(toolCallId ? { toolCallId } : {}),
            tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
          };
        }
        return {
          id: item.id,
          prevId: item.prevId,
          archiveAt,
          boundaryReason,
          role: "tool",
          text: headText,
          status: item.status,
          toolName: item.output.toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(errorText ? { toolError: errorText } : {}),
          writeResult,
          tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
        };
      }
      if (item.output.toolName === "subtask") {
        const argsObj = toRecord(item.output.args);
        const description = typeof argsObj?.description === "string" ? argsObj.description.trim() : "";
        const session = toRecord(argsObj?.session);
        const modeRaw = typeof session?.mode === "string" ? session.mode.trim() : "";
        const mode = modeRaw === "new" || modeRaw === "existing" || modeRaw === "fork" ? modeRaw : "";
        const agentId = typeof argsObj?.agentId === "string" ? argsObj.agentId.trim() : "";
        const agentName = agentId ? resolveAgentName(agentId) : "";
        return {
          id: item.id,
          prevId: item.prevId,
          archiveAt,
          boundaryReason,
          role: "tool",
          text: headText,
          status: item.status,
          toolName: item.output.toolName,
          ...(toolCallId ? { toolCallId } : {}),
          ...(subtaskSessionId ? { subtaskSessionId } : {}),
          ...(errorText ? { toolError: errorText } : {}),
          ...(description ? { subtaskDescription: description } : {}),
          ...(mode ? { subtaskMode: mode } : {}),
          ...(agentId ? { subtaskAgentId: agentId } : {}),
          ...(agentName ? { subtaskAgentName: agentName } : {}),
          tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
        };
      }
      let line = headText;
      if (errorText) {
        line += `\nerror: ${errorText}`;
      }
      return {
        id: item.id,
        prevId: item.prevId,
        archiveAt,
        boundaryReason,
        role: "tool",
        text: line,
        status: item.status,
        toolName: item.output.toolName,
        ...(toolCallId ? { toolCallId } : {}),
        ...(subtaskSessionId ? { subtaskSessionId } : {}),
        tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
      };
    }
    if (item.kind === "system" && item.output.type === "system_text") {
      return {
        id: item.id,
        prevId: item.prevId,
        archiveAt,
        boundaryReason,
        role: "system",
        text: item.output.text,
        status: item.status
      };
    }
    return {
      id: item.id,
      prevId: item.prevId,
      archiveAt,
      boundaryReason,
      role: "system",
      text: JSON.stringify(item.output),
      status: item.status
    };
  });

  // assistant 消息展示规则:
  // - 非终态: 即使 text 为空也保留(用于展示 loading 行)
  // - 终态: text 为空则隐藏
  return mapped.filter((item) => {
    if (item.role !== "assistant") return true;
    if (!isTerminalStatus(item.status)) return true;
    return item.text.trim().length > 0;
  });
});

const latestTodoListItemId = computed<number | null>(() => {
  for (let i = displayItems.value.length - 1; i >= 0; i -= 1) {
    const item = displayItems.value[i];
    if (item?.todoList) return item.id;
  }
  return null;
});

function isTodoCollapsed(itemId: number) {
  return collapsedTodoItemIds.value.has(itemId);
}

function isTextMessageExpanded(itemId: number) {
  return expandedTextMessageIds.value.has(itemId);
}

function isTextMessageClamped(itemId: number) {
  return clampedTextMessageIds.value.has(itemId);
}

function onToggleTextMessageExpanded(itemId: number, expanded: boolean) {
  const next = new Set(expandedTextMessageIds.value);
  if (expanded) next.add(itemId);
  else next.delete(itemId);
  expandedTextMessageIds.value = next;
  onRequestVirtualMeasure(itemId);
}

function onTextMessageClampChange(itemId: number, clamped: boolean) {
  const next = new Set(clampedTextMessageIds.value);
  if (clamped) next.add(itemId);
  else next.delete(itemId);
  clampedTextMessageIds.value = next;
}

function onToggleTodoCollapse(itemId: number) {
  const next = new Set(collapsedTodoItemIds.value);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  collapsedTodoItemIds.value = next;
  onRequestVirtualMeasure(itemId);
}

watch(
  latestTodoListItemId,
  (latestId, prevLatestId) => {
    if (latestId == null) {
      if (collapsedTodoItemIds.value.size > 0) {
        collapsedTodoItemIds.value = new Set();
      }
      return;
    }
    if (latestId === prevLatestId) return;
    const next = new Set<number>();
    for (const item of displayItems.value) {
      if (!item.todoList) continue;
      if (item.id === latestId) continue;
      next.add(item.id);
    }
    collapsedTodoItemIds.value = next;
    onRequestVirtualMeasure(latestId);
  },
  { immediate: true }
);

function messageGapTopAt(index: number) {
  if (index <= 0) return 0;
  const prev = displayItems.value[index - 1];
  const current = displayItems.value[index];
  if (!prev || !current) return MESSAGE_GAP_DEFAULT;

  const prevIsTool = prev.role === "tool";
  const currentIsTool = current.role === "tool";

  if (prevIsTool && currentIsTool) return MESSAGE_GAP_TOOL_TOOL;
  if (prevIsTool) return MESSAGE_GAP_PREV_TOOL;
  if (currentIsTool) return MESSAGE_GAP_CUR_TOOL;
  return MESSAGE_GAP_DEFAULT;
}

function estimateTextBlockHeight(text: string, options?: {
  charsPerLine?: number;
  lineHeight?: number;
  minLines?: number;
  maxLines?: number;
}) {
  const raw = String(text || "");
  const charsPerLine = Math.max(16, Math.floor(options?.charsPerLine ?? 52));
  const lineHeight = Math.max(12, Math.floor(options?.lineHeight ?? 20));
  const minLines = Math.max(1, Math.floor(options?.minLines ?? 1));
  const maxLines = Math.max(minLines, Math.floor(options?.maxLines ?? 80));

  const explicitLines = raw.length > 0 ? raw.split("\n").length : 1;
  const wrappedLines = Math.max(1, Math.ceil(raw.length / charsPerLine));
  const lines = Math.min(maxLines, Math.max(minLines, explicitLines, wrappedLines));
  return lines * lineHeight;
}

function estimateRowHeight(index: number) {
  const item = displayItems.value[index];
  if (!item) return 88;
  const gap = messageGapTopAt(index);
  if (item.role === "user") {
    return 44 + estimateTextBlockHeight(item.text, { charsPerLine: 56, lineHeight: 20, minLines: 2, maxLines: 24 }) + gap;
  }
  if (item.role === "assistant") {
    const terminal = isTerminalStatus(item.status);
    // 非终态 assistant 底部会额外渲染一行 loading 提示。
    const loadingRow = terminal ? 0 : 24;
    const base = terminal ? 52 : 44;
    const minLines = terminal ? 2 : 1;
    return base + estimateTextBlockHeight(item.text, { charsPerLine: 50, lineHeight: 20, minLines, maxLines: 80 }) + loadingRow + gap;
  }
  if (item.role === "system") {
    return 34 + estimateTextBlockHeight(item.text, { charsPerLine: 70, lineHeight: 18, minLines: 1, maxLines: 16 }) + gap;
  }

  if (item.applyPatch) {
    const fileCount = item.applyPatch.files.length;
    const rows = Math.min(fileCount, 6);
    // apply_patch 收起态: 近似按“每个文件一行 tool 文本”的高度估算,并用 tool-tool 间距作为行间距。
    return 18 + rows * 20 + Math.max(0, rows - 1) * MESSAGE_GAP_TOOL_TOOL + gap;
  }
  if (item.todoList) {
    if (isTodoCollapsed(item.id)) {
      return 52 + gap;
    }
    const rows = Math.min(item.todoList.todos.length, 4);
    return 96 + rows * 28 + gap;
  }
  if (item.writeResult) {
    return 116 + gap;
  }
  if (item.toolName === "subtask") return 136 + gap;
  return 32 + estimateTextBlockHeight(item.text, { charsPerLine: 72, lineHeight: 18, minLines: 1, maxLines: 20 }) + gap;
}

// 持久化测量结果: 避免虚拟列表在某些 re-measure 场景下回退到粗略 estimate,
// 导致大幅 scrollAdjustments 校正与可见的跳动。
const measuredRowSizeByItemId = new Map<number, number>();

function measureVirtualRowElement(element: HTMLDivElement) {
  const indexAttr = element.getAttribute("data-index");
  const index = indexAttr ? Number(indexAttr) : NaN;
  const list = displayItems.value;
  const msg = Number.isFinite(index) && index >= 0 && index < list.length ? list[index] : null;
  const itemId = msg?.id ?? 0;
  const size = Math.max(0, Math.ceil(element.getBoundingClientRect().height));
  if (itemId > 0 && size > 0) {
    measuredRowSizeByItemId.set(itemId, size);
  }
  return size;
}

const rowVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>(
  computed(() => ({
    count: displayItems.value.length > 0 ? displayItems.value.length + 1 : 0,
    getScrollElement: () => scrollEl.value,
    getItemKey: (index: number) => {
      const list = displayItems.value;
      if (index === list.length) return "__bottom_spacer__";
      return list[index]?.id ?? index;
    },
    estimateSize: (index: number) => {
      const list = displayItems.value;
      if (index === list.length) return MESSAGE_LIST_BOTTOM_SPACER_PX;
      const msg = list[index];
      if (msg?.id) {
        const cached = measuredRowSizeByItemId.get(msg.id);
        if (typeof cached === "number" && Number.isFinite(cached) && cached > 0) {
          return cached;
        }
      }
      return estimateRowHeight(index);
    },
    measureElement: (element) => measureVirtualRowElement(element as unknown as HTMLDivElement),
    overscan: 12,
    // 将 ResizeObserver 的测量回调合并到 rAF,减少连续同步测量引起的抖动。
    useAnimationFrameWithResizeObserver: true
   }))
);

const virtualTotalSize = computed(() => rowVirtualizer.value.getTotalSize());

const virtualRows = computed<VirtualDisplayRow[]>(() => {
  const list = displayItems.value;
  const rows: VirtualDisplayRow[] = [];
  for (const virtualItem of rowVirtualizer.value.getVirtualItems()) {
    const isSpacer = virtualItem.index === list.length;
    const msg = isSpacer ? list[list.length - 1] : list[virtualItem.index];
    if (!msg) continue;
    rows.push({
      key: typeof virtualItem.key === "number" || typeof virtualItem.key === "string" ? virtualItem.key : String(virtualItem.key),
      index: virtualItem.index,
      start: virtualItem.start,
      gapTop: isSpacer ? 0 : messageGapTopAt(virtualItem.index),
      kind: isSpacer ? "spacer" : "message",
      msg,
      spacerHeight: MESSAGE_LIST_BOTTOM_SPACER_PX
    });
  }
  return rows;
});

function onVirtualRowMounted(refValue: Element | { $el?: unknown } | null) {
  if (!refValue) return;
  const element = refValue instanceof Element
    ? refValue
    : refValue.$el instanceof Element
      ? refValue.$el
      : null;
  if (!element) return;
  rowVirtualizer.value.measureElement(element as HTMLDivElement);
}

let measureReqSeq = 0;

function onRequestVirtualMeasure(targetMsgId?: number) {
  const el = scrollEl.value;
  if (!el) return;

  // 用户在历史消息里展开/收起(例如 apply_patch diff)时,不应触发自动吸底。
  const dist = distanceToBottom();
  const followBottom = stickToBottom.value && dist <= 4;

  const containerRect = el.getBoundingClientRect();
  const nodes = Array.from(el.querySelectorAll<HTMLElement>(".agent-virtual-row-inner[data-msg-id]"));
  const firstVisible = nodes
    .map((node) => ({
      node,
      rect: node.getBoundingClientRect(),
      msgId: Number(node.dataset.msgId || 0)
    }))
    .filter((item) => item.msgId > 0 && item.rect.bottom > containerRect.top)
    .sort((a, b) => a.rect.top - b.rect.top)[0];

  const anchorMsgId = firstVisible?.msgId ?? 0;
  const anchorOffsetPx = firstVisible ? firstVisible.rect.top - containerRect.top : 0;

  if (!followBottom) {
    stickToBottom.value = false;
    userUnfollowed.value = true;
  }

  const seq = ++measureReqSeq;
  void nextTick().then(async () => {
    if (seq !== measureReqSeq) return;
    if (typeof targetMsgId === "number" && targetMsgId > 0) {
      const targetEl = el.querySelector<HTMLElement>(`.agent-virtual-row-inner[data-msg-id='${targetMsgId}']`);
      if (targetEl) {
        rowVirtualizer.value.measureElement(targetEl as HTMLDivElement);
      }
    }
    await nextTick();
    if (seq !== measureReqSeq) return;

    if (followBottom) {
      await scrollToBottom();
      return;
    }

    if (!anchorMsgId) return;
    const anchorEl = el.querySelector<HTMLElement>(`.agent-virtual-row-inner[data-msg-id='${anchorMsgId}']`);
    if (!anchorEl) return;
    const nextRect = anchorEl.getBoundingClientRect();
    const nextOffset = nextRect.top - containerRect.top;
    const delta = nextOffset - anchorOffsetPx;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;

    el.scrollTop = Math.max(0, Math.floor(el.scrollTop + delta));
    lastKnownScrollTop = el.scrollTop;
  });
}

function roleLabel(role: DisplayItem["role"]) {
  if (role === "user") return t("agent.client.roles.user");
  if (role === "assistant") return t("agent.client.roles.assistant");
  if (role === "tool") return t("agent.client.roles.tool");
  return t("agent.client.roles.system");
}

function isSubtaskCard(item: DisplayItem) {
  return item.role === "tool" && item.toolName === "subtask";
}

function isApplyPatchCard(item: DisplayItem) {
  return item.role === "tool" && item.toolName === "apply_patch" && !!item.applyPatch;
}

function isTodolistCard(item: DisplayItem) {
  return item.role === "tool" && item.toolName === "todolist" && !!item.todoList;
}

function isWriteCard(item: DisplayItem) {
  return item.role === "tool" && item.toolName === "write" && !!item.writeResult;
}

function isRichToolCard(item: DisplayItem) {
  return isSubtaskCard(item) || isTodolistCard(item) || isApplyPatchCard(item) || isWriteCard(item);
}

function formatSubtaskMode(mode?: string) {
  if (mode === "new") return t("agent.client.subtaskModeNew");
  if (mode === "fork") return t("agent.client.subtaskModeFork");
  if (mode === "existing") return t("agent.client.subtaskModeExisting");
  return mode || "-";
}

function subtaskStatusIcon(status: AgentContextItemRecord["status"]) {
  if (status === "completed") return CheckCircleOutlined;
  if (status === "failed") return ExclamationCircleOutlined;
  if (status === "cancelled") return CloseCircleOutlined;
  if (status === "denied") return MinusCircleOutlined;
  if (status === "awaiting_permission") return QuestionCircleOutlined;
  if (status === "queued") return ClockCircleOutlined;
  if (status === "running" || status === "streaming") return LoadingOutlined;
  return QuestionCircleOutlined;
}

function subtaskStatusSpin(status: AgentContextItemRecord["status"]) {
  return status === "running" || status === "streaming";
}

function subtaskStatusIconClass(status: AgentContextItemRecord["status"]) {
  if (status === "completed") return "text-emerald-500";
  if (status === "failed") return "text-red-500";
  if (status === "cancelled") return "text-[color:var(--text-tertiary)]";
  if (status === "denied") return "text-red-500";
  if (status === "awaiting_permission") return "text-amber-500";
  if (status === "queued") return "text-[color:var(--text-tertiary)]";
  if (status === "running" || status === "streaming") return "text-blue-500";
  return "text-[color:var(--text-tertiary)]";
}

function truncateText(input: string, maxLen: number) {
  const value = String(input || "");
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function toCompactText(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolArgs(args: unknown) {
  if (typeof args === "undefined") return "";
  return truncateText(toCompactText(args), 120);
}

function clearPoll() {
  if (pollTimer === null) return;
  window.clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delayMs = 800) {
  clearPoll();
  if (!props.active) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void refreshAll(false);
  }, delayMs);
}

function kickPollAfterRefresh(params: { forceFull: boolean; forceFollowBottom: boolean }) {
  // warmup: 即使服务端 runState 暂时还是 idle,也短暂补轮询几次,覆盖“写入稍晚/调度稍晚”的窗口。
  warmupPollRemaining = Math.max(warmupPollRemaining, 3);
  const seq = ++pollHintRefreshSeq;
  void (async () => {
    await refreshAll(params.forceFull, params.forceFollowBottom);
    if (seq !== pollHintRefreshSeq) return;
    if (!props.active || !props.sessionId) return;
    // 无论 refreshAll 内部是否决定继续轮询,这里都补一枪短延迟 poll,
    // 避免服务端 runState/item 写入稍晚导致 UI 停在 idle/空列表。
    schedulePoll(POLL_IMMEDIATE_REFRESH_MS);
  })();
}

type ScrollAnchor = {
  msgId: number;
  offsetPx: number;
};

function captureScrollAnchor(el: HTMLElement): ScrollAnchor | null {
  const containerRect = el.getBoundingClientRect();
  const nodes = Array.from(el.querySelectorAll<HTMLElement>(".agent-virtual-row-inner[data-msg-id]"));
  const firstVisible = nodes
    .map((node) => ({
      node,
      rect: node.getBoundingClientRect(),
      msgId: Number(node.dataset.msgId || 0)
    }))
    .filter((item) => item.msgId > 0 && item.rect.bottom > containerRect.top)
    .sort((a, b) => a.rect.top - b.rect.top)[0];

  const msgId = firstVisible?.msgId ?? 0;
  if (!msgId) return null;
  return {
    msgId,
    offsetPx: firstVisible ? firstVisible.rect.top - containerRect.top : 0
  };
}

function restoreScrollAnchor(el: HTMLElement, anchor: ScrollAnchor) {
  const containerRect = el.getBoundingClientRect();
  const anchorEl = el.querySelector<HTMLElement>(`.agent-virtual-row-inner[data-msg-id='${anchor.msgId}']`);
  if (!anchorEl) return;
  const nextOffset = anchorEl.getBoundingClientRect().top - containerRect.top;
  const delta = nextOffset - anchor.offsetPx;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
  el.scrollTop = Math.max(0, el.scrollTop + delta);
}

function distanceToBottom() {
  const el = scrollEl.value;
  if (!el) return Number.POSITIVE_INFINITY;
  return Math.max(0, el.scrollHeight - (el.scrollTop + el.clientHeight));
}

function updateStickToBottomState() {
  if (displayItems.value.length === 0) {
    stickToBottom.value = true;
    userUnfollowed.value = false;
    return;
  }
  const dist = distanceToBottom();
  if (userUnfollowed.value) {
    stickToBottom.value = dist <= 4;
    if (stickToBottom.value) {
      userUnfollowed.value = false;
    }
    return;
  }
  stickToBottom.value = dist <= BOTTOM_FOLLOW_THRESHOLD_PX;
}

async function loadEarlierHistoryPage() {
  if (!props.active) return;
  if (!props.sessionReady) return;
  if (loadingEarlier.value) return;
  if (reachedTop.value) return;
  const el = scrollEl.value;
  if (!el) return;
  if (items.value.length === 0) return;
  if (el.scrollTop > TOP_LOAD_THRESHOLD_PX) return;

  const beforeId = items.value[0]?.id;
  if (typeof beforeId !== "number" || !Number.isFinite(beforeId) || beforeId <= 0) return;

  const seq = ++loadEarlierSeq;
  const sessionId = props.sessionId;
  loadingEarlier.value = true;
  try {
    const expectedHeadItemId = typeof lastKnownHeadItemId.value === "number" ? lastKnownHeadItemId.value : undefined;
    const page = await getAgentContextItems(sessionId, {
      beforeId,
      limit: HISTORY_PAGE_LIMIT,
      ...(expectedHeadItemId ? { expectedHeadItemId } : {})
    });

    if (seq !== loadEarlierSeq) return;
    if (props.sessionId !== sessionId) return;

    lastKnownHeadItemId.value = page.headItemId;

    if (page.items.length === 0) {
      reachedTop.value = true;
      return;
    }

    const existing = new Set(items.value.map((item) => item.id));
    const prepend = page.items.filter((item) => !existing.has(item.id));
    if (prepend.length === 0) {
      // 理论上不应发生;为避免滚动到顶重复触发,将其视为已到最早.
      reachedTop.value = true;
      return;
    }

    // prepend 前记录首屏锚点,用于在虚拟列表高度/测量变化时稳定视口位置。
    const anchor = captureScrollAnchor(el);

    items.value = [...prepend, ...items.value];

    // 索引锚点补偿(不依赖 DOM): prepend 后同一条消息的 index 会整体后移 prepend.length。
    // 我们用 virtualizer 的 offset 计算来做滚动补偿,避免 scrollToIndex 的多次重试与可见滚动。
    // 这一步只依赖 measurementsCache(estimate + 已缓存的真实测量),比 scrollHeight 差值更稳。
    await nextTick();
    if (anchor) {
      const list = displayItems.value;
      const prevIndex = list.findIndex((item) => item.id === anchor.msgId);
      if (prevIndex >= 0) {
        const nextIndex = prevIndex + prepend.length;
        const before = rowVirtualizer.value.getOffsetForIndex(prevIndex, "start")?.[0] ?? 0;
        const after = rowVirtualizer.value.getOffsetForIndex(nextIndex, "start")?.[0] ?? 0;
        const delta = after - before;
        if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
          el.scrollTop = Math.max(0, el.scrollTop + delta);
        }
      }
    }

    syncBoundaryMarkerCursor(prepend);
    // 若后端明确告知已无更多历史,避免再触发一次无效请求.
    if (page.hasMoreBefore === false) {
      reachedTop.value = true;
    }

    await nextTick();
    rowVirtualizer.value.measure();
    await nextTick();

    // 二次校正(可选): 若锚点刚好在渲染窗口内,用像素级 DOM offset 做最后的微调。
    // 不再使用 scrollToIndex,避免其多次重试带来的可见滚动。
    if (anchor) restoreScrollAnchor(el, anchor);

    // 同步滚动基线,避免后续 scroll 事件把程序滚动误判为用户滚动。
    lastKnownScrollTop = el.scrollTop;
    atTop.value = el.scrollTop <= TOP_LOAD_THRESHOLD_PX;
  } catch (err) {
    if (err instanceof ApiError && err.code === "AGENT_CONTEXT_ITEMS_HEAD_MOVED") {
      // head 回退时,继续沿旧 beforeId 翻页会混入不再可见的分支;给出提示即可。
      message.info(err.message || "session head moved");
      // 重新拉取 tail window,让 UI 回到当前 head 对应的时间线。
      await refreshAll(true);
      return;
    }
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    if (seq === loadEarlierSeq) {
      loadingEarlier.value = false;
    }
  }
}

function onMessageListScroll() {
  const el = scrollEl.value;
  if (!el) return;
  const nextTop = el.scrollTop;
  const delta = nextTop - lastKnownScrollTop;
  lastKnownScrollTop = nextTop;
  atTop.value = nextTop <= TOP_LOAD_THRESHOLD_PX;

  // 用户主动向上滚动时,即使仍在“离底部阈值”内也不应继续吸附.
  if (delta < 0) {
    stickToBottom.value = false;
    userUnfollowed.value = true;
    clearFollowBottomLock();
    void loadEarlierHistoryPage();
    return;
  }

  if (atTop.value) {
    void loadEarlierHistoryPage();
  }

  updateStickToBottomState();
}

function onMessageListWheel(event: WheelEvent) {
  // wheel 事件触发早于 scroll,用于提前取消吸底。
  // 否则在“贴底状态微微向上滚动”时,可能被 totalSize 变化触发的 scrollToBottom 抢回并产生跳动。
  if (event.deltaY < 0) {
    stickToBottom.value = false;
    userUnfollowed.value = true;
    clearFollowBottomLock();
  }
}

function clearFollowBottomLock() {
  followBottomLockSeq += 1;
  followBottomLockRemaining.value = 0;
  followBottomLockInFlight = false;
  if (followBottomLockTimer != null) {
    window.clearTimeout(followBottomLockTimer);
    followBottomLockTimer = null;
  }
}

function startFollowBottomLock(options?: { force?: boolean }) {
  const force = options?.force === true;
  if (!props.active) return;
  if (userUnfollowed.value) return;
  if (!force && !stickToBottom.value) return;
  followBottomLockSeq += 1;
  const seq = followBottomLockSeq;
  followBottomLockRemaining.value = Math.max(followBottomLockRemaining.value, FOLLOW_BOTTOM_LOCK_MAX_ATTEMPTS);
  if (followBottomLockTimer != null) {
    window.clearTimeout(followBottomLockTimer);
  }
  followBottomLockTimer = window.setTimeout(() => {
    if (seq !== followBottomLockSeq) return;
    followBottomLockRemaining.value = 0;
    followBottomLockTimer = null;
  }, FOLLOW_BOTTOM_LOCK_TIMEOUT_MS);
  void runFollowBottomLock(seq);
}

async function runFollowBottomLock(seq: number) {
  if (followBottomLockInFlight) return;
  followBottomLockInFlight = true;
  try {
    while (seq === followBottomLockSeq && followBottomLockRemaining.value > 0) {
      if (!props.active) break;
      if (!stickToBottom.value) break;
      if (userUnfollowed.value) break;
      if (distanceToBottom() <= 4) break;

      followBottomLockRemaining.value = Math.max(0, followBottomLockRemaining.value - 1);
      await scrollToBottom({ force: true });

      // 让 DOM 渲染/测量有机会推进,再判断是否仍需要补滚动。
      await nextTick();
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    }
  } finally {
    followBottomLockInFlight = false;
    if (seq === followBottomLockSeq && distanceToBottom() <= 4) {
      followBottomLockRemaining.value = 0;
    }
  }
}

async function scrollToBottom(options?: { force?: boolean }) {
  const force = options?.force === true;
  if (!force && !stickToBottom.value) return;
  if (displayItems.value.length === 0) return;

  const seq = ++scrollToBottomSeq;
  await nextTick();
  if (seq !== scrollToBottomSeq) return;

  // 最后一行是“底部 spacer”,用于给输入框留出空气.
  const index = displayItems.value.length;
  if (index < 0) return;

  rowVirtualizer.value.scrollToIndex(index, { align: "end" });
  await nextTick();
  if (seq !== scrollToBottomSeq) return;
  updateStickToBottomState();
  if (force || stickToBottom.value) {
    userUnfollowed.value = false;
  }

  // 同步滚动基线,避免后续 scroll 事件把程序滚动误判为“用户向上滚动”。
  const el = scrollEl.value;
  if (el) lastKnownScrollTop = el.scrollTop;
}

async function scrollToBottomStable(options?: { force?: boolean }) {
  await scrollToBottom(options);
  const force = options?.force === true;
  if (force) {
    // forceFollowBottom 场景下,即使高度估算导致 dist>阈值,也应继续视为“吸底模式”。
    stickToBottom.value = true;
    userUnfollowed.value = false;
  }
  if (force || (stickToBottom.value && !userUnfollowed.value)) {
    startFollowBottomLock({ force });
  }
}

async function focusInputIfNeeded() {
  if (!props.active) return;
  if (isSubtaskSession.value) return;
  await nextTick();
  inputEl.value?.focus?.();
}

function upsertItem(next: AgentContextItemRecord) {
  const idx = items.value.findIndex((item) => item.id === next.id);
  if (idx < 0) {
    items.value = [...items.value, next].sort((a, b) => a.id - b.id);
    return;
  }
  const copy = [...items.value];
  copy[idx] = next;
  items.value = copy;
}

function itemById(itemId: number) {
  return items.value.find((item) => item.id === itemId) ?? null;
}

function hasItemChanged(current: AgentContextItemRecord | null, latest: AgentContextItemRecord) {
  if (!current) return true;
  if (current.updatedAt !== latest.updatedAt) return true;
  if (current.status !== latest.status) return true;
  const currentArchiveAt = typeof current.archiveAt === "number" ? current.archiveAt : null;
  const latestArchiveAt = typeof latest.archiveAt === "number" ? latest.archiveAt : null;
  if (currentArchiveAt !== latestArchiveAt) return true;
  if (String(current.boundaryReason || "") !== String(latest.boundaryReason || "")) return true;
  return JSON.stringify(current.output) !== JSON.stringify(latest.output);
}

function isTerminalStatus(status: AgentContextItemRecord["status"]) {
  return terminalStatuses.has(status);
}

const handledBoundaryMarkerId = ref(0);

function isBoundaryMarkerItem(item: AgentContextItemRecord) {
  return item.kind === "system" && String(item.boundaryReason || "").trim().length > 0;
}

function maxBoundaryMarkerId(list: AgentContextItemRecord[]) {
  let maxId = 0;
  for (const item of list) {
    if (!isBoundaryMarkerItem(item)) continue;
    maxId = Math.max(maxId, item.id);
  }
  return maxId;
}

function syncBoundaryMarkerCursor(list: AgentContextItemRecord[]) {
  handledBoundaryMarkerId.value = Math.max(handledBoundaryMarkerId.value, maxBoundaryMarkerId(list));
}

function shouldForceFullRefreshForBoundaryMarker(list: AgentContextItemRecord[]) {
  for (const item of list) {
    if (!isBoundaryMarkerItem(item)) continue;
    if (item.id > handledBoundaryMarkerId.value) return true;
  }
  return false;
}

async function refreshAll(forceFull: boolean, forceFollowBottom = false) {
  if (!props.sessionReady) {
    runState.value = {
      sessionId: props.sessionId,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      waitingToolItemId: null,
      lastResponseTotalTokens: null,
      runNoticeText: "",
      nonTerminalItemIds: [],
      updatedAt: 0,
      appliedItemId: 0
    };
    loadEarlierSeq += 1;
    handledBoundaryMarkerId.value = 0;
    items.value = [];
    expandedTextMessageIds.value = new Set();
    clampedTextMessageIds.value = new Set();
    lastKnownHeadItemId.value = null;
    loadingEarlier.value = false;
    reachedTop.value = false;
    atTop.value = false;
    clearPoll();
    return;
  }
  if (loading.value) return;
  loading.value = true;
  try {
    const prevRunStatus = runState.value.status;
    const state = await getAgentRunState(props.sessionId);
    runState.value = state;

    if (state.status !== "idle") {
      settlePollRemaining = 0;
    } else if (prevRunStatus !== "idle") {
      // 运行结束后继续短暂补轮询,避免最终输出写入稍晚导致 UI 停在半截。
      settlePollRemaining = 2;
    }

    if (forceFull || items.value.length === 0) {
      // full reload 会替换 items,需取消可能 in-flight 的向上分页请求。
      loadEarlierSeq += 1;
      loadingEarlier.value = false;
      const full = await getAgentContextItems(props.sessionId, { tailLimit: INITIAL_TAIL_LIMIT });
      items.value = [...full.items].sort((a, b) => a.id - b.id);
      syncBoundaryMarkerCursor(items.value);
      lastKnownHeadItemId.value = full.headItemId;
      reachedTop.value = full.hasMoreBefore === false;
      await scrollToBottomStable({ force: forceFollowBottom });
    } else {
      const lastId = items.value.length > 0 ? items.value[items.value.length - 1]!.id : 0;
      const delta = await getAgentContextItems(props.sessionId, { afterId: lastId });
      lastKnownHeadItemId.value = delta.headItemId;
      const headMovedBackward = delta.headItemId == null ? lastId > 0 : delta.headItemId < lastId;
      const firstDelta = delta.items[0];
      const chainBroken = !!firstDelta && firstDelta.prevId !== lastId;
      const hasBoundaryMarker = shouldForceFullRefreshForBoundaryMarker(delta.items);
      if (headMovedBackward || chainBroken || hasBoundaryMarker) {
        loadEarlierSeq += 1;
        loadingEarlier.value = false;
        const full = await getAgentContextItems(props.sessionId, { tailLimit: INITIAL_TAIL_LIMIT });
        items.value = [...full.items].sort((a, b) => a.id - b.id);
        syncBoundaryMarkerCursor(items.value);
        lastKnownHeadItemId.value = full.headItemId;
        reachedTop.value = full.hasMoreBefore === false;
        await scrollToBottomStable({ force: forceFollowBottom });
      } else if (delta.items.length > 0) {
        for (const item of delta.items) {
          upsertItem(item);
        }
        syncBoundaryMarkerCursor(delta.items);
        await scrollToBottomStable({ force: forceFollowBottom });
      }
    }

    const nonTerminalIds = new Set<number>(runState.value.nonTerminalItemIds || []);
    if (runState.value.activeAssistantItemId) {
      nonTerminalIds.add(runState.value.activeAssistantItemId);
    }
    // 兜底: 本地若仍有非终态项,继续主动拉取,避免服务端 runState 已 idle 时状态停留在 queued。
    for (const localItem of items.value) {
      if (!isTerminalStatus(localItem.status)) {
        nonTerminalIds.add(localItem.id);
      }
    }
    let nonTerminalChanged = false;
    for (const itemId of nonTerminalIds) {
      const current = itemById(itemId);
      if (current && isTerminalStatus(current.status)) {
        continue;
      }
      const latest = await getAgentContextItem(props.sessionId, itemId);
      if (hasItemChanged(current, latest)) {
        nonTerminalChanged = true;
      }
      upsertItem(latest);
    }

    if (state.status === "idle" && settlePollRemaining > 0) {
      const tailId = items.value[items.value.length - 1]?.id;
      if (typeof tailId === "number") {
        const currentTail = itemById(tailId);
        const latestTail = await getAgentContextItem(props.sessionId, tailId);
        if (hasItemChanged(currentTail, latestTail)) {
          nonTerminalChanged = true;
        }
        upsertItem(latestTail);
      }
    }

    if (nonTerminalChanged) {
      await scrollToBottomStable({ force: forceFollowBottom });
    }

    const hasLocalNonTerminal = items.value.some((item) => !isTerminalStatus(item.status));
    if (state.status !== "idle") {
      warmupPollRemaining = 0;
      schedulePoll(POLL_RUNNING_MS);
    } else if (hasLocalNonTerminal) {
      warmupPollRemaining = 0;
      schedulePoll(POLL_LOCAL_NON_TERMINAL_MS);
    } else if (settlePollRemaining > 0) {
      warmupPollRemaining = 0;
      settlePollRemaining -= 1;
      schedulePoll(POLL_SETTLE_MS);
    } else if (warmupPollRemaining > 0) {
      // 仅在 idle 且无非终态项时启用 warmup,避免干扰正常运行轮询节奏。
      warmupPollRemaining -= 1;
      schedulePoll(POLL_IMMEDIATE_REFRESH_MS);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    schedulePoll(POLL_ERROR_RETRY_MS);
  } finally {
    loading.value = false;
  }
}

function onAgentChange(value: string) {
  const next = String(value || "").trim();
  if (!next) return;
  emit("update:modelValue", next);
}

function onCycleAgent(step: 1 | -1) {
  if (!hasAvailableAgents.value) return;
  const options = props.agentOptions;
  if (options.length === 0) return;
  const current = effectiveAgentId.value;
  let index = options.findIndex((item) => item.value === current);
  if (index < 0) index = 0;
  const nextIndex = (index + step + options.length) % options.length;
  const nextId = options[nextIndex]?.value;
  if (!nextId || nextId === current) return;
  emit("update:modelValue", nextId);
}

function goAgentProfiles() {
  void router.push("/settings/agent/profiles");
}

function onOpenSubtask(sessionId?: string) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  emit("open-subtask", id);
}

function onChooseSession() {
  emit("choose-session");
}

function onOpenParent() {
  const sessionId = String(props.parentSessionId || "").trim();
  if (!sessionId) return;
  emit("open-parent", sessionId);
}

function newClientRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

function onPickSlashCommand(name: string) {
  const cmd = slashCommandMap.get(name);
  if (!cmd) return;
  slashCommandSelection.value = cmd.name;
  draft.value = cmd.usage;
  void focusInputIfNeeded();
}

function moveSlashCommandSelection(step: 1 | -1) {
  const hint = slashCommandHint.value;
  if (!hint.visible || hint.commands.length === 0) return;
  const currentIdx = Math.max(0, hint.commands.findIndex((item) => item.name === hint.activeCommand));
  const nextIdx = (currentIdx + step + hint.commands.length) % hint.commands.length;
  slashCommandSelection.value = hint.commands[nextIdx]?.name || "";
}

function pickActiveSlashCommand() {
  const hint = slashCommandHint.value;
  if (!hint.visible || hint.commands.length === 0) return false;
  const targetName = hint.activeCommand || hint.commands[0]?.name;
  if (!targetName) return false;
  onPickSlashCommand(targetName);
  return true;
}

function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;

  if (event.key === "Escape") {
    event.preventDefault();
    void onCancelRun();
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    onCycleAgent(event.shiftKey ? -1 : 1);
    return;
  }

  if (slashCommandHint.value.visible && event.key === "ArrowDown") {
    event.preventDefault();
    moveSlashCommandSelection(1);
    return;
  }

  if (slashCommandHint.value.visible && event.key === "ArrowUp") {
    event.preventDefault();
    moveSlashCommandSelection(-1);
    return;
  }

  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    if (pickActiveSlashCommand()) {
      return;
    }
    void onSend();
  }
}

function resolveSlashCommand(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized.startsWith("/")) return null;
  const commandName = normalized.slice(1);
  const command = slashCommandMap.get(commandName);
  if (!command) return null;
  if (command.strictOnly && normalized !== command.usage) return null;
  return command;
}

async function executeSlashCommand(params: {
  command: SlashCommandDefinition;
  sessionId: string;
  workspaceId: string;
  clientRequestId: string;
  agentId: string;
}) {
  if (params.command.action === "compact") {
    await compactAgentSession(params.sessionId, {
      workspaceId: params.workspaceId,
      clientRequestId: params.clientRequestId,
      agentId: params.agentId
    });
    return;
  }
  if (params.command.action === "clear") {
    await clearAgentSession(params.sessionId, {
      workspaceId: params.workspaceId
    });
    return;
  }
  throw new Error(`unsupported slash command: ${params.command.name}`);
}

async function onCancelRun() {
  if (!props.sessionId) return;
  if (actionLoading.value === "cancel") return;
  if (runState.value.status === "idle") return;

  actionLoading.value = "cancel";
  actionTargetId.value = null;
  try {
    await cancelAgentSession(props.sessionId, {
      workspaceId: props.workspaceId
    });
    // No confirmation for cancel; keep it snappy and predictable.
    message.success(t("agent.client.cancelled"));
    await refreshAll(true);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    actionLoading.value = null;
    actionTargetId.value = null;
  }
}

async function onForkFromMessage(itemId: number) {
  actionLoading.value = "fork";
  actionTargetId.value = itemId;
  try {
    const session = await forkAgentSession({
      fromSessionId: props.sessionId,
      fromItemId: itemId,
      mode: "with_archive"
    });
    message.success(t("agent.client.forked"));
    emit("forked", session.id);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    actionLoading.value = null;
    actionTargetId.value = null;
  }
}

function onRevertToMessage(itemId: number) {
  const target = itemById(itemId);
  if (!target) {
    message.warning(t("agent.client.revertTargetMissing"));
    return;
  }

  let toItemId: number | null = null;
  let revertDraft = "";
  let isUserTarget = false;

  if (target.kind === "user" && target.output.type === "user_text") {
    isUserTarget = true;
    toItemId = target.prevId;
    revertDraft = target.output.text;
  } else if (target.kind === "assistant" && target.output.type === "assistant_text") {
    toItemId = target.id;
  }

  if (toItemId == null) {
    message.warning(t("agent.client.revertTargetMissing"));
    return;
  }

  Modal.confirm({
    title: isUserTarget ? t("agent.client.revertConfirmTitle") : t("agent.client.revertConfirmTitleAssistant"),
    content: isUserTarget ? t("agent.client.revertConfirmContent") : t("agent.client.revertConfirmContentAssistant"),
    okText: t("agent.client.revert"),
    cancelText: t("common.cancel"),
    async onOk() {
      actionLoading.value = "revert";
      actionTargetId.value = itemId;
      try {
        await revertAgentSession(props.sessionId, {
          workspaceId: props.workspaceId,
          toItemId,
          reason: "manual_revert"
        });
        if (isUserTarget && revertDraft.trim()) {
          draft.value = revertDraft;
        }
        message.success(t("agent.client.reverted"));
        await refreshAll(true);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        actionLoading.value = null;
        actionTargetId.value = null;
      }
    }
  });
}

async function onToolPermission(itemId: number, decision: "approve" | "deny") {
  actionLoading.value = decision;
  actionTargetId.value = itemId;
  try {
    await decideAgentToolPermission(props.sessionId, {
      workspaceId: props.workspaceId,
      toolItemId: itemId,
      decision
    });
    await refreshAll(false);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    actionLoading.value = null;
    actionTargetId.value = null;
  }
}

async function onSend() {
  if (isSubtaskSession.value) return;
  if (!hasAvailableAgents.value) {
    message.warning(t("agent.client.noAgentHint"));
    return;
  }
  const text = draft.value.trim();
  if (!text || sending.value) return;
  const agentId = effectiveAgentId.value;
  if (!agentId) {
    message.warning(t("agent.client.noAgentHint"));
    return;
  }
  sending.value = true;
  try {
    const targetSessionId = props.sessionReady
      ? props.sessionId
      : props.ensureSession
        ? await props.ensureSession(props.sessionId)
        : "";
    if (!targetSessionId) {
      throw new Error("failed to create agent session");
    }

    const clientRequestId = newClientRequestId();
    const slashCommand = resolveSlashCommand(text);
    if (slashCommand) {
      await executeSlashCommand({
        command: slashCommand,
        sessionId: targetSessionId,
        workspaceId: props.workspaceId,
        clientRequestId,
        agentId
      });
    } else {
      await sendAgentMessage(targetSessionId, {
        workspaceId: props.workspaceId,
        text,
        clientRequestId,
        agentId
      });
    }
    draft.value = "";
    if (targetSessionId === props.sessionId) {
      await refreshAll(false);
      schedulePoll(POLL_IMMEDIATE_REFRESH_MS);
    } else {
      emit("request-poll-session", targetSessionId);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    sending.value = false;
  }
}

watch(
  () => [props.pollHint ?? 0, props.sessionId, props.active] as const,
  (next, prev) => {
    const [hint, sessionId, active] = next;
    const prevHint = prev?.[0] ?? 0;
    const prevSessionId = prev?.[1];
    if (!sessionId) return;
    const hintChanged = hint !== prevHint;
    // 兼容跨组件时序: 当目标 pane 挂载时 hint 可能已经>0,需要立即触发一次补轮询。
    const mountedWithPendingHint = sessionId !== prevSessionId && hint > 0;
    if (hintChanged || mountedWithPendingHint) {
      if (!active) {
        pendingPollHint.value = true;
        return;
      }
      pendingPollHint.value = false;
      kickPollAfterRefresh({ forceFull: false, forceFollowBottom: false });
    }
  },
  { immediate: true }
);

watch(
  () => [String(props.modelValue || ""), props.agentOptions.map((item) => `${item.value}:${item.isDefault ? "1" : "0"}`).join("|")],
  () => {
    if (!hasAvailableAgents.value) {
      if (props.modelValue) {
        emit("update:modelValue", null);
      }
      return;
    }
    const current = String(props.modelValue || "").trim();
    const next = effectiveAgentId.value;
    if (next && next !== current) {
      emit("update:modelValue", next);
    }
  },
  { immediate: true }
);

watch(
  () => [props.sessionId, props.workspaceId],
  () => {
    clearPoll();
    clearFollowBottomLock();
    loadEarlierSeq += 1;
    handledBoundaryMarkerId.value = 0;
    scrollToBottomSeq += 1;
    pendingPollHint.value = false;
    warmupPollRemaining = 0;
    items.value = [];
    expandedTextMessageIds.value = new Set();
    clampedTextMessageIds.value = new Set();
    lastKnownHeadItemId.value = null;
    loadingEarlier.value = false;
    reachedTop.value = false;
    atTop.value = false;
    stickToBottom.value = true;
    userUnfollowed.value = false;
    forcedBottomOnFirstActive.value = false;
    runState.value = {
      sessionId: props.sessionId,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      waitingToolItemId: null,
      lastResponseTotalTokens: null,
      runNoticeText: "",
      nonTerminalItemIds: [],
      updatedAt: 0,
      appliedItemId: 0
    };
    rowVirtualizer.value.measure();
    // 重置滚动方向判断基线,避免切换会话后首次 scroll 误判为“用户向上滚动”。
    lastKnownScrollTop = 0;
    if (props.sessionId && props.active) {
      forcedBottomOnFirstActive.value = true;
      void refreshAll(true, true);
      void focusInputIfNeeded();
    }
  },
  { immediate: true }
);

watch(
  () => props.active,
  (active) => {
    if (!active) {
      clearPoll();
      clearFollowBottomLock();
      pendingPollHint.value = false;
      warmupPollRemaining = 0;
      return;
    }

    const forceFollowBottom = !forcedBottomOnFirstActive.value;
    if (forceFollowBottom) {
      forcedBottomOnFirstActive.value = true;
      stickToBottom.value = true;
      userUnfollowed.value = false;
    }

    rowVirtualizer.value.measure();
    const forceFull = items.value.length === 0;
    if (pendingPollHint.value) {
      pendingPollHint.value = false;
      kickPollAfterRefresh({ forceFull, forceFollowBottom });
    } else {
      void refreshAll(forceFull, forceFollowBottom);
    }
    void focusInputIfNeeded();
  }
);

// Workspace 内切换工具时,AgentToolView 被 KeepAlive 缓存,组件不会重新挂载。
// activated 时主动 refresh,避免回到 Agent 后列表为空且不触发拉取。
onActivated(() => {
  if (!props.active) return;
  if (!props.sessionId) return;
  if (!props.sessionReady) return;
  // KeepAlive 恢复时先重新测量虚拟列表尺寸,再刷新一次状态.
  void nextTick().then(() => {
    rowVirtualizer.value.measure();
    void refreshAll(false, true);
  });
});

watch(
  () => virtualTotalSize.value,
  (next, prev) => {
    if (!props.active) return;
    if (displayItems.value.length === 0) return;
    if (typeof prev === "number" && next === prev) return;

    // 吸底稳定锁生效期间,忽略距离门禁,持续补滚动直到高度稳定。
    if (followBottomLockRemaining.value > 0) {
      void runFollowBottomLock(followBottomLockSeq);
      return;
    }

    if (!stickToBottom.value) return;
    if (userUnfollowed.value) return;
    if (distanceToBottom() > 4) return;
    void scrollToBottom();
  }
);

onBeforeUnmount(() => {
  clearPoll();
  clearFollowBottomLock();
  scrollToBottomSeq += 1;
});
</script>

<style scoped>
.agent-message-list {
  display: flex;
  flex-direction: column;
  /*
   * 虚拟列表会频繁修正行高并导致 scrollHeight 变化.
   * 浏览器 scroll anchoring 在这种场景下可能产生“固定位置的大跳动”.
   */
  overflow-anchor: none;
}

/*
 * Agent 字号策略:
 * - user/assistant: 使用消息列表容器 font-size (var(--agent-font-size))
 * - tool/system: 略小一档
 */
.agent-message-item.is-tool-message,
.agent-message-item.is-system-message {
  font-size: 0.85em;
}

.agent-virtual-list {
  position: relative;
  width: 100%;
}

.agent-virtual-row {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
}

.agent-virtual-row-inner {
  width: 100%;
  box-sizing: border-box;
  overflow-anchor: none;
}

@media (hover: hover) and (pointer: fine) {
  .agent-message-item.is-text-clamped:hover {
    border-color: rgba(148, 163, 184, 0.55);
    background: rgba(148, 163, 184, 0.06);
  }
}

.message-controls {
  color: var(--text-secondary);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.message-id {
  font-size: 0.92em;
  line-height: 1;
  color: inherit;
}

.agent-message-item:hover .message-controls {
  opacity: 1;
  pointer-events: auto;
}

.subtask-card.is-clickable {
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .subtask-card.is-clickable:hover {
    box-shadow: inset 0 0 0 999px rgba(255, 255, 255, 0.04);
  }
}

.subtask-card.is-disabled {
  opacity: 0.8;
}

.subtask-title-icon {
  display: inline-block;
  font-size: 1.05em;
}

.slash-command-item {
  appearance: none;
  background: transparent;
  color: inherit;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.slash-command-item.is-active {
  border-color: rgba(59, 130, 246, 0.4);
  background: rgba(59, 130, 246, 0.12);
}

@media (hover: hover) and (pointer: fine) {
  .slash-command-item:hover {
    border-color: rgba(59, 130, 246, 0.28);
    background: rgba(59, 130, 246, 0.08);
  }
}

:deep(.agent-input-textarea) {
  border-radius: 4px;
}
</style>
