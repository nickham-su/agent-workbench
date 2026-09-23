<template>
  <section class="panel" :aria-label="title" :data-testid="testId">
    <header><h3>{{ title }}</h3><DashboardStatusBadge :status="panel.status" /></header>
    <template v-if="panel.status === 'available' || panel.status === 'partial'">
      <ul v-if="display.series.length" class="chart-legend" :aria-label="`${title} ${t('dashboard.chartLegend')}`">
        <li v-for="series in display.series" :key="series.key">
          <span class="legend-swatch" :style="{ backgroundColor: series.color }" aria-hidden="true" />
          {{ seriesLabel(series.labelKey) }}
        </li>
      </ul>

      <svg class="trend" viewBox="0 0 100 72" preserveAspectRatio="none" role="group" aria-roledescription="chart" :aria-labelledby="`${chartTitleId} ${chartDescriptionId}`">
        <title :id="chartTitleId">{{ title }}</title>
        <desc :id="chartDescriptionId">{{ summary }}</desc>
        <line class="chart-baseline" x1="6" x2="94" y1="56" y2="56" aria-hidden="true" />
        <template v-if="display.shape === 'line'">
          <polyline
            v-for="segment in linePolylines"
            :key="`${segment.series.key}-${segment.index}`"
            class="line-segment"
            :data-series="segment.series.key"
            :data-segment="segment.index"
            :points="segment.points"
            fill="none"
            :stroke="segment.series.color"
            stroke-width="2"
            aria-hidden="true"
          />
          <circle
            v-for="marker in lineMarkers"
            :key="`${marker.series.key}-${marker.index}`"
            class="line-marker"
            :data-series="marker.series.key"
            :data-segment="marker.index"
            :cx="marker.x"
            :cy="marker.y"
            r="1.8"
            :fill="marker.series.color"
            aria-hidden="true"
          />
          <g v-for="bucket in lineBuckets" :key="`line-${bucket.index}`" class="chart-bucket" role="group" tabindex="0" :aria-label="bucket.ariaLabel">
            <title>{{ bucket.ariaLabel }}</title>
            <rect class="chart-hit" :x="bucket.x - bucket.width / 2" y="4" :width="bucket.width" height="52" aria-hidden="true" />
          </g>
        </template>
        <template v-else>
          <g v-for="bucket in barBuckets" :key="`bar-${bucket.index}`" class="chart-bucket" role="group" tabindex="0" :aria-label="bucket.ariaLabel" :data-stack-total="bucket.reportedTotal ?? 'unknown'" :data-testid="`stacked-bars-bucket-${bucket.index}`">
            <title>{{ bucket.ariaLabel }}</title>
            <rect
              v-for="segment in bucket.segments"
              :key="segment.series.key"
              class="bar-segment stacked-bars"
              :data-series="segment.series.key"
              :data-value="segment.value"
              :x="segment.x"
              :y="segment.y"
              :width="segment.width"
              :height="segment.height"
              :fill="segment.series.color"
              aria-hidden="true"
            />
            <rect class="chart-hit" :x="bucket.x" y="4" :width="bucket.width" height="52" aria-hidden="true" />
          </g>
          <circle
            v-for="marker in tokenFallbackMarkers"
            :key="`token-marker-${marker.series.key}-${marker.index}`"
            class="line-marker token-fallback-marker"
            :data-series="marker.series.key"
            :data-segment="marker.index"
            :cx="marker.x"
            :cy="marker.y"
            r="1.8"
            :fill="marker.series.color"
            aria-hidden="true"
          />
        </template>
        <text v-for="bucket in axisBuckets" :key="`axis-${bucket.index}`" class="chart-axis-label" :x="bucket.x" y="68" text-anchor="middle" aria-hidden="true">{{ bucket.label }}</text>
      </svg>

      <details v-if="display.buckets.length" class="chart-details">
        <summary>{{ t('dashboard.chartBucketDetails') }}</summary>
        <table>
          <thead><tr><th scope="col">{{ t('dashboard.chartBucket') }}</th><th v-for="series in display.series" :key="series.key" scope="col">{{ seriesLabel(series.labelKey) }}</th><th v-if="display.shape === 'stacked-bars'" scope="col">{{ t('dashboard.chartTotal') }}</th></tr></thead>
          <tbody>
            <tr v-for="(bucket, index) in display.buckets" :key="`detail-${index}`" :data-testid="`chart-bucket-detail-${index}`">
              <th scope="row">{{ bucketLabel(bucket) }}</th>
              <td v-for="(value, valueIndex) in bucket.values" :key="display.series[valueIndex]?.key">{{ valueLabel(value, display.series[valueIndex]?.labelKey) }}</td>
              <td v-if="display.shape === 'stacked-bars'">{{ countLabel(bucket.reportedTotal) }}</td>
            </tr>
          </tbody>
        </table>
      </details>

      <p class="sr-only">{{ summary }}</p>
      <p v-if="panel.status === 'partial' && gitMetadata" class="reason">{{ t("dashboard.knownPartialLowerBound") }} · {{ t("dashboard.readyRepos") }}: {{ gitMetadata.readyRepoCount }}/{{ gitMetadata.totalRepoCount }}</p>
      <p v-if="panel.status === 'partial'" class="reason">{{ t(`dashboard.reason.${panel.partialReason}`) }} · {{ comparison }}</p>
      <p v-else class="comparison">{{ comparison }}</p>
    </template>
    <p v-else class="reason">{{ t(`dashboard.reason.${panel.unavailableReason}`) }} · {{ comparison }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { createDashboardChartDisplay, knownStackTotal, splitLineSegments, type DashboardChartBucket, type DashboardChartKind, type DashboardChartSeries } from "../dashboard-chart-renderer";
import { formatComparison, formatCount, formatDateTime, formatDuration, formatRatio } from "../dashboard-formatters";
import type { DashboardTrendPanel } from "../dashboard-types";
import DashboardStatusBadge from "./DashboardStatusBadge.vue";

type LineSegment = { series: DashboardChartSeries; index: number; points: string; pointCount: number; x: number; y: number };
type LineBucket = { index: number; x: number; width: number; ariaLabel: string };
type BarSegment = { series: DashboardChartSeries; value: number; x: number; y: number; width: number; height: number };
type BarBucket = { index: number; x: number; width: number; reportedTotal: number | null; ariaLabel: string; segments: BarSegment[] };

const props = withDefaults(defineProps<{
  title: string;
  kind: DashboardChartKind;
  panel: DashboardTrendPanel;
  timezone?: string;
  gitMetadata?: { readyRepoCount: number; totalRepoCount: number };
  testId?: string;
}>(), { timezone: "UTC" });

const { t, locale } = useI18n();
const chartId = useId();
const chartTitleId = `dashboard-chart-title-${chartId}`;
const chartDescriptionId = `dashboard-chart-description-${chartId}`;
const plotLeft = 6;
const plotRight = 94;
const plotTop = 4;
const plotBottom = 56;

const display = computed(() => createDashboardChartDisplay(props.kind, props.panel.status === "unavailable" ? [] : props.panel.data));
const allLineValues = computed(() => display.value.series.flatMap((series) => series.values).filter((value): value is number => value !== null));
const lineMaximum = computed(() => Math.max(1, ...allLineValues.value));
const stackTotals = computed(() => display.value.buckets.map((bucket) => knownStackTotal(bucket.values)));
const barMaximum = computed(() => Math.max(1, ...stackTotals.value.filter((value): value is number => value !== null)));

function bucketX(index: number, size: number) {
  return size < 2 ? (plotLeft + plotRight) / 2 : plotLeft + (index * (plotRight - plotLeft)) / (size - 1);
}

function bucketWidth(size: number) {
  return size === 0 ? plotRight - plotLeft : Math.min(12, (plotRight - plotLeft) / size * 0.72);
}

function seriesLabel(labelKey: string) {
  return t(`dashboard.${labelKey}`);
}

function countLabel(value: number | null) {
  return formatCount(value, locale.value);
}

function valueLabel(value: number | null, labelKey?: string) {
  if (value === null) return "—";
  if (labelKey === "ratio") return formatRatio(value, locale.value);
  if (labelKey === "duration") return formatDuration(value);
  return countLabel(value);
}

function bucketLabel(bucket: DashboardChartBucket) {
  return `${formatDateTime(bucket.from, props.timezone, locale.value)} – ${formatDateTime(bucket.to, props.timezone, locale.value)}`;
}

function bucketAriaLabel(bucket: DashboardChartBucket, index: number) {
  const values = bucket.values.map((value, valueIndex) => `${seriesLabel(display.value.series[valueIndex]?.labelKey ?? "unknown")} ${valueLabel(value, display.value.series[valueIndex]?.labelKey)}`);
  const total = display.value.shape === "stacked-bars" ? `; ${t("dashboard.chartTotal")} ${countLabel(bucket.reportedTotal)}` : "";
  return `${t("dashboard.chartBucket")} ${index + 1}, ${bucketLabel(bucket)}: ${values.join(", ")}${total}`;
}

function pointCoordinates(index: number, value: number, bucketCount: number) {
  return {
    x: bucketX(index, bucketCount),
    y: plotBottom - (value / lineMaximum.value) * (plotBottom - plotTop),
  };
}

const lineSegments = computed<LineSegment[]>(() => {
  const bucketCount = display.value.buckets.length;
  return display.value.series.flatMap((series) => splitLineSegments(series.values).map((segment, index) => {
    const coordinates = segment.map((point) => pointCoordinates(point.index, point.value, bucketCount));
    return {
      series,
      index,
      pointCount: coordinates.length,
      points: coordinates.map((point) => `${point.x},${point.y}`).join(" "),
      x: coordinates[0].x,
      y: coordinates[0].y,
    };
  }));
});
const linePolylines = computed(() => lineSegments.value.filter((segment) => segment.pointCount >= 2));
const lineMarkers = computed(() => lineSegments.value.filter((segment) => segment.pointCount === 1));

const lineBuckets = computed<LineBucket[]>(() => display.value.buckets.map((bucket, index) => ({
  index,
  x: bucketX(index, display.value.buckets.length),
  width: Math.max(4, (plotRight - plotLeft) / Math.max(1, display.value.buckets.length)),
  ariaLabel: bucketAriaLabel(bucket, index),
})));

const barBuckets = computed<BarBucket[]>(() => {
  const bucketCount = display.value.buckets.length;
  const width = bucketWidth(bucketCount);
  const slotWidth = (plotRight - plotLeft) / Math.max(1, bucketCount);
  return display.value.buckets.map((bucket, index) => {
    const stackTotal = stackTotals.value[index];
    const reportedTotal = props.kind === "monitoring" ? bucket.reportedTotal : stackTotal;
    const x = plotLeft + index * slotWidth + (slotWidth - width) / 2;
    const segments: BarSegment[] = [];
    if (stackTotal !== null) {
      let accumulated = 0;
      for (const [seriesIndex, value] of bucket.values.entries()) {
        const numericValue = value ?? 0;
        const height = (numericValue / barMaximum.value) * (plotBottom - plotTop);
        const y = plotBottom - ((accumulated + numericValue) / barMaximum.value) * (plotBottom - plotTop);
        segments.push({ series: display.value.series[seriesIndex], value: numericValue, x, y, width, height });
        accumulated += numericValue;
      }
    }
    return { index, x, width, reportedTotal, ariaLabel: bucketAriaLabel(bucket, index), segments };
  });
});

/**
 * Token bars require both values for an honest composition. For every bucket
 * whose composition is incomplete, retain each known series value as a marker
 * instead of drawing a false zero-valued stack or joining a line across it.
 */
const tokenFallbackMarkers = computed(() => {
  if (props.kind !== "tokens") return [] as LineSegment[];
  const bucketCount = display.value.buckets.length;
  return display.value.series.flatMap((series) => series.values.flatMap((value, index) => {
    if (value === null || stackTotals.value[index] !== null) return [];
    const barBucket = barBuckets.value[index];
    if (!barBucket) return [];
    const coordinates = pointCoordinates(index, value, bucketCount);
    return [{ series, index, pointCount: 1, points: `${barBucket.x + barBucket.width / 2},${coordinates.y}`, x: barBucket.x + barBucket.width / 2, y: coordinates.y }];
  }));
});

const axisBuckets = computed(() => {
  const xPositions = display.value.shape === "line"
    ? display.value.buckets.map((_, index) => bucketX(index, display.value.buckets.length))
    : barBuckets.value.map((bucket) => bucket.x + bucket.width / 2);
  return display.value.buckets.map((bucket, index) => ({
    index,
    x: xPositions[index],
    label: formatDateTime(bucket.from, props.timezone, locale.value),
  }));
});
const summary = computed(() => `${props.title}: ${display.value.shape}, ${display.value.buckets.length} ${t("dashboard.chartBuckets")}`);
const comparison = computed(() => props.panel.comparison.status === "available" ? formatComparison(props.panel.comparison, locale.value) : t(`dashboard.comparison.${props.panel.comparison.status}`));
</script>

<style scoped>
.panel{background:var(--panel-bg-elevated);border:1px solid var(--border-color);border-radius:8px;padding:14px}.panel header{display:flex;justify-content:space-between;align-items:center;gap:12px}.panel h3{font-size:14px;margin:0}.trend{height:190px;width:100%;margin-top:8px;overflow:visible;background:linear-gradient(180deg,transparent 97%,var(--border-color) 97%)}.chart-baseline{stroke:var(--border-color);stroke-width:.5}.line-segment{vector-effect:non-scaling-stroke}.line-marker{stroke:var(--panel-bg-elevated);stroke-width:.5;vector-effect:non-scaling-stroke}.bar-segment{vector-effect:non-scaling-stroke}.chart-hit{fill:transparent;outline:none}.chart-bucket:focus{outline:none}.chart-bucket:focus .chart-hit{stroke:var(--primary);stroke-width:.6}.chart-axis-label{fill:var(--text-tertiary);font-size:3px}.chart-legend{display:flex;flex-wrap:wrap;gap:6px 14px;list-style:none;margin:10px 0 0;padding:0;color:var(--text-color-secondary);font-size:12px}.chart-legend li{display:flex;align-items:center;gap:5px}.legend-swatch{width:9px;height:9px;border-radius:2px;display:inline-block}.chart-details{margin-top:8px;color:var(--text-color-secondary);font-size:12px}.chart-details summary{cursor:pointer}.chart-details table{width:100%;border-collapse:collapse;margin-top:6px}.chart-details th,.chart-details td{padding:4px;text-align:right;border-top:1px solid var(--border-color-secondary);font-variant-numeric:tabular-nums}.chart-details th:first-child{text-align:left}.reason,.comparison{font-size:12px;color:var(--text-color-secondary)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
</style>
