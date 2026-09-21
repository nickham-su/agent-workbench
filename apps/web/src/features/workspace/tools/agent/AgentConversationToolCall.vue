<template>
  <section :style="compactToolStyle">
    <template v-if="part.toolName === 'todolist'">
      <AgentTodoListCard
        v-if="todo"
        :collapsed="todoCollapsed"
        :goal="todo.goal"
        :todos="todo.todos"
        :summary="todo.summary"
        :error-text="execution?.error || undefined"
        @toggle-collapse="emit('toggle-todo')"
      />
      <div
        v-else
        class="my-1 flex items-center gap-2 rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2"
      >
        <span class="font-semibold">todolist</span>
        <LoadingOutlined v-if="loading" spin class="text-blue-500" />
        <span v-else-if="execution?.error" class="text-red-500">{{ execution.error }}</span>
      </div>
    </template>
    <AgentSubtaskCard
      v-else-if="part.toolName === 'subtask' && execution"
      :input="part.input"
      :execution="execution"
      :detail="detail"
      :agent-name="subtaskAgentName"
      :now="now"
      @open-subtask="emit('open-subtask', $event)"
    />
    <div v-else>
      <AgentApplyPatchCard
        v-if="part.toolName === 'apply_patch'"
        :workspace-id="workspaceId"
        :tool-id="toolId"
        :session-id="sessionId"
        :tool-execution-id="execution?.id"
        :input="part.input"
        :execution="execution"
        :now="now"
      />
      <AgentWriteCard
        v-else-if="part.toolName === 'write'"
        :workspace-id="workspaceId"
        :tool-id="toolId"
        :session-id="sessionId"
        :tool-execution-id="execution?.id"
        :input="part.input"
        :execution="execution"
        :now="now"
      />
      <AgentToolCallRow
        v-else
        :tool-name="part.toolName"
        :input="part.input"
        :execution="execution"
        :now="now"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { LoadingOutlined } from "@ant-design/icons-vue";
import type {
  AgentTimelineToolExecution,
  AgentToolCallPart,
  AgentToolExecution,
} from "@agent-workbench/shared";
import { computed, watch } from "vue";
import AgentApplyPatchCard from "./AgentApplyPatchCard.vue";
import AgentSubtaskCard from "./AgentSubtaskCard.vue";
import AgentTodoListCard from "./AgentTodoListCard.vue";
import AgentToolCallRow from "./AgentToolCallRow.vue";
import AgentWriteCard from "./AgentWriteCard.vue";
import { parseTodoDisplay } from "./agentToolExecutionDisplay";

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  sessionId: string;
  part: AgentToolCallPart;
  execution: AgentTimelineToolExecution | null;
  detail?: AgentToolExecution;
  loading: boolean;
  now: number;
  todoCollapsed?: boolean;
  subtaskAgentLabels?: Record<string, string>;
}>();
const emit = defineEmits<{
  "request-detail": [executionId: string];
  "open-subtask": [sessionId: string];
  "toggle-todo": [];
}>();
const todo = computed(() => parseTodoDisplay(props.detail?.structuredResult));
const compactToolStyle = {
  fontSize: "calc(var(--agent-font-size, 13px) - 3px)",
};
const detailRequestKey = computed(() =>
  props.execution &&
  (props.part.toolName === "todolist" || props.part.toolName === "subtask")
    ? `${props.execution.id}:${props.execution.updatedRevision}`
    : null,
);
const subtaskAgentName = computed(() => {
  const agentId = typeof props.part.input.agentId === "string"
    ? props.part.input.agentId.trim()
    : "";
  return props.subtaskAgentLabels?.[agentId]?.trim() || agentId;
});

watch(
  [detailRequestKey, () => props.detail, () => props.loading] as const,
  ([key, detail, loading]) => {
    if (key && props.execution && !detail && !loading) {
      emit("request-detail", props.execution.id);
    }
  },
  { immediate: true },
);
</script>
