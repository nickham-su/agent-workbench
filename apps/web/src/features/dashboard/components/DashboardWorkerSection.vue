<template>
  <div class="worker-section">
    <DashboardWorkerSnapshot :result="liveSnapshot" :timezone="timezone" />
    <div class="worker-metrics">
      <DashboardMetricCard :title="t('dashboard.unexpectedExits')" :value="formatCount(metricNumberValue(worker.metrics.unexpectedExits), locale)" :result="worker.metrics.unexpectedExits" test-id="worker-metric-unexpectedExits" />
      <DashboardMetricCard :title="t('dashboard.workerRestartCount')" :value="formatCount(metricNumberValue(worker.metrics.restartAttempts), locale)" :result="worker.metrics.restartAttempts" test-id="worker-metric-restartAttempts" />
      <DashboardMetricCard :title="t('dashboard.restartFailed')" :value="formatCount(metricNumberValue(worker.metrics.restartFailed), locale)" :result="worker.metrics.restartFailed" test-id="worker-metric-restartFailed" />
    </div>
    <p class="worker-success" data-testid="worker-restart-succeeded">
      {{ t('dashboard.restartSucceeded') }}: <strong>{{ formatCount(metricNumberValue(worker.metrics.restartSucceeded), locale) }}</strong>
      <span v-if="successComparison"> · {{ successComparison }}</span>
    </p>
    <div class="worker-main" data-testid="worker-main">
      <DashboardTrendChart :title="t('dashboard.restarts')" kind="worker_events" :panel="worker.eventTrend" :timezone="timezone" />
      <DashboardRestartRecords :result="worker.restartRecords" :timezone="timezone" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatComparison, formatCount } from "../dashboard-formatters";
import { metricNumberValue } from "../dashboard-types";
import DashboardMetricCard from "./DashboardMetricCard.vue";
import DashboardRestartRecords from "./DashboardRestartRecords.vue";
import DashboardTrendChart from "./DashboardTrendChart.vue";
import DashboardWorkerSnapshot from "./DashboardWorkerSnapshot.vue";

const props = defineProps<{
  worker: DashboardData["worker"];
  liveSnapshot: DashboardData["exceptions"]["workerLiveSnapshot"];
  timezone: string;
}>();
const { t, locale } = useI18n();
const successComparison = computed(() => props.worker.metrics.restartSucceeded.status === "available" && props.worker.metrics.restartSucceeded.comparison.status === "available"
  ? formatComparison(props.worker.metrics.restartSucceeded.comparison, locale.value) : "");
</script>
<style scoped>
.worker-section{display:grid;gap:12px;min-width:0}
.worker-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.worker-success{margin:0;padding:0 2px;font-size:12px;line-height:1.5;color:var(--text-color-secondary)}
.worker-success strong{color:var(--text-color);font-variant-numeric:tabular-nums}
.worker-main{display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:12px;align-items:stretch;min-width:0}
.worker-main>*{min-width:0}
@container (max-width: 900px){.worker-main{grid-template-columns:minmax(0,1fr)}}
@container (max-width: 600px){.worker-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width: 420px){.worker-metrics{grid-template-columns:minmax(0,1fr)}}
</style>
