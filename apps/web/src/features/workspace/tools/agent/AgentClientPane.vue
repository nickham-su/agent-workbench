<template>
  <div class="h-full min-h-0 flex flex-col">
    <div
      v-if="isSubtaskSession"
      class="px-3 py-2 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] text-xs text-[color:var(--text-tertiary)]"
    >
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

    <div ref="scrollEl" class="agent-message-list flex-1 min-h-0 overflow-auto p-3 bg-[var(--panel-bg)]">
      <div v-if="displayItems.length === 0" class="h-full flex flex-col items-center justify-center gap-3 text-base text-[color:var(--text-tertiary)]">
        <div>{{ t("agent.client.welcome") }}</div>
        <a-button v-if="props.canChooseSession" type="link" size="small" class="!px-0" @click="onChooseSession">
          {{ t("agent.client.chooseSession") }}
        </a-button>
      </div>
      <div
        v-for="msg in displayItems"
        :key="msg.id"
        class="agent-message-item relative rounded p-2"
        :class="[
          msg.role === 'tool'
            ? isRichToolCard(msg)
              ? 'is-tool-message border-0 bg-transparent px-0 py-0.5'
              : 'is-tool-message border-0 bg-transparent pl-2 pr-0 py-0.5'
            : '',
          msg.role === 'user' ? 'is-user-message border border-blue-500/30 bg-blue-500/10' : 'border-0',
          msg.role === 'assistant' ? 'is-assistant-message bg-[var(--panel-bg)]' : '',
          msg.role === 'system' ? 'bg-[var(--panel-bg)]' : '',
          msg.role === 'user' && msg.tone === 'error' ? 'border-red-500/40 bg-red-500/5' : '',
          msg.role !== 'user' && msg.role !== 'tool' && msg.tone === 'error' ? 'bg-red-500/5' : ''
        ]"
      >
        <div v-if="msg.role !== 'tool' && !isSubtaskSession" class="message-controls absolute right-2 top-1.5 z-10 flex items-center gap-1">
          <span class="message-id">#{{ msg.id }}</span>
          <template v-if="msg.role === 'user' || msg.role === 'assistant'">
            <a-tooltip :title="t('agent.client.fork')" placement="top">
              <a-button
                size="small"
                type="text"
                :loading="actionLoading === 'fork' && actionTargetId === msg.id"
                :aria-label="t('agent.client.fork')"
                @click="onForkFromMessage(msg.id)"
              >
                <template #icon><ForkOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip :title="t('agent.client.revert')" placement="top">
              <a-button
                size="small"
                type="text"
                :disabled="msg.role === 'user' ? msg.prevId == null : false"
                :loading="actionLoading === 'revert' && actionTargetId === msg.id"
                :aria-label="t('agent.client.revert')"
                @click="onRevertToMessage(msg.id)"
              >
                <template #icon><RollbackOutlined /></template>
              </a-button>
            </a-tooltip>
          </template>
        </div>
        <div v-if="msg.role === 'system'" class="text-[11px] text-[color:var(--text-tertiary)] pb-1 pr-24">
          {{ roleLabel(msg.role) }}
        </div>
        <div
          v-if="isSubtaskCard(msg)"
          class="subtask-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2"
          :class="[
            msg.subtaskSessionId ? 'is-clickable' : 'is-disabled',
            msg.tone === 'error' ? 'border-red-500/40 bg-red-500/5' : ''
          ]"
          @click="onOpenSubtask(msg.subtaskSessionId)"
        >
          <div class="flex items-center gap-2">
            <div class="text-[12px] font-semibold">
              <DoubleRightOutlined class="subtask-title-icon mr-0.5 text-blue-500" />
              {{ t("agent.client.subtaskCardTitle") }}: {{ msg.subtaskDescription || "-" }}
            </div>
            <a-tag color="default" class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0">{{ msg.status }}</a-tag>
          </div>
          <div class="pt-0.5 text-[12px] text-[color:var(--text-secondary)]">
            {{ t("agent.client.subtaskAgent") }}: {{ msg.subtaskAgentName || msg.subtaskAgentId || "-" }}
            <span class="inline-block w-3" />
            {{ t("agent.client.subtaskMode") }}: {{ formatSubtaskMode(msg.subtaskMode) }}
          </div>
          <div class="pt-0.5 text-[12px] text-[color:var(--text-secondary)]">
            {{ t("agent.client.subtaskSessionId") }}: {{ msg.subtaskSessionId || "-" }}
          </div>
          <div v-if="msg.toolError" class="pt-1 text-[12px] text-red-500">
            Error: {{ msg.toolError }}
          </div>
        </div>
        <AgentApplyPatchCard
          v-else-if="isApplyPatchCard(msg) && msg.applyPatch"
          :status="msg.status"
          :text="msg.applyPatch.text"
          :error-text="msg.toolError"
          :summary="msg.applyPatch.summary"
          :files="msg.applyPatch.files"
          :omitted-files="msg.applyPatch.omittedFiles"
        />
        <div
          v-else
          class="whitespace-pre-wrap break-words"
          :class="[
            msg.role === 'tool' ? 'text-[11px] font-mono text-[color:var(--text-secondary)]' : 'text-[13px]',
            msg.role !== 'tool' ? 'pr-24' : '',
            msg.tone === 'error' ? 'text-red-500' : ''
          ]"
        >
          {{ msg.text }}
        </div>
        <div v-if="msg.role === 'tool' && msg.status === 'awaiting_permission'" class="pt-2 flex items-center gap-1">
          <a-button
            size="small"
            :loading="actionLoading === 'approve' && actionTargetId === msg.id"
            @click="onToolPermission(msg.id, 'approve')"
          >
            {{ t("agent.client.approve") }}
          </a-button>
          <a-button
            size="small"
            danger
            :loading="actionLoading === 'deny' && actionTargetId === msg.id"
            @click="onToolPermission(msg.id, 'deny')"
          >
            {{ t("agent.client.deny") }}
          </a-button>
        </div>
      </div>
    </div>

    <div v-if="!isSubtaskSession" class="p-3 border-t border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <div class="flex items-end gap-2">
        <a-textarea
          ref="inputEl"
          v-model:value="draft"
          class="agent-input-textarea"
          :disabled="!hasAvailableAgents"
          :auto-size="{ minRows: 2, maxRows: 6 }"
          :placeholder="hasAvailableAgents ? t('agent.client.inputPlaceholder') : t('agent.client.inputPlaceholderNoAgent')"
          @keydown.enter.exact.prevent="onSend"
          @keydown.tab.prevent="onCycleAgent(1)"
          @keydown.shift.tab.prevent="onCycleAgent(-1)"
        />
        <a-tooltip v-if="runState.status !== 'idle'" :title="t('agent.client.cancel')" placement="top">
          <a-button
            class="cancel-icon-btn"
            :loading="actionLoading === 'cancel'"
            @click="onCancelRun"
          >
            <template #icon><CloseOutlined /></template>
          </a-button>
        </a-tooltip>
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
          <div v-else class="flex items-center gap-2 text-xs text-[color:var(--text-tertiary)]">
            <span>{{ t("agent.client.noAgentHint") }}</span>
            <a-button type="link" size="small" class="!px-0" @click="goAgentProfiles">
              {{ t("agent.client.goCreateAgent") }}
            </a-button>
          </div>
          <div class="text-xs text-[color:var(--text-tertiary)] whitespace-nowrap">
            {{ t("agent.client.lastTotalTokens") }}: {{ formattedLastTotalTokens }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AgentContextItemRecord, AgentSessionRunState } from "@agent-workbench/shared";
import { CloseOutlined, DoubleRightOutlined, ForkOutlined, RollbackOutlined } from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import AgentApplyPatchCard from "./AgentApplyPatchCard.vue";
import {
  cancelAgentSession,
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
  before: string;
  after: string;
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

type DisplayItem = {
  id: number;
  prevId: number | null;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  status: AgentContextItemRecord["status"];
  toolName?: string;
  toolError?: string;
  subtaskSessionId?: string;
  subtaskDescription?: string;
  subtaskMode?: "new" | "existing" | "fork" | string;
  subtaskAgentId?: string;
  subtaskAgentName?: string;
  applyPatch?: ApplyPatchDisplay;
  tone?: "normal" | "error";
};

const props = defineProps<{
  workspaceId: string;
  sessionId: string;
  sessionKind: "primary" | "subtask";
  parentSessionId?: string | null;
  sessionReady: boolean;
  ensureSession?: (sessionId: string) => Promise<string>;
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
}>();

const { t } = useI18n();
const router = useRouter();

const loading = ref(false);
const sending = ref(false);
const draft = ref("");
const runState = ref<AgentSessionRunState>({
  sessionId: props.sessionId,
  status: "idle",
  activeRunId: null,
  activeAssistantItemId: null,
  waitingToolItemId: null,
  lastResponseTotalTokens: null,
  nonTerminalItemIds: [],
  updatedAt: 0,
  appliedItemId: 0
});
const items = ref<AgentContextItemRecord[]>([]);
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<{ focus?: () => void } | null>(null);

const actionLoading = ref<"cancel" | "fork" | "revert" | "approve" | "deny" | null>(null);
const actionTargetId = ref<number | null>(null);

let pollTimer: number | null = null;
let settlePollRemaining = 0;
const terminalStatuses = new Set<AgentContextItemRecord["status"]>(["completed", "failed", "denied", "cancelled"]);
const isSubtaskSession = computed(() => props.sessionKind === "subtask");

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
      before: typeof file.before === "string" ? file.before : "",
      after: typeof file.after === "string" ? file.after : "",
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

const displayItems = computed<DisplayItem[]>(() => {
  const hiddenAssistantIds = new Set<number>();
  for (const item of items.value) {
    if (item.kind !== "assistant" || item.output.type !== "assistant_text") continue;
    if (item.output.text.trim().length > 0) continue;
    const hasToolChild = items.value.some((next) => next.kind === "tool" && next.prevId === item.id);
    if (hasToolChild) {
      hiddenAssistantIds.add(item.id);
    }
  }

  const mapped = items.value.map<DisplayItem>((item) => {
    if (item.kind === "user" && item.output.type === "user_text") {
      return { id: item.id, prevId: item.prevId, role: "user", text: item.output.text, status: item.status };
    }
    if (item.kind === "assistant" && item.output.type === "assistant_text") {
      return {
        id: item.id,
        prevId: item.prevId,
        role: "assistant",
        text: item.output.text,
        status: item.status,
        tone: item.status === "failed" ? "error" : "normal"
      };
    }
    if (item.kind === "tool" && item.output.type === "tool") {
      const argsText = formatToolArgs(item.output.args);
      const callText = `${item.output.toolName}(${argsText})`;
      const statusText = `[${item.status}]`;
      const resultObj = toRecord(item.output.result);
      const subtaskSessionId =
        typeof resultObj?.subtaskSessionId === "string" && resultObj.subtaskSessionId.trim()
          ? resultObj.subtaskSessionId.trim()
          : undefined;
      const errorText = item.output.error ? truncateText(item.output.error, 220) : undefined;
      if (item.output.toolName === "apply_patch") {
        const applyPatch = parseApplyPatchDisplay(item.output.result);
        if (!applyPatch) {
          let line = `${callText} ${statusText}`;
          if (errorText) {
            line += `\nerror: ${errorText}`;
          }
          return {
            id: item.id,
            prevId: item.prevId,
            role: "tool",
            text: line,
            status: item.status,
            toolName: item.output.toolName,
            tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
          };
        }
        return {
          id: item.id,
          prevId: item.prevId,
          role: "tool",
          text: `${callText} ${statusText}`,
          status: item.status,
          toolName: item.output.toolName,
          ...(errorText ? { toolError: errorText } : {}),
          ...(applyPatch ? { applyPatch } : {}),
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
          role: "tool",
          text: `${callText} ${statusText}`,
          status: item.status,
          toolName: item.output.toolName,
          ...(subtaskSessionId ? { subtaskSessionId } : {}),
          ...(errorText ? { toolError: errorText } : {}),
          ...(description ? { subtaskDescription: description } : {}),
          ...(mode ? { subtaskMode: mode } : {}),
          ...(agentId ? { subtaskAgentId: agentId } : {}),
          ...(agentName ? { subtaskAgentName: agentName } : {}),
          tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
        };
      }
      let line = `${callText} ${statusText}`;
      if (errorText) {
        line += `\nerror: ${errorText}`;
      }
      return {
        id: item.id,
        prevId: item.prevId,
        role: "tool",
        text: line,
        status: item.status,
        toolName: item.output.toolName,
        ...(subtaskSessionId ? { subtaskSessionId } : {}),
        tone: item.status === "failed" || item.status === "denied" ? "error" : "normal"
      };
    }
    if (item.kind === "system" && item.output.type === "system_text") {
      return { id: item.id, prevId: item.prevId, role: "system", text: item.output.text, status: item.status };
    }
    return {
      id: item.id,
      prevId: item.prevId,
      role: "system",
      text: JSON.stringify(item.output),
      status: item.status
    };
  });
  return mapped.filter((item) => !(item.role === "assistant" && hiddenAssistantIds.has(item.id)));
});

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

function isRichToolCard(item: DisplayItem) {
  return isSubtaskCard(item) || isApplyPatchCard(item);
}

function formatSubtaskMode(mode?: string) {
  if (mode === "new") return t("agent.client.subtaskModeNew");
  if (mode === "fork") return t("agent.client.subtaskModeFork");
  if (mode === "existing") return t("agent.client.subtaskModeExisting");
  return mode || "-";
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

async function scrollToBottom() {
  await nextTick();
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
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
  return JSON.stringify(current.output) !== JSON.stringify(latest.output);
}

function isTerminalStatus(status: AgentContextItemRecord["status"]) {
  return terminalStatuses.has(status);
}

async function refreshAll(forceFull: boolean) {
  if (!props.sessionReady) {
    runState.value = {
      sessionId: props.sessionId,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      waitingToolItemId: null,
      lastResponseTotalTokens: null,
      nonTerminalItemIds: [],
      updatedAt: 0,
      appliedItemId: 0
    };
    items.value = [];
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
      const full = await getAgentContextItems(props.sessionId);
      items.value = [...full.items].sort((a, b) => a.id - b.id);
      await scrollToBottom();
    } else {
      const lastId = items.value.length > 0 ? items.value[items.value.length - 1]!.id : 0;
      const delta = await getAgentContextItems(props.sessionId, lastId);
      const headMovedBackward = delta.headItemId == null ? lastId > 0 : delta.headItemId < lastId;
      const firstDelta = delta.items[0];
      const chainBroken = !!firstDelta && firstDelta.prevId !== lastId;
      if (headMovedBackward || chainBroken) {
        const full = await getAgentContextItems(props.sessionId);
        items.value = [...full.items].sort((a, b) => a.id - b.id);
        await scrollToBottom();
      } else if (delta.items.length > 0) {
        for (const item of delta.items) {
          upsertItem(item);
        }
        await scrollToBottom();
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
      await scrollToBottom();
    }

    const hasLocalNonTerminal = items.value.some((item) => !isTerminalStatus(item.status));
    if (state.status !== "idle") {
      schedulePoll(600);
    } else if (hasLocalNonTerminal) {
      schedulePoll(400);
    } else if (settlePollRemaining > 0) {
      settlePollRemaining -= 1;
      schedulePoll(300);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    schedulePoll(1200);
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
  void router.push("/settings/agentProfiles");
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

async function onCancelRun() {
  Modal.confirm({
    title: t("agent.client.cancelConfirmTitle"),
    content: t("agent.client.cancelConfirmContent"),
    okText: t("agent.client.cancel"),
    cancelText: t("common.cancel"),
    okButtonProps: { danger: true },
    async onOk() {
      actionLoading.value = "cancel";
      actionTargetId.value = null;
      try {
        await cancelAgentSession(props.sessionId, {
          workspaceId: props.workspaceId
        });
        message.success(t("agent.client.cancelled"));
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

async function onForkFromMessage(itemId: number) {
  actionLoading.value = "fork";
  actionTargetId.value = itemId;
  try {
    const session = await forkAgentSession({
      fromSessionId: props.sessionId,
      fromItemId: itemId
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

    await sendAgentMessage(targetSessionId, {
      workspaceId: props.workspaceId,
      text,
      clientRequestId: newClientRequestId(),
      agentId
    });
    draft.value = "";
    if (targetSessionId === props.sessionId) {
      await refreshAll(false);
      schedulePoll(300);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    sending.value = false;
  }
}

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
    items.value = [];
    runState.value = {
      sessionId: props.sessionId,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      waitingToolItemId: null,
      lastResponseTotalTokens: null,
      nonTerminalItemIds: [],
      updatedAt: 0,
      appliedItemId: 0
    };
    if (props.sessionId) {
      void refreshAll(true);
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
      return;
    }
    void refreshAll(false);
    void focusInputIfNeeded();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  clearPoll();
});
</script>

<style scoped>
.agent-message-list {
  display: flex;
  flex-direction: column;
}

.agent-message-item + .agent-message-item {
  margin-top: 12px;
}

.agent-message-item + .agent-message-item.is-tool-message {
  margin-top: 6px;
}

.agent-message-item.is-tool-message + .agent-message-item {
  margin-top: 8px;
}

.agent-message-item.is-tool-message + .agent-message-item.is-tool-message {
  margin-top: 2px;
}

.agent-message-item.is-assistant-message {
  transition: box-shadow 0.15s ease;
}

@media (hover: hover) and (pointer: fine) {
  .agent-message-item.is-assistant-message:hover {
    box-shadow: inset 0 0 0 999px rgba(255, 255, 255, 0.04);
  }
}

.message-controls {
  color: var(--text-secondary);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.message-id {
  font-size: 12px;
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
  font-size: 14px;
}

.cancel-icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-color: rgba(239, 68, 68, 0.35);
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

@media (hover: hover) and (pointer: fine) {
  .cancel-icon-btn:hover {
    border-color: rgba(239, 68, 68, 0.55);
    color: #ef4444;
    background: rgba(239, 68, 68, 0.14);
  }
}

:deep(.agent-input-textarea) {
  border-radius: 4px;
}
</style>
