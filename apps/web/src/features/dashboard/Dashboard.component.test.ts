import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DashboardQuerySuccessResponseSchema, type DashboardData } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import { mount } from "@vue/test-utils";
import { getInstanceByDom } from "echarts/core";
import { createI18n } from "vue-i18n";
import { i18n } from "@/shared/i18n";
import enUS from "@/shared/i18n/locales/en-US";
import MetricCard from "./components/DashboardMetricCard.vue";
import TrendChart from "./components/DashboardTrendChart.vue";
import DomainSummary from "./components/DashboardDomainSummary.vue";
import WorkerSnapshot from "./components/DashboardWorkerSnapshot.vue";
import RestartRecords from "./components/DashboardRestartRecords.vue";
import Tables from "./components/DashboardTables.vue";
import AgentSection from "./components/DashboardAgentSection.vue";
import ModelSection from "./components/DashboardModelSection.vue";
import WorkerSection from "./components/DashboardWorkerSection.vue";
import AgentDistribution from "./components/DashboardAgentDistribution.vue";
import DistributionEChart from "./components/DashboardDistributionEChart.vue";
import { dashboardSuccessFixture } from "./dashboard-fixture";
import type { DashboardTrendPanel } from "./dashboard-types";
import DashboardTab from "./views/DashboardTab.vue";
import { dashboardQueryKey } from "./dashboard-injection";

const options = { global: { plugins: [i18n] } };
test("概览 ECharts 的键盘读数与明细表保留真实零和未知桶", async () => {
  const panel = {
    ...dashboardSuccessFixture.data.overviewTrends.totalTokens,
    data: [{ from: 1, to: 2, count: 0 }, { from: 2, to: 3, count: null }],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "total tokens", kind: "total_tokens", panel, echarts: true } });
  assert.equal(wrapper.findAll("svg.trend").length, 0);
  assert.equal(wrapper.findAll("[data-testid^='chart-bucket-detail-']").length, 2);
  const chart = wrapper.get(".echarts-chart");
  await chart.trigger("focus");
  assert.match(wrapper.get(".keyboard-bucket").text(), /0/);
  await chart.trigger("keydown", { key: "ArrowRight" });
  assert.match(wrapper.get(".keyboard-bucket").text(), /—/);
  await chart.trigger("blur");
  assert.equal(wrapper.find(".keyboard-bucket").exists(), false);
  wrapper.unmount();
});
test("挂载至页面时概览实际初始化 ECharts SVG 并响应指标更新", async () => {
  const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: {
    title: "trend", kind: "total_tokens", panel: dashboardSuccessFixture.data.overviewTrends.totalTokens, echarts: true,
  } });
  assert.ok(wrapper.find(".echarts-chart svg").exists());
  await wrapper.setProps({ kind: "ratio", panel: dashboardSuccessFixture.data.overviewTrends.cacheHitRate });
  assert.ok(wrapper.find(".echarts-chart svg").exists());
  wrapper.unmount();
});
test("概览状态折线摘要、明细与键盘读数呈现全部状态的安全合计", async () => {
  const base = dashboardSuccessFixture.data.overviewTrends.modelRequests;
  const complete = { from: 1, to: 2, completed: 3, failed: 1, timedOut: 0, other: 0 };
  const partial = { ...base, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, data: [complete] };
  const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: { title: "Requests", kind: "model_status", panel: partial, echarts: true } });
  const chart = wrapper.get(".echarts-chart");
  const instance = getInstanceByDom(chart.element as HTMLElement)!;
  const tooltip = () => (instance.getOption().tooltip as Array<{ formatter: (params: unknown) => string }>)[0].formatter([{ dataIndex: 0 }]);
  assert.match(tooltip(), /(?:全部状态合计|all statuses).*4/);
  assert.match(chart.attributes("aria-label") ?? "", /平滑折线图|smooth line chart/);
  assert.doesNotMatch(wrapper.get(".sr-only").text(), /stacked-bars/);
  assert.match(wrapper.get(".chart-details thead").text(), /全部状态合计|all statuses/);
  assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(), "4");
  await chart.trigger("focus");
  await wrapper.get(".echarts-legend button").trigger("click");
  assert.match(tooltip(), /(?:全部状态合计|all statuses).*4/);
  assert.doesNotMatch(tooltip(), /(?:完成|Completed):/);
  await chart.trigger("focus");
  assert.match(wrapper.get(".keyboard-bucket").text(), /(?:全部状态合计|all statuses).*4/);
  assert.doesNotMatch(wrapper.get(".keyboard-bucket").text(), /(?:完成|Completed)/);
  assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(), "4", "legend does not recalculate total from visible statuses");

  // Contract currently requires all four statuses; this malformed bucket tests the defensive null path.
  const incomplete = { ...partial, data: [{ ...complete, failed: null }] } as unknown as DashboardTrendPanel;
  await wrapper.setProps({ panel: incomplete });
  assert.match(tooltip(), /(?:全部状态合计|all statuses).*—/);
  assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(), "—");
  assert.match(wrapper.get(".keyboard-bucket").text(), /(?:全部状态合计|all statuses).*—/);
  await wrapper.setProps({ kind: "ratio", panel: dashboardSuccessFixture.data.overviewTrends.modelSuccessRate });
  assert.doesNotMatch(tooltip(), /全部状态合计|all statuses/);
  assert.doesNotMatch(wrapper.get(".chart-details thead").text(), /全部状态合计|all statuses/);
  assert.doesNotMatch(wrapper.get(".keyboard-bucket").text(), /全部状态合计|all statuses/);
  await wrapper.setProps({ kind: "model_status", panel: partial });
  assert.equal(wrapper.findAll('.echarts-legend button[aria-pressed="true"]').length, 4, "switching back restores all series");
  assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(), "4");
  wrapper.unmount();
});
test("英文概览摘要与全部状态合计使用英文文案，其他图仍为堆叠柱", () => {
  const en = createI18n({ legacy: false, locale: "en-US", messages: { "en-US": enUS } });
  const panel = dashboardSuccessFixture.data.overviewTrends.modelRequests;
  const props = { title: "Requests", kind: "model_status" as const, panel };
  const overview = mount(TrendChart, { global: { plugins: [en] }, props: { ...props, echarts: true } });
  assert.match(overview.get(".echarts-chart").attributes("aria-label") ?? "", /smooth line chart/);
  assert.match(overview.get(".chart-details thead").text(), /Total requests \(all statuses\)/);
  overview.unmount();
  const legacy = mount(TrendChart, { global: { plugins: [en] }, props });
  assert.match(legacy.get(".sr-only").text(), /stacked bar chart/);
  assert.equal(legacy.get(".echarts-chart").attributes("role"), "group");
  assert.doesNotMatch(legacy.get(".chart-details thead").text(), /all statuses/);
  legacy.unmount();
});
test("概览原生图例允许隐藏全部系列，并在重新选中后同步可见曲线与键盘读数", async () => {
  const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: {
    title: "requests", kind: "model_status", panel: dashboardSuccessFixture.data.overviewTrends.modelRequests, echarts: true,
  } });
  const buttons = wrapper.findAll(".echarts-legend button");
  const chart = wrapper.get(".echarts-chart");
  const instance = getInstanceByDom(chart.element as HTMLElement)!;
  assert.equal(buttons.length, 4);
  const series = instance.getOption().series as Array<{ type: string; smooth: number; smoothMonotone: string; data: unknown[] }>;
  assert.equal(series.length, 4);
  for (const item of series) {
    assert.equal(item.type, "line"); assert.ok(item.smooth > 0); assert.equal(item.smoothMonotone, "x");
  }
  await chart.trigger("focus");
  await buttons[0].trigger("click");
  assert.equal(buttons[0].attributes("aria-pressed"), "false");
  assert.equal((instance.getOption().series as unknown[]).length, 3);
  assert.doesNotMatch(wrapper.get(".keyboard-bucket").text(), /(?:完成|Completed)/);
  for (const button of buttons.slice(1)) await button.trigger("click");
  assert.deepEqual(instance.getOption().series, []);
  assert.ok(wrapper.get(".echarts-no-series").text());
  assert.equal(wrapper.find(".keyboard-bucket").exists(), false);
  await buttons[0].trigger("click");
  assert.equal((instance.getOption().series as unknown[]).length, 1);
  await chart.trigger("focus");
  assert.match(wrapper.get(".keyboard-bucket").text(), /(?:完成|Completed)/);
  wrapper.unmount();
});
test("概览刷新、桶数缩减与指标切换均重置同步键盘位置与 ECharts tooltip", async () => {
  const base = dashboardSuccessFixture.data.overviewTrends.totalTokens;
  const row = (from: number, count: number | null) => ({ from, to: from + 1000, count });
  const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: {
    title: "tokens", kind: "total_tokens", panel: { ...base, data: [row(1, 1), row(2, 2), row(3, 3)] }, echarts: true,
  } });
  const host = wrapper.get(".echarts-chart");
  const instance = getInstanceByDom(host.element as HTMLElement)!;
  const actions: Array<{ type: string; dataIndex?: number }> = [];
  const original = instance.dispatchAction.bind(instance);
  instance.dispatchAction = ((action: { type: string; dataIndex?: number }) => {
    actions.push(action);
    original(action);
  }) as typeof instance.dispatchAction;
  await host.trigger("focus");
  await host.trigger("keydown", { key: "ArrowRight" });
  await host.trigger("keydown", { key: "ArrowRight" });
  assert.match(wrapper.get(".keyboard-bucket").text(), /3/);
  await wrapper.setProps({ panel: { ...base, data: [row(10, 10), row(20, 20)] } });
  assert.match(wrapper.get(".keyboard-bucket").text(), /20/);
  assert.equal(actions.at(-1)?.type, "showTip");
  assert.equal(actions.at(-1)?.dataIndex, 1, "after shrinking, tip points to the new last bucket");
  await wrapper.setProps({ title: "count", kind: "count", panel: { ...base, data: [row(30, 90), row(40, 80)] } });
  assert.match(wrapper.get(".keyboard-bucket").text(), /90/);
  assert.equal(actions.at(-1)?.dataIndex, 0, "switching metric resets to first bucket");
  assert.equal((instance.getOption().series as Array<{ data: number[] }>)[0].data[0], 90);
  wrapper.unmount();
});
test("根主题颜色变化时概览坐标轴与提示同步使用实际次级文字色", async () => {
  const root = document.documentElement;
  const prior = root.style.getPropertyValue("--text-secondary");
  const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: {
    title: "tokens", kind: "total_tokens", panel: dashboardSuccessFixture.data.overviewTrends.totalTokens, echarts: true,
  } });
  const instance = getInstanceByDom(wrapper.get(".echarts-chart").element as HTMLElement)!;
  try {
    root.style.setProperty("--text-secondary", "#a1b2c3");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const axis = instance.getOption().yAxis as Array<{ axisLabel: { color: string } }>;
    assert.equal(axis[0].axisLabel.color, "#a1b2c3");
  } finally {
    if (prior) root.style.setProperty("--text-secondary", prior);
    else root.style.removeProperty("--text-secondary");
    wrapper.unmount();
  }
});
test("Dashboard shared fixture 符合公开 TypeBox 响应合同", () => { assert.equal(Value.Check(DashboardQuerySuccessResponseSchema, dashboardSuccessFixture), true); });
test("模型六卡、趋势与覆盖双栏及模型对比表按原型组织", async () => {
  const wrapper = mount(ModelSection, { ...options, props: { model: dashboardSuccessFixture.data.model, cacheHitRate: dashboardSuccessFixture.data.overview.cacheHitRate, timezone: "UTC" } });
  assert.equal(wrapper.findAll(".model-primary-metrics > *").length, 6);
  assert.equal(wrapper.findAll(".model-main > *").length, 2);
  assert.equal(wrapper.findAll(".coverage-item").length, 4);
  assert.equal(wrapper.find("[data-testid='model-more']").exists(), false);
  assert.match(wrapper.get("[data-testid='model-metric-tokens']").text(), /4/);
  assert.match(wrapper.get("[data-testid='model-metric-tokens']").text(), /5/);
  assert.deepEqual(wrapper.findAll(".token-comparison").map((item) => item.text()), ["+10%", "+10%"]);
  assert.deepEqual(wrapper.findAll(".coverage-comparison").map((item) => item.text()), ["+10%", "+10%", "+10%", "+10%"]);
  for (const key of ["requestCount", "successRate", "timeoutRate", "completedAverageDuration", "tokens", "cacheHitRate"]) {
    await wrapper.get(`[data-testid='model-metric-${key}'] button`).trigger("click");
    assert.equal(wrapper.get(`[data-testid='model-metric-${key}'] button`).attributes("aria-pressed"), "true");
    assert.ok(wrapper.find(`[data-testid='model-trend-${key === "requestCount" ? "requests" : key}']`).exists());
  }
  const headings = wrapper.findAll(".table-wrap th").map((item) => item.text());
  assert.equal(headings.length, 8);
  assert.match(headings.join(" "), /超时率|Timeout rate/i);
  assert.match(headings.join(" "), /缓存命中率|Cache hit rate/i);
  const cells = wrapper.findAll(".table-wrap tbody td").map((item) => item.text());
  assert.equal(cells.length, 8);
  assert.equal(cells[2], "3");
  assert.match(cells[4]!, /^0/);
  wrapper.unmount();
});
test("模型覆盖率未知不画零，安全零显示零；双 Token 值互不冒充且 partial 不展示采集文案", async () => {
  const source = dashboardSuccessFixture.data.model;
  const metrics = source.metrics;
  const partial = { ...metrics.inputTokenCoverage, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, value: { ratio: 0.25 } };
  const unavailable = { status: "unavailable" as const, value: null, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["model" as const], comparison: { status: "not_applicable" as const, kind: null, delta: null } };
  const model = { ...source, metrics: {
    ...metrics,
    inputTokens: { ...metrics.inputTokens, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, value: { count: 0 } },
    outputTokens: { ...metrics.outputTokens, value: { count: null } },
    inputTokenCoverage: partial,
    outputTokenCoverage: { ...metrics.outputTokenCoverage, value: { ratio: 0 } },
    totalTokenCoverage: { ...metrics.totalTokenCoverage, value: { ratio: null } },
    inputCacheCoverage: unavailable,
  } };
  const wrapper = mount(ModelSection, { ...options, attachTo: document.body, props: { model, cacheHitRate: dashboardSuccessFixture.data.overview.cacheHitRate, timezone: "UTC" } });
  const tokenValues = wrapper.get(".token-values").text();
  assert.match(tokenValues, /0/);
  assert.match(tokenValues, /—/);
  assert.equal(wrapper.get("[data-testid='model-coverage-inputTokenCoverage'] .mini-ratio-echart").attributes("data-ratio"), "0.25");
  assert.equal(wrapper.get("[data-testid='model-coverage-outputTokenCoverage'] .mini-ratio-echart").attributes("data-ratio"), "0");
  for (const [key, value] of [['inputTokenCoverage', 0.25], ['outputTokenCoverage', 0]] as const) {
    const host = wrapper.get(`[data-testid='model-coverage-${key}'] .mini-ratio-echart`).element as HTMLElement;
    const series = getInstanceByDom(host)!.getOption().series as Array<{ type: string; data: number[] }>;
    assert.equal(series[0].type, 'bar');
    assert.deepEqual(series[0].data, [value]);
  }
  assert.match(wrapper.get("[data-testid='model-coverage-outputTokenCoverage']").text(), /0%/);
  assert.equal(wrapper.find("[data-testid='model-coverage-totalTokenCoverage'] .mini-ratio-echart").exists(), false);
  assert.equal(wrapper.find("[data-testid='model-coverage-inputCacheCoverage'] .mini-ratio-echart").exists(), false);
  assert.doesNotMatch(wrapper.get("[data-testid='model-coverage']").text(), /覆盖缺口|Coverage gap|不可用|Unavailable/);
  assert.equal(wrapper.get("[data-testid='model-metric-tokens']").findAll(".token-comparison").length, 0);
  assert.equal(wrapper.get("[data-testid='model-coverage-inputTokenCoverage']").findAll(".coverage-comparison").length, 0);
  assert.doesNotMatch(wrapper.get("[data-testid='model-coverage-inputTokenCoverage'] .mini-ratio-echart").attributes("aria-label") ?? "", /\+10%/);
  assert.equal(wrapper.get("[data-testid='model-coverage']").findAll(".coverage-comparison").length, 1);
  wrapper.unmount();
});
test("模型 Token 和覆盖率比较只跟随各自安全值及 available 比较，负值和零有独立语义", () => {
  const source = dashboardSuccessFixture.data.model;
  const metrics = source.metrics;
  const notApplicable = { status: "not_applicable" as const, kind: null, delta: null };
  const comparison = { status: "available" as const, kind: "percentage_points" as const, delta: -0.1 };
  const wrapper = mount(ModelSection, { ...options, props: { model: { ...source, metrics: {
    ...metrics,
    inputTokens: { ...metrics.inputTokens, value: { count: 0 }, comparison: { status: "available" as const, kind: "relative" as const, delta: 0 } },
    outputTokens: { ...metrics.outputTokens, comparison: notApplicable },
    inputTokenCoverage: { ...metrics.inputTokenCoverage, comparison },
    outputTokenCoverage: { ...metrics.outputTokenCoverage, value: { ratio: 0 }, comparison: { status: "available" as const, kind: "percentage_points" as const, delta: 0 } },
    totalTokenCoverage: { ...metrics.totalTokenCoverage, comparison: notApplicable },
  } }, cacheHitRate: dashboardSuccessFixture.data.overview.cacheHitRate, timezone: "UTC" } });
  assert.deepEqual(wrapper.findAll(".token-comparison").map((item) => item.text()), ["+0%"]);
  assert.equal(wrapper.get("[data-testid='model-coverage-inputTokenCoverage'] .coverage-comparison").text(), "-10.0pp");
  assert.equal(wrapper.get("[data-testid='model-coverage-outputTokenCoverage'] .coverage-comparison").text(), "+0.0pp");
  assert.match(wrapper.get("[data-testid='model-coverage-outputTokenCoverage'] .mini-ratio-echart").attributes("aria-label") ?? "", /0%.*\+0.0pp/);
  assert.equal(wrapper.find("[data-testid='model-coverage-totalTokenCoverage'] .coverage-comparison").exists(), false);
  wrapper.unmount();
});
test("Agent 6+4 指标与趋势、三块汇总和工具状态按照原型布局且保留交互", async () => {
  const wrapper = mount(AgentSection, { ...options, attachTo: document.body, props: { agent: dashboardSuccessFixture.data.agent, timezone: "UTC" } });
  assert.equal(wrapper.findAll(".agent-primary-metrics [data-testid^='agent-metric-']").length, 6);
  assert.equal(wrapper.findAll(".agent-secondary-metrics [data-testid^='agent-metric-']").length, 4);
  assert.equal(wrapper.findAll(".agent-distributions .dashboard-panel").length, 3);
  assert.equal(wrapper.findAll(".agent-tools .dashboard-panel").length, 2);
  for (const key of ["totalDuration", "runCount", "primaryRunCount", "subtaskRunCount", "userMessageCount", "assistantMessageCount", "toolCallCount", "toolSuccessRate", "manualCompactionCount", "autoCompactionCount"]) {
    const card = wrapper.get(`[data-testid="agent-metric-${key}"]`);
    await card.get("button").trigger("click");
    assert.equal(card.get("button").attributes("aria-pressed"), "true");
    assert.equal(wrapper.get(`[data-testid="agent-trend-${key}"] h3`).text(), card.get(".metric-title").text());
  }
  assert.equal(wrapper.get('[data-testid="agent-metric-manualCompactionCount"] .metric-value').text(), "0");
  assert.match(wrapper.get('[data-testid="agent-run-terminal"] .donut-center').text(), /3/);
  const runHost = wrapper.get('[data-testid="agent-run-terminal"] .distribution-echart').element as HTMLElement;
  const runChart = getInstanceByDom(runHost)!;
  const getRunCounts = () => (runChart.getOption().series as Array<{ type: string; data: Array<{ value: number }> }>)[0].data.map((row) => row.value);
  assert.equal((runChart.getOption().series as Array<{ type: string }>)[0].type, 'pie');
  assert.equal(getRunCounts().reduce((sum, count) => sum + count, 0), 3);
  await wrapper.get('.scope-controls button:nth-child(2)').trigger('click');
  assert.equal(wrapper.get('.scope-controls button:nth-child(2)').attributes('aria-pressed'), 'true');
  assert.match(wrapper.get('[data-testid="agent-run-terminal"] .donut-center').text(), /2/);
  assert.equal(getRunCounts().reduce((sum, count) => sum + count, 0), 2);
  await wrapper.get('.scope-controls button:nth-child(3)').trigger('click');
  assert.equal(getRunCounts().reduce((sum, count) => sum + count, 0), 1);
  const chartHost = wrapper.get('[data-testid="agent-message-type"] .distribution-echart');
  const messageOptions = getInstanceByDom(chartHost.element as HTMLElement)!.getOption();
  assert.equal((messageOptions.series as Array<{ type: string }>)[0].type, 'bar');
  assert.ok((messageOptions.yAxis as Array<{ axisLabel: { show?: boolean } }>)[0].axisLabel);
  assert.equal(wrapper.findAll('[data-testid="agent-message-type"] .distribution-rows').length, 0);
  await chartHost.trigger('focus');
  await chartHost.trigger('keydown', { key: 'ArrowDown' });
  assert.match(wrapper.get('[data-testid="agent-message-type"] [role="status"]').text(), /已知占比|占比|share/i);
  assert.match(wrapper.get('[data-testid="agent-tool-status"] .donut-center').text(), /2/);
  const styles = readFileSync(new URL("./components/DashboardAgentSection.vue", import.meta.url), "utf8");
  assert.match(styles, /@container\(max-width:780px\)[^{]*\{[^}]*\.agent-main,\.agent-tools,\.agent-distributions\{grid-template-columns:minmax\(0,1fr\)/);
  wrapper.unmount();
});
test("Agent 趋势与消息图在容器宽度变化后重排为实际宽度", () => {
  const wrapper = mount(AgentSection, { ...options, attachTo: document.body, props: { agent: dashboardSuccessFixture.data.agent, timezone: "UTC" } });
  const trendHost = wrapper.get('.echarts-chart').element as HTMLElement;
  const messageHost = wrapper.get('[data-testid="agent-message-type"] .distribution-echart').element as HTMLElement;
  const trend = getInstanceByDom(trendHost)!;
  const message = getInstanceByDom(messageHost)!;
  Object.defineProperty(trendHost, "clientWidth", { configurable: true, value: 960 });
  Object.defineProperty(trendHost, "clientHeight", { configurable: true, value: 236 });
  Object.defineProperty(messageHost, "clientWidth", { configurable: true, value: 420 });
  Object.defineProperty(messageHost, "clientHeight", { configurable: true, value: 114 });
  window.dispatchEvent(new Event("resize"));
  assert.equal(trend.getWidth(), 960);
  assert.equal(message.getWidth(), 420);
  assert.equal(message.getHeight(), 114);
  wrapper.unmount();
});
test("Agent 分类图只统计真实类别；部分结果只呈现已知份额，空值不伪装成零", () => {
  const base = dashboardSuccessFixture.data.agent.runTypeDistribution;
  const full = { ...base, data: [{ kind: "primary" as const, count: 0 }, { kind: "subtask" as const, count: 2 }, { kind: "other" as const, count: 1 }] };
  const wrapper = mount(AgentDistribution, { ...options, props: { panel: full, title: "Runs", labelGroup: "distribution", variant: "donut" } });
  assert.match(wrapper.get('.donut-center').text(), /3/);
  assert.match(wrapper.text(), /其他|Other/);
  assert.equal(wrapper.findAll('.distribution-row').length, 3);
  const partial = { ...base, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, data: full.data };
  const known = mount(AgentDistribution, { ...options, props: { panel: partial, title: "Runs", labelGroup: "distribution", variant: "donut" } });
  assert.match(known.get('.donut-center').text(), /已知观测|Known observations/);
  assert.doesNotMatch(known.text(), /%/);
  const message = dashboardSuccessFixture.data.agent.messageTypeDistribution;
  const partialBars = mount(AgentDistribution, { ...options, props: { panel: { ...message, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const }, title: "Messages", labelGroup: "distribution", variant: "bars" } });
  assert.match(partialBars.text(), /仅表示已知类别|relative shares of known categories/);
  assert.equal(partialBars.findAll('.distribution-rows').length, 0);
  assert.doesNotMatch(partialBars.text(), /%/);
  const statuses = { ...dashboardSuccessFixture.data.agent.toolStatusDistribution, data: [{ status: "completed" as const, count: 0 }, { status: "cancelled" as const, count: 1 }, { status: "unknown" as const, count: 2 }] };
  const toolStatus = mount(AgentDistribution, { ...options, props: { panel: statuses, title: "Tools", labelGroup: "distribution", variant: "donut" } });
  assert.match(toolStatus.text(), /取消|Cancelled/);
  assert.match(toolStatus.text(), /未知|Unknown/);
  assert.match(toolStatus.get('.donut-center').text(), /3/);
  const unavailable = { ...base, status: "unavailable" as const, data: null, completeness: "none" as const, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const };
  const empty = mount(AgentDistribution, { ...options, props: { panel: unavailable, title: "Runs", labelGroup: "distribution", variant: "donut" } });
  assert.equal(empty.findAll('.donut-center').length, 0);
  assert.equal(empty.get('[role="note"]').text(), '—');
  const zero = mount(AgentDistribution, { ...options, props: { panel: { ...base, data: [] }, title: "Runs", labelGroup: "distribution", variant: "donut" } });
  assert.match(zero.get('.donut-center').text(), /0/);
});
test("Agent 工具表保留取消、未知和仅已完成均时，未知工具名与不可用安全呈现", () => {
  const base = dashboardSuccessFixture.data.agent.toolDetails;
  const partial = { ...base, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, data: [{ toolName: null, calls: 3, completed: 0, failed: 1, cancelled: 1, unknown: 1, completedAverageDurationMs: null }] };
  const table = mount(Tables, { ...options, props: { title: "Tools", panel: partial, tableKind: "tools" } });
  assert.equal(table.findAll('th').length, 7);
  assert.match(table.get('thead').text(), /取消|Cancelled/);
  assert.match(table.get('tbody').text(), /未知|Unknown/);
  assert.match(table.get('tbody').text(), /—/);
  assert.equal(table.findAll('.status').length, 0);
  const complete = mount(Tables, { ...options, props: { title: "Tools", panel: base, tableKind: "tools" } });
  assert.match(complete.get('tbody').text(), /read/);
  assert.doesNotMatch(complete.get('tbody').text(), /NaN/);
});
test("真实 shared 成功夹具：指标卡保留服务端 comparison，不把 unavailable 变为零", async () => { const result = dashboardSuccessFixture.data.overview.modelRequests; const wrapper = mount(MetricCard, { ...options, props: { title: "requests", value: "3", result } }); assert.match(wrapper.text(), /\+10%|\+10\.0%/); const unavailable = { status: "unavailable" as const, value: null, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["run" as const], comparison: { status: "not_applicable" as const, kind: null, delta: null } }; await wrapper.setProps({ value: "—", result: unavailable }); assert.equal(wrapper.get(".metric-value").text(), "—"); assert.equal(wrapper.findAll(".status").length, 0); assert.doesNotMatch(wrapper.text(), /暂无可安全展示的数据|No safe data|不适用|Not applicable/); });
test("指标卡百分点评比只在结果与比较均可展示时出现", async () => {
  const result = dashboardSuccessFixture.data.model.metrics.successRate;
  const comparison = { status: "available" as const, kind: "percentage_points" as const, delta: 0.1 };
  const wrapper = mount(MetricCard, { ...options, props: { title: "success", value: "50%", result: { ...result, comparison } } });
  assert.match(wrapper.text(), /\+10\.0pp/);
  await wrapper.setProps({ result: { ...result, comparison: { status: "previous_zero" as const, kind: null, delta: null } } });
  assert.doesNotMatch(wrapper.text(), /pp|previous_zero/);
  await wrapper.setProps({ value: "—", result: { status: "unavailable", value: null, dataIncomplete: true, unavailableReason: "no_safe_data", requiredDomains: ["model"], comparison } });
  assert.equal(wrapper.get(".metric-value").text(), "—");
  assert.doesNotMatch(wrapper.text(), /pp/);
  wrapper.unmount();
});
test("缺失 Output Token 时散点可悬停且键盘选中真实散点，不绘制伪堆叠柱", async () => {
  const panel = { ...dashboardSuccessFixture.data.model.trends.tokens, data: [
    { from: 1, to: 2, inputTokens: 4, outputTokens: null },
    { from: 2, to: 3, inputTokens: 8, outputTokens: null },
    { from: 3, to: 4, inputTokens: null, outputTokens: 3 },
  ] };
  const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: { title: "tokens", kind: "tokens", panel } });
  const chart = getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
  const series = chart.getOption().series as Array<{ type: string; data: Array<number | null>; silent?: boolean; tooltip?: { show?: boolean } }>;
  assert.deepEqual(series.map((item) => item.type), ['bar', 'scatter', 'bar', 'scatter']);
  assert.deepEqual(series.map((item) => item.data), [[null, null, null], [4, 8, null], [null, null, null], [null, null, 3]]);
  assert.notEqual(series[1].silent, true);
  assert.notEqual(series[1].tooltip?.show, false);
  const tooltip = (chart.getOption().tooltip as Array<{ formatter: (params: unknown) => string }>)[0].formatter;
  for (const [seriesIndex, dataIndex, known, unknown] of [[1, 0, /Input tokens: 4/i, /Output tokens: —/i], [3, 2, /Output tokens: 3/i, /Input tokens: —/i]] as const) {
    const tip = tooltip([{ seriesIndex, dataIndex }]);
    assert.match(tip, known);
    assert.match(tip, unknown);
    assert.match(tip, /总计.*—|Total.*—/);
  }
  // Drive the actual SVG renderer's hit test rather than merely inspecting options.
  const point = chart.convertToPixel({ seriesIndex: 1 }, [0, 4]) as number[];
  assert.ok(point.every(Number.isFinite));
  const hovered = chart.getZr().handler.findHover(point[0], point[1]);
  assert.ok(hovered.target, 'known Token scatter must be hit-testable');
  chart.getZr().handler.dispatch('mousemove', { zrX: point[0], zrY: point[1] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const hoveredTipText = (wrapper.get('.echarts-chart').element as HTMLElement).textContent ?? '';
  assert.match(hoveredTipText, /Input tokens.*4/s);
  assert.match(hoveredTipText, /Output tokens.*—/s);
  assert.match(hoveredTipText, /Total.*—/s);
  const actions: Array<{ seriesIndex: number; dataIndex: number }> = [];
  const originalDispatch = chart.dispatchAction.bind(chart);
  chart.dispatchAction = ((action: { type: string; seriesIndex?: number; dataIndex?: number }) => {
    if (action.type === 'showTip') actions.push({ seriesIndex: action.seriesIndex!, dataIndex: action.dataIndex! });
    originalDispatch(action);
  }) as typeof chart.dispatchAction;
  const host = wrapper.get('.echarts-chart');
  await host.trigger('focus');
  assert.deepEqual(actions.at(-1), { seriesIndex: 1, dataIndex: 0 });
  await host.trigger('keydown', { key: 'ArrowRight' });
  assert.deepEqual(actions.at(-1), { seriesIndex: 1, dataIndex: 1 });
  await host.trigger('keydown', { key: 'ArrowRight' });
  assert.deepEqual(actions.at(-1), { seriesIndex: 3, dataIndex: 2 });
  assert.match(wrapper.get('.keyboard-bucket').text(), /3/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const renderedTip = (host.element as HTMLElement).textContent ?? '';
  assert.match(renderedTip, /Output tokens.*3/s);
  assert.match(renderedTip, /Input tokens.*—/s);
  assert.match(renderedTip, /Total.*—/s);
  const inputLegend = wrapper.get('.echarts-legend button');
  await inputLegend.trigger('click');
  assert.deepEqual(actions.at(-1), { seriesIndex: 1, dataIndex: 2 });
  const priorActions = actions.length;
  await host.trigger('keydown', { key: 'ArrowLeft' });
  assert.equal(actions.length, priorActions, 'no known visible component means no tooltip anchor');
  assert.match(wrapper.get('.keyboard-bucket').text(), /Output tokens.*—/i);
  await host.trigger('keydown', { key: 'ArrowRight' });
  assert.deepEqual(actions.at(-1), { seriesIndex: 1, dataIndex: 2 });
  await inputLegend.trigger('click');
  assert.deepEqual(actions.at(-1), { seriesIndex: 3, dataIndex: 2 });
  assert.equal(wrapper.findAll('svg.trend, .bar-track, progress').length, 0);
  assert.match(wrapper.get('.chart-details').text(), /4/);
  assert.match(wrapper.get('.chart-details').text(), /—/);
  wrapper.unmount();
});

test("Domain summary 在 available 与 partial 展示已知域，仅 unavailable 隐藏域", () => {
  const available = dashboardSuccessFixture.data.exceptions.domainHealth;
  const partial = { ...available, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const unavailable = { status: "unavailable" as const, completeness: "none" as const, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["run" as const], comparison: available.comparison, data: null, diagnosedAt: 2, asOf: 2 };
  for (const [result, hasKnownData] of [[available, true], [partial, true], [unavailable, false]] as const) {
    const wrapper = mount(DomainSummary, { ...options, props: { result } });
    assert.equal(wrapper.findAll(".health-table tbody tr").length > 0, hasKnownData);
    if (result.status === "partial") assert.match(wrapper.text(), /覆盖缺口|Coverage gap/);
    if (result.status === "unavailable") assert.match(wrapper.text(), /暂无可安全展示的数据|No safe data/);
  }
});
test("Worker 实时快照使用 shared value 与 snapshotAt", () => { const wrapper = mount(WorkerSnapshot, { ...options, props: { result: dashboardSuccessFixture.data.exceptions.workerLiveSnapshot, timezone: "UTC" } }); assert.match(wrapper.text(), /运行中|Running/); assert.match(wrapper.text(), /1/); assert.match(wrapper.text(), /快照时间|Snapshot/); });
test("Worker 范围统计与实时快照分别呈现，不显示详细域诊断", () => {
  const data = dashboardSuccessFixture.data;
  const wrapper = mount(WorkerSection, { ...options, props: {
    worker: data.worker,
    liveSnapshot: data.exceptions.workerLiveSnapshot,
    timezone: "UTC",
  } });
  assert.equal(wrapper.findAll(".snapshot-grid article").length, 4);
  assert.match(wrapper.get("[data-testid='worker-live-status']").text(), /配置槽位|Configured slots/);
  assert.match(wrapper.get("[data-testid='worker-live-status']").text(), /本地降级运行|Local fallback running/);
  assert.equal(wrapper.findAll(".worker-metrics .metric-card").length, 3);
  for (const key of ["unexpectedExits", "restartAttempts", "restartFailed"]) {
    assert.ok(wrapper.find(`[data-testid='worker-metric-${key}']`).exists());
  }
  assert.match(wrapper.get("[data-testid='worker-restart-succeeded']").text(), /0/);
  assert.equal(wrapper.findAll("[data-testid='worker-main'] > *").length, 2);
  assert.ok(wrapper.find(".table-wrap table").exists());
  assert.equal(wrapper.findAll(".worker-health, .domain-entry").length, 0);
  assert.doesNotMatch(wrapper.text(), /查看数据域详细诊断|View detailed domain diagnostics/);
});
test("Worker 重启统计已知零保留，partial 即使比较可用也不显示变化", () => {
  const data = dashboardSuccessFixture.data;
  const available = mount(WorkerSection, { ...options, props: { worker: data.worker, liveSnapshot: data.exceptions.workerLiveSnapshot, timezone: "UTC" } });
  assert.match(available.get("[data-testid='worker-restart-succeeded']").text(), /0.*\+10%/);
  const succeeded = data.worker.metrics.restartSucceeded;
  const partial = { ...succeeded, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const worker = { ...data.worker, metrics: { ...data.worker.metrics, restartSucceeded: partial } };
  const wrapper = mount(WorkerSection, { ...options, props: { worker, liveSnapshot: data.exceptions.workerLiveSnapshot, timezone: "UTC" } });
  assert.match(wrapper.get("[data-testid='worker-restart-succeeded']").text(), /0/);
  assert.doesNotMatch(wrapper.get("[data-testid='worker-restart-succeeded']").text(), /\+10%/);
  wrapper.unmount();
  available.unmount();
});

test("Worker 快照零值、未知利用率与不可用均不伪造进度，时间分别显示", () => {
  const source = dashboardSuccessFixture.data.exceptions.workerLiveSnapshot;
  const snapshotAt = Date.UTC(2024, 0, 2);
  const asOf = Date.UTC(2024, 0, 3);
  const partial = {
    ...source,
    status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const,
    snapshotAt, asOf,
    value: { ...source.value, running: 0, queued: 0, concurrency: 0, utilization: null, localFallbackRunning: 0, lastReadyAt: null },
  };
  const known = mount(WorkerSnapshot, { ...options, props: { result: partial, timezone: "UTC" } });
  assert.match(known.text(), /2024/);
  assert.match(known.text(), /1月2日|Jan 2|January 2/);
  assert.match(known.text(), /1月3日|Jan 3|January 3/);
  assert.match(known.get(".slot-usage").text(), /—/);
  assert.equal(known.find(".slot-usage progress").exists(), false);
  assert.equal(known.get(".snapshot-grid article").find("strong")?.text(), "0");
  const unavailable: import("@agent-workbench/shared").WorkerLiveSnapshotResult = {
    status: "unavailable", value: null, dataIncomplete: true, unavailableReason: "domain_unavailable", requiredDomains: ["worker"],
    comparison: { status: "domain_unavailable", kind: null, delta: null }, snapshotAt: null, asOf,
  };
  const unknown = mount(WorkerSnapshot, { ...options, props: { result: unavailable, timezone: "UTC" } });
  assert.equal(unknown.findAll(".snapshot-grid article").length, 4);
  assert.ok(unknown.findAll(".snapshot-grid strong").every((node) => node.text() === "—"));
  assert.equal(unknown.find("progress").exists(), false);
});
test("数据指标 partial 留已知数值，unavailable 留中性空态，不显示采集状态", () => {
  const partial = { ...dashboardSuccessFixture.data.overview.modelRequests, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const metric = mount(MetricCard, { ...options, props: { title: "requests", value: "3", result: partial } });
  assert.match(metric.text(), /3/);
  assert.equal(metric.findAll(".status").length, 0);
  assert.doesNotMatch(metric.text(), /\+10%/);
  assert.doesNotMatch(metric.text(), /覆盖缺口|Coverage gap|数据不完整|Incomplete/);
  const unavailable = { status: "unavailable" as const, data: null, dataIncomplete: true as const, unavailableReason: "domain_unavailable" as const, requiredDomains: ["run" as const], comparison: { status: "domain_unavailable" as const, kind: null, delta: null } };
  const trend = mount(TrendChart, { ...options, props: { title: "unavailable", kind: "count", panel: unavailable } });
  assert.equal(trend.get("[role='note']").text(), "—");
  assert.ok(trend.get("[role='note']").attributes("aria-label"));
  assert.equal(trend.findAll("polyline").length, 0);
  assert.equal(trend.findAll(".status").length, 0);
  assert.doesNotMatch(trend.text(), /域不可用|Domain unavailable/);
});
test("真实 DashboardTab：mounted 单请求、preset 自动刷新，custom 仅 Apply 请求", async () => {
  const calls: Array<import("@agent-workbench/shared").DashboardQueryRequest> = [];
  const query = async (request: import("@agent-workbench/shared").DashboardQueryRequest) => {
    calls.push(request);
    return { ...dashboardSuccessFixture, rangeId: `range-${calls.length}`, timezone: request.timezone, from: request.rangeKind === "custom" ? request.from : 1, to: request.rangeKind === "custom" ? request.to : 2 };
  };
  const wrapper = mount(DashboardTab, {
    attachTo: document.body,
    global: {
      plugins: [i18n],
      provide: { [dashboardQueryKey as symbol]: query },
      stubs: {
        "a-select": { props: ["value"], emits: ["update:value"], template: '<select :value="value" @change="$emit(\'update:value\', $event.target.value)"><slot /></select>' },
        "a-select-option": { props: ["value"], template: '<option :value="value"><slot /></option>' },
        "a-button": { props: ["disabled"], emits: ["click"], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
        "a-alert": { template: '<div><slot /></div>' }, "a-spin": { template: '<div><slot /></div>' }, "a-empty": { template: '<div><slot /></div>' },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const selects = wrapper.findAll("select");
  assert.equal(selects.length, 1);
  await selects[0].setValue("preset_30d");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  await selects[0].setValue("custom");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const inputs = wrapper.findAll('input[type="datetime-local"]');
  await inputs[0].setValue("2024-01-01T00:00");
  await inputs[1].setValue("2024-01-02T00:00");
  assert.equal(calls.length, 2);
  const apply = wrapper.findAll("button").find((button) => /应用|Apply/.test(button.text()));
  assert.ok(apply);
  await apply!.trigger("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  assert.match(wrapper.get('[data-testid="dashboard-section-overview"]').text(), /域状态摘要|Domain status summary/);
  assert.equal(wrapper.find('[data-testid="overview-metric-totalTokens"]').exists(), false);
  const toolCard = wrapper.get('[data-testid="overview-metric-toolCallCount"]');
  assert.match(toolCard.get(".metric-title").text(), /工具调用|Tool calls/);
  assert.equal(toolCard.get(".metric-value").text(), "2");
  await toolCard.get("button").trigger("click");
  assert.equal(wrapper.get('[data-testid="overview-trend-toolCallCount"] .echarts-chart').attributes("tabindex"), "0");
  assert.match(wrapper.get('[data-testid="overview-trend-toolCallCount"] .chart-details').text(), /2/);
  const sectionButtons = wrapper.findAll("nav.dashboard-section-tabs button");
  assert.equal(sectionButtons.length, 4);
  assert.doesNotMatch(sectionButtons.map((button) => button.text()).join(" "), /Git/);
  assert.equal(wrapper.find('[data-testid="dashboard-section-git"]').exists(), false);
  // Chart instances must not initialize under hidden tabs with a fallback width.
  assert.equal(wrapper.find('[data-testid="dashboard-section-agent"]').exists(), false);
  await sectionButtons[1].trigger("click");
  const agentSection = wrapper.get('[data-testid="dashboard-section-agent"]');
  assert.ok(getInstanceByDom(agentSection.get('.echarts-chart').element as HTMLElement));
  assert.ok(getInstanceByDom(agentSection.get('[data-testid="agent-message-type"] .distribution-echart').element as HTMLElement));
  for (const key of ["totalDuration", "runCount", "primaryRunCount", "subtaskRunCount", "userMessageCount", "assistantMessageCount", "toolCallCount", "toolSuccessRate", "manualCompactionCount", "autoCompactionCount"]) {
    const card = agentSection.get(`[data-testid="agent-metric-${key}"]`);
    await card.get("button").trigger("click");
    assert.equal(card.get("button").attributes("aria-pressed"), "true");
    const trend = agentSection.get(`[data-testid="agent-trend-${key}"]`);
    assert.equal(trend.get("h3").text(), card.get(".metric-title").text());
  }
  await sectionButtons[2].trigger("click");
  const modelSection = wrapper.get('[data-testid="dashboard-section-model"]');
  assert.ok(modelSection.find('[data-testid="model-metric-tokens"]').exists(), "模型详情仍保留输入/输出 Token");
  assert.ok(modelSection.get('[data-testid="model-metric-tokens"]').text().includes("4"));
  await modelSection.get('[data-testid="model-metric-cacheHitRate"] button').trigger("click");
  assert.ok(modelSection.find('[data-testid="model-trend-cacheHitRate"]').exists());
  await sectionButtons[3].trigger("click");
  assert.ok(wrapper.find('[data-testid="dashboard-section-worker"]').exists());
  wrapper.unmount();
});

test("概览工具调用趋势从 Agent 数据读取，部分采集仍保留真实零", async () => {
  const base = dashboardSuccessFixture;
  const toolMetric = base.data.agent.metrics.toolCallCount;
  const toolTrend = base.data.agent.trends.toolCallCount;
  const response = {
    ...base,
    data: {
      ...base.data,
      overview: { ...base.data.overview, totalTokens: { ...base.data.overview.totalTokens, value: { count: null } } },
      agent: { ...base.data.agent,
        metrics: { ...base.data.agent.metrics, toolCallCount: { ...toolMetric, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, value: 7 } },
        trends: { ...base.data.agent.trends, toolCallCount: { ...toolTrend, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, data: [{ from: 1, to: 2, count: 0 }, { from: 2, to: 3, count: 7 }] } },
      },
    },
  };
  assert.equal(Value.Check(DashboardQuerySuccessResponseSchema, response), true);
  const wrapper = mount(DashboardTab, {
    global: {
      plugins: [i18n],
      provide: { [dashboardQueryKey as symbol]: async () => response },
      stubs: {
        "a-select": { props: ["value"], template: '<select :value="value"><slot /></select>' },
        "a-select-option": { props: ["value"], template: '<option :value="value"><slot /></option>' },
        "a-button": { props: ["disabled"], template: '<button :disabled="disabled"><slot /></button>' },
        "a-alert": { template: '<div><slot /></div>' }, "a-spin": { template: '<div><slot /></div>' }, "a-empty": { template: '<div><slot /></div>' },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapper.find('[data-testid="overview-metric-totalTokens"]').exists(), false);
  const card = wrapper.get('[data-testid="overview-metric-toolCallCount"]');
  assert.equal(card.get(".metric-value").text(), "7");
  await card.get("button").trigger("click");
  assert.equal(card.get("button").attributes("aria-pressed"), "true");
  const chart = wrapper.get('[data-testid="overview-trend-toolCallCount"]');
  assert.match(chart.get("h3").text(), /工具调用|Tool calls/);
  assert.equal(chart.get(".echarts-chart").attributes("tabindex"), "0");
  assert.equal(chart.findAll('[data-testid^="chart-bucket-detail-"]').length, 2);
  assert.match(chart.get(".chart-details").text(), /0/);
  assert.match(chart.get(".chart-details").text(), /7/);
  assert.equal(chart.find(".metric-hint").exists(), false);
  await wrapper.get('.metric-grid.six button').trigger("click");
  assert.ok(wrapper.find('[data-testid="overview-trend-monitoringVolume"]').exists(), "切回其他卡片时趋势同步更新");
  wrapper.unmount();
});

test("概览工具调用未采集时，卡片与趋势均显示未知而非零", async () => {
  const base = dashboardSuccessFixture;
  const unavailable = { status: "unavailable" as const, dataIncomplete: true as const, unavailableReason: "domain_unavailable" as const, requiredDomains: ["tool" as const], comparison: { status: "domain_unavailable" as const, kind: null, delta: null } };
  const response = {
    ...base,
    data: { ...base.data, agent: { ...base.data.agent,
      metrics: { ...base.data.agent.metrics, toolCallCount: { ...unavailable, value: null } },
      trends: { ...base.data.agent.trends, toolCallCount: { ...unavailable, data: null } },
    } },
  };
  assert.equal(Value.Check(DashboardQuerySuccessResponseSchema, response), true);
  const wrapper = mount(DashboardTab, {
    global: {
      plugins: [i18n],
      provide: { [dashboardQueryKey as symbol]: async () => response },
      stubs: { "a-select": true, "a-select-option": true, "a-button": true, "a-alert": true, "a-spin": { template: '<div><slot /></div>' }, "a-empty": true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const card = wrapper.get('[data-testid="overview-metric-toolCallCount"]');
  assert.equal(card.get(".metric-value").text(), "—");
  await card.get("button").trigger("click");
  assert.ok(wrapper.get('[data-testid="overview-trend-toolCallCount"]').find(".empty-value").exists());
  assert.equal(wrapper.get('[data-testid="overview-trend-toolCallCount"]').find('.echarts-chart').exists(), false);
  wrapper.unmount();
});

test("Worker 等部分结果保留业务数据，仅专用健康区展示采集原因", () => {
  const workerPartial = { ...dashboardSuccessFixture.data.exceptions.workerLiveSnapshot, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const worker = mount(WorkerSnapshot, { ...options, props: { result: workerPartial, timezone: "UTC" } });
  assert.match(worker.text(), /本地降级|Local fallback/);
  assert.match(worker.text(), /最近 Ready|Last ready/);
  const recordsPartial = { ...dashboardSuccessFixture.data.worker.restartRecords, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const records = mount(RestartRecords, { ...options, props: { result: recordsPartial, timezone: "UTC" } });
  assert.match(records.text(), /重启成功|Restart succeeded/);
  const coverage = { ...dashboardSuccessFixture.data.model.metrics.inputTokenCoverage, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const metric = mount(MetricCard, { ...options, props: { title: "coverage", value: "100%", result: coverage } });
  assert.match(metric.text(), /100%/);
  for (const wrapper of [worker, records, metric]) {
    assert.equal(wrapper.findAll(".status").length, 0);
    assert.doesNotMatch(wrapper.text(), /\+10%/, "partial with an available comparison is not a reliable change");
    assert.doesNotMatch(wrapper.text(), /覆盖缺口|Coverage gap/);
  }
});

test("Ratio、Duration 的 null 值在 ECharts 折线上断开；Token 部分组成仅用散点", () => {
  const panels = [
    { kind: 'ratio' as const, panel: { ...dashboardSuccessFixture.data.model.trends.successRate, data: [
      { from: 1, to: 2, ratio: .25 }, { from: 2, to: 3, ratio: null }, { from: 3, to: 4, ratio: .75 }] } },
    { kind: 'duration' as const, panel: { ...dashboardSuccessFixture.data.model.trends.completedAverageDuration, data: [
      { from: 1, to: 2, durationMs: 2_000, reliableSampleCount: 1 }, { from: 2, to: 3, durationMs: null, reliableSampleCount: 0 }, { from: 3, to: 4, durationMs: 4_000, reliableSampleCount: 1 }] } },
  ];
  for (const { kind, panel } of panels) {
    const wrapper = mount(TrendChart, { ...options, attachTo: document.body, props: { title: kind, kind, panel } });
    const series = getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!.getOption().series as Array<{ type: string; data: Array<number | null>; connectNulls: boolean }>;
    assert.deepEqual(series[0].data, kind === 'ratio' ? [.25, null, .75] : [2_000, null, 4_000]);
    assert.equal(series[0].connectNulls, false);
    wrapper.unmount();
  }
});

test("各分区 ECharts 图具备可键盘读数的分组语义与展开明细", async () => {
  const panel = { ...dashboardSuccessFixture.data.model.trends.successRate, data: [
    { from: 1, to: 2, ratio: .25 }, { from: 2, to: 3, ratio: null }, { from: 3, to: 4, ratio: .75 }] };
  const wrapper = mount(TrendChart, { ...options, props: { title: 'rate', kind: 'ratio', panel } });
  const chart = wrapper.get('.echarts-chart');
  assert.equal(chart.attributes('role'), 'group');
  assert.equal(chart.attributes('tabindex'), '0');
  assert.match(chart.attributes('aria-label') ?? '', /平滑折线图|smooth line chart/);
  await chart.trigger('focus');
  await chart.trigger('keydown', { key: 'ArrowRight' });
  assert.match(wrapper.get('.keyboard-bucket').text(), /—/);
  assert.equal(wrapper.findAll('[data-testid^="chart-bucket-detail-"]').length, 3);
  wrapper.unmount();
});

test("模型请求状态 ECharts 四系列按原值堆叠；键盘图例保留隐藏状态总请求数", async () => {
 const panel={...dashboardSuccessFixture.data.model.trends.requests,data:[
  {from:1,to:2,completed:6,failed:2,timedOut:1,other:1},
  {from:2,to:3,completed:4,failed:0,timedOut:2,other:0}]};
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'model requests',kind:'model_status',panel}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const series=chart.getOption().series as Array<{type:string;stack:string;data:number[]}>;
 assert.equal(series.length,4);
 assert.ok(series.every((item)=>item.type==='bar' && item.stack==='total'));
 assert.deepEqual(series.map((item)=>item.data[0]),[6,2,1,1]);
 assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(),'10');
 assert.equal(wrapper.findAll('.echarts-legend button').length,4);
 const tooltip=(chart.getOption().tooltip as Array<{formatter:(params:unknown)=>string}>)[0].formatter;
 await wrapper.get('.echarts-legend button').trigger('click');
 assert.match(tooltip([{dataIndex:0}]),/全部状态合计|all statuses/);
 assert.equal(wrapper.findAll('svg.trend, .bar-segment').length,0);
 wrapper.unmount();
});

test("监控七域 partial 由 ECharts 绘制真实堆叠，reportedTotal 不被重算", () => {
 const panel={...dashboardSuccessFixture.data.overviewTrends.monitoringVolume,status:'partial' as const,completeness:'partial' as const,dataIncomplete:true as const,partialReason:'coverage_gap' as const,
 data:[{from:1,to:2,total:29,run:1,session:2,message:3,tool:4,execution:5,model:6,worker:7}]};
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'monitoring',kind:'monitoring',panel}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const bars=chart.getOption().series as Array<{type:string;stack:string;data:number[]}>;
 assert.equal(bars.length,7);
 assert.ok(bars.every((item)=>item.type==='bar' && item.stack==='total'));
 assert.equal(bars.reduce((total,item)=>total+item.data[0],0),28);
 assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(),'29');
 const tooltip=(chart.getOption().tooltip as Array<{formatter:(params:unknown)=>string}>)[0].formatter;
 assert.match(tooltip([{dataIndex:0}]),/29/);
 assert.doesNotMatch(wrapper.text(),/覆盖缺口|Coverage gap/);
 wrapper.unmount();
});

test("Token 和 Worker 事件由 ECharts 保持堆叠柱而非平滑折线", () => {
 const candidates=[
  {kind:'tokens' as const,panel:{...dashboardSuccessFixture.data.model.trends.tokens,data:[{from:1,to:2,inputTokens:8,outputTokens:2},{from:2,to:3,inputTokens:6,outputTokens:3}]}},
  {kind:'worker_events' as const,panel:{...dashboardSuccessFixture.data.worker.eventTrend,data:[{from:1,to:2,unexpectedExits:2,restartAttempts:3},{from:2,to:3,unexpectedExits:1,restartAttempts:4}]}}
 ];
 for(const {kind,panel} of candidates){
  const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:kind,kind,panel}});
  const bars=(getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!.getOption().series as Array<{type:string;stack?:string;data:number[]}>).filter((item)=>item.type==='bar');
  assert.equal(bars.length,2); assert.ok(bars.every((item)=>item.stack==='total'));
  assert.deepEqual(bars.map((item)=>item.data[0]),kind==='tokens'?[8,2]:[2,3]);
  assert.match(wrapper.get('.sr-only').text(),/堆叠柱状图|stacked bar chart/);
  wrapper.unmount();
 }
});

test("概览用六卡 + 双栏主趋势/健康表，卡片切换保留真实 DTO", async () => {
  const wrapper = mount(DashboardTab, {
    global: {
      plugins: [i18n],
      provide: { [dashboardQueryKey as symbol]: async () => dashboardSuccessFixture },
      stubs: { "a-select": true, "a-select-option": true, "a-button": true, "a-alert": true, "a-spin": { template: '<div><slot /></div>' }, "a-empty": true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const overview = wrapper.get('[data-testid="dashboard-section-overview"]');
  const cards = overview.findAll(".metric-grid.six .metric-card");
  assert.equal(cards.length, 6);
  const cardKeys = ["monitoringVolume", "agentDuration", "toolCallCount", "modelRequests", "modelSuccessRate", "cacheHitRate"];
  assert.deepEqual(cards.map((card) => card.get(".metric-title").text()), cardKeys.map((key) => i18n.global.t(`dashboard.${key}`)));
  assert.equal(overview.find('[data-testid="overview-metric-totalTokens"]').exists(), false);
  assert.ok(overview.find('[data-testid="overview-trend-monitoringVolume"]').exists());
  for (const [index, trend] of [
    "monitoringVolume", "agentDuration", "toolCallCount", "modelRequests", "modelSuccessRate", "cacheHitRate",
  ].entries()) {
    await cards[index]!.get("button").trigger("click");
    const chart = overview.get(`[data-testid="overview-trend-${trend}"]`);
    assert.match(chart.get("h3").text(), new RegExp(cards[index]!.get(".metric-title").text()));
  }
  assert.equal(overview.findAll(".overview-main > *").length, 2);
  assert.ok(overview.find('[data-testid="overview-domain-health"]').exists());
  assert.match(overview.find('[data-testid="overview-domain-health"] .dashboard-panel-head').text(), /数据域状态|Domain status summary/);
  assert.equal(overview.findAll('[data-testid="overview-domain-health"] .dashboard-panel-actions').length, 0);
  assert.equal(overview.findAll(".overview-diagnostics, .configuration-diagnostics").length, 0);
  assert.doesNotMatch(overview.text(), /配置诊断|Configuration diagnostic/);
  await overview.findAll(".metric-grid.six button")[1].trigger("click");
  assert.ok(overview.find('[data-testid="overview-trend-agentDuration"]').exists());
  await wrapper.findAll("nav.dashboard-section-tabs button")[3]!.trigger("click");
  assert.ok(wrapper.find('[data-testid="dashboard-section-worker"] .worker-main').exists());
  assert.equal(wrapper.findAll('[data-testid="dashboard-section-worker"] .domain-entry').length, 0);
  wrapper.unmount();
});

test("Dashboard 顶部仅提供时间范围和刷新，不显示时区控件或当前时区", async () => {
  const requests: string[] = [];
  const wrapper = mount(DashboardTab, {
    global: {
      plugins: [i18n],
      provide: { [dashboardQueryKey as symbol]: async (request: { timezone: string }) => {
        requests.push(request.timezone);
        return { ...dashboardSuccessFixture, timezone: request.timezone };
      } },
      stubs: { "a-select": true, "a-select-option": true, "a-button": true, "a-alert": true, "a-spin": { template: '<div><slot /></div>' }, "a-empty": true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const controls = wrapper.get(".controls");
  assert.equal(controls.findAll("a-select-stub").length, 1);
  assert.equal(controls.findAll("label").length, 1);
  assert.doesNotMatch(controls.text(), /时区|Timezone|Asia\/|Europe\/|America\/|UTC/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  wrapper.unmount();
});

test("范围内配置变更保留响应数据，但概览不显示配置诊断", async () => {
  const response = {
    ...dashboardSuccessFixture,
    data: {
      ...dashboardSuccessFixture.data,
      overview: {
        ...dashboardSuccessFixture.data.overview,
        monitoringVolume: {
          ...dashboardSuccessFixture.data.overview.monitoringVolume,
          value: {
            ...dashboardSuccessFixture.data.overview.monitoringVolume.value,
            configurationChangedWithinRange: true,
          },
        },
      },
    },
  };
  assert.equal(Value.Check(DashboardQuerySuccessResponseSchema, response), true);
  const wrapper = mount(DashboardTab, {
    global: {
      plugins: [i18n],
      provide: { [dashboardQueryKey as symbol]: async () => response },
      stubs: { "a-select": true, "a-select-option": true, "a-button": true, "a-alert": true, "a-spin": { template: '<div><slot /></div>' }, "a-empty": true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const overview = wrapper.get('[data-testid="dashboard-section-overview"]');
  assert.equal(overview.findAll(".overview-warning").length, 0);
  assert.equal(overview.findAll(".overview-diagnostics, .configuration-diagnostics").length, 0);
  assert.doesNotMatch(overview.text(), /配置诊断|Configuration diagnostic|配置版本|Configuration version/);
  assert.equal(overview.findAll(".metric-card").length, 6);
  assert.ok(overview.find('[data-testid="overview-domain-health"] table').exists());
  assert.equal(wrapper.findAll('[data-testid="dashboard-section-worker"] .domain-entry').length, 0);
  wrapper.unmount();
});

test("概览监控趋势只使用服务端 total，密集桶分类轴不显示每个日期", () => {
 const data=Array.from({length:40},(_,index)=>({from:Date.UTC(2025,0,1)+index*3_600_000,to:Date.UTC(2025,0,1)+(index+1)*3_600_000,total:index+1,run:index+1,session:0,message:0,tool:0,execution:0,model:0,worker:0}));
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'monitoring',kind:'monitoring_total',panel:{...dashboardSuccessFixture.data.overviewTrends.monitoringVolume,data},echarts:true}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const lines=chart.getOption().series as Array<{type:string;data:number[]}>;
 assert.equal(lines.length,1); assert.equal(lines[0].type,'line'); assert.deepEqual(lines[0].data,data.map((row)=>row.total));
  const axis = chart.getOption().xAxis as Array<{ axisLabel: { formatter: (value: string) => string } }>;
 assert.ok(Array.from({length:40},(_,i)=>axis[0].axisLabel.formatter(String(i))).filter(Boolean).length<=6);
 assert.equal(wrapper.findAll('svg.trend, .bar-segment').length,0);
 wrapper.unmount();
});

test("健康侧栏仅在表格逐行展示真实域状态和最后成功时间", () => {
  const available = dashboardSuccessFixture.data.exceptions.domainHealth;
  const result = { ...available, data: [
    available.data[0],
    { ...available.data[0], domain: "model" as const, status: "degraded" as const, lastSucceededAt: null },
  ] };
  const wrapper = mount(DomainSummary, { ...options, props: { result, timezone: "UTC" } });
  assert.equal(wrapper.findAll(".health-table tbody tr").length, 2);
  assert.match(wrapper.get(".dashboard-panel-head").text(), /数据域状态|Domain status summary/);
  assert.equal(wrapper.findAll(".dashboard-panel-actions").length, 0);
  assert.match(wrapper.get(".health-table tbody tr:first-child").text(), /1970/);
  assert.match(wrapper.get(".health-table tbody tr:last-child").text(), /—/);
  assert.match(wrapper.get(".health-table tbody tr:last-child").text(), /降级|Degraded/);
});

test("域状态摘要仅为异常域提供可操作的已知迹象，不猜测根因", async () => {
  const source = dashboardSuccessFixture.data.exceptions.domainHealth;
  const base = source.data[0]!;
  const worker = { ...base, domain: "worker" as const, status: "degraded" as const,
    coverageGaps: { ...base.coverageGaps, openCount: 3, hasOpenGap: true },
    slots: [{ ...base.slots[0]!, producerId: "secret-producer-id" }] };
  const disabled = { ...base, domain: "model" as const, status: "disabled" as const,
    expectedSlotCount: 0, activeGenerationCount: 0, slots: [] };
  const stale = { ...base, domain: "session" as const, status: "stale" as const,
    slots: [{ ...base.slots[0]!, checkpoint: { freshness: "stale" as const, observedAt: 2 } }] };
  const missing = { ...base, domain: "execution" as const, status: "degraded" as const,
    expectedSlotCount: 2, activeGenerationCount: 1,
    slots: [{ ...base.slots[0]!, checkpoint: { freshness: "missing" as const, observedAt: null } }] };
  const wrapper = mount(DomainSummary, { ...options, attachTo: document.body,
    props: { result: { ...source, data: [base, worker, disabled, stale, missing] } } });
  try {
    const rows = wrapper.findAll(".health-table tbody tr");
    assert.equal(rows.length, 5);
    assert.equal(rows[0]!.findAll(".health-evidence-trigger").length, 0);
    const triggers = rows.slice(1).map((row) => row.get("button.health-evidence-trigger"));
    for (const trigger of triggers) {
      assert.equal(trigger.attributes("type"), "button");
      assert.match(trigger.attributes("aria-label") ?? "", /已知异常迹象|Known indicators/);
    }
    assert.match(triggers[0]!.attributes("aria-label")!, /3 个开放覆盖缺口|3 open coverage gaps/);
    assert.doesNotMatch(triggers[0]!.attributes("aria-label")!, /根因|root cause|secret-producer-id/);
    assert.match(triggers[1]!.attributes("aria-label")!, /当前已禁用|currently disabled/);
    assert.match(triggers[2]!.attributes("aria-label")!, /检查点已过期|stale checkpoints/);
    assert.match(triggers[3]!.attributes("aria-label")!, /缺少活跃 Generation|no active generation/);
    assert.match(triggers[3]!.attributes("aria-label")!, /检查点缺失|no checkpoint/);
    await triggers[0]!.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(document.body.querySelector(".ant-popover-inner")?.textContent ?? "", /3 个开放覆盖缺口|3 open coverage gaps/);
  } finally {
    wrapper.unmount();
  }
});

test("概览窄屏布局有双栏堆叠与六卡重排断点", () => {
  const source = readFileSync(new URL("./views/DashboardTab.vue", import.meta.url), "utf8");
  assert.match(source, /\.overview-main\{display:grid;grid-template-columns:minmax\(0,2fr\) minmax\(280px,1fr\)/);
  assert.match(source, /@media\(max-width:930px\)\{\.overview-main\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(source, /@container\(max-width:700px\)\{\.metric-grid\.six\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("ECharts 大计数轴简写但 tooltip 与明细保持原始值", () => {
 const panel={...dashboardSuccessFixture.data.overviewTrends.monitoringVolume,data:[
  {from:1,to:2,total:1_234_567,run:1,session:1,message:1,tool:1,execution:1,model:1,worker:1},
  {from:2,to:3,total:1_500_000,run:1,session:1,message:1,tool:1,execution:1,model:1,worker:1}]};
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'monitoring',kind:'monitoring_total',panel,echarts:true}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const axis=(chart.getOption().yAxis as Array<{axisLabel:{formatter:(value:number)=>string}}>)[0];
 assert.match(axis.axisLabel.formatter(1_500_000),/1.5M/);
 assert.match(wrapper.get('[data-testid="chart-bucket-detail-0"]').text(),/1,234,567/);
 assert.match((chart.getOption().tooltip as Array<{formatter:(params:unknown)=>string}>)[0].formatter([{dataIndex:0}]),/1,234,567/);
 wrapper.unmount();
});

test("计数只有 1 时 ECharts 纵轴强制整数刻度且绘制零值", () => {
 const panel={...dashboardSuccessFixture.data.agent.trends.runCount,data:[{from:1,to:2,count:1},{from:2,to:3,count:0}]};
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'count',kind:'count',panel}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const axis=(chart.getOption().yAxis as Array<{minInterval:number;min:number}>)[0];
 assert.equal(axis.minInterval,1); assert.equal(axis.min,0);
 assert.deepEqual((chart.getOption().series as Array<{data:number[]}>)[0].data,[1,0]);
 wrapper.unmount();
});

test("短时长 ECharts 坐标轴、提示和明细均保留毫秒与秒", () => {
 const panel={...dashboardSuccessFixture.data.overviewTrends.agentDuration,data:[{from:1,to:2,durationMs:1500},{from:2,to:3,durationMs:500}]};
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'duration',kind:'duration',panel}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const axis=(chart.getOption().yAxis as Array<{axisLabel:{formatter:(value:number)=>string}}>)[0];
 assert.equal(axis.axisLabel.formatter(1500),'1.5s'); assert.equal(axis.axisLabel.formatter(500),'500ms');
 assert.match(wrapper.get('[data-testid="chart-bucket-detail-0"]').text(),/1.5s/);
 wrapper.unmount();
});

test("Worker 一次事件仍是 ECharts 整数轴的两系列堆叠柱", () => {
 const panel={...dashboardSuccessFixture.data.worker.eventTrend,data:[{from:1,to:2,unexpectedExits:1,restartAttempts:0}]};
 const wrapper=mount(TrendChart,{...options,attachTo:document.body,props:{title:'worker',kind:'worker_events',panel}});
 const chart=getInstanceByDom(wrapper.get('.echarts-chart').element as HTMLElement)!;
 const axis=(chart.getOption().yAxis as Array<{minInterval:number}>)[0];
 assert.equal(axis.minInterval,1);
 assert.deepEqual((chart.getOption().series as Array<{type:string;stack:string;data:number[]}>).map((series)=>[series.type,series.stack,series.data[0]]),[['bar','total',1],['bar','total',0]]);
 assert.equal(wrapper.get('[data-testid="chart-bucket-detail-0"] td:last-child').text(),'1');
 wrapper.unmount();
});

test("所有数据面板将采集状态留给健康区，空态不是零也不显示无效对比", () => {
  const unavailable = { status: "unavailable" as const, completeness: "none" as const, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["run" as const], comparison: { status: "not_applicable" as const, kind: null, delta: null } };
  const missingToolTable = { ...unavailable, data: null };
  const missingRecords = { ...unavailable, data: null };
  const missingSnapshot = { ...unavailable, value: null, snapshotAt: null, asOf: 2 };
  const panels = [
    mount(Tables, { ...options, props: { title: "details", panel: missingToolTable, tableKind: "tools" } }),
    mount(RestartRecords, { ...options, props: { result: missingRecords, timezone: "UTC" } }),
    mount(WorkerSnapshot, { ...options, props: { result: missingSnapshot, timezone: "UTC" } }),
    mount(TrendChart, { ...options, props: { title: "count", kind: "count", panel: { ...unavailable, data: null } } }),
  ];
  for (const [index, wrapper] of panels.entries()) {
    assert.equal(wrapper.findAll(".status").length, 0);
    if (index === 2) {
      // The live snapshot keeps four visible cards when unavailable, each showing a neutral unknown value.
      assert.equal(wrapper.findAll(".snapshot-grid strong").length, 4);
      assert.ok(wrapper.findAll(".snapshot-grid strong").every((value) => value.text() === "—"));
    } else {
      assert.equal(wrapper.get("[role=note]").text(), "—");
      assert.ok(wrapper.get("[role=note]").attributes("aria-label"));
    }
    assert.doesNotMatch(wrapper.text(), /覆盖缺口|Coverage gap|暂无可安全展示的数据|No safe data|不适用|Not applicable/);
    assert.doesNotMatch(wrapper.text(), /\b0\b/);
  }
  assert.equal(panels[0].findAll("table").length, 0);
  assert.equal(panels[1].findAll("table").length, 0);
});

test("partial 的分布、明细、折线和业务状态保留已知值，不显示采集诊断", () => {
  const partial = { status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const, requiredDomains: ["run" as const], comparison: { status: "previous_not_covered" as const, kind: null, delta: null } };
  const distribution = mount(AgentDistribution, { ...options, props: { title: "distribution", panel: { ...dashboardSuccessFixture.data.agent.runTypeDistribution, ...partial }, labelGroup: "distribution", variant: "donut" } });
  const table = mount(Tables, { ...options, props: { title: "details", tableKind: "tools", panel: { ...dashboardSuccessFixture.data.agent.toolDetails, ...partial } } });
  const records = mount(RestartRecords, { ...options, props: { result: { ...dashboardSuccessFixture.data.worker.restartRecords, ...partial }, timezone: "UTC" } });
  const snapshot = mount(WorkerSnapshot, { ...options, props: { result: { ...dashboardSuccessFixture.data.exceptions.workerLiveSnapshot, ...partial }, timezone: "UTC" } });
  const chart = mount(TrendChart, { ...options, props: { title: "count", kind: "count", panel: { ...dashboardSuccessFixture.data.agent.trends.runCount, ...partial, data: [{ from: 1, to: 2, count: 0 }] } } });
  for (const wrapper of [distribution, table, records, snapshot, chart]) {
    assert.equal(wrapper.findAll(".status").length, 0);
    assert.doesNotMatch(wrapper.text(), /覆盖缺口|Coverage gap|上一范围未覆盖|Previous period not covered/);
  }
  assert.match(distribution.text(), /2/);
  assert.match(table.text(), /read/);
  assert.match(records.text(), /重启成功|Restart succeeded/);
  assert.match(snapshot.text(), /运行中|Running/);
  assert.match(chart.get(".chart-details").text(), /0/);
  const health = mount(DomainSummary, { ...options, props: { result: { ...dashboardSuccessFixture.data.exceptions.domainHealth, ...partial } } });
  assert.ok(health.findAll(".status").length > 0);
  assert.match(health.text(), /覆盖缺口|Coverage gap/);
});
test("Worker 利用率用 ECharts 横条保持安全原始比率", () => {
  const wrapper = mount(WorkerSnapshot, { ...options, attachTo: document.body, props: { result: dashboardSuccessFixture.data.exceptions.workerLiveSnapshot, timezone: "UTC" } });
  const host = wrapper.get('.mini-ratio-echart');
  assert.equal(wrapper.find('progress').exists(), false);
  assert.equal(host.attributes('data-ratio'), '0.5');
  const series = getInstanceByDom(host.element as HTMLElement)!.getOption().series as Array<{ type: string; data: number[] }>;
  assert.equal(series[0].type, 'bar');
  assert.deepEqual(series[0].data, [0.5]);
  wrapper.unmount();
});
test("Agent 分布全零时环图及条图键盘读数不把未知占比说成零", async () => {
  for (const variant of ['donut', 'bars'] as const) {
    for (const partial of [false, true]) {
      const wrapper = mount(DistributionEChart, { ...options, attachTo: document.body, props: {
        title: 'Distribution', variant, partial, labelGroup: 'distribution', colors: ['#7388e9', '#57bfa7'],
        rows: [{ label: 'primary', count: 0 }, { label: 'subtask', count: 0 }],
      } });
      const host = wrapper.get('.distribution-echart');
      const chart = getInstanceByDom(host.element as HTMLElement)!;
      const series = chart.getOption().series as Array<{ type: string; data: Array<{ value: number }> }>;
      assert.equal(series[0].type, variant === 'donut' ? 'pie' : 'bar');
      assert.deepEqual(series[0].data.map(({ value }) => value), [0, 0]);
      const tooltip = (chart.getOption().tooltip as Array<{ formatter: (params: unknown) => string }>)[0].formatter;
      assert.match(tooltip({ dataIndex: 0 }), /0.*—/s);
      assert.doesNotMatch(tooltip({ dataIndex: 1 }), /0%/);
      await host.trigger('focus');
      assert.match(wrapper.get('.distribution-current').text(), /0.*—/s);
      await host.trigger('keydown', { key: 'ArrowDown' });
      assert.match(wrapper.get('.distribution-current').text(), /0.*—/s);
      assert.doesNotMatch(host.attributes('aria-label') ?? '', /0%/);
      wrapper.unmount();
    }
  }
});
