import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalyticsComparisonResultSchema,
  DashboardDataSchema,
  DashboardQueryErrorResponseSchema,
  DashboardQueryRequestSchema,
  DashboardQuerySuccessResponseSchema,
  DomainHealthSchema,
  MetricResultSchema,
  ModelCompletedDurationTrendPointSchema,
  ModelTableSchema,
  ModelRequestTrendPointSchema,
  ModelTokenTrendPointSchema,
  NullableCountTrendPointSchema,
  MonitoringVolumeTrendPointSchema,
  PanelResultSchema,
  RunTerminalDistributionsByScopeSchema,
  ToolDetailPanelResultSchema,
  WorkerEventTrendPointSchema,
  WorkerRestartRecordSchema
} from "../src/contracts/analytics.js";

const comparison = { status: "not_applicable", delta: null, kind: null } as const;

test("MetricResult is a closed discriminated union", () => {
  const schema = MetricResultSchema(Type.Number());
  const available = { status: "available", value: 3, completeness: "complete", dataIncomplete: false, requiredDomains: ["model"], comparison };
  assert.equal(Value.Check(schema, available), true);
  assert.equal(Value.Check(schema, { ...available, value: null }), false);
  assert.equal(Value.Check(schema, { ...available, dataIncomplete: true }), false);
  assert.equal(Value.Check(schema, { ...available, partialReason: "coverage_gap" }), false);

  const partial = { status: "partial", value: 3, completeness: "partial", dataIncomplete: true, partialReason: "coverage_gap", requiredDomains: ["model"], comparison };
  assert.equal(Value.Check(schema, partial), true);
  assert.equal(Value.Check(schema, { ...partial, partialReason: "not_a_reason" }), false);

  const unavailable = { status: "unavailable", value: null, dataIncomplete: true, unavailableReason: "no_safe_data", requiredDomains: ["model"], comparison };
  assert.equal(Value.Check(schema, unavailable), true);
  assert.equal(Value.Check(schema, { ...unavailable, value: 0 }), false);
  assert.equal(Value.Check(schema, { ...unavailable, completeness: "complete" }), false);
});

test("PanelResult and ComparisonResult reject illegal branch fields", () => {
  const panel = PanelResultSchema(Type.Array(Type.String()));
  const valid = { status: "available", data: ["known"], completeness: "complete", dataIncomplete: false, requiredDomains: ["tool"], comparison: { status: "available", delta: 12.5, kind: "relative" } };
  assert.equal(Value.Check(panel, valid), true);
  assert.equal(Value.Check(panel, { ...valid, dataIncomplete: true }), false);
  assert.equal(Value.Check(panel, { ...valid, partialReason: "coverage_gap" }), false);
  assert.equal(Value.Check(AnalyticsComparisonResultSchema, { status: "available", delta: null, kind: "relative" }), false);
  assert.equal(Value.Check(AnalyticsComparisonResultSchema, { status: "previous_zero", delta: 1, kind: "relative" }), false);
});

test("Dashboard request and error contracts are strict while timestamps require safe integers", () => {
  assert.equal(Value.Check(DashboardQueryRequestSchema, { rangeKind: "preset_7d", timezone: "Asia/Shanghai" }), true);
  assert.equal(Value.Check(DashboardQueryRequestSchema, { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 }), true);
  assert.equal(Value.Check(DashboardQueryRequestSchema, { rangeKind: "preset_7d", timezone: "UTC", from: 1 }), false);
  assert.equal(Value.Check(DashboardQueryRequestSchema, { rangeKind: "custom", timezone: "UTC", from: 1 }), false);
  assert.equal(Value.Check(DashboardQueryRequestSchema, { rangeKind: "custom", timezone: "UTC", from: Number.MAX_SAFE_INTEGER + 1, to: Number.MAX_SAFE_INTEGER + 2 }), false);
  assert.equal(Value.Check(DashboardQueryErrorResponseSchema, { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } }), true);
  assert.equal(Value.Check(DashboardQueryErrorResponseSchema, { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE", message: "not safe" } }), false);
  assert.equal(Value.Check(DashboardQuerySuccessResponseSchema, { kind: "success", rangeId: "r", from: Number.MAX_SAFE_INTEGER + 1, to: 2, asOf: 2, timezone: "UTC", data: {} }), false);
});

test("model request trends are explicit non-negative status stacks", () => {
  const valid = { from: 1, to: 2, completed: 3, failed: 1, timedOut: 0, other: 2 };
  assert.equal(Value.Check(ModelRequestTrendPointSchema, valid), true);
  assert.equal(Value.Check(ModelRequestTrendPointSchema, { ...valid, failed: -1 }), false);
  assert.equal(Value.Check(ModelRequestTrendPointSchema, { ...valid, value: 6 }), false);
});

test("model usage stays nullable and model rows include render-ready quality details", () => {
  assert.equal(Value.Check(ModelTokenTrendPointSchema, { from: 1, to: 2, inputTokens: null, outputTokens: null }), true);
  assert.equal(Value.Check(ModelTokenTrendPointSchema, { from: 1, to: 2, inputTokens: -1, outputTokens: 0 }), false);
  assert.equal(Value.Check(NullableCountTrendPointSchema, { from: 1, to: 2, count: null }), true);
  assert.equal(Value.Check(NullableCountTrendPointSchema, { from: 1, to: 2, count: -1 }), false);
  assert.equal(Value.Check(ModelTableSchema, [{ provider: "provider", model: "model", requests: 1, successRate: null, timeoutRate: null, completedAverageDurationMs: null, reliableDurationSampleCount: 0, inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheHitRate: null }]), true);
});

test("model duration and monitoring volume trends retain nullable samples and tooltip composition", () => {
  const durationWithoutSamples = { from: 1, to: 2, durationMs: null, reliableSampleCount: 0 };
  assert.equal(Value.Check(ModelCompletedDurationTrendPointSchema, durationWithoutSamples), true);
  assert.equal(Value.Check(ModelCompletedDurationTrendPointSchema, { ...durationWithoutSamples, durationMs: -1 }), false);
  assert.equal(Value.Check(ModelCompletedDurationTrendPointSchema, { from: 1, to: 2, durationMs: null }), false);

  const volume = { from: 1, to: 2, total: 7, run: 1, session: 1, message: 1, tool: 1, execution: 1, model: 1, worker: 1 };
  assert.equal(Value.Check(MonitoringVolumeTrendPointSchema, volume), true);
  assert.equal(Value.Check(MonitoringVolumeTrendPointSchema, { ...volume, git: 1 }), false);
  assert.equal(Value.Check(MonitoringVolumeTrendPointSchema, { ...volume, unknown: 1 }), false);
});

test("tool details only permit unknown names in a controlled partial result", () => {
  const row = { toolName: "shell", calls: 2, completed: 1, failed: 0, cancelled: 1, unknown: 0, completedAverageDurationMs: 4 };
  const available = { status: "available", data: [row], completeness: "complete", dataIncomplete: false, requiredDomains: ["tool"], comparison } as const;
  assert.equal(Value.Check(ToolDetailPanelResultSchema, available), true);
  assert.equal(Value.Check(ToolDetailPanelResultSchema, { ...available, data: [{ ...row, toolName: null }] }), false);
  assert.equal(Value.Check(ToolDetailPanelResultSchema, { ...available, partialReason: "coverage_gap" }), false);

  const partial = { status: "partial", data: [{ ...row, toolName: null }], completeness: "partial", dataIncomplete: true, partialReason: "signal_loss", requiredDomains: ["tool"], comparison } as const;
  assert.equal(Value.Check(ToolDetailPanelResultSchema, partial), true);
  assert.equal(Value.Check(ToolDetailPanelResultSchema, { ...partial, partialReason: undefined }), false);
  assert.equal(Value.Check(ToolDetailPanelResultSchema, { status: "unavailable", data: [row], dataIncomplete: true, unavailableReason: "no_safe_data", requiredDomains: ["tool"], comparison }), false);
});

test("worker trend and restart records contain only render-ready controlled fields", () => {
  assert.equal(Value.Check(WorkerEventTrendPointSchema, { from: 1, to: 2, unexpectedExits: 1, restartAttempts: 2 }), true);
  assert.equal(Value.Check(WorkerEventTrendPointSchema, { from: 1, to: 2, unexpectedExits: 1 }), false);
  const restart = { occurredAt: 1, event: "restart_attempted", restartStatus: "pending" };
  assert.equal(Value.Check(WorkerRestartRecordSchema, restart), true);
  assert.equal(Value.Check(WorkerRestartRecordSchema, { ...restart, event: "raw_exit" }), false);
  assert.equal(Value.Check(WorkerRestartRecordSchema, { ...restart, path: "/private" }), false);
});

test("Run terminal distribution returns every prototype scope in the same panel", () => {
  const statuses = [{ status: "completed", count: 1 }, { status: "failed", count: 0 }, { status: "cancelled", count: 0 }, { status: "interrupted", count: 0 }, { status: "unknown", count: 0 }];
  assert.equal(Value.Check(RunTerminalDistributionsByScopeSchema, { all: statuses, main: statuses, subtask: statuses }), true);
  assert.equal(Value.Check(RunTerminalDistributionsByScopeSchema, { all: statuses, main: statuses }), false);
});

test("domain health preserves controlled, non-sensitive diagnostics", () => {
  const health = {
    status: "available", data: [{
      domain: "model", status: "degraded", collectionStartedAt: 1, reconciledThrough: null, rollupReadyThrough: null,
      retentionFloor: null, lastSucceededAt: null, expectedSlotCount: 1, activeGenerationCount: 1,
      slots: [{ slotStatus: "generation_active", producerNamespace: "agent", producerId: "worker", producerGeneration: "g-1", lifecycle: "stale", checkpoint: { freshness: "missing", observedAt: null }, coverageGaps: { openCount: 1, historicalCount: 2, earliestGapFrom: 1, hasOpenGap: true } }],
      coverageGaps: { openCount: 1, historicalCount: 2, earliestGapFrom: 1, hasOpenGap: true }
    }], completeness: "complete", dataIncomplete: false, requiredDomains: ["model"], comparison, diagnosedAt: 2, asOf: 2
  };
  assert.equal(Value.Check(DomainHealthSchema, health), true);
  assert.equal(Value.Check(DomainHealthSchema, { ...health, data: [{ ...health.data[0], slots: [{ ...health.data[0].slots[0], error: "/secret/path" }] }] }), false);
  assert.equal(Value.Check(DomainHealthSchema, { ...health, data: [{ ...health.data[0], activeGenerationCount: 0, slots: [{ slotStatus: "missing_generation", producerNamespace: "agent", producerId: "worker", producerGeneration: null, lifecycle: null, checkpoint: { freshness: "missing", observedAt: null }, coverageGaps: { openCount: 0, historicalCount: 0, earliestGapFrom: null, hasOpenGap: false } }] }] }), true);
  assert.equal(Value.Check(DomainHealthSchema, { ...health, data: [{ ...health.data[0], activeGenerationCount: 0, slots: [{ slotStatus: "missing_generation", producerNamespace: "agent", producerId: "worker", producerGeneration: "g-1", lifecycle: null, checkpoint: { freshness: "missing", observedAt: null }, coverageGaps: { openCount: 0, historicalCount: 0, earliestGapFrom: null, hasOpenGap: false } }] }] }), false);
});

test("Dashboard data exposes independent results for all cards, trends, distributions and tables", () => {
  const properties = (DashboardDataSchema as any).properties;
  assert.deepEqual(Object.keys(properties.overview.properties).sort(), ["agentDuration", "cacheHitRate", "modelRequests", "modelSuccessRate", "monitoringVolume", "totalTokens"]);
  assert.deepEqual(Object.keys(properties.overviewTrends.properties).sort(), ["agentDuration", "cacheHitRate", "modelRequests", "modelSuccessRate", "monitoringVolume", "totalTokens"]);
  assert.ok(properties.model.properties.metrics.properties.inputReportedCount);
  assert.ok(properties.model.properties.metrics.properties.totalDerivedCount);
  assert.ok(properties.model.properties.metrics.properties.inputCacheCoverage);
  assert.ok(properties.agent.properties.toolDetails);
  assert.ok(properties.agent.properties.toolStatusDistribution);
  assert.deepEqual(Object.keys(properties.agent.properties.trends.properties).sort(), ["assistantMessageCount", "autoCompactionCount", "manualCompactionCount", "primaryRunCount", "runCount", "subtaskRunCount", "toolCallCount", "toolSuccessRate", "totalDuration", "userMessageCount"]);
  assert.deepEqual(Object.keys(properties.model.properties.trends.properties).sort(), ["cacheHitRate", "completedAverageDuration", "requests", "successRate", "timeoutRate", "tokens"]);
  assert.ok(properties.model.properties.metrics.properties.timeoutKindBreakdown);
  assert.ok(properties.model.properties.metrics.properties.completedAverageDuration);
  assert.equal(Value.Check(properties.model.properties.metrics.properties.inputTokens, {
    status: "available", value: { count: null }, completeness: "complete", dataIncomplete: false, requiredDomains: ["model"], comparison
  }), true);
  assert.equal(properties.git, undefined);
  assert.equal(properties.exceptions.properties.gitHeatmap180d, undefined);
  assert.deepEqual(Object.keys(properties.worker.properties).sort(), ["eventTrend", "metrics", "restartRecords"]);
});
