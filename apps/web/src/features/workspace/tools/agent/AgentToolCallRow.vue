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
      class="shrink-0 whitespace-nowrap tabular-nums"
      :class="execution?.status === 'failed' ? 'text-red-500' : 'text-[color:var(--text-tertiary)]'"
    >{{ executionText }}</span>
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
      class="shrink-0 whitespace-nowrap tabular-nums"
      :class="execution?.status === 'failed' ? 'text-red-500' : 'text-[color:var(--text-tertiary)]'"
    >{{ executionText }}</span>
  </div>
</template>

<script setup lang="ts">
import type { AgentTimelineToolExecution } from "@agent-workbench/shared";
import { computed } from "vue";
import {
  formatToolExecutionText,
  formatToolInputPreview,
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
const titleText = computed(() =>
  [props.toolName, inputText.value, props.execution?.error]
    .filter(Boolean)
    .join(" · "),
);
</script>
