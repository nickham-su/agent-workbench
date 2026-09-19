<template>
  <div v-if="label" class="mb-1 font-medium text-[color:var(--text-tertiary)]">
    {{ label }}
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
