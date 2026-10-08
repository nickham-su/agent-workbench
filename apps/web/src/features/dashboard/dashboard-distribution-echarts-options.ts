import type { EChartsOption } from "echarts";

export type DashboardDistributionRow = { label: string; count: number };
type Variant = "donut" | "bars";
type Labels = { name: (label: string) => string; count: (count: number) => string; share: (ratio: number) => string; shareLabel: string; knownShareLabel: string };
type Colors = { text: string; secondary: string; border: string; background: string; palette: readonly string[] };
function escapeHtml(text: string) { return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }

/** The original row counts are never inferred from a percentage, even for partial panels. */
export function dashboardDistributionOptions(rows: readonly DashboardDistributionRow[], variant: Variant, partial: boolean, labels: Labels, colors: Colors): EChartsOption {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const tooltip: EChartsOption["tooltip"] = {
    trigger: "item", confine: true, backgroundColor: colors.background, borderColor: colors.border, textStyle: { color: colors.text },
    formatter: (params: unknown) => {
      const index = (params as { dataIndex?: number })?.dataIndex ?? -1;
      const row = rows[index];
      if (!row) return "";
      const share = total > 0 ? labels.share(row.count / total) : "—";
      return `${escapeHtml(labels.name(row.label))}: ${escapeHtml(labels.count(row.count))}<br/>${escapeHtml(partial ? labels.knownShareLabel : labels.shareLabel)}: ${escapeHtml(share)}`;
    },
  };
  const data = rows.map((row, index) => ({ name: labels.name(row.label), value: row.count, itemStyle: { color: colors.palette[index % colors.palette.length] } }));
  if (variant === "donut") return {
    animation: false, tooltip,
    series: [{ type: "pie", radius: ["56%", "79%"], center: ["50%", "50%"], stillShowZeroSum: false,
      label: { show: false }, labelLine: { show: false }, data }],
  };
  return {
    animation: false, tooltip,
    grid: { left: 8, right: 88, top: 6, bottom: 6, outerBoundsMode: "same", outerBoundsContain: "axisLabel" },
    // A distribution bar compares categories with one another, not with their sum.
    xAxis: { type: "value", min: 0, max: Math.max(1, ...rows.map((row) => row.count)), show: false },
    yAxis: { type: "category", data: rows.map((row) => labels.name(row.label)), inverse: true,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: colors.text, width: 105, overflow: "truncate" } },
    series: [{ type: "bar", barMaxWidth: 16, data,
      label: { show: true, position: "right", color: colors.text, formatter: (params) => labels.count(Number(params.value ?? 0)) } }],
  };
}
