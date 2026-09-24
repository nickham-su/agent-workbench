<template>
  <DashboardPanelShell :title="title" :test-id="testId">
    <template v-if="panel.status === 'available' || panel.status === 'partial'">

      <div v-if="display.buckets.length" class="chart-layout">
        <div class="chart-y-axis" aria-hidden="true"><span v-for="tick in yTicks" :key="tick" :style="{ top: `${tickY(tick) / 60 * 100}%` }">{{ axisValueLabel(tick) }}</span></div>
        <div class="chart-plot">
      <svg class="trend" viewBox="0 0 100 60" preserveAspectRatio="none" role="group" aria-roledescription="chart" :aria-labelledby="`${chartTitleId} ${chartDescriptionId}`">
        <title :id="chartTitleId">{{ title }}</title>
        <desc :id="chartDescriptionId">{{ summary }}</desc>
        <line v-for="tick in yTicks" :key="tick" class="chart-grid-line" x1="6" x2="94" :y1="tickY(tick)" :y2="tickY(tick)" aria-hidden="true" />
        <template v-if="display.shape === 'line'">
          <polygon v-for="segment in (kind === 'monitoring_total' ? linePolylines : [])" :key="`area-${segment.series.key}-${segment.index}`" class="chart-area" :points="`${segment.points} ${segment.lastX},56 ${segment.x},56`" fill="#4f8cff" aria-hidden="true" />
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
      </svg>
      <div class="chart-x-axis" aria-hidden="true"><span v-for="bucket in visibleAxisBuckets" :key="`axis-${bucket.index}`" class="chart-axis-label" :style="{ left: `${bucket.x}%` }" :data-x="bucket.x">{{ bucket.label }}</span></div>
        </div>
      </div>

      <DashboardEmptyValue v-else />
      <ul v-if="display.series.length && display.buckets.length" class="chart-legend" :aria-label="`${title} ${t('dashboard.chartLegend')}`">
        <li v-for="series in display.series" :key="series.key">
          <span class="legend-swatch" :style="{ backgroundColor: series.color }" aria-hidden="true" />
          {{ seriesLabel(series.labelKey) }}
        </li>
      </ul>


      <details v-if="display.buckets.length" class="chart-details">
        <summary>{{ t('dashboard.chartBucketDetails') }}</summary>
        <div class="chart-table-scroll"><table>
          <thead><tr><th scope="col">{{ t('dashboard.chartBucket') }}</th><th v-for="series in display.series" :key="series.key" scope="col">{{ seriesLabel(series.labelKey) }}</th><th v-if="display.shape === 'stacked-bars'" scope="col">{{ t('dashboard.chartTotal') }}</th></tr></thead>
          <tbody>
            <tr v-for="(bucket, index) in display.buckets" :key="`detail-${index}`" :data-testid="`chart-bucket-detail-${index}`">
              <th scope="row">{{ bucketLabel(bucket) }}</th>
              <td v-for="(value, valueIndex) in bucket.values" :key="display.series[valueIndex]?.key">{{ valueLabel(value, display.series[valueIndex]?.labelKey) }}</td>
              <td v-if="display.shape === 'stacked-bars'">{{ countLabel(bucket.reportedTotal) }}</td>
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
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { createDashboardChartDisplay, knownStackTotal, splitLineSegments, type DashboardChartBucket, type DashboardChartKind, type DashboardChartSeries } from "../dashboard-chart-renderer";
import { formatChartAxisCount, formatChartDuration, formatComparison, formatCount, formatDateTime, formatRatio } from "../dashboard-formatters";
import type { DashboardTrendPanel } from "../dashboard-types";
import DashboardPanelShell from "./DashboardPanelShell.vue";
import DashboardEmptyValue from "./DashboardEmptyValue.vue";

type LineSegment = { series: DashboardChartSeries; index: number; points: string; pointCount: number; x: number; lastX: number; y: number };
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
const gitLowerBound = computed(() => props.gitMetadata !== undefined && props.panel.status === "partial");
const allLineValues = computed(() => display.value.series.flatMap((series) => series.values).filter((value): value is number => value !== null));
const stackTotals = computed(() => display.value.buckets.map((bucket) => knownStackTotal(bucket.values)));

// Display geometry only. Count/duration ticks must not imply fractional events,
// while the plotted maximum and labels must use the same scale.
function niceStep(target: number) {
  const power = 10 ** Math.floor(Math.log10(target));
  const normalized = target / power;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
}
const axisScale = computed(() => {
  const values = display.value.shape === "line" ? allLineValues.value : [
    ...stackTotals.value.filter((value): value is number => value !== null),
    // Incomplete Token compositions still show their known values as markers.
    ...(props.kind === "tokens" ? allLineValues.value : []),
  ];
  const maximum = Math.max(0, ...values);
  if (props.kind === "ratio") return { maximum: 1, ticks: [1, 0.75, 0.5, 0.25, 0] };
  if (maximum === 0) return { maximum: 1, ticks: [0] };
  const step = Math.max(1, niceStep(maximum / 4));
  const axisMaximum = Math.ceil(maximum / step) * step;
  const count = Math.round(axisMaximum / step);
  return { maximum: axisMaximum, ticks: Array.from({ length: count + 1 }, (_, index) => (count - index) * step) };
});
const lineMaximum = computed(() => axisScale.value.maximum);
const barMaximum = computed(() => axisScale.value.maximum);

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
  const label = formatCount(value, locale.value);
  return gitLowerBound.value && value !== null ? `≥${label}` : label;
}

function valueLabel(value: number | null, labelKey?: string) {
  if (value === null) return "—";
  if (labelKey === "ratio") return formatRatio(value, locale.value);
  if (labelKey === "duration") return formatChartDuration(value, locale.value);
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
      lastX: coordinates[coordinates.length - 1].x,
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
  return display.value.series.flatMap((series) => series.values.flatMap((value, index) => {
    if (value === null || stackTotals.value[index] !== null) return [];
    const barBucket = barBuckets.value[index];
    if (!barBucket) return [];
    const y = tickY(value);
    return [{ series, index, pointCount: 1, points: `${barBucket.x + barBucket.width / 2},${y}`, x: barBucket.x + barBucket.width / 2, lastX: barBucket.x + barBucket.width / 2, y }];
  }));
});

const yTicks = computed(() => axisScale.value.ticks);
function tickY(value: number) { return plotBottom - (value / axisScale.value.maximum) * (plotBottom - plotTop); }
function axisValueLabel(value: number) {
  if (props.kind === "ratio") return formatRatio(value, locale.value);
  if (props.kind === "duration") return formatChartDuration(value, locale.value);
  return formatChartAxisCount(Math.round(value), locale.value);
}
const visibleAxisBuckets = computed(() => {
  const buckets = axisBuckets.value;
  if (buckets.length < 2) return buckets;
  const stride = Math.max(1, Math.ceil((buckets.length - 1) / 4));
  return buckets.filter((bucket) => bucket.index === 0 || bucket.index === buckets.length - 1 || bucket.index % stride === 0);
});
const axisBuckets = computed(() => {
  const xPositions = display.value.shape === "line"
    ? display.value.buckets.map((_, index) => bucketX(index, display.value.buckets.length))
    : barBuckets.value.map((bucket) => bucket.x + bucket.width / 2);
  return display.value.buckets.map((bucket, index) => ({
    index,
    x: xPositions[index],
    label: bucket.from === null ? "—" : new Intl.DateTimeFormat(locale.value, {
      timeZone: props.timezone, month: "numeric", day: "numeric", hour: "2-digit", hour12: false,
    }).format(bucket.from),
  }));
});
const summary = computed(() => `${props.title}: ${display.value.shape}, ${display.value.buckets.length} ${t("dashboard.chartBuckets")}`);
const comparison = computed(() => props.panel.status === "available" && props.panel.comparison.status === "available" ? formatComparison(props.panel.comparison, locale.value) : "");
</script>

<style scoped>
.chart-layout{display:flex;gap:8px;min-width:0;margin-top:8px}.chart-y-axis{position:relative;width:52px;flex:none;height:200px;text-align:right;color:var(--text-color-secondary);font-size:10px;font-variant-numeric:tabular-nums}.chart-y-axis span{position:absolute;right:0;transform:translateY(-50%);white-space:nowrap}.chart-plot{min-width:0;flex:1}.trend{display:block;width:100%;height:200px;overflow:hidden}.chart-grid-line{stroke:var(--border-color-secondary);stroke-width:.4;vector-effect:non-scaling-stroke}.chart-area{opacity:.12}.line-segment{vector-effect:non-scaling-stroke}.line-marker{stroke:var(--panel-bg-elevated);stroke-width:.5;vector-effect:non-scaling-stroke}.bar-segment{vector-effect:non-scaling-stroke}.chart-hit{fill:transparent;outline:none}.chart-bucket:focus{outline:none}.chart-bucket:focus .chart-hit{stroke:#69b1ff;stroke-width:.6}.chart-x-axis{position:relative;height:21px;margin:0;color:var(--text-color-secondary);font-size:10px}.chart-axis-label{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap;font-variant-numeric:tabular-nums}.chart-axis-label:first-child{transform:none}.chart-axis-label:last-child{transform:translateX(-100%)}.chart-legend{display:flex;flex-wrap:wrap;gap:6px 14px;list-style:none;margin:8px 0;padding:0;color:var(--text-color-secondary);font-size:11px}.chart-legend li{display:flex;align-items:center;gap:5px}.legend-swatch{width:9px;height:9px;border-radius:50%;display:inline-block}.chart-details{margin-top:8px;color:var(--text-color-secondary);font-size:12px}.chart-details summary{cursor:pointer}.chart-table-scroll{max-width:100%;overflow-x:auto}.chart-details table{width:100%;min-width:max-content;border-collapse:collapse;margin-top:6px}.chart-details th,.chart-details td{padding:4px;text-align:right;border-top:1px solid var(--border-color-secondary);font-variant-numeric:tabular-nums}.chart-details th:first-child{text-align:left}.reason,.comparison{font-size:11px;color:var(--text-color-secondary);margin:8px 0 0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(max-width:560px){.chart-y-axis{width:48px}.chart-axis-label{font-size:9px}.chart-axis-label:not(:first-child):not(:last-child){display:none}}
</style>
