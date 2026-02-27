<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="px-3 py-2 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xs text-[color:var(--text-tertiary)]">{{ t("agent.client.agentLabel") }}</span>
          <a-select
            :value="effectiveAgentId"
            :options="agentOptionsWithDefault"
            size="small"
            style="min-width: 180px; max-width: 320px"
            @update:value="onAgentChange"
          />
          <a-tag v-if="runState.status !== 'idle'" color="processing">{{ t("agent.client.running") }}</a-tag>
        </div>
        <a-button
          v-if="runState.status !== 'idle'"
          size="small"
          danger
          :loading="isActionLoading('cancel')"
          :disabled="!cancelAnchorEventId || isActionBusy"
          @click="onCancelRun"
        >
          {{ t("agent.client.cancel") }}
        </a-button>
      </div>
    </div>

    <div ref="scrollEl" class="flex-1 min-h-0 overflow-auto p-3 space-y-3 bg-[var(--panel-bg)]">
      <div v-if="messages.length === 0" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("agent.client.empty") }}
      </div>
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="rounded border border-[var(--border-color-secondary)] p-2"
        :class="[
          msg.role === 'user' ? 'bg-[var(--panel-bg-elevated)]' : 'bg-[var(--panel-bg)]',
          msg.tone === 'error' ? 'border-red-500/40 bg-red-500/5' : ''
        ]"
      >
        <div class="text-[11px] text-[color:var(--text-tertiary)] pb-1">{{ roleLabel(msg.role) }}</div>
        <div class="text-xs whitespace-pre-wrap break-words" :class="msg.tone === 'error' ? 'text-red-500' : ''">{{ msg.text }}</div>
        <div v-if="msg.role === 'user'" class="pt-2 flex items-center gap-1">
          <a-button
            size="small"
            type="text"
            :loading="isActionLoading('fork', msg.id)"
            :disabled="isActionBusy"
            @click="onForkFromMessage(msg.id)"
          >
            {{ t("agent.client.fork") }}
          </a-button>
          <a-button
            size="small"
            type="text"
            danger
            :loading="isActionLoading('revert', msg.id)"
            :disabled="isActionBusy"
            @click="onRevertToMessage(msg.id)"
          >
            {{ t("agent.client.revert") }}
          </a-button>
        </div>
      </div>
      <div v-if="runState.status !== 'idle'" class="text-xs text-[color:var(--text-tertiary)]">
        {{ t("agent.client.streamingHint") }}
      </div>
    </div>

    <div class="p-3 border-t border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <a-textarea
        v-model:value="draft"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        :placeholder="t('agent.client.inputPlaceholder')"
        @keydown.enter.exact.prevent="onSend"
      />
      <div class="pt-2 flex items-center justify-between">
        <div class="text-[11px] text-[color:var(--text-tertiary)]">{{ t("agent.client.sendHint") }}</div>
        <div class="flex items-center gap-2">
          <a-button size="small" type="text" :loading="loading" @click="refreshAll">{{ t("agent.client.refresh") }}</a-button>
          <a-button size="small" type="primary" :loading="sending" :disabled="!canSend" @click="onSend">{{ t("agent.client.send") }}</a-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AgentSessionRunState } from "@agent-workbench/shared";
import { Modal, message } from "ant-design-vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  cancelAgentSession,
  forkAgentSession,
  getAgentConversation,
  getAgentRunState,
  revertAgentSession,
  sendAgentMessage
} from "@/shared/api";

type AgentOption = {
  value: string;
  label: string;
};

type MessageItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tone?: "normal" | "error";
};

type TimelineEvent = {
  id: string;
  type: string;
  prevId: string | null;
  payload: Record<string, any>;
};

type ControlAction = "cancel" | "fork" | "revert";

const props = defineProps<{
  workspaceId: string;
  sessionId: string;
  active: boolean;
  modelValue?: string | null;
  agentOptions: AgentOption[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
  forked: [sessionId: string];
}>();

const { t } = useI18n();

const loading = ref(false);
const sending = ref(false);
const draft = ref("");
const messages = ref<MessageItem[]>([]);
const rawEvents = ref<TimelineEvent[]>([]);
const runState = ref<AgentSessionRunState>({
  sessionId: props.sessionId,
  status: "idle",
  activeRunId: null,
  updatedAt: 0,
  appliedEventId: 0
});
const scrollEl = ref<HTMLElement | null>(null);
const actionLoading = ref<ControlAction | null>(null);
const actionTargetEventId = ref<string | null>(null);

let pollTimer: number | null = null;

const effectiveAgentId = computed(() => {
  const raw = String(props.modelValue || "").trim();
  return raw || "__default__";
});

const agentOptionsWithDefault = computed(() => {
  return [
    { value: "__default__", label: t("agent.client.defaultAgent") },
    ...props.agentOptions
  ];
});

const canSend = computed(() => {
  if (sending.value) return false;
  if (!props.workspaceId || !props.sessionId) return false;
  return draft.value.trim().length > 0;
});

const cancelAnchorEventId = computed(() => findCancelAnchorEventId(rawEvents.value, runState.value.activeRunId));
const isActionBusy = computed(() => actionLoading.value !== null);

function roleLabel(role: MessageItem["role"]) {
  if (role === "user") return t("agent.client.roles.user");
  if (role === "assistant") return t("agent.client.roles.assistant");
  return t("agent.client.roles.system");
}

function parseMessages(events: TimelineEvent[]) {
  const out: MessageItem[] = [];
  for (const event of events) {
    if (event.type === "user.message.created") {
      const preview = String(event.payload?.text?.preview || "");
      if (!preview) continue;
      out.push({ id: event.id, role: "user", text: preview });
      continue;
    }
    if (event.type === "model.turn.committed") {
      const assistantText = String(event.payload?.assistantText || "");
      if (!assistantText) continue;
      out.push({ id: event.id, role: "assistant", text: assistantText });
      continue;
    }
    if (event.type === "tool.requested") {
      const summary = String(event.payload?.summary || event.payload?.toolName || "");
      if (!summary) continue;
      out.push({ id: event.id, role: "system", text: `[tool] ${summary}` });
      continue;
    }
    if (event.type === "tool.failed") {
      const err = String(event.payload?.error || "tool failed");
      out.push({ id: event.id, role: "system", text: `[tool] ${err}`, tone: "error" });
      continue;
    }
    if (event.type === "run.failed") {
      const err = String(event.payload?.error || "run failed");
      out.push({ id: event.id, role: "system", text: `[run] ${err}`, tone: "error" });
      continue;
    }
    if (event.type === "run.cancelled") {
      const reason = String(event.payload?.reason || "cancelled");
      out.push({ id: event.id, role: "system", text: `[run] cancelled: ${reason}` });
      continue;
    }
    if (event.type === "model.turn.failed") {
      const err = String(event.payload?.error || "model turn failed");
      out.push({ id: event.id, role: "system", text: `[model] ${err}`, tone: "error" });
    }
  }
  return out;
}

function findCancelAnchorEventId(events: TimelineEvent[], activeRunId: string | null) {
  if (!activeRunId) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== "run.created") continue;
    if (String(event.payload?.runId || "") !== activeRunId) continue;
    if (typeof event.prevId === "string" && event.prevId) {
      return event.prevId;
    }
    break;
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "user.message.created") return event.id;
  }
  return null;
}

function isActionLoading(action: ControlAction, targetEventId?: string) {
  if (actionLoading.value !== action) return false;
  if (!targetEventId) return true;
  return actionTargetEventId.value === targetEventId;
}

function userMessageDraftFromEventId(eventId: string) {
  const ev = rawEvents.value.find((e) => e.id === eventId);
  if (!ev || ev.type !== "user.message.created") return { text: "", toEventId: null as string | null };
  const text = String(ev.payload?.text?.preview || "");
  const toEventId = typeof ev.prevId === "string" && ev.prevId ? ev.prevId : null;
  return { text, toEventId };
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
    void refreshAll();
  }, delayMs);
}

async function scrollToBottom() {
  await nextTick();
  const el = scrollEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

async function refreshAll() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [conversation, state] = await Promise.all([getAgentConversation(props.sessionId), getAgentRunState(props.sessionId)]);
    const events = conversation.events as TimelineEvent[];
    const mapped = parseMessages(events);
    const changed = mapped.length !== messages.value.length || mapped.at(-1)?.id !== messages.value.at(-1)?.id;
    rawEvents.value = events;
    messages.value = mapped;
    runState.value = state;
    if (changed) {
      await scrollToBottom();
    }
    if (state.status !== "idle") {
      schedulePoll(700);
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    schedulePoll(1200);
  } finally {
    loading.value = false;
  }
}

function onAgentChange(value: string) {
  const next = value === "__default__" ? null : value;
  emit("update:modelValue", next);
}

function newClientRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

async function onCancelRun() {
  const anchorEventId = cancelAnchorEventId.value;
  if (!anchorEventId) {
    message.warning(t("agent.client.cancelAnchorMissing"));
    return;
  }
  if (isActionBusy.value) return;

  Modal.confirm({
    title: t("agent.client.cancelConfirmTitle"),
    content: t("agent.client.cancelConfirmContent"),
    okText: t("agent.client.cancel"),
    cancelText: t("common.cancel"),
    okButtonProps: { danger: true },
    async onOk() {
      actionLoading.value = "cancel";
      actionTargetEventId.value = anchorEventId;
      try {
        await cancelAgentSession(props.sessionId, {
          workspaceId: props.workspaceId,
          anchorEventId
        });
        message.success(t("agent.client.cancelled"));
        await refreshAll();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        actionLoading.value = null;
        actionTargetEventId.value = null;
      }
    }
  });
}

async function onForkFromMessage(eventId: string) {
  if (!eventId || isActionBusy.value) return;
  actionLoading.value = "fork";
  actionTargetEventId.value = eventId;
  try {
    const session = await forkAgentSession({
      fromSessionId: props.sessionId,
      fromEventId: eventId
    });
    message.success(t("agent.client.forked"));
    emit("forked", session.id);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    actionLoading.value = null;
    actionTargetEventId.value = null;
  }
}

function onRevertToMessage(eventId: string) {
  if (!eventId || isActionBusy.value) return;

  const { text, toEventId } = userMessageDraftFromEventId(eventId);
  if (!toEventId) {
    message.warning(t("agent.client.revertTargetMissing"));
    return;
  }

  Modal.confirm({
    title: t("agent.client.revertConfirmTitle"),
    content: t("agent.client.revertConfirmContent"),
    okText: t("agent.client.revert"),
    cancelText: t("common.cancel"),
    okButtonProps: { danger: true },
    async onOk() {
      actionLoading.value = "revert";
      actionTargetEventId.value = eventId;
      try {
        await revertAgentSession(props.sessionId, {
          workspaceId: props.workspaceId,
          // 回退到上一条 event,把当前这条用户消息作为下一次输入草稿。
          toEventId,
          reason: "manual_revert"
        });
        if (text.trim()) {
          // 用户确认后再填充输入框,避免未确认就覆盖草稿。
          draft.value = text;
        }
        message.success(t("agent.client.reverted"));
        await refreshAll();
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        actionLoading.value = null;
        actionTargetEventId.value = null;
      }
    }
  });
}

async function onSend() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  try {
    const agentId = effectiveAgentId.value === "__default__" ? undefined : effectiveAgentId.value;
    await sendAgentMessage(props.sessionId, {
      workspaceId: props.workspaceId,
      text,
      clientRequestId: newClientRequestId(),
      agentId
    });
    draft.value = "";
    await refreshAll();
    schedulePoll(300);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    sending.value = false;
  }
}

watch(
  () => [props.sessionId, props.workspaceId],
  () => {
    messages.value = [];
    rawEvents.value = [];
    runState.value = {
      sessionId: props.sessionId,
      status: "idle",
      activeRunId: null,
      updatedAt: 0,
      appliedEventId: 0
    };
    clearPoll();
    if (props.sessionId) {
      void refreshAll();
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
    void refreshAll();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  clearPoll();
});
</script>
