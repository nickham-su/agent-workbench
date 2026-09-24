<template>
  <DashboardPanelShell :title="t('dashboard.liveSnapshot')" test-id="worker-live-status">
    <p class="snapshot-time">
      {{ t("dashboard.snapshotAt") }}: {{ formatDateTime(result.snapshotAt, timezone, locale) }}
      · {{ t("dashboard.asOf") }}: {{ formatDateTime(result.asOf, timezone, locale) }}
    </p>
    <div class="snapshot-grid">
      <article><span>{{ t("dashboard.running") }}</span><strong>{{ formatCount(snapshot?.running, locale) }}</strong></article>
      <article><span>{{ t("dashboard.queued") }}</span><strong>{{ formatCount(snapshot?.queued, locale) }}</strong></article>
      <article>
        <span>{{ t("dashboard.concurrency") }}</span>
        <strong>{{ formatCount(snapshot?.concurrency, locale) }}</strong>
        <div class="slot-usage">
          <span>{{ t("dashboard.utilization") }}: {{ formatRatio(snapshot?.utilization, locale) }}</span>
          <progress v-if="snapshot?.utilization != null" :value="snapshot.utilization" max="1" :aria-label="t('dashboard.utilization')" />
        </div>
      </article>
      <article><span>{{ t("dashboard.lastReadyAt") }}</span><strong class="ready-time">{{ formatDateTime(snapshot?.lastReadyAt, timezone, locale) }}</strong></article>
    </div>
    <p class="snapshot-foot">
      {{ t("dashboard.localFallbackNote") }}: {{ formatCount(snapshot?.localFallbackRunning, locale) }}
      <span v-if="comparisonLabel"> · {{ comparisonLabel }}</span>
    </p>
  </DashboardPanelShell>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { WorkerLiveSnapshotResult } from "@agent-workbench/shared";
import { formatComparison, formatCount, formatDateTime, formatRatio } from "../dashboard-formatters";
import DashboardPanelShell from "./DashboardPanelShell.vue";

const props = defineProps<{ result: WorkerLiveSnapshotResult; timezone: string }>();
const { t, locale } = useI18n();
const snapshot = computed(() => props.result.status === "unavailable" ? null : props.result.value);
const comparisonLabel = computed(() => props.result.status === "available" && props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : "");
</script>
<style scoped>
.snapshot-time,.snapshot-foot{margin:0;color:var(--text-color-secondary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.snapshot-time{margin-bottom:12px}
.snapshot-foot{margin-top:12px}
.snapshot-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.snapshot-grid article{min-width:0;min-height:90px;display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--border-color-secondary);border-radius:3px;background:var(--panel-bg);font-size:12px;color:var(--text-color-secondary)}
.snapshot-grid strong{font-size:25px;line-height:28px;font-weight:600;color:var(--text-color);font-variant-numeric:tabular-nums}
.snapshot-grid strong.ready-time{font-size:15px;line-height:1.5;overflow-wrap:anywhere}
.slot-usage{display:grid;gap:5px;margin-top:auto}
.slot-usage progress{display:block;width:100%;height:6px;accent-color:#1677ff}
@container (max-width: 850px){.snapshot-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width: 450px){.snapshot-grid{grid-template-columns:minmax(0,1fr)}}
</style>
