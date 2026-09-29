<template>
  <DashboardPanelShell :title="title" :test-id="testId">
    <template v-if="panel.status === 'available' || panel.status === 'partial'">
      <DashboardEChart v-if="display.buckets.length" :display="display" :title="title" :summary="summary" :timezone="timezone" :overview="echarts" />
      <DashboardEmptyValue v-else />
      <details v-if="display.buckets.length" class="chart-details">
        <summary>{{ t('dashboard.chartBucketDetails') }}</summary>
        <div class="chart-table-scroll"><table>
          <thead><tr><th scope="col">{{ t('dashboard.chartBucket') }}</th><th v-for="series in display.series" :key="series.key" scope="col">{{ t(`dashboard.${series.labelKey}`) }}</th><th v-if="display.shape === 'stacked-bars'" scope="col">{{ kind === 'model_status' && echarts ? t('dashboard.chartAllStatusTotal') : t('dashboard.chartTotal') }}</th></tr></thead>
          <tbody>
            <tr v-for="(bucket, index) in display.buckets" :key="index" :data-testid="`chart-bucket-detail-${index}`">
              <th scope="row">{{ formatChartBucketInterval(bucket.from, bucket.to, timezone, locale) }}</th>
              <td v-for="(value, valueIndex) in bucket.values" :key="display.series[valueIndex]?.key">{{ valueLabel(value, display.series[valueIndex]?.labelKey) }}</td>
              <td v-if="display.shape === 'stacked-bars'">{{ formatCount(bucketTotal(bucket), locale) }}</td>
            </tr>
          </tbody>
        </table></div>
      </details>
      <p class="sr-only">{{ summary }}</p>
      <p v-if="comparison" class="comparison">{{ comparison }}</p>
    </template>
    <DashboardEmptyValue v-else />
  </DashboardPanelShell>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { createDashboardChartDisplay, knownStackTotal, type DashboardChartBucket, type DashboardChartKind } from "../dashboard-chart-renderer";
import { formatChartBucketInterval, formatChartDuration, formatComparison, formatCount, formatRatio } from "../dashboard-formatters";
import type { DashboardTrendPanel } from "../dashboard-types";
import DashboardEChart from "./DashboardEChart.vue";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardEmptyValue from "./DashboardEmptyValue.vue";

const props = withDefaults(defineProps<{
  title: string;
  kind: DashboardChartKind;
  panel: DashboardTrendPanel;
  /** Overview uses independent smoothed lines even for request status counts. */
  echarts?: boolean;
  timezone?: string;
  testId?: string;
}>(), { timezone: "UTC" });
const { t, locale } = useI18n();
const display = computed(() => createDashboardChartDisplay(props.kind, props.panel.status === "unavailable" ? [] : props.panel.data));
const summary = computed(() => `${props.title}: ${t(props.echarts || display.value.shape === "line" ? "dashboard.chartSmoothLine" : "dashboard.chartStackedBars")}, ${display.value.buckets.length} ${t("dashboard.chartBuckets")}`);
const comparison = computed(() => props.panel.status === "available" && props.panel.comparison.status === "available" ? formatComparison(props.panel.comparison, locale.value) : "");
function bucketTotal(bucket: DashboardChartBucket): number | null {
  return props.kind === "monitoring" ? bucket.reportedTotal : knownStackTotal(bucket.values);
}
function valueLabel(value: number | null, labelKey?: string): string {
  if (labelKey === "ratio") return formatRatio(value, locale.value);
  if (labelKey === "duration") return value === null ? "—" : formatChartDuration(value, locale.value);
  return formatCount(value, locale.value);
}
</script>

<style scoped>
.chart-details{margin-top:8px;color:var(--text-secondary);font-size:12px}.chart-details summary{cursor:pointer}.chart-table-scroll{max-width:100%;overflow-x:auto}.chart-details table{width:100%;min-width:max-content;border-collapse:collapse;margin-top:6px}.chart-details th,.chart-details td{padding:4px;text-align:right;border-top:1px solid var(--border-color-secondary);font-variant-numeric:tabular-nums}.chart-details th:first-child{text-align:left}.comparison{font-size:11px;color:var(--text-secondary);margin:8px 0 0}
</style>
