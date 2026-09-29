import assert from "node:assert/strict";
import test from "node:test";
import { dashboardDistributionOptions } from "./dashboard-distribution-echarts-options";

const labels = { name: (key: string) => key, count: String, share: (ratio: number) => `${ratio * 100}%`, shareLabel: "Share", knownShareLabel: "Known share" };
const colors = { text: "#fff", secondary: "#aaa", border: "#555", background: "#222", palette: ["red", "blue"] };
const rows = [{ label: "primary", count: 3 }, { label: "subtask", count: 1 }];

test("Agent 终态/类型分布由 ECharts 环图显示真实计数，partial 占比仅针对已知类别", () => {
  const full = dashboardDistributionOptions(rows, "donut", false, labels, colors);
  const donut = (full.series as Array<{ type: string; data: Array<{ name: string; value: number }> }>)[0];
  assert.equal(donut.type, "pie");
  assert.deepEqual(donut.data.map(({ name, value }) => [name, value]), [["primary", 3], ["subtask", 1]]);
  const tooltip = (full.tooltip as { formatter: (params: unknown) => string }).formatter;
  assert.match(tooltip({ dataIndex: 0 }), /primary: 3.*Share: 75%/);
  const partial = dashboardDistributionOptions(rows, "donut", true, labels, colors);
  assert.match((partial.tooltip as { formatter: (params: unknown) => string }).formatter({ dataIndex: 0 }), /Known share: 75%/);
  assert.deepEqual((dashboardDistributionOptions([{ label: "other", count: 0 }], "donut", false, labels, colors).series as Array<{ data: Array<{ value: number }> }>)[0].data.map((item) => item.value), [0]);
});

test("Agent 消息分布在同一张 ECharts 图中对齐类别、计数和横条", () => {
  const bar = dashboardDistributionOptions(rows, "bars", true, labels, colors);
  const series = (bar.series as Array<{ type: string; label: { formatter: (params: unknown) => string } }>)[0];
  assert.equal(series.type, "bar");
  assert.equal((bar.xAxis as { max: number }).max, 3);
  assert.deepEqual((bar.yAxis as { data: string[] }).data, ["primary", "subtask"]);
  assert.equal(series.label.formatter({ value: 3 }), "3");
  assert.deepEqual((bar.series as Array<{ data: Array<{ value: number }> }>)[0].data.map((item) => item.value), [3, 1]);
  assert.match((bar.tooltip as { formatter: (params: unknown) => string }).formatter({ dataIndex: 1 }), /Known share: 25%/);
  assert.equal((bar.tooltip as { formatter: (params: unknown) => string }).formatter({ dataIndex: 50 }), "");
});

test("分布 tooltip 对任意标签转义", () => {
  const opts = dashboardDistributionOptions([{ label: "<x>", count: 1 }], "donut", false, labels, colors);
  assert.doesNotMatch((opts.tooltip as { formatter: (params: unknown) => string }).formatter({ dataIndex: 0 }), /<x>/);
});

test("Agent 环图与消息条图全零时完整及 partial 提示都保留计数，不推断占比", () => {
  const zeroRows = [{ label: "primary", count: 0 }, { label: "subtask", count: 0 }];
  for (const variant of ["donut", "bars"] as const) {
    for (const partial of [false, true]) {
      const opts = dashboardDistributionOptions(zeroRows, variant, partial, labels, colors);
      const series = (opts.series as Array<{ data: Array<{ value: number }> }>)[0];
      assert.deepEqual(series.data.map(({ value }) => value), [0, 0]);
      const formatter = (opts.tooltip as { formatter: (params: unknown) => string }).formatter;
      for (const index of [0, 1]) {
        const tip = formatter({ dataIndex: index });
        assert.match(tip, new RegExp(`${zeroRows[index].label}: 0`));
        assert.match(tip, new RegExp(`${partial ? "Known share" : "Share"}: —`));
        assert.doesNotMatch(tip, /0%|NaN%/);
      }
    }
  }
});
