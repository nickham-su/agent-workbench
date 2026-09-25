import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DashboardQuerySuccessResponseSchema, type DashboardData } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import { mount } from "@vue/test-utils";
import { i18n } from "@/shared/i18n";
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
import { dashboardSuccessFixture } from "./dashboard-fixture";
import DashboardTab from "./views/DashboardTab.vue";
import { dashboardQueryKey } from "./dashboard-injection";

const options = { global: { plugins: [i18n] } };
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
  const wrapper = mount(ModelSection, { ...options, props: { model, cacheHitRate: dashboardSuccessFixture.data.overview.cacheHitRate, timezone: "UTC" } });
  const tokenValues = wrapper.get(".token-values").text();
  assert.match(tokenValues, /0/);
  assert.match(tokenValues, /—/);
  assert.equal(wrapper.get("[data-testid='model-coverage-inputTokenCoverage'] progress").attributes("value"), "0.25");
  assert.equal(wrapper.get("[data-testid='model-coverage-outputTokenCoverage'] progress").attributes("value"), "0");
  assert.match(wrapper.get("[data-testid='model-coverage-outputTokenCoverage']").text(), /0%/);
  assert.equal(wrapper.find("[data-testid='model-coverage-totalTokenCoverage'] progress").exists(), false);
  assert.equal(wrapper.find("[data-testid='model-coverage-inputCacheCoverage'] progress").exists(), false);
  assert.doesNotMatch(wrapper.get("[data-testid='model-coverage']").text(), /覆盖缺口|Coverage gap|不可用|Unavailable/);
  assert.equal(wrapper.get("[data-testid='model-metric-tokens']").findAll(".token-comparison").length, 0);
  assert.equal(wrapper.get("[data-testid='model-coverage-inputTokenCoverage']").findAll(".coverage-comparison").length, 0);
  assert.doesNotMatch(wrapper.get("[data-testid='model-coverage-inputTokenCoverage'] progress").attributes("aria-label") ?? "", /\+10%/);
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
  assert.match(wrapper.get("[data-testid='model-coverage-outputTokenCoverage'] progress").attributes("aria-label") ?? "", /0%.*\+0.0pp/);
  assert.equal(wrapper.find("[data-testid='model-coverage-totalTokenCoverage'] .coverage-comparison").exists(), false);
  wrapper.unmount();
});
test("Agent 6+4 指标与趋势、三块汇总和工具状态按照原型布局且保留交互", async () => {
  const wrapper = mount(AgentSection, { ...options, props: { agent: dashboardSuccessFixture.data.agent, timezone: "UTC" } });
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
  await wrapper.get('.scope-controls button:nth-child(2)').trigger('click');
  assert.equal(wrapper.get('.scope-controls button:nth-child(2)').attributes('aria-pressed'), 'true');
  assert.match(wrapper.get('[data-testid="agent-run-terminal"] .donut-center').text(), /2/);
  assert.match(wrapper.get('[data-testid="agent-tool-status"] .donut-center').text(), /2/);
  const styles = readFileSync(new URL("./components/DashboardAgentSection.vue", import.meta.url), "utf8");
  assert.match(styles, /@container\(max-width:780px\)[^{]*\{[^}]*\.agent-main,\.agent-tools,\.agent-distributions\{grid-template-columns:minmax\(0,1fr\)/);
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
test("连续已知 Input Token 与未知 Output Token 按 bucket 输出 fallback marker，不补零或连线", () => {
  const panel = {
    ...dashboardSuccessFixture.data.model.trends.tokens,
    data: [
      { from: 1, to: 2, inputTokens: 4, outputTokens: null },
      { from: 2, to: 3, inputTokens: 8, outputTokens: null },
    ],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "tokens", kind: "tokens", panel } });
  assert.doesNotMatch(wrapper.html(), /NaN/);
  assert.equal(wrapper.findAll(".bar-segment").length, 0);
  const inputMarkers = wrapper.findAll(".token-fallback-marker[data-series='inputTokens']");
  const axisLabels = wrapper.findAll(".chart-axis-label");
  const bucketHits = wrapper.findAll(".chart-bucket .chart-hit");
  assert.equal(inputMarkers.length, 2);
  assert.equal(wrapper.findAll(".token-fallback-marker[data-series='outputTokens']").length, 0);
  assert.equal(wrapper.findAll("polyline").length, 0);
  inputMarkers.forEach((marker, index) => {
    const center = Number(marker.attributes("cx"));
    const hit = bucketHits[index];
    assert.equal(center, Number(axisLabels[index].attributes("data-x")), "fallback marker shares the bucket axis center");
    assert.ok(center >= Number(hit.attributes("x")) && center <= Number(hit.attributes("x")) + Number(hit.attributes("width")), "fallback marker stays inside its bucket hit target");
  });
  const details = wrapper.get(".chart-details").text();
  assert.match(details, /4/); assert.match(details, /8/); assert.match(details, /—/);
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
  const tokenCard = wrapper.get('[data-testid="overview-metric-totalTokens"]');
  assert.match(tokenCard.get(".metric-title").text(), /总 Token|Total tokens/);
  assert.equal(tokenCard.get(".metric-value").text(), "9");
  await tokenCard.get("button").trigger("click");
  assert.ok(wrapper.get('[data-testid="overview-trend-totalTokens"] .chart-bucket').attributes("aria-label")?.includes("9"));
  const sectionButtons = wrapper.findAll("nav.dashboard-section-tabs button");
  assert.equal(sectionButtons.length, 4);
  assert.doesNotMatch(sectionButtons.map((button) => button.text()).join(" "), /Git/);
  assert.equal(wrapper.find('[data-testid="dashboard-section-git"]').exists(), false);
  await sectionButtons[1].trigger("click");
  const agentSection = wrapper.get('[data-testid="dashboard-section-agent"]');
  for (const key of ["totalDuration", "runCount", "primaryRunCount", "subtaskRunCount", "userMessageCount", "assistantMessageCount", "toolCallCount", "toolSuccessRate", "manualCompactionCount", "autoCompactionCount"]) {
    const card = agentSection.get(`[data-testid="agent-metric-${key}"]`);
    await card.get("button").trigger("click");
    assert.equal(card.get("button").attributes("aria-pressed"), "true");
    const trend = agentSection.get(`[data-testid="agent-trend-${key}"]`);
    assert.equal(trend.get("h3").text(), card.get(".metric-title").text());
  }
  await sectionButtons[2].trigger("click");
  const modelSection = wrapper.get('[data-testid="dashboard-section-model"]');
  await modelSection.get('[data-testid="model-metric-cacheHitRate"] button').trigger("click");
  assert.ok(modelSection.find('[data-testid="model-trend-cacheHitRate"]').exists());
  await sectionButtons[3].trigger("click");
  assert.ok(wrapper.find('[data-testid="dashboard-section-worker"]').exists());
  wrapper.unmount();
});

test("概览总 Token 未知显示中性空值，可靠零显示 0；点击后趋势遵循同一语义", async () => {
  for (const [count, label] of [[null, "—"], [0, "0"]] as const) {
    const base = dashboardSuccessFixture;
    const response = {
      ...base,
      data: {
        ...base.data,
        overview: { ...base.data.overview, totalTokens: { ...base.data.overview.totalTokens, value: { count } } },
        overviewTrends: { ...base.data.overviewTrends, totalTokens: { ...base.data.overviewTrends.totalTokens, data: [{ from: 1, to: 2, count }] } },
        model: { ...base.data.model, metrics: { ...base.data.model.metrics, totalTokens: { ...base.data.model.metrics.totalTokens, value: { count } } } },
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
          "a-button": { props: ["disabled"], emits: ["click"], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
          "a-alert": { template: '<div><slot /></div>' }, "a-spin": { template: '<div><slot /></div>' }, "a-empty": { template: '<div><slot /></div>' },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const card = wrapper.get('[data-testid="overview-metric-totalTokens"]');
    assert.equal(card.get(".metric-value").text(), label);
    assert.equal(card.find(".metric-foot").exists(), false);
    await card.get("button").trigger("click");
    const chart = wrapper.get('[data-testid="overview-trend-totalTokens"]');
    assert.match(chart.get(".chart-bucket").attributes("aria-label") ?? "", count === null ? /—/ : /(?:总 Token|Total tokens) 0/);
    assert.equal(chart.findAll(".line-marker").length, count === null ? 0 : 1);
    wrapper.unmount();
  }
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

test("合法 Ratio、Token、Duration 的 null bucket 使用独立 marker，且绝不跨 gap 连线", () => {
  const ratioPanel = {
    ...dashboardSuccessFixture.data.model.trends.successRate,
    data: [
      { from: 1_700_000_000_000, to: 1_700_000_360_000, ratio: .25 },
      { from: 1_700_000_360_000, to: 1_700_000_720_000, ratio: null },
      { from: 1_700_000_720_000, to: 1_700_001_080_000, ratio: .75 },
    ],
  };
  const durationPanel = {
    ...dashboardSuccessFixture.data.model.trends.completedAverageDuration,
    data: [
      { from: 1_700_000_000_000, to: 1_700_000_360_000, durationMs: 2_000, reliableSampleCount: 1 },
      { from: 1_700_000_360_000, to: 1_700_000_720_000, durationMs: null, reliableSampleCount: 0 },
      { from: 1_700_000_720_000, to: 1_700_001_080_000, durationMs: 4_000, reliableSampleCount: 1 },
    ],
  };
  const tokenPanel = {
    ...dashboardSuccessFixture.data.model.trends.tokens,
    data: [
      { from: 1_700_000_000_000, to: 1_700_000_360_000, inputTokens: 4, outputTokens: null },
      { from: 1_700_000_360_000, to: 1_700_000_720_000, inputTokens: null, outputTokens: null },
      { from: 1_700_000_720_000, to: 1_700_001_080_000, inputTokens: 8, outputTokens: null },
    ],
  };
  for (const { kind, panel } of [
    { kind: "ratio" as const, panel: ratioPanel },
    { kind: "duration" as const, panel: durationPanel },
    { kind: "tokens" as const, panel: tokenPanel },
  ]) {
    const wrapper = mount(TrendChart, { ...options, props: { title: kind, kind, panel, timezone: "UTC" } });
    assert.equal(wrapper.findAll(".line-marker").length, 2, `${kind} retains two isolated known values as markers`);
    assert.equal(wrapper.findAll("polyline").length, 0, `${kind} never connects across its null bucket`);
  }
});

test("趋势 SVG 以 group 描述图表，时间桶保持独立键盘可达语义和明细", () => {
  const panel = {
    ...dashboardSuccessFixture.data.model.trends.successRate,
    data: [
      { from: 1_700_000_000_000, to: 1_700_000_360_000, ratio: .25 },
      { from: 1_700_000_360_000, to: 1_700_000_720_000, ratio: null },
      { from: 1_700_000_720_000, to: 1_700_001_080_000, ratio: .75 },
    ],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "rate", kind: "ratio", panel, timezone: "UTC" } });
  const chart = wrapper.get("svg");
  assert.equal(chart.attributes("role"), "group");
  const labelledBy = chart.attributes("aria-labelledby")?.split(" ") ?? [];
  assert.equal(labelledBy.length, 2);
  for (const id of labelledBy) assert.ok(wrapper.find(`#${id}`).exists(), `${id} names or describes the chart`);
  assert.equal(wrapper.findAll(".chart-bucket[role='group'][tabindex='0']").length, 3);
  assert.equal(wrapper.findAll("[data-testid^='chart-bucket-detail-']").length, 3);
  assert.match(wrapper.get(".chart-details").text(), /时间桶|Time bucket/);
});

test("模型请求状态按后端 bucket 状态值堆叠为柱，轴标签对齐柱中心且图例可访问", () => {
  const panel = {
    ...dashboardSuccessFixture.data.model.trends.requests,
    data: [
      { from: 1, to: 2, completed: 6, failed: 2, timedOut: 1, other: 1 },
      { from: 2, to: 3, completed: 4, failed: 0, timedOut: 2, other: 0 },
    ],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "model requests", kind: "model_status", panel } });
  assert.equal(wrapper.findAll("polyline").length, 0);
  assert.equal(wrapper.findAll(".bar-segment.stacked-bars").length, 8);
  const firstBucket = wrapper.get("[data-testid='stacked-bars-bucket-0']");
  assert.equal(firstBucket.attributes("data-stack-total"), "10");
  assert.equal(firstBucket.findAll(".bar-segment").reduce((total, item) => total + Number(item.attributes("data-value")), 0), 10);
  const firstSegment = firstBucket.get(".bar-segment");
  const firstAxis = wrapper.get(".chart-axis-label");
  assert.equal(Number(firstAxis.attributes("data-x")), Number(firstSegment.attributes("x")) + Number(firstSegment.attributes("width")) / 2);
  const legend = wrapper.get(".chart-legend");
  assert.match(legend.attributes("aria-label") ?? "", /图例|Legend/);
  assert.equal(legend.findAll("li").length, 4);
  assert.match(legend.text(), /完成|Completed/);
});

test("监控数据量使用合法 partial PanelResult 表达不完整，并保留七域组成", () => {
  const panel = {
    ...dashboardSuccessFixture.data.overviewTrends.monitoringVolume,
    status: "partial" as const,
    completeness: "partial" as const,
    dataIncomplete: true as const,
    partialReason: "coverage_gap" as const,
    data: [
      { from: 1, to: 2, total: 28, run: 1, session: 2, message: 3, tool: 4, execution: 5, model: 6, worker: 7 },
      { from: 2, to: 3, total: 28, run: 1, session: 2, message: 3, tool: 4, execution: 5, model: 6, worker: 7 },
    ],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "monitoring", kind: "monitoring", panel } });
  const completeBucket = wrapper.get("[data-testid='stacked-bars-bucket-0']");
  assert.equal(completeBucket.attributes("data-stack-total"), "28");
  assert.equal(completeBucket.findAll(".bar-segment").length, 7);
  assert.equal(completeBucket.findAll(".bar-segment").reduce((total, item) => total + Number(item.attributes("data-value")), 0), 28);
  assert.equal(wrapper.findAll(".chart-legend li").length, 7);
  assert.doesNotMatch(wrapper.text(), /覆盖缺口|Coverage gap/);
});

test("Token 与 Worker 事件遵循原型使用堆叠柱状图而不是通用折线", () => {
  const tokenPanel = {
    ...dashboardSuccessFixture.data.model.trends.tokens,
    data: [
      { from: 1_700_000_000_000, to: 1_700_000_360_000, inputTokens: 8, outputTokens: 2 },
      { from: 1_700_000_360_000, to: 1_700_000_720_000, inputTokens: 6, outputTokens: 3 },
    ],
  };
  const workerPanel = {
    ...dashboardSuccessFixture.data.worker.eventTrend,
    data: [
      { from: 1_700_000_000_000, to: 1_700_000_360_000, unexpectedExits: 2, restartAttempts: 3 },
      { from: 1_700_000_360_000, to: 1_700_000_720_000, unexpectedExits: 1, restartAttempts: 4 },
    ],
  };
  for (const { title, kind, panel } of [
    { title: "tokens", kind: "tokens" as const, panel: tokenPanel },
    { title: "worker", kind: "worker_events" as const, panel: workerPanel },
  ]) {
    const wrapper = mount(TrendChart, { ...options, props: { title, kind, panel, timezone: "UTC" } });
    assert.equal(wrapper.findAll("polyline").length, 0);
    assert.equal(wrapper.findAll(".bar-segment.stacked-bars").length, 4);
    const firstBucket = wrapper.get("[data-testid='stacked-bars-bucket-0']");
    assert.equal(firstBucket.findAll(".bar-segment").at(0)?.attributes("x"), firstBucket.findAll(".bar-segment").at(1)?.attributes("x"));
    assert.equal(wrapper.findAll(".chart-axis-label").length, 2);
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
  assert.equal(overview.findAll(".metric-grid.six .metric-card").length, 6);
  assert.equal(overview.findAll(".overview-main > *").length, 2);
  assert.ok(overview.find('[data-testid="overview-trend-monitoringVolume"]').exists());
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

test("概览监控折线只采用服务端 total；密集桶轴最多五个标签，无 SVG 常显日期", () => {
  const data = Array.from({ length: 40 }, (_, index) => ({
    from: Date.UTC(2025, 0, 1) + index * 3_600_000,
    to: Date.UTC(2025, 0, 1) + (index + 1) * 3_600_000,
    total: index + 1, run: index + 1, session: 0, message: 0, tool: 0,
    execution: 0, model: 0, worker: 0,
  }));
  const panel = { ...dashboardSuccessFixture.data.overviewTrends.monitoringVolume, data };
  const wrapper = mount(TrendChart, { ...options, props: { title: "monitoring", kind: "monitoring_total", panel } });
  assert.equal(wrapper.findAll(".chart-axis-label").length <= 5, true);
  assert.equal(wrapper.findAll("svg text").length, 0);
  assert.equal(wrapper.findAll(".bar-segment").length, 0);
  assert.equal(wrapper.findAll(".chart-area").length, 1);
  assert.equal(wrapper.findAll("[data-testid^='chart-bucket-detail-']").length, 40);
  assert.equal(wrapper.findAll(".chart-bucket[tabindex='0']").length, 40);
  assert.equal(wrapper.get(".chart-bucket").attributes("aria-label")?.includes("1"), true);
  const unknown = { status: "unavailable" as const, data: null, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["run" as const], comparison: { status: "not_applicable" as const, kind: null, delta: null } };
  const unavailable = mount(TrendChart, { ...options, props: { title: "monitoring", kind: "monitoring_total", panel: unknown } });
  assert.equal(unavailable.findAll(".line-segment").length, 0);
  assert.equal(unavailable.get("[role=note]").text(), "—");
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

test("大计数轴不显示会被截断的完整数字，bucket 仍提供完整原始值", () => {
  const panel = {
    ...dashboardSuccessFixture.data.overviewTrends.monitoringVolume,
    data: [
      { from: 1, to: 2, total: 1_234_567, run: 1_234_567, session: 0, message: 0, tool: 0, execution: 0, model: 0, worker: 0 },
      { from: 2, to: 3, total: 500_000, run: 500_000, session: 0, message: 0, tool: 0, execution: 0, model: 0, worker: 0 },
    ],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "monitoring", kind: "monitoring_total", panel } });
  const axisLabels = wrapper.findAll(".chart-y-axis span").map((label) => label.text());
  assert.deepEqual(axisLabels, ["1.5M", "1M", "500k", "0"]);
  assert.equal(wrapper.findAll(".chart-grid-line").length, axisLabels.length);
  assert.ok(wrapper.get(".chart-bucket").attributes("aria-label")?.includes("1,234,567"));
  assert.ok(wrapper.get('[data-testid="chart-bucket-detail-0"]').text().includes("1,234,567"));
  assert.equal(wrapper.findAll(".line-segment").length, 1);
});

test("计数最大值为 1 时纵轴仅显示整数 1/0 并与网格及数据坐标一致", () => {
  const panel = {
    ...dashboardSuccessFixture.data.agent.trends.runCount,
    data: [{ from: 1, to: 2, count: 1 }, { from: 2, to: 3, count: 0 }],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "count", kind: "count", panel } });
  assert.deepEqual(wrapper.findAll(".chart-y-axis span").map((label) => label.text()), ["1", "0"]);
  assert.deepEqual(wrapper.findAll(".chart-grid-line").map((line) => Number(line.attributes("y1"))), [4, 56]);
  assert.equal(wrapper.get(".line-segment").attributes("points"), "6,4 94,56");
});

test("合法短时长趋势在纵轴与 bucket 明细中按秒/毫秒显示", () => {
  const panel = {
    ...dashboardSuccessFixture.data.overviewTrends.agentDuration,
    data: [{ from: 1, to: 2, durationMs: 1_500 }, { from: 2, to: 3, durationMs: 500 }],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "duration", kind: "duration", panel } });
  assert.deepEqual(wrapper.findAll(".chart-y-axis span").map((label) => label.text()), ["1.5s", "1s", "500ms", "0ms"]);
  assert.ok(wrapper.get(".chart-bucket").attributes("aria-label")?.includes("1.5s"));
  assert.ok(wrapper.get('[data-testid="chart-bucket-detail-0"]').text().includes("1.5s"));
  assert.equal(wrapper.findAll(".chart-grid-line").length, 4);
});

test("Worker 堆叠计数为 1 时也只用整数轴，保留原有堆叠形态", () => {
  const panel = {
    ...dashboardSuccessFixture.data.worker.eventTrend,
    data: [{ from: 1, to: 2, unexpectedExits: 1, restartAttempts: 0 }],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "worker", kind: "worker_events", panel } });
  assert.deepEqual(wrapper.findAll(".chart-y-axis span").map((label) => label.text()), ["1", "0"]);
  assert.equal(wrapper.findAll(".bar-segment").length, 2);
  assert.equal(wrapper.findAll(".line-segment").length, 0);
  assert.equal(wrapper.get("[data-testid='stacked-bars-bucket-0']").attributes("data-stack-total"), "1");
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
  assert.match(chart.get(".chart-bucket").attributes("aria-label") ?? "", /0/);
  const health = mount(DomainSummary, { ...options, props: { result: { ...dashboardSuccessFixture.data.exceptions.domainHealth, ...partial } } });
  assert.ok(health.findAll(".status").length > 0);
  assert.match(health.text(), /覆盖缺口|Coverage gap/);
});
