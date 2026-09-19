<template>
  <section
    class="subtask-card my-1 rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2"
    :class="[
      display.subtaskSessionId ? 'is-clickable' : 'is-disabled',
      execution.status === 'failed' ? 'border-red-500/40 bg-red-500/5' : '',
    ]"
    @click="openSubtask"
  >
    <div class="flex items-center gap-2">
      <div class="font-semibold">
        <DoubleRightOutlined class="subtask-title-icon mr-0.5 text-blue-500" />
        {{ t("agent.client.subtaskCardTitle") }}: {{ display.description || "-" }}
      </div>
      <component
        :is="statusIcon"
        class="shrink-0"
        :class="statusIconClass"
        :spin="execution.status === 'running'"
      />
    </div>
    <div
      class="pt-0.5 text-[color:var(--text-secondary)] flex flex-wrap items-center gap-x-3 gap-y-0.5"
    >
      <span>{{ t("agent.client.subtaskAgent") }}: {{ agentName || display.agent || "-" }}</span>
      <span>{{ t("agent.client.subtaskMode") }}: {{ modeText }}</span>
      <span v-if="startedAtText">
        {{ t("agent.client.subtaskStartedAt") }}: {{ startedAtText }}
      </span>
      <span v-if="durationText">
        {{ t("agent.client.subtaskDuration") }}: {{ durationText }}
      </span>
    </div>
    <div class="pt-0.5 text-[color:var(--text-secondary)] flex items-center gap-1 min-w-0">
      {{ t("agent.client.subtaskSessionId") }}: {{ display.subtaskSessionId || "-" }}
      <a-button
        v-if="display.subtaskSessionId"
        size="small"
        type="text"
        class="!px-1 !text-[color:var(--text-tertiary)] hover:!text-[color:var(--text-tertiary)] shrink-0"
        :aria-label="t('agent.client.copySessionId')"
        @click="copySessionId"
      >
        <template #icon><CopyOutlined class="text-[12px]" /></template>
      </a-button>
    </div>
    <div v-if="execution.error" class="pt-1 text-red-500">
      Error: {{ execution.error }}
    </div>
  </section>
</template>

<script setup lang="ts">
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DoubleRightOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons-vue";
import type {
  AgentTimelineToolExecution,
  AgentToolExecution,
} from "@agent-workbench/shared";
import { message } from "ant-design-vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { copyTextWithExecCommand } from "./agentClientHeader";
import { parseSubtaskDisplay } from "./agentToolExecutionDisplay";
import { formatElapsedDuration } from "./subtaskRunDisplay";

const props = defineProps<{
  input: Record<string, unknown>;
  execution: AgentTimelineToolExecution;
  detail?: AgentToolExecution;
  agentName?: string;
  now: number;
}>();
const emit = defineEmits<{ "open-subtask": [sessionId: string] }>();
const { t } = useI18n();
const display = computed(() =>
  parseSubtaskDisplay(props.input, props.detail?.structuredResult),
);
const modeText = computed(() => {
  if (display.value.mode === "new") return t("agent.client.subtaskModeNew");
  if (display.value.mode === "fork") return t("agent.client.subtaskModeFork");
  if (display.value.mode === "existing") return t("agent.client.subtaskModeExisting");
  return display.value.mode || "-";
});
const startedAtText = computed(() => formatStartedAt(props.execution.startedAt, props.now));
const durationText = computed(() => {
  const startedAt = props.execution.startedAt;
  if (startedAt === null) return "";
  const endedAt = props.execution.completedAt
    ?? (props.execution.status === "running" ? props.now : null);
  return endedAt === null ? "" : formatElapsedDuration(Math.max(0, endedAt - startedAt));
});
const statusIcon = computed(() => {
  if (props.execution.status === "completed") return CheckCircleOutlined;
  if (props.execution.status === "failed") return ExclamationCircleOutlined;
  if (props.execution.status === "cancelled") return CloseCircleOutlined;
  if (props.execution.status === "queued") return ClockCircleOutlined;
  if (props.execution.status === "running") return LoadingOutlined;
  return QuestionCircleOutlined;
});
const statusIconClass = computed(() => {
  if (props.execution.status === "completed") return "text-emerald-500";
  if (props.execution.status === "failed") return "text-red-500";
  if (props.execution.status === "running") return "text-blue-500";
  return "text-[color:var(--text-tertiary)]";
});

function formatStartedAt(startedAt: number | null, now: number) {
  if (startedAt === null || !Number.isFinite(startedAt) || startedAt <= 0) return "";
  const started = new Date(startedAt);
  const current = new Date(now);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(started);
  if (
    started.getFullYear() === current.getFullYear()
    && started.getMonth() === current.getMonth()
    && started.getDate() === current.getDate()
  ) return time;
  const month = String(started.getMonth() + 1).padStart(2, "0");
  const day = String(started.getDate()).padStart(2, "0");
  return `${month}-${day} ${time}`;
}
function openSubtask() {
  if (display.value.subtaskSessionId) emit("open-subtask", display.value.subtaskSessionId);
}
async function copySessionId(event: MouseEvent) {
  event.stopPropagation();
  const content = display.value.subtaskSessionId?.trim();
  if (!content) return;
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(content);
      message.success(t("agent.client.sessionIdCopied"));
      return;
    }
  } catch {
    // Clipboard API 不可用时继续使用兼容回退。
  }
  try {
    if (!copyTextWithExecCommand(content)) throw new Error("copy command failed");
    message.success(t("agent.client.sessionIdCopied"));
  } catch (error) {
    message.error(t("common.copyFailed", {
      reason: error instanceof Error ? error.message : String(error),
    }));
  }
}
</script>

<style scoped>
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
</style>
