<template>
  <div ref="host" class="mini-ratio-echart" role="img" :aria-label="label" :data-ratio="ratio" />
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { init, use, type ECharts } from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { formatRatio } from "../dashboard-formatters";

use([BarChart, GridComponent, TooltipComponent, SVGRenderer]);
const props = defineProps<{ ratio: number; label: string }>();
const { locale } = useI18n();
const host = ref<HTMLElement | null>(null);
let chart: ECharts | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
function render() {
  if (!chart) return;
  const style = getComputedStyle(document.documentElement);
  const color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback;
  chart.setOption({
    animation: false,
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: "value", min: 0, max: 1, show: false },
    yAxis: { type: "category", data: [""], show: false },
    tooltip: { trigger: "item", confine: true, backgroundColor: color("--panel-bg-elevated", "#222"), borderColor: color("--border-color-secondary", "#555"), textStyle: { color: color("--text-color", "#ddd") },
      formatter: () => formatRatio(props.ratio, locale.value) },
    series: [{ type: "bar", barWidth: 7, showBackground: true, backgroundStyle: { color: color("--border-color-secondary", "#555") },
      itemStyle: { color: color("--primary-color", "#1677ff"), borderRadius: 3 }, data: [props.ratio] }],
  }, { notMerge: true });
}
watch(() => [props.ratio, props.label, locale.value], render);
onMounted(() => {
  if (!host.value?.isConnected) return;
  chart = init(host.value, undefined, { renderer: "svg", width: host.value.clientWidth || 100, height: 12 });
  render();
  if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host.value); }
  else window.addEventListener("resize", resize);
  if (typeof window.MutationObserver !== "undefined") { themeObserver = new window.MutationObserver(render); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] }); }
});
function resize() {
  if (!host.value || !chart || !host.value.clientWidth || !host.value.clientHeight) return;
  chart.resize({ width: host.value.clientWidth, height: host.value.clientHeight });
}
onBeforeUnmount(() => { resizeObserver?.disconnect(); themeObserver?.disconnect(); window.removeEventListener("resize", resize); chart?.dispose(); });
</script>
<style scoped>
.mini-ratio-echart{width:100%;min-width:0;height:12px}
</style>
