<template>
  <DashboardPanelShell :title="t('dashboard.restartRecords')">
    <p v-if="comparisonLabel">{{ comparisonLabel }}</p>
    <div v-if="result.status !== 'unavailable' && result.data.length" class="table-wrap"><table><thead><tr><th scope="col">{{ t("dashboard.occurredAt") }}</th><th scope="col">{{ t("dashboard.event") }}</th><th scope="col">{{ t("dashboard.restartStatus") }}</th></tr></thead><tbody><tr v-for="record in result.data" :key="`${record.occurredAt}-${record.event}`"><td>{{ formatDateTime(record.occurredAt, timezone, locale) }}</td><td>{{ t(`dashboard.workerEvent.${record.event}`) }}</td><td>{{ t(`dashboard.restartStatusValue.${record.restartStatus}`) }}</td></tr></tbody></table></div>
    <DashboardEmptyValue v-else />
  </DashboardPanelShell>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { DashboardData } from "@agent-workbench/shared";
import { formatComparison, formatDateTime } from "../dashboard-formatters";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardEmptyValue from "./DashboardEmptyValue.vue";
const props = defineProps<{ result: DashboardData["worker"]["restartRecords"]; timezone: string }>();
const { t, locale } = useI18n();
const comparisonLabel = computed(() => props.result.status === "available" && props.result.comparison.status === "available" ? formatComparison(props.result.comparison, locale.value) : "");
</script>
<style scoped>p,table{font-size:12px;color:var(--text-color-secondary)}.table-wrap{max-width:100%;overflow-x:auto}table{width:100%;min-width:400px;border-collapse:collapse}th,td{padding:8px;border-top:1px solid var(--border-color);text-align:left;white-space:nowrap}</style>
