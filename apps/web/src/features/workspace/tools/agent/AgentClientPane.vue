<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="px-3 py-2 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]">
      <div class="flex items-center gap-2">
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
import { message } from "ant-design-vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getAgentConversation, getAgentRunState, sendAgentMessage } from "@/shared/api";

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

const props = defineProps<{
  workspaceId: string;
  sessionId: string;
  active: boolean;
  modelValue?: string | null;
  agentOptions: AgentOption[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const { t } = useI18n();

const loading = ref(false);
const sending = ref(false);
const draft = ref("");
const messages = ref<MessageItem[]>([]);
const runState = ref<AgentSessionRunState>({
  sessionId: props.sessionId,
  status: "idle",
  activeRunId: null,
  updatedAt: 0,
  appliedEventId: 0
});
const scrollEl = ref<HTMLElement | null>(null);

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

function roleLabel(role: MessageItem["role"]) {
  if (role === "user") return t("agent.client.roles.user");
  if (role === "assistant") return t("agent.client.roles.assistant");
  return t("agent.client.roles.system");
}

function parseMessages(events: Array<{ id: string; type: string; payload: Record<string, any> }>) {
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
    const mapped = parseMessages(conversation.events as Array<{ id: string; type: string; payload: Record<string, any> }>);
    const changed = mapped.length !== messages.value.length || mapped.at(-1)?.id !== messages.value.at(-1)?.id;
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
