<template>
  <section data-testid="agent-message-queue" aria-live="polite">
    <p v-if="snapshot && snapshot.pendingCount > 0" class="mb-2 text-sm" data-testid="queue-pending-count">
      {{ t('agent.client.queuePendingCount', { count: snapshot.pendingCount }) }}
    </p>
  </section>
</template>
<script setup lang="ts">
import type { AgentMessageQueueSnapshot } from '@agent-workbench/shared';
import { useI18n } from 'vue-i18n';
defineProps<{ snapshot: AgentMessageQueueSnapshot | null }>();
const { t } = useI18n();
</script>
