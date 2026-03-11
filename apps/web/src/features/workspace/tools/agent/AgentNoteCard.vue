<template>
  <div
    class="flex items-center gap-2 min-w-0 flex-wrap w-full pl-2 pr-0 py-0.5 rounded cursor-default hover:bg-[var(--hover-bg)] transition-colors duration-100 font-mono text-[color:var(--text-secondary)]"
  >
    <FileTextOutlined class="shrink-0 text-[color:var(--text-tertiary)]" />
    <span class="shrink-0 font-semibold text-[color:var(--text-color)]">note</span>
    <span class="min-w-0 flex-1 break-words text-[color:var(--text-color)]" :title="content">{{ content }}</span>
    <span v-if="errorText" class="min-w-0 max-w-[30%] truncate text-red-500">error: {{ errorText }}</span>
  </div>
</template>

<script setup lang="ts">
import { FileTextOutlined } from "@ant-design/icons-vue";

defineProps<{ content: string; errorText?: string }>();
</script>
