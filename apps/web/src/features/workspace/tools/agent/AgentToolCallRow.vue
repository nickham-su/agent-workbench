<template>
  <button
    v-if="interactive"
    type="button"
    class="m-0 flex w-full min-w-0 appearance-none items-center gap-2 border-0 bg-transparent px-0 py-0.5 text-left font-mono text-[1em] text-[color:var(--text-secondary)] outline-none"
    :disabled="loading"
    :title="titleText"
    @click="emit('activate')"
  >
    <span class="shrink-0 font-semibold text-[color:var(--text-color)]">{{ toolName }}</span>
    <span class="min-w-0 flex-1 truncate">{{ inputText }}</span>
    <span
      v-if="executionText"
      class="shrink-0 inline-flex items-center gap-1 whitespace-nowrap tabular-nums"
      :class="executionStatusClass"
    >
      <component
        v-if="executionStatusIcon"
        :is="executionStatusIcon"
        class="shrink-0"
        :spin="execution?.status === 'running'"
      />
      {{ executionText }}
    </span>
  </button>
  <div
    v-else
    class="flex w-full min-w-0 items-center gap-2 px-0 py-0.5 font-mono text-[1em] text-[color:var(--text-secondary)]"
    :title="titleText"
  >
    <span class="shrink-0 font-semibold text-[color:var(--text-color)]">{{ toolName }}</span>
    <span class="min-w-0 flex-1 truncate">{{ inputText }}</span>
    <span
      v-if="executionText"
      class="shrink-0 inline-flex items-center gap-1 whitespace-nowrap tabular-nums"
      :class="executionStatusClass"
    >
      <component
        v-if="executionStatusIcon"
        :is="executionStatusIcon"
        class="shrink-0"
        :spin="execution?.status === 'running'"
      />
      {{ executionText }}
    </span>
  </div>
</template>

<script setup lang="ts">
import {
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons-vue";
import type { AgentTimelineToolExecution } from "@agent-workbench/shared";
import { computed } from "vue";
import {
  formatToolExecutionText,
  formatToolInputPreview,
  toolExecutionStatusTextClass,
} from "./agentToolExecutionDisplay";

const props = withDefaults(
  defineProps<{
    toolName: string;
    input: unknown;
    execution: AgentTimelineToolExecution | null;
    now: number;
    interactive?: boolean;
    loading?: boolean;
  }>(),
  { interactive: false, loading: false },
);
const emit = defineEmits<{ activate: [] }>();

const inputText = computed(() => formatToolInputPreview(props.input));
const executionText = computed(() =>
  formatToolExecutionText(props.execution, props.now),
);
const executionStatusClass = computed(() =>
  props.execution
    ? toolExecutionStatusTextClass(props.execution.status)
    : "text-[color:var(--text-tertiary)]",
);
const executionStatusIcon = computed(() => {
  if (props.execution?.status === "completed") return null;
  if (props.execution?.status === "running") return LoadingOutlined;
  if (props.execution?.status === "failed") return ExclamationCircleOutlined;
  if (props.execution?.status === "queued") return ClockCircleOutlined;
  if (props.execution?.status === "cancelled") return CloseCircleOutlined;
  return QuestionCircleOutlined;
});
const titleText = computed(() =>
  [props.toolName, inputText.value, props.execution?.error]
    .filter(Boolean)
    .join(" · "),
);
</script>
