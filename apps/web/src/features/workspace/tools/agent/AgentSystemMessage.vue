<template>
  <div
    v-if="label"
    class="agent-compaction-divider flex items-center gap-3 py-2 text-xs font-medium text-blue-500"
    role="separator"
    :aria-label="label"
  >
    <span class="h-px flex-1 bg-current" />
    <span class="whitespace-nowrap">{{ label }}</span>
    <span class="h-px flex-1 bg-current" />
  </div>
  <AgentTextMessage
    class="agent-system-message"
    :style="{ fontSize: 'calc(var(--agent-font-size, 13px) - 3px)' }"
    :text="text"
    :message-id="messageId"
    :expanded="expanded"
    :max-height-px="100"
    @toggle="expanded = $event"
  />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import AgentTextMessage from "./AgentTextMessage.vue";

const props = defineProps<{
  text: string;
  messageId: string;
  label?: string;
}>();

const expanded = ref(false);

watch(
  () => props.messageId,
  () => {
    expanded.value = false;
  },
);
</script>
