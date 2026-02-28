<template>
  <div class="todo-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2">
    <div class="flex items-center gap-2">
      <div class="text-[12px] font-semibold">{{ t("agent.client.todoListCardTitle") }}</div>
    </div>

    <div v-if="errorText" class="pt-0.5 text-[12px] text-red-500 whitespace-pre-wrap break-words">error: {{ errorText }}</div>

    <div v-if="todos.length === 0" class="pt-2 text-[12px] text-[color:var(--text-tertiary)]">
      {{ t("agent.client.todoListEmpty") }}
    </div>

    <div v-else class="pt-1.5 flex flex-col gap-0.5">
      <div
        v-for="(todo, index) in todos"
        :key="`${todo.status}-${todo.content}-${index}`"
        class="px-2 py-0.5 leading-4 text-[12px]"
      >
        <component :is="statusIcon(todo.status)" class="mr-1 align-[-1px]" :class="statusIconClass(todo.status)" />
        <span class="break-words" :class="todo.status === 'completed' || todo.status === 'cancelled' ? 'line-through opacity-70' : ''">
          {{ todo.content }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, SyncOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

defineProps<{
  errorText?: string;
  todos: Array<{
    content: string;
    status: TodoStatus;
  }>;
}>();

const { t } = useI18n();

function statusIcon(status: TodoStatus) {
  if (status === "completed") return CheckCircleOutlined;
  if (status === "cancelled") return CloseCircleOutlined;
  if (status === "in_progress") return SyncOutlined;
  return ClockCircleOutlined;
}

function statusIconClass(status: TodoStatus) {
  if (status === "completed") return "text-emerald-500";
  if (status === "cancelled") return "text-red-500";
  if (status === "in_progress") return "text-blue-500";
  return "text-[color:var(--text-tertiary)]";
}
</script>
