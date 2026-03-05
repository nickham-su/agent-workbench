<template>
  <div
    :class="collapsed ? 'py-0.5 pl-2 cursor-pointer' : 'todo-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2 cursor-pointer'"
    @click="emit('toggle-collapse')"
  >
    <div v-if="collapsed" class="flex items-center gap-2 min-w-0 text-[12px] leading-5 flex-wrap">
      <span class="font-semibold shrink-0">todolist</span>
      <span class="shrink-0 text-[12px] font-semibold">{{ props.summary.completed }}/{{ props.summary.total }}</span>
      <span class="min-w-0 max-w-[60%] truncate text-[11px] text-[color:var(--text-secondary)]" :title="inProgressSummary">
        {{ inProgressSummary }}
      </span>
    </div>

    <div v-else class="flex items-center gap-2 min-w-0">
      <div class="text-[12px] font-semibold shrink-0">todolist</div>
      <span class="shrink-0 text-[12px] font-semibold">{{ props.summary.completed }}/{{ props.summary.total }}</span>
    </div>

    <div v-if="errorText" class="pt-0.5 text-[12px] text-red-500 whitespace-pre-wrap break-words">error: {{ errorText }}</div>

    <div v-if="!collapsed && todos.length === 0" class="pt-2 text-[12px] text-[color:var(--text-tertiary)]">
      {{ t("agent.client.todoListEmpty") }}
    </div>

    <div v-else-if="!collapsed" class="pt-1.5 flex flex-col gap-0.5">
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
import { computed } from "vue";
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

const props = defineProps<{
  errorText?: string;
  collapsed?: boolean;
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

const emit = defineEmits<{
  "toggle-collapse": [];
}>();

const { t } = useI18n();
const collapsed = computed(() => props.collapsed === true);
const inProgressSummary = computed(() => {
  const tasks = props.todos
    .filter((item) => item.status === "in_progress")
    .map((item) => item.content.trim())
    .filter((item) => item.length > 0);
  if (tasks.length === 0) return "-";
  return tasks.join(" | ");
});

function statusIcon(status: TodoStatus) {
  if (status === "completed") return CheckCircleOutlined;
  if (status === "cancelled") return CloseCircleOutlined;
  if (status === "in_progress") return PlayCircleOutlined;
  return ClockCircleOutlined;
}

function statusIconClass(status: TodoStatus) {
  if (status === "completed") return "text-emerald-500";
  if (status === "cancelled") return "text-red-500";
  if (status === "in_progress") return "text-blue-500";
  return "text-[color:var(--text-tertiary)]";
}
</script>
