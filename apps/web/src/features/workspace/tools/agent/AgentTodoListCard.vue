<template>
  <div class="todo-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2">
    <div class="flex items-center gap-2">
      <div class="text-[12px] font-semibold">{{ t("agent.client.todoListCardTitle") }}</div>
      <a-tag color="default" class="!m-0 !text-[10px] !leading-[16px] !px-1 !py-0">{{ status }}</a-tag>
    </div>

    <div class="pt-0.5 text-[12px] text-[color:var(--text-secondary)]">
      {{
        t("agent.client.todoListSummary", {
          total: summary.total,
          inProgress: summary.inProgress,
          pending: summary.pending,
          completed: summary.completed,
          cancelled: summary.cancelled
        })
      }}
    </div>

    <div v-if="errorText" class="pt-0.5 text-[12px] text-red-500 whitespace-pre-wrap break-words">error: {{ errorText }}</div>

    <div v-if="todos.length === 0" class="pt-2 text-[12px] text-[color:var(--text-tertiary)]">
      {{ t("agent.client.todoListEmpty") }}
    </div>

    <div v-else class="pt-2 flex flex-col gap-1">
      <div
        v-for="(todo, index) in todos"
        :key="`${todo.status}-${todo.content}-${index}`"
        class="rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg)] px-2 py-1 text-[12px]"
      >
        <span class="mr-1">{{ statusSymbol(todo.status) }}</span>
        <span class="break-words" :class="todo.status === 'completed' || todo.status === 'cancelled' ? 'line-through opacity-70' : ''">
          {{ todo.content }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

defineProps<{
  status: string;
  errorText?: string;
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  };
  todos: Array<{
    content: string;
    status: TodoStatus;
  }>;
}>();

const { t } = useI18n();

function statusSymbol(status: TodoStatus) {
  if (status === "completed") return "[x]";
  if (status === "cancelled") return "[-]";
  if (status === "in_progress") return "[~]";
  return "[ ]";
}
</script>
