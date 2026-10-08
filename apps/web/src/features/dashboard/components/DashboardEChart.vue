<template>
  <div class="echarts-wrapper">
    <div class="echarts-legend" role="group" :aria-label="`${title} ${t('dashboard.chartLegend')}`">
      <button v-for="series in display.series" :key="series.key" type="button" :aria-pressed="visibleKeys.has(series.key)" :class="{ inactive: !visibleKeys.has(series.key) }" @click="toggleSeries(series.key)">
        <span class="legend-swatch" :style="{ backgroundColor: series.color }" aria-hidden="true" />{{ t(`dashboard.${series.labelKey}`) }}
      </button>
    </div>
    <div ref="host" class="echarts-chart" role="group" tabindex="0" :aria-label="summary" @keydown="onKeydown" @focus="focusBucket" @blur="blurBucket" />
    <p v-if="!visibleKeys.size" class="echarts-no-series" role="status">{{ t('dashboard.chartNoSeriesSelected') }}</p>
    <p v-if="activeBucket !== null" class="keyboard-bucket" role="status">{{ bucketDescription(activeBucket) }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { init, use, type ECharts } from "echarts/core";
import { LineChart, BarChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { dashboardEChartsOptions } from "../dashboard-echarts-options";
import { knownStackTotal, type DashboardChartBucket, type DashboardChartDisplay } from "../dashboard-chart-renderer";
import { formatChartAxisCount, formatChartBucketInterval, formatChartDuration, formatCount, formatDateTime, formatRatio } from "../dashboard-formatters";

use([LineChart, BarChart, ScatterChart, GridComponent, TooltipComponent, SVGRenderer]);

const props = defineProps<{ display: DashboardChartDisplay; title: string; summary: string; timezone: string; overview?: boolean }>();
const { t, locale } = useI18n();
const host = ref<HTMLElement | null>(null);
const activeBucket = ref<number | null>(null);
const visibleKeys = ref(new Set(props.display.series.map((series) => series.key)));
let chart: ECharts | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;

function bucketLabel(bucket: DashboardChartBucket): string {
  return formatChartBucketInterval(bucket.from, bucket.to, props.timezone, locale.value);
}
function valueLabel(value: number | null, key: string): string {
  if (value === null) return "—";
  if (key === "ratio") return formatRatio(value, locale.value);
  if (key === "duration") return formatChartDuration(value, locale.value);
  return formatCount(value, locale.value);
}
function bucketDescription(index: number): string {
  const bucket = props.display.buckets[index];
  if (!bucket) return "";
  const values = bucket.values.flatMap((value, i) => {
    const series = props.display.series[i];
    return visibleKeys.value.has(series.key) ? [`${t(`dashboard.${series.labelKey}`)} ${valueLabel(value, series.labelKey)}`] : [];
  });
  if (props.display.kind === "model_status")
    values.push(`${t("dashboard.chartAllStatusTotal")} ${valueLabel(knownStackTotal(bucket.values), "count")}`);
  return `${t("dashboard.chartBucket")} ${index + 1}, ${bucketLabel(bucket)}: ${values.join(", ")}`;
}
function tooltipSeriesIndex(index: number): number | null {
  if (props.display.kind !== "tokens" || props.overview) return 0;
  const bucket = props.display.buckets[index];
  if (!bucket) return null;
  const visible = props.display.series.map((series, originalIndex) => ({ series, originalIndex }))
    .filter(({ series }) => visibleKeys.value.has(series.key));
  if (knownStackTotal(bucket.values) !== null) return visible.length ? 0 : null;
  // In standard Token charts each visible series yields [bar, scatter]. A
  // partial bucket's bars are null; only a known, visible scatter can host a tip.
  const scatterIndex = visible.findIndex(({ originalIndex }) => bucket.values[originalIndex] !== null);
  return scatterIndex < 0 ? null : scatterIndex * 2 + 1;
}
function syncKeyboardTooltip(): void {
  chart?.dispatchAction({ type: "hideTip" });
  if (activeBucket.value === null || !visibleKeys.value.size) return;
  const seriesIndex = tooltipSeriesIndex(activeBucket.value);
  if (seriesIndex !== null)
    chart?.dispatchAction({ type: "showTip", seriesIndex, dataIndex: activeBucket.value });
}
function render(): void {
  if (!chart || !host.value) return;
  const style = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  chart.setOption(dashboardEChartsOptions(props.display, {
    series: (key) => t(`dashboard.${key}`), bucket: bucketLabel,
    axisBucket: (bucket) => formatDateTime(bucket.from, props.timezone, locale.value), value: valueLabel,
    axis: (value) => props.display.kind === "ratio" ? formatRatio(value, locale.value) : props.display.kind === "duration" ? formatChartDuration(value, locale.value) : formatChartAxisCount(Math.round(value), locale.value),
    allStatusesTotal: t("dashboard.chartAllStatusTotal"),
    total: t("dashboard.chartTotal"),
  }, {
    text: color("--text-color", "#ddd"), secondary: color("--text-secondary", "#aaa"),
    border: color("--border-color-secondary", "#555"), background: color("--panel-bg-elevated", "#222"),
  }, visibleKeys.value, props.overview ? "overview" : "standard"), { notMerge: true });
  syncKeyboardTooltip();
}
function toggleSeries(key: string): void {
  const next = new Set(visibleKeys.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  visibleKeys.value = next;
  if (!next.size) activeBucket.value = null;
  render();
}
function focusBucket(): void {
  if (!props.display.buckets.length || !visibleKeys.value.size) return;
  activeBucket.value = 0;
  syncKeyboardTooltip();
}
function blurBucket(): void {
  activeBucket.value = null;
  chart?.dispatchAction({ type: "hideTip" });
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  if (!props.display.buckets.length || !visibleKeys.value.size) return;
  event.preventDefault();
  activeBucket.value = Math.max(0, Math.min(props.display.buckets.length - 1, (activeBucket.value ?? 0) + (event.key === "ArrowRight" ? 1 : -1)));
  syncKeyboardTooltip();
}
watch(() => props.display, (current, previous) => {
  const keys = current.series.map((series) => series.key);
  if (current.kind !== previous.kind || keys.join("|") !== previous.series.map((series) => series.key).join("|")) {
    visibleKeys.value = new Set(keys);
    if (activeBucket.value !== null) activeBucket.value = 0;
  }
  if (!current.buckets.length || !visibleKeys.value.size) activeBucket.value = null;
  else if (activeBucket.value !== null) activeBucket.value = Math.min(activeBucket.value, current.buckets.length - 1);
  render();
});
watch(() => [props.title, props.timezone, locale.value], render);
onMounted(() => {
  // Detached component mounts in unit tests have no layout; the actual dashboard is attached.
  if (!host.value?.isConnected) return;
  chart = init(host.value, undefined, { renderer: "svg", width: host.value.clientWidth || 400, height: host.value.clientHeight || 236 });
  render();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host.value);
  } else window.addEventListener("resize", resize);
  if (typeof window.MutationObserver !== "undefined") {
    themeObserver = new window.MutationObserver(render);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  }
});
function resize(): void {
  if (!host.value || !chart || !host.value.clientWidth || !host.value.clientHeight) return;
  chart.resize({ width: host.value.clientWidth, height: host.value.clientHeight });
}
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  window.removeEventListener("resize", resize);
  chart?.dispose();
});
</script>

<style scoped>
.echarts-wrapper{position:relative;min-width:0;margin-top:8px}.echarts-legend{display:flex;flex-wrap:wrap;gap:4px 10px}.echarts-legend button{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--text-secondary);padding:3px 5px;cursor:pointer;font-size:11px}.echarts-legend button:not(.inactive){color:var(--text-color)}.echarts-legend button.inactive{opacity:.5}.echarts-legend button:focus-visible{outline:2px solid var(--primary-color,#69b1ff)}.legend-swatch{width:9px;height:9px;border-radius:50%}.echarts-chart{width:100%;height:236px;outline:none}.echarts-chart:focus-visible{outline:2px solid var(--primary-color,#69b1ff);outline-offset:2px}.echarts-no-series{position:absolute;top:50%;width:100%;text-align:center;pointer-events:none;color:var(--text-secondary);font-size:12px}.keyboard-bucket{margin:4px 0;color:var(--text-secondary);font-size:11px}
</style>
