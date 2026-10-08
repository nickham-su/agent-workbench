<template>
  <div class="distribution-chart-wrap">
    <div ref="host" class="distribution-echart" role="group" tabindex="0" :aria-label="description" :style="{ height: variant === 'donut' ? '180px' : `${Math.max(110, rows.length * 38)}px` }" @focus="focusFirst" @blur="blur" @keydown="onKeydown" />
    <div v-if="variant === 'donut'" class="donut-center" aria-hidden="true"><b>{{ formatCount(total, locale) }}</b><small>{{ partial ? t('dashboard.knownObserved') : labelGroup === 'runStatus' ? t('dashboard.terminalRunTotal') : t('dashboard.distributionTotal') }}</small></div>
    <p v-if="selected !== null" class="distribution-current" role="status">{{ rowDescription(selected) }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { init, use, type ECharts } from "echarts/core";
import { PieChart, BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { dashboardDistributionOptions, type DashboardDistributionRow } from "../dashboard-distribution-echarts-options";
import { formatCount, formatRatio } from "../dashboard-formatters";

use([PieChart, BarChart, GridComponent, TooltipComponent, SVGRenderer]);
const props = defineProps<{ title: string; rows: DashboardDistributionRow[]; variant: "donut" | "bars"; partial: boolean; labelGroup: "runStatus" | "distribution"; colors: readonly string[] }>();
const { t, locale } = useI18n();
const total = computed(() => props.rows.reduce((sum, row) => sum + row.count, 0));
const host = ref<HTMLElement | null>(null);
const selected = ref<number | null>(null);
const description = computed(() => `${props.title}: ${props.partial ? t('dashboard.knownObserved') : t('dashboard.distributionTotal')} ${formatCount(total.value, locale.value)}; ${props.rows.map((_, i) => rowDescription(i)).join('; ')}`);
let chart: ECharts | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
function rowDescription(index: number) {
  const row = props.rows[index];
  if (!row) return "";
  const share = total.value > 0 ? formatRatio(row.count / total.value, locale.value) : "—";
  return `${t(`dashboard.${props.labelGroup}.${row.label}`)}: ${formatCount(row.count, locale.value)}, ${props.partial ? t('dashboard.chartKnownShare') : t('dashboard.chartShare')}: ${share}`;
}
function showTip() {
  chart?.dispatchAction({ type: "hideTip" });
  if (selected.value !== null && selected.value < props.rows.length && props.rows[selected.value].count > 0)
    chart?.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: selected.value });
}
function focusFirst() { if (props.rows.length) { selected.value = 0; showTip(); } }
function blur() { selected.value = null; chart?.dispatchAction({ type: "hideTip" }); }
function onKeydown(event: KeyboardEvent) {
  if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") || !props.rows.length) return;
  event.preventDefault();
  selected.value = Math.max(0, Math.min(props.rows.length - 1, (selected.value ?? 0) + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1)));
  showTip();
}
function render() {
  if (!chart) return;
  const style = getComputedStyle(document.documentElement);
  const color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback;
  chart.setOption(dashboardDistributionOptions(props.rows, props.variant, props.partial, {
    name: (label) => t(`dashboard.${props.labelGroup}.${label}`), count: (value) => formatCount(value, locale.value), share: (value) => formatRatio(value, locale.value),
    shareLabel: t('dashboard.chartShare'), knownShareLabel: t('dashboard.chartKnownShare'),
  }, { text: color('--text-color', '#ddd'), secondary: color('--text-secondary', '#aaa'), border: color('--border-color-secondary', '#555'), background: color('--panel-bg-elevated', '#222'), palette: props.colors }), { notMerge: true });
  showTip();
}
watch(() => [props.rows, props.variant, props.partial, locale.value], () => {
  if (!props.rows.length) selected.value = null;
  else if (selected.value !== null) selected.value = Math.min(selected.value, props.rows.length - 1);
  render();
});
onMounted(() => {
  if (!host.value?.isConnected) return;
  chart = init(host.value, undefined, { renderer: 'svg', width: host.value.clientWidth || 180, height: host.value.clientHeight || 180 });
  render();
  if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host.value); }
  else window.addEventListener('resize', resize);
  if (typeof window.MutationObserver !== 'undefined') { themeObserver = new window.MutationObserver(render); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] }); }
});
function resize() {
  if (!host.value || !chart || !host.value.clientWidth || !host.value.clientHeight) return;
  chart.resize({ width: host.value.clientWidth, height: host.value.clientHeight });
}
onBeforeUnmount(() => { resizeObserver?.disconnect(); themeObserver?.disconnect(); window.removeEventListener('resize', resize); chart?.dispose(); });
</script>
<style scoped>
.distribution-chart-wrap{min-width:0;position:relative}.distribution-echart{width:100%;outline:none}.distribution-echart:focus-visible{outline:2px solid var(--primary-color,#69b1ff);outline-offset:2px}.donut-center{position:absolute;top:90px;left:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;pointer-events:none}.donut-center b{font-size:22px}.donut-center small{font-size:11px;color:var(--text-secondary)}.distribution-current{margin:4px 0;color:var(--text-secondary);font-size:11px}
</style>
