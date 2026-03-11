<template>
  <div
    class="flex items-start gap-2 min-w-0 w-full pl-2 pr-0 py-0.5 rounded cursor-default font-mono text-[color:var(--text-secondary)]"
  >
    <PushpinOutlined class="shrink-0 self-start mt-[3px] text-[color:var(--text-color)]" />
    <div class="min-w-0 flex-1 flex flex-col">
      <span class="min-w-0 break-words text-[color:var(--text-color)]" :title="content">{{ content }}</span>
      <div v-if="errorText" class="pt-0.5 text-red-500 break-words whitespace-pre-wrap">error: {{ errorText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PushpinOutlined } from "@ant-design/icons-vue";

defineProps<{ content: string; errorText?: string }>();
</script>
