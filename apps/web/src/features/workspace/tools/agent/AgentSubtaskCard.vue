<template>
  <section
    class="mt-1 rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2 text-[0.9em]"
  >
    <div class="font-semibold">subtask · {{ execution.status }}</div>
    <dl
      class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[color:var(--text-secondary)]"
    >
      <template v-if="display.description"
        ><dt>描述</dt>
        <dd class="break-words">{{ display.description }}</dd></template
      >
      <template v-if="display.agent"
        ><dt>Agent</dt>
        <dd>{{ display.agent }}</dd></template
      >
      <template v-if="display.mode"
        ><dt>模式</dt>
        <dd>{{ display.mode }}</dd></template
      >
      <template v-if="duration"
        ><dt>耗时</dt>
        <dd>{{ duration }}</dd></template
      >
    </dl>
    <div
      v-if="display.resultText"
      class="mt-2 whitespace-pre-wrap break-words text-[color:var(--text-secondary)]"
    >
      {{ display.resultText }}
    </div>
    <a-button
      v-if="display.subtaskSessionId"
      type="link"
      size="small"
      class="!px-0 mt-1"
      @click="emit('open-subtask', display.subtaskSessionId)"
      >打开子任务</a-button
    >
  </section>
</template>

<script setup lang="ts">
import type {
  AgentTimelineToolExecution,
  AgentToolExecution,
} from "@agent-workbench/shared";
import { computed } from "vue";
import { formatElapsedDuration } from "./subtaskRunDisplay";
import { parseSubtaskDisplay } from "./agentToolExecutionDisplay";

const props = defineProps<{
  input: Record<string, unknown>;
  execution: AgentTimelineToolExecution;
  detail?: AgentToolExecution;
}>();
const emit = defineEmits<{ "open-subtask": [sessionId: string] }>();
const display = computed(() =>
  parseSubtaskDisplay(props.input, props.detail?.structuredResult),
);
const duration = computed(() =>
  props.execution.startedAt !== null && props.execution.completedAt !== null
    ? formatElapsedDuration(
        Math.max(0, props.execution.completedAt - props.execution.startedAt),
      )
    : "",
);
</script>
