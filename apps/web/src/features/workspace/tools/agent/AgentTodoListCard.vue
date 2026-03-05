<template>
  <div
    :class="
      collapsed
        ? 'w-full pl-2 pr-0 py-0.5 rounded cursor-pointer hover:bg-[var(--hover-bg)] transition-colors duration-100 text-[11px] font-mono text-[color:var(--text-secondary)]'
        : 'w-full todo-card rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2 cursor-pointer hover:bg-[var(--hover-bg)] hover:border-[var(--border-color)] transition-colors duration-100'
    "
    @click="emit('toggle-collapse')"
  >
    <div v-if="collapsed" class="flex items-center gap-2 min-w-0 flex-wrap">
      <span class="font-semibold text-[color:var(--text-color)] shrink-0">todolist</span>
      <component
        v-if="collapsedPreview.status === 'in_progress' || collapsedPreview.status === 'completed'"
        :is="statusIcon(collapsedPreview.status)"
        class="shrink-0 mr-0.5 align-[-1px]"
        :class="statusIconClass(collapsedPreview.status)"
      />
      <span class="shrink-0 font-semibold text-[color:var(--text-color)]">[{{ collapsedProgressText }}]</span>
      <span
        class="min-w-0 flex-1 truncate text-[color:var(--text-secondary)]"
        :title="collapsedPreview.text"
      >
        {{ collapsedPreview.text }}
      </span>
    </div>

    <div v-else class="flex items-center gap-2 min-w-0">
      <div class="text-[12px] font-semibold shrink-0">todolist</div>
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

const collapsedProgressText = computed(() => {
  const total = Math.max(0, props.summary.total);
  if (total === 0) return "0/0";

  const completed = Math.max(0, props.summary.completed);
  const inProgress = Math.max(0, props.summary.inProgress);

  // 进度语义: 正在进行第几个。
  // - 有进行中任务时: 已完成数+1 / 总数
  // - 没有进行中任务时: 已完成数 / 总数
  if (inProgress > 0) {
    const current = Math.min(total, Math.max(1, completed + 1));
    return `${current}/${total}`;
  }
  return `${Math.min(total, completed)}/${total}`;
});
const collapsedPreview = computed((): { status: TodoStatus | null; text: string } => {
  const inProgressTasks = props.todos
    .filter((item) => item.status === "in_progress")
    .map((item) => item.content.trim())
    .filter((item) => item.length > 0);
  if (inProgressTasks.length > 0) {
    return { status: "in_progress", text: inProgressTasks.join(" | ") };
  }

  // 全部完成后,收起态仍然展示最后一条任务(而不是 "-")。
  const allCompleted = props.todos.length > 0 && props.todos.every((item) => item.status === "completed");
  if (allCompleted) {
    const last = [...props.todos].reverse().find((item) => item.content.trim().length > 0);
    return { status: "completed", text: last?.content.trim() || "-" };
  }

  return { status: null, text: "-" };
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
