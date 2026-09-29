import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardChartDisplay } from "./dashboard-chart-renderer";
import { dashboardEChartsOptions } from "./dashboard-echarts-options";
import { formatChartBucketInterval } from "./dashboard-formatters";

const labels = {
  series: (key: string) => key,
  bucket: (bucket: { from: number | null; to: number | null }) => `${bucket.from} – ${bucket.to}`,
  axisBucket: (bucket: { from: number | null }) => String(bucket.from),
  value: (value: number | null) => value === null ? "—" : String(value),
  axis: String,
  total: "Total",
  allStatusesTotal: "Total requests (all statuses)",
};
const colors = { text: "#eee", secondary: "#aaa", border: "#444", background: "#222" };

test("概览折线保留零值、null 间断及真实时间桶边界", () => {
  const display = createDashboardChartDisplay("total_tokens", [
    { from: 1, to: 2, count: 0 }, { from: 2, to: 4, count: null }, { from: 4, to: 5, count: 9 },
  ]);
  const options = dashboardEChartsOptions(display, labels, colors);
  const series = (options.series as Array<{ type: string; data: unknown[]; connectNulls: boolean; showSymbol: boolean; smooth: number; smoothMonotone: string }>)[0];
  assert.equal(series.type, "line");
  assert.deepEqual(series.data, [0, null, 9]);
  assert.equal(series.connectNulls, false);
  assert.ok(series.smooth > 0 && series.smooth < 1);
  assert.equal(series.smoothMonotone, "x");
  assert.equal(series.showSymbol, true, "isolated known points must remain visible");
  assert.deepEqual((options.xAxis as { data: string[] }).data, ["0", "1", "2"]);
  assert.equal((options.xAxis as { boundaryGap: boolean }).boundaryGap, false);
  const formatter = (options.tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.match(formatter([{ dataIndex: 1 }]), /2 – 4/);
  assert.match(formatter([{ dataIndex: 1 }]), /—/);
  assert.match(formatter([{ dataIndex: 0 }]), /0/);
});

test("原生图例切换同步过滤曲线、键盘值与 tooltip，全部隐藏时没有旧提示", () => {
  const display = createDashboardChartDisplay("model_status", [{ from: 1, to: 2, completed: 3, failed: 1, timedOut: 0, other: 0 }, { from: 2, to: 3, completed: 4, failed: null, timedOut: 0, other: 0 }]);
  const selected = new Set(["failed"]);
  const onlyFailed = dashboardEChartsOptions(display, labels, colors, selected);
  assert.deepEqual((onlyFailed.series as Array<{ name: string }>).map((series) => series.name), ["failed"]);
  const formatter = (onlyFailed.tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.match(formatter([{ dataIndex: 0 }]), /failed: 1/);
  assert.match(formatter([{ dataIndex: 0 }]), /Total requests \(all statuses\): 4/);
  assert.match(formatter([{ dataIndex: 1 }]), /Total requests \(all statuses\): —/);
  assert.doesNotMatch(formatter([{ dataIndex: 0 }]), /completed:/);

  const empty = dashboardEChartsOptions(display, labels, colors, new Set());
  assert.deepEqual(empty.series, []);
  assert.equal((empty.tooltip as { formatter: (params: unknown) => string }).formatter([{ dataIndex: 0 }]), "");
});

test("DST 回拨时相同本地小时的 tooltip 时间具有不同 UTC 偏移，不改变桶边界", () => {
  const first = Date.parse("2024-11-03T05:00:00Z");
  const repeated = Date.parse("2024-11-03T06:00:00Z");
  const end = Date.parse("2024-11-03T07:00:00Z");
  const interval1 = formatChartBucketInterval(first, repeated, "America/New_York", "en-US");
  const interval2 = formatChartBucketInterval(repeated, end, "America/New_York", "en-US");
  assert.match(interval1, /GMT-4.*GMT-5/);
  assert.match(interval2, /GMT-5/);
  const display = createDashboardChartDisplay("count", [
    { from: first, to: repeated, count: 1 }, { from: repeated, to: end, count: 2 },
  ]);
  assert.deepEqual(display.buckets.map(({ from, to }) => [from, to]), [[first, repeated], [repeated, end]]);
  const opts = dashboardEChartsOptions(display, { ...labels, bucket: ({ from, to }) => formatChartBucketInterval(from, to, "America/New_York", "en-US") }, colors);
  const tooltip = (opts.tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.match(tooltip([{ dataIndex: 0 }]), /GMT-4.*GMT-5/);
  assert.match(tooltip([{ dataIndex: 1 }]), /GMT-5/);
});

test("概览状态计数由堆叠柱改为独立平滑曲线；缺项不补零也不伪造总量", () => {
  const display = createDashboardChartDisplay("model_status", [
    { from: 1, to: 2, completed: 3, failed: 1, timedOut: 0, other: 0 },
    { from: 2, to: 3, completed: 4, failed: null, timedOut: 0, other: 0 },
  ]);
  assert.equal(display.shape, "stacked-bars", "共享适配器及其他分区保持原状");
  const options = dashboardEChartsOptions(display, labels, colors);
  for (const series of options.series as Array<{ type: string; stack?: string; smooth: number; smoothMonotone: string; connectNulls: boolean }>) {
    assert.equal(series.type, "line");
    assert.equal(series.stack, undefined);
    assert.equal(series.smoothMonotone, "x");
    assert.ok(series.smooth > 0);
    assert.equal(series.connectNulls, false);
  }
  assert.deepEqual((options.series as Array<{ data: unknown[] }>).map((series) => series.data), [[3, 4], [1, null], [0, 0], [0, 0]]);
  const formatter = (options.tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.match(formatter([{ dataIndex: 1 }]), /completed: 4/);
  assert.match(formatter([{ dataIndex: 1 }]), /failed: —/);
  assert.match(formatter([{ dataIndex: 1 }]), /Total requests \(all statuses\): —/);
  assert.match(formatter([{ dataIndex: 0 }]), /Total requests \(all statuses\): 4/);
});

test("总请求数零值和数据缺失的区别不受折线类型影响", () => {
  const display = createDashboardChartDisplay("model_status", [{ from: 1, to: 2, completed: 0, failed: 0, timedOut: 0, other: 0 }, { from: 2, to: 3, completed: null, failed: 0, timedOut: 0, other: 0 }]);
  const formatter = (dashboardEChartsOptions(display, labels, colors).tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.match(formatter([{ dataIndex: 0 }]), /Total requests \(all statuses\): 0/);
  assert.match(formatter([{ dataIndex: 1 }]), /Total requests \(all statuses\): —/);
});

test("概览各实际指标均为不堆叠的平滑折线；比率限定在 0-100%", () => {
  const kinds = ["monitoring_total", "duration", "model_status", "ratio", "total_tokens"] as const;
  for (const kind of kinds) {
    const display = createDashboardChartDisplay(kind, [{ from: 1, to: 2, total: 7, durationMs: 20, completed: 3, failed: 1, timedOut: 2, other: 1, ratio: 0, count: 4 }, { from: 2, to: 3, total: 8, durationMs: 30, completed: 4, failed: 2, timedOut: 1, other: 1, ratio: 1, count: 5 }]);
    const opts = dashboardEChartsOptions(display, labels, colors);
    for (const series of opts.series as Array<{ type: string; smooth: number; smoothMonotone: string; stack?: string; connectNulls: boolean }>) {
      assert.equal(series.type, "line", kind);
      assert.ok(series.smooth > 0, kind);
      assert.equal(series.smoothMonotone, "x", kind);
      assert.equal(series.stack, undefined, kind);
      assert.equal(series.connectNulls, false, kind);
    }
    if (kind === "ratio") {
      const yAxis = opts.yAxis as { min: number; max?: number };
      assert.equal(yAxis.min, 0); assert.equal(yAxis.max, 1);
    }
  }
});

test("模型/Worker 使用真实完整组成的 ECharts 堆叠柱，未知桶不缩短为伪堆叠", () => {
  for (const kind of ["model_status", "worker_events"] as const) {
    const display = createDashboardChartDisplay(kind, [
      { from: 1, to: 2, completed: 3, failed: 1, timedOut: 0, other: 0, unexpectedExits: 2, restartAttempts: 3 },
      { from: 2, to: 3, completed: 4, failed: null, timedOut: 0, other: 0, unexpectedExits: null, restartAttempts: 5 },
    ]);
    const opts = dashboardEChartsOptions(display, labels, colors, undefined, "standard");
    const bars = opts.series as Array<{ type: string; stack: string; data: Array<number | null> }>;
    assert.equal(bars.length, display.series.length);
    for (const bar of bars) { assert.equal(bar.type, "bar"); assert.equal(bar.stack, "total"); assert.equal(bar.data[1], null); }
    assert.equal((opts.xAxis as { boundaryGap: boolean }).boundaryGap, true);
    const tooltip = (opts.tooltip as { formatter: (params: unknown) => string }).formatter;
    assert.match(tooltip([{ dataIndex: 1 }]), /—/);
    if (kind === "model_status") assert.match(tooltip([{ dataIndex: 1 }]), /Total requests \(all statuses\): —/);
  }
});

test("Token 缺失组成只保留已知孤立点，不补零或连接；图例隐藏后不泄漏该系列", () => {
  const display = createDashboardChartDisplay("tokens", [
    { from: 1, to: 2, inputTokens: 4, outputTokens: null },
    { from: 2, to: 3, inputTokens: 8, outputTokens: null },
    { from: 3, to: 4, inputTokens: 5, outputTokens: 2 },
  ]);
  const opts = dashboardEChartsOptions(display, labels, colors, undefined, "standard");
  const series = opts.series as Array<{ type: string; data: Array<number | null> }>;
  assert.deepEqual(series.map((item) => item.type), ["bar", "scatter", "bar", "scatter"]);
  assert.deepEqual(series.map((item) => item.data), [[null, null, 5], [4, 8, null], [null, null, 2], [null, null, null]]);
  for (const scatter of series.filter((item) => item.type === "scatter")) {
    // ECharts must receive pointer events and its axis tooltip for partial buckets.
    assert.notEqual((scatter as { silent?: boolean }).silent, true);
    assert.notEqual((scatter as { tooltip?: { show?: boolean } }).tooltip?.show, false);
  }
  assert.match((opts.tooltip as { formatter: (params: unknown) => string }).formatter([{ dataIndex: 0 }]), /Total: —/);
  assert.match((opts.tooltip as { formatter: (params: unknown) => string }).formatter([{ seriesIndex: 1, dataIndex: 0 }]), /inputTokens: 4.*outputTokens: —.*Total: —/s);
  const filtered = dashboardEChartsOptions(display, labels, colors, new Set(["outputTokens"]), "standard");
  assert.deepEqual((filtered.series as Array<{ name: string }>).map((item) => item.name), ["outputTokens", "outputTokens"]);
  assert.doesNotMatch((filtered.tooltip as { formatter: (params: unknown) => string }).formatter([{ dataIndex: 0 }]), /inputTokens|Total:/);
});

test("tooltip 转义动态文本，避免图表数据进入 HTML", () => {
  const display = createDashboardChartDisplay("count", [{ from: 1, to: 2, count: 1 }]);
  const options = dashboardEChartsOptions(display, { ...labels, series: () => "<script>", bucket: () => "<bad>" }, colors);
  const formatter = (options.tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.doesNotMatch(formatter([{ dataIndex: 0 }]), /<script>|<bad>/);
});
