<template>
  <section class="panel">
    <header><h3>{{ t("dashboard.liveSnapshot") }}</h3><DashboardStatusBadge :status="result.status" /></header>
    <p>{{ t("dashboard.snapshotAt") }}: {{ formatDateTime(result.snapshotAt, timezone, locale) }} · {{ t("dashboard.asOf") }}: {{ formatDateTime(result.asOf, timezone, locale) }}</p>
    <template v-if="result.status !== 'unavailable'">
      <div class="snapshot-grid"><article v-for="item in cards" :key="item.label"><span>{{ item.label }}</span><b>{{ item.value }}</b></article></div>
      <p>{{ t("dashboard.localFallback") }}: {{ formatCount(result.value.localFallbackRunning, locale) }}</p>
      <p v-if="result.status === 'partial'">{{ t(`dashboard.reason.${result.partialReason}`) }} · {{ comparisonLabel }}</p><p v-else>{{ comparisonLabel }}</p>
    </template>
    <p v-else>{{ t(`dashboard.reason.${result.unavailableReason}`) }} · {{ comparisonLabel }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { WorkerLiveSnapshotResult } from "@agent-workbench/shared";
import { formatComparison, formatCount, formatDateTime } from "../dashboard-formatters";
import DashboardStatusBadge from "./DashboardStatusBadge.vue";
const props = defineProps<{ result: WorkerLiveSnapshotResult; timezone: string }>();
const { t, locale } = useI18n();
const cards = computed(() => {
  if (props.result.status === "unavailable") return [];
  const value = props.result.value;
  return [{ label: t("dashboard.running"), value: formatCount(value.running, locale.value) }, { label: t("dashboard.queued"), value: formatCount(value.queued, locale.value) }, { label: t("dashboard.concurrency"), value: formatCount(value.concurrency, locale.value) }, { label: t("dashboard.lastReadyAt"), value: formatDateTime(value.lastReadyAt, props.timezone, locale.value) }];
});
const comparisonLabel = computed(() => props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : t(`dashboard.comparison.${props.result.comparison.status}`));
</script>
<style scoped>.panel{background:var(--panel-bg-elevated);border:1px solid var(--border-color);border-radius:8px;padding:14px}.panel header{display:flex;justify-content:space-between}.panel h3{font-size:14px;margin:0}.panel p{font-size:12px;color:var(--text-color-secondary)}.snapshot-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.snapshot-grid article{display:grid;gap:6px;padding:8px;border-radius:5px;background:var(--panel-bg);font-size:12px}.snapshot-grid b{font-size:20px}@media(max-width:700px){.snapshot-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}</style>
