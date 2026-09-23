import assert from "node:assert/strict";
import test from "node:test";
import { DashboardQuerySuccessResponseSchema } from "@agent-workbench/shared";
import { Value } from "@sinclair/typebox/value";
import { mount } from "@vue/test-utils";
import { i18n } from "@/shared/i18n";
import MetricCard from "./components/DashboardMetricCard.vue";
import TrendChart from "./components/DashboardTrendChart.vue";
import GitHeatmap from "./components/DashboardGitHeatmap.vue";
import DomainHealth from "./components/DashboardDomainHealth.vue";
import DomainSummary from "./components/DashboardDomainSummary.vue";
import WorkerSnapshot from "./components/DashboardWorkerSnapshot.vue";
import GitMetricCard from "./components/DashboardGitMetricCard.vue";
import RestartRecords from "./components/DashboardRestartRecords.vue";
import { dashboardSuccessFixture } from "./dashboard-fixture";
import DashboardTab from "./views/DashboardTab.vue";
import { dashboardQueryKey } from "./dashboard-injection";

const options = { global: { plugins: [i18n] } };
test("Dashboard shared fixture 符合公开 TypeBox 响应合同", () => { assert.equal(Value.Check(DashboardQuerySuccessResponseSchema, dashboardSuccessFixture), true); });
test("真实 shared 成功夹具：指标卡保留服务端 comparison，不把 unavailable 变为零", async () => { const result = dashboardSuccessFixture.data.overview.modelRequests; const wrapper = mount(MetricCard, { ...options, props: { title: "requests", value: "3", result } }); assert.match(wrapper.text(), /\+10%|\+10\.0%/); const unavailable = { status: "unavailable" as const, value: null, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["run" as const], comparison: { status: "not_applicable" as const, kind: null, delta: null } }; await wrapper.setProps({ value: "—", result: unavailable }); assert.match(wrapper.text(), /暂无可安全展示的数据|No safe data/); });
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
    assert.equal(center, Number(axisLabels[index].attributes("x")), "fallback marker shares the bucket axis center");
    assert.ok(center >= Number(hit.attributes("x")) && center <= Number(hit.attributes("x")) + Number(hit.attributes("width")), "fallback marker stays inside its bucket hit target");
  });
  const details = wrapper.get(".chart-details").text();
  assert.match(details, /4/); assert.match(details, /8/); assert.match(details, /—/);
});
test("Git partial 显示 ready/total 与受控 reason，健康面板显示 slot 诊断", () => { const heatmap = { ...dashboardSuccessFixture.data.exceptions.gitHeatmap180d, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "repo_not_ready" as const }; const heatmapWrapper = mount(GitHeatmap, { ...options, props: { result: heatmap, timezone: "UTC" } }); assert.match(heatmapWrapper.text(), /1\/1/); assert.match(heatmapWrapper.text(), /仓库未就绪|Repository not ready/); assert.equal(heatmapWrapper.findAll(".heatmap span").length, 1); const healthWrapper = mount(DomainHealth, { ...options, props: { result: dashboardSuccessFixture.data.exceptions.domainHealth, timezone: "UTC" } }); assert.match(healthWrapper.text(), /api\/a/); assert.match(healthWrapper.text(), /Generation 活跃|Generation active/); });
test("DomainHealth 同一 slot 的两代均以 generation key 渲染身份与 lifecycle", () => {
  const source = dashboardSuccessFixture.data.exceptions.domainHealth;
  const first = source.data![0]!;
  const active = first.slots.find((slot) => slot.slotStatus === "generation_active")!;
  const old = { ...active, producerGeneration: "generation-old", lifecycle: "stale" as const, checkpoint: { freshness: "stale" as const, observedAt: 1 } };
  const current = { ...active, producerGeneration: "generation-new", lifecycle: "registered" as const, checkpoint: { freshness: "fresh" as const, observedAt: 2 } };
  const result = { ...source, data: [{ ...first, activeGenerationCount: 2, slots: [old, current] }, ...source.data!.slice(1)] } as typeof source;
  const wrapper = mount(DomainHealth, { ...options, props: { result, timezone: "UTC" } });
  assert.match(wrapper.text(), /generation-old/); assert.match(wrapper.text(), /generation-new/);
  assert.match(wrapper.text(), /Stale|陈旧/); assert.match(wrapper.text(), /Registered|已注册/);
  assert.equal(wrapper.findAll("li").filter((item) => item.text().includes("generation-")).length, 2);
});


test("Overview Git partial 卡和趋势保留下界、仓库进度及原因", () => {
  const metric = { ...dashboardSuccessFixture.data.overview.gitCommits, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "repo_not_ready" as const };
  const trend = { ...dashboardSuccessFixture.data.overviewTrends.gitCommits, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "repo_not_ready" as const };
  const card = mount(GitMetricCard, { ...options, props: { title: "commits", value: "1", result: metric, selected: false } });
  const chart = mount(TrendChart, { ...options, props: { title: "commits", kind: "count", panel: trend, gitMetadata: trend } });
  for (const wrapper of [card, chart]) {
    assert.match(wrapper.text(), /已知部分下界|Known partial lower bound/);
    assert.match(wrapper.text(), /1\/1/);
    assert.match(wrapper.text(), /仓库未就绪|Repository not ready/);
  }
});
test("Domain summary 在 available 与 partial 展示已知域，仅 unavailable 隐藏域", () => {
  const available = dashboardSuccessFixture.data.exceptions.domainHealth;
  const partial = { ...available, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const unavailable = { status: "unavailable" as const, completeness: "none" as const, dataIncomplete: true as const, unavailableReason: "no_safe_data" as const, requiredDomains: ["run" as const], comparison: available.comparison, data: null, diagnosedAt: 2, asOf: 2 };
  for (const [result, hasKnownData] of [[available, true], [partial, true], [unavailable, false]] as const) {
    const wrapper = mount(DomainSummary, { ...options, props: { result } });
    assert.equal(wrapper.findAll(".domains span").length > 0, hasKnownData);
    if (result.status === "partial") assert.match(wrapper.text(), /覆盖缺口|Coverage gap/);
    if (result.status === "unavailable") assert.match(wrapper.text(), /暂无可安全展示的数据|No safe data/);
  }
});
test("Worker 实时快照使用 shared value 与 snapshotAt", () => { const wrapper = mount(WorkerSnapshot, { ...options, props: { result: dashboardSuccessFixture.data.exceptions.workerLiveSnapshot, timezone: "UTC" } }); assert.match(wrapper.text(), /运行中|Running/); assert.match(wrapper.text(), /1/); assert.match(wrapper.text(), /快照时间|Snapshot/); });
test("available、partial、unavailable 判别联合均有受控展示", async () => {
  const partial = { ...dashboardSuccessFixture.data.overview.modelRequests, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const metric = mount(MetricCard, { ...options, props: { title: "partial", value: "3", result: partial } });
  assert.match(metric.text(), /数据不完整|Incomplete/);
  assert.match(metric.text(), /覆盖缺口|Coverage gap/);
  const unavailable = { status: "unavailable" as const, data: null, dataIncomplete: true as const, unavailableReason: "domain_unavailable" as const, requiredDomains: ["run" as const], comparison: { status: "domain_unavailable" as const, kind: null, delta: null } };
  const trend = mount(TrendChart, { ...options, props: { title: "unavailable", kind: "count", panel: unavailable } });
  assert.match(trend.text(), /域不可用|Domain unavailable/);
  assert.equal(trend.findAll("polyline").length, 0);
});

test("真实 DashboardTab：mounted 单请求、preset/timezone 自动刷新，custom 仅 Apply 请求", async () => {
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
  await selects[0].setValue("preset_30d");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  await selects[1].setValue("Asia/Tokyo");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  await selects[0].setValue("custom");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  const inputs = wrapper.findAll('input[type="datetime-local"]');
  await inputs[0].setValue("2024-01-01T00:00");
  await inputs[1].setValue("2024-01-02T00:00");
  assert.equal(calls.length, 3);
  const apply = wrapper.findAll("button").find((button) => /应用|Apply/.test(button.text()));
  assert.ok(apply);
  await apply!.trigger("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 4);
  assert.match(wrapper.get('[data-testid="dashboard-section-overview"]').text(), /域状态摘要|Domain status summary/);
  await wrapper.get('[data-testid="overview-metric-gitCommits"] button').trigger("click");
  assert.ok(wrapper.find('[data-testid="overview-trend-gitCommits"]').exists());
  const sectionButtons = wrapper.findAll("nav.section-tabs button");
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
  const gitSection = wrapper.get('[data-testid="dashboard-section-git"]');
  await gitSection.get('[data-testid="git-metric-filesChanged"] button').trigger("click");
  assert.ok(gitSection.find('[data-testid="git-trend-filesChanged"]').exists());
  wrapper.unmount();
});

test("Git、Worker、Health 与 token coverage 的 partial 结果保留服务端已知数据和原因", () => {
  const gitPartial = { ...dashboardSuccessFixture.data.git.metrics.commits, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "repo_not_ready" as const };
  const git = mount(GitMetricCard, { ...options, props: { title: "commits", value: "1", result: gitPartial, selected: false } });
  assert.match(git.text(), /已知部分|Known partial/); assert.match(git.text(), /1\/1/);
  const workerPartial = { ...dashboardSuccessFixture.data.exceptions.workerLiveSnapshot, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const worker = mount(WorkerSnapshot, { ...options, props: { result: workerPartial, timezone: "UTC" } });
  assert.match(worker.text(), /本地降级|Local fallback/); assert.match(worker.text(), /最近 Ready|Last ready/); assert.match(worker.text(), /覆盖缺口|Coverage gap/);
  const healthPartial = { ...dashboardSuccessFixture.data.exceptions.domainHealth, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const health = mount(DomainHealth, { ...options, props: { result: healthPartial, timezone: "UTC" } });
  assert.match(health.text(), /覆盖缺口|Coverage gap/); assert.match(health.text(), /0\/0/);
  const recordsPartial = { ...dashboardSuccessFixture.data.worker.restartRecords, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const records = mount(RestartRecords, { ...options, props: { result: recordsPartial, timezone: "UTC" } });
  assert.match(records.text(), /覆盖缺口|Coverage gap/); assert.match(records.text(), /重启成功|Restart succeeded/);
  const coverage = { ...dashboardSuccessFixture.data.model.metrics.inputTokenCoverage, status: "partial" as const, completeness: "partial" as const, dataIncomplete: true as const, partialReason: "coverage_gap" as const };
  const metric = mount(MetricCard, { ...options, props: { title: "coverage", value: "100%", result: coverage } });
  assert.match(metric.text(), /覆盖缺口|Coverage gap/);
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
  assert.equal(Number(firstAxis.attributes("x")), Number(firstSegment.attributes("x")) + Number(firstSegment.attributes("width")) / 2);
  const legend = wrapper.get(".chart-legend");
  assert.match(legend.attributes("aria-label") ?? "", /图例|Legend/);
  assert.equal(legend.findAll("li").length, 4);
  assert.match(legend.text(), /完成|Completed/);
});

test("监控数据量使用合法 partial PanelResult 表达不完整，并保留八域组成", () => {
  const panel = {
    ...dashboardSuccessFixture.data.overviewTrends.monitoringVolume,
    status: "partial" as const,
    completeness: "partial" as const,
    dataIncomplete: true as const,
    partialReason: "coverage_gap" as const,
    data: [
      { from: 1, to: 2, total: 36, run: 1, session: 2, message: 3, tool: 4, execution: 5, model: 6, worker: 7, git: 8 },
      { from: 2, to: 3, total: 36, run: 1, session: 2, message: 3, tool: 4, execution: 5, model: 6, worker: 7, git: 8 },
    ],
  };
  const wrapper = mount(TrendChart, { ...options, props: { title: "monitoring", kind: "monitoring", panel } });
  const completeBucket = wrapper.get("[data-testid='stacked-bars-bucket-0']");
  assert.equal(completeBucket.attributes("data-stack-total"), "36");
  assert.equal(completeBucket.findAll(".bar-segment").length, 8);
  assert.equal(completeBucket.findAll(".bar-segment").reduce((total, item) => total + Number(item.attributes("data-value")), 0), 36);
  assert.equal(wrapper.findAll(".chart-legend li").length, 8);
  assert.match(wrapper.text(), /覆盖缺口|Coverage gap/);
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
