import type { EChartsOption } from "echarts";
import type { BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from "echarts/charts";
import { knownStackTotal, type DashboardChartBucket, type DashboardChartDisplay } from "./dashboard-chart-renderer";

type Labels = {
  series: (key: string) => string;
  bucket: (bucket: DashboardChartBucket) => string;
  axisBucket: (bucket: DashboardChartBucket) => string;
  value: (value: number | null, key: string) => string;
  axis: (value: number) => string;
  allStatusesTotal: string;
  total: string;
};
type Colors = { text: string; secondary: string; border: string; background: string };
export type DashboardEChartMode = "overview" | "standard";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Bucket positions are categorical (DST days may differ in duration).
 * Only overview status counts are independent lines; other composed data stay stacked.
 */
export function dashboardEChartsOptions(display: DashboardChartDisplay, labels: Labels, colors: Colors, visibleKeys: ReadonlySet<string> = new Set(display.series.map((series) => series.key)), mode: DashboardEChartMode = "overview"): EChartsOption {
  const stacked = mode === "standard" && display.shape === "stacked-bars";
  const names = display.series.map((series) => labels.series(series.labelKey));
  const count = display.buckets.length;
  const stride = Math.max(1, Math.ceil((count - 1) / 4));
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: colors.text },
    grid: { top: 12, bottom: 38, left: 12, right: 14, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: colors.background,
      borderColor: colors.border,
      textStyle: { color: colors.text },
      axisPointer: { type: stacked ? "shadow" : "line" },
      // Keep nulls for visible series, but never list a series hidden by the native legend.
      formatter: (params: unknown) => {
        const entry = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined;
        const bucket = display.buckets[entry?.dataIndex ?? -1];
        if (!bucket || visibleKeys.size === 0) return "";
        const rows = bucket.values.flatMap((value, index) => {
          const series = display.series[index];
          return visibleKeys.has(series.key) ? [`<div><span style="color:${series.color}">●</span> ${escapeHtml(names[index])}: ${escapeHtml(labels.value(value, series.labelKey))}</div>`] : [];
        });
        if (display.kind === "model_status") {
          // Even with hidden lines/bars, this is always the original four statuses.
          const total = knownStackTotal(bucket.values);
          rows.push(`<div>${escapeHtml(labels.allStatusesTotal)}: ${escapeHtml(labels.value(total, "count"))}</div>`);
        } else if (stacked && display.series.every((series) => visibleKeys.has(series.key))) {
          // Do not label the visible subset as the total of the whole composition.
          const total = display.kind === "monitoring" ? bucket.reportedTotal : knownStackTotal(bucket.values);
          rows.push(`<div>${escapeHtml(labels.total)}: ${escapeHtml(labels.value(total, "count"))}</div>`);
        }
        return `<div>${escapeHtml(labels.bucket(bucket))}</div>${rows.join("")}`;
      },
    },
    xAxis: {
      type: "category", data: display.buckets.map((_, index) => String(index)), boundaryGap: stacked,
      axisLabel: {
        color: colors.secondary, hideOverlap: true,
        interval: 0,
        formatter: (value: string) => {
          const index = Number(value);
          return index === 0 || index === count - 1 || index % stride === 0
            ? labels.axisBucket(display.buckets[index]) : "";
        },
      },
      axisLine: { lineStyle: { color: colors.border } }, axisTick: { show: false },
    },
    yAxis: {
      type: "value", min: 0, max: display.kind === "ratio" ? 1 : undefined,
      minInterval: display.kind === "ratio" ? undefined : 1,
      axisLabel: { color: colors.secondary, formatter: (value: number) => labels.axis(value) },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: display.series.flatMap<LineSeriesOption | BarSeriesOption | ScatterSeriesOption>((series, seriesIndex) => {
      if (!visibleKeys.has(series.key)) return [];
      if (stacked) {
        const bars = [{ name: names[seriesIndex], type: "bar" as const, stack: "total", barMaxWidth: 28,
          itemStyle: { color: series.color },
          // One missing component means the whole stack is unknown, never a shorter bar.
          data: series.values.map((value, index) => knownStackTotal(display.buckets[index].values) === null ? null : value) }];
        if (display.kind !== "tokens") return bars;
        // Token compositions can be incomplete: show known components as hoverable isolated points.
        return [...bars, { name: names[seriesIndex], type: "scatter" as const, symbolSize: 7, z: 5,
          itemStyle: { color: series.color },
          data: series.values.map((value, index) => knownStackTotal(display.buckets[index].values) === null ? value : null) }];
      }
      return [{ name: names[seriesIndex], type: "line" as const,
        // X-monotone control points never overshoot the endpoints' Y range.
        smooth: 0.25, smoothMonotone: "x" as const, connectNulls: false,
        showSymbol: true, symbolSize: 5, emphasis: { focus: "series" as const },
        lineStyle: { width: 2 }, itemStyle: { color: series.color }, data: series.values }];
    }),
  };
}
