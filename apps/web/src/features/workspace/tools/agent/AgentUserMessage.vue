<template>
  <div class="agent-user-message" :class="tone === 'error' ? 'text-red-500' : ''">
    <div v-if="props.text" class="whitespace-pre-wrap break-words">{{ props.text }}</div>
    <a-button
      v-if="props.attachments.length"
      type="link"
      size="small"
      class="!px-0 !h-auto"
      @click="emit('preview')"
    >
      🖼️ {{ t("agent.client.imageCount", { count: props.attachments.length }) }}
    </a-button>
  </div>
</template>

<script setup lang="ts">
import type { AgentMessageImageAttachment } from "@agent-workbench/shared";
import { useI18n } from "vue-i18n";

const props = withDefaults(defineProps<{
  text: string;
  tone?: "normal" | "error";
  attachments?: AgentMessageImageAttachment[];
}>(), {
  tone: "normal",
  attachments: () => []
});

const tone = props.tone;
const emit = defineEmits<{ preview: [] }>();
const { t } = useI18n();
</script>
