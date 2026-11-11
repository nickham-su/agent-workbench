<template>
  <section class="mb-2 text-sm" data-testid="agent-message-queue" aria-live="polite">
    <p v-if="snapshot && snapshot.pendingCount > 0" data-testid="queue-pending-count">
      {{ t('agent.client.queuePendingCount', { count: snapshot.pendingCount }) }}
    </p>
    <p v-if="error" class="text-amber-500" data-testid="queue-offline">{{ t('agent.client.queueOffline') }}</p>
    <p v-if="snapshot?.mode === 'paused'" data-testid="queue-paused">{{ t('agent.client.queuePaused') }} <span v-if="snapshot.pauseCode">({{ snapshot.pauseCode }})</span></p>
    <p v-if="snapshot && snapshot.unconfirmedInputCount > 0" data-testid="queue-unconfirmed-count">
      {{ t('agent.client.queueUnconfirmedCount', { count: snapshot.unconfirmedInputCount }) }}
    </p>
    <p v-if="stopBlocked" data-testid="queue-stop-barrier" :data-stop-state="snapshot?.stop.state ?? 'unknown'">{{ t(snapshot?.stop.state === 'pending' ? 'agent.client.queueStopPending' : 'agent.client.queueStopUnknown') }}</p>
    <p v-if="unknownControl">{{ t('agent.client.queueControlUnknown') }}</p>
    <div v-if="unknownSubmission" data-testid="queue-submission-unknown">
      <p>{{ t('agent.client.queueSubmissionUnknown') }}</p>
      <a-button size="small" :disabled="busy" @click="emit('lookup')">{{ t('agent.client.queueLookup') }}</a-button>
      <a-button size="small" :disabled="busy" @click="emit('retry')">{{ t('agent.client.queueRetryOriginal') }}</a-button>
    </div>
    <div v-if="retainedSubmission" data-testid="queue-retained-submission">
      <p v-if="retainedSubmission.phase === 'rejected'">{{ t(retainedSubmission.status === 507 ? 'agent.client.queueRetentionFull' : 'agent.client.queueSubmissionRejected') }}</p>
      <details>
        <summary>{{ t('agent.client.queueRetainedDraft') }}</summary>
        <p class="whitespace-pre-wrap break-all">{{ retainedSubmission.submission.draft }}</p>
        <p v-for="image in retainedSubmission.submission.images" :key="image.id">{{ image.filename }}</p>
      </details>
      <a-button size="small" :disabled="busy" @click="emit('restore')">{{ t('agent.client.queueRestoreDraft') }}</a-button>
      <a-button v-if="retainedSubmission.phase === 'rejected'" size="small" :disabled="busy" @click="emit('retry')">{{ t('agent.client.queueRetryOriginal') }}</a-button>
    </div>
    <div v-if="unknownClear" data-testid="queue-clear-unknown">
      <p>{{ t('agent.client.queueClearUnknown') }}</p>
      <a-button size="small" :disabled="busy" @click="emit('clear')">{{ t('agent.client.queueRetryClear') }}</a-button>
    </div>
    <a-button v-if="unknownStop" size="small" :disabled="busy" @click="emit('stop')">{{ t('agent.client.queueRetryStop') }}</a-button>
    <div v-if="snapshot && (snapshot.mode === 'paused' || snapshot.unconfirmedInputCount > 0)">
      <a-button v-if="snapshot.unconfirmedInputCount > 0" danger size="small" :disabled="busy || stopBlocked || (unknownControl !== null && unknownControl !== 'abandon')" @click="emit('abandon')">{{ t('agent.client.queueAbandon') }}</a-button>
    </div>
    <details v-if="snapshot && snapshot.items.length" data-testid="queue-items">
      <summary>{{ t('agent.client.queueView') }}</summary>
      <ol class="max-h-40 overflow-auto list-decimal pl-5">
        <li v-for="item in snapshot.items" :key="item.id" :data-receipt-id="item.id">
          <button type="button" class="text-left whitespace-pre-wrap break-all" @click="emit('detail', item.id)">{{ item.textPreview || t('agent.client.queueImageMessage') }}</button>
          <span v-if="item.attachmentCount"> · {{ t('agent.client.imageCount', { count: item.attachmentCount }) }}</span>
          <a-button size="small" :disabled="busy" @click="emit('cancel', item.id)">{{ t('common.cancel') }}</a-button>
        </li>
      </ol>
    </details>
  </section>
</template>
<script setup lang="ts">
import type { AgentMessageQueueSnapshot } from '@agent-workbench/shared';
import type { QueueSubmissionHandoff } from './useAgentMessageQueue';
import { useI18n } from 'vue-i18n';
defineProps<{
  unknownClear?: boolean;
  retainedSubmission?: QueueSubmissionHandoff | null;
  snapshot: AgentMessageQueueSnapshot | null; error: boolean; busy: boolean;
  stopBlocked: boolean; unknownSubmission: boolean; unknownStop: boolean;
  unknownControl: 'resume' | 'abandon' | null;
}>();
const emit = defineEmits<{
  restore: []; lookup: []; retry: []; stop: []; clear: []; abandon: []; cancel: [receiptId: string]; detail: [receiptId: string];
}>();
const { t } = useI18n();
</script>
