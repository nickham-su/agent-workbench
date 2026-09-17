<template>
  <section>
    <div class="font-mono text-[0.9em] text-[color:var(--text-secondary)]">
      {{ part.toolName }}({{ formatToolInput(part.input) }})
      <span v-if="execution && execution.status !== 'completed'"
        >[{{ execution.status }}]</span
      >
    </div>
    <div
      v-if="execution?.resultPreview"
      class="mt-1 whitespace-pre-wrap text-[color:var(--text-secondary)]"
    >
      {{ execution.resultPreview }}
    </div>
    <div
      v-if="execution?.resultTruncated"
      class="mt-1 text-[0.85em] text-[color:var(--text-tertiary)]"
    >
      {{ t("agent.client.resultPreviewTruncated") }}
    </div>
    <div v-if="execution?.error" class="mt-1 whitespace-pre-wrap text-red-500">
      {{ execution.error }}
    </div>
    <a-button
      v-if="execution && supportsDetail(part.toolName)"
      size="small"
      type="link"
      class="!px-0 mt-1"
      :loading="loading"
      @click="emit('toggle-detail', execution.id)"
    >
      {{
        detail ? t("agent.client.hideDetails") : t("agent.client.showDetails")
      }}
    </a-button>
    <template v-if="execution && detail">
      <AgentTodoListCard
        v-if="part.toolName === 'todolist' && todo"
        :goal="todo.goal"
        :todos="todo.todos"
        :summary="todo.summary"
        :error-text="execution.error || undefined"
      />
      <AgentApplyPatchCard
        v-else-if="part.toolName === 'apply_patch' && applyPatch"
        :workspace-id="workspaceId"
        :tool-id="toolId"
        :session-id="sessionId"
        :tool-execution-id="execution.id"
        :summary="applyPatch.summary"
        :files="applyPatch.files"
        :omitted-files="applyPatch.omittedFiles"
        :error-text="execution.error || undefined"
      />
      <AgentWriteCard
        v-else-if="part.toolName === 'write' && write"
        :workspace-id="workspaceId"
        :tool-id="toolId"
        :session-id="sessionId"
        :tool-execution-id="execution.id"
        :summary="write"
        :error-text="execution.error || undefined"
      />
      <AgentScratchpadCard
        v-else-if="part.toolName === 'scratchpad' && scratchpad"
        :content="scratchpad"
        :error-text="execution.error || undefined"
      />
      <AgentSubtaskCard
        v-else-if="part.toolName === 'subtask'"
        :input="part.input"
        :execution="execution"
        :detail="detail"
        @open-subtask="emit('open-subtask', $event)"
      />
      <pre
        v-else-if="detail.structuredResult != null"
        class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-[0.85em]"
        >{{ structuredResult }}</pre>
    </template>
  </section>
</template>

<script setup lang="ts">
import type {
  AgentTimelineToolExecution,
  AgentToolCallPart,
  AgentToolExecution,
} from "@agent-workbench/shared";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import AgentApplyPatchCard from "./AgentApplyPatchCard.vue";
import AgentScratchpadCard from "./AgentScratchpadCard.vue";
import AgentSubtaskCard from "./AgentSubtaskCard.vue";
import AgentTodoListCard from "./AgentTodoListCard.vue";
import AgentWriteCard from "./AgentWriteCard.vue";
import {
  formatToolInput as formatToolCallInput,
  parseApplyPatchDisplay,
  parseScratchpadContent,
  parseTodoDisplay,
  parseWriteDisplay,
} from "./agentToolExecutionDisplay";

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  sessionId: string;
  part: AgentToolCallPart;
  execution: AgentTimelineToolExecution | null;
  detail?: AgentToolExecution;
  loading: boolean;
}>();
const emit = defineEmits<{
  "toggle-detail": [executionId: string];
  "open-subtask": [sessionId: string];
}>();
const { t } = useI18n();
const todo = computed(() => parseTodoDisplay(props.detail?.structuredResult));
const applyPatch = computed(() =>
  parseApplyPatchDisplay(props.detail?.structuredResult),
);
const write = computed(() => parseWriteDisplay(props.detail?.structuredResult));
const scratchpad = computed(() =>
  parseScratchpadContent(props.detail?.structuredResult),
);
const structuredResult = computed(() => {
  try {
    return JSON.stringify(props.detail?.structuredResult, null, 2);
  } catch {
    return String(props.detail?.structuredResult);
  }
});
function supportsDetail(name: string) {
  return ["todolist", "apply_patch", "write", "scratchpad", "subtask"].includes(
    name,
  );
}
function formatToolInput(value: unknown) {
  return formatToolCallInput(value);
}
</script>
