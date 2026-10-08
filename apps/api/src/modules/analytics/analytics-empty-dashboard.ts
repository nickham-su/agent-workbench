import type { AnalyticsDomain, DashboardData, DashboardQueryErrorResponse, DashboardQueryRequest, DashboardQuerySuccessResponse } from "@agent-workbench/shared";
import { randomUUID } from "node:crypto";
import type { AnalyticsDomainState } from "./analytics-db.js";
import { resolveDashboardRange } from "./analytics.service.js";

const ALL_FACT_DOMAINS = ["run", "session", "message", "tool", "execution", "model", "worker"] as const;
const COMPARISON_UNAVAILABLE = { status: "domain_unavailable", delta: null, kind: null } as const;
const COMPARISON_NOT_APPLICABLE = { status: "not_applicable", delta: null, kind: null } as const;

function unavailableMetric(requiredDomains: AnalyticsDomain[]) {
  return { status: "unavailable", value: null, dataIncomplete: true, unavailableReason: "domain_unavailable", requiredDomains, comparison: COMPARISON_UNAVAILABLE };
}

function unavailablePanel(requiredDomains: AnalyticsDomain[]) {
  return { status: "unavailable", data: null, dataIncomplete: true, unavailableReason: "domain_unavailable", requiredDomains, comparison: COMPARISON_UNAVAILABLE };
}

function buildEmptyDashboardData(params: { asOf: number; states: AnalyticsDomainState[] }): DashboardData {
  const modelMetric = () => unavailableMetric(["model"]);
  const modelPanel = () => unavailablePanel(["model"]);
  const workerMetric = () => unavailableMetric(["worker"]);
  const workerPanel = () => unavailablePanel(["worker"]);
  const durationMetric = () => unavailableMetric(["agent_duration", "execution"]);
  const durationPanel = () => unavailablePanel(["agent_duration", "execution"]);
  const runMetric = () => unavailableMetric(["run"]);
  const runPanel = () => unavailablePanel(["run"]);
  const messageMetric = () => unavailableMetric(["message"]);
  const messagePanel = () => unavailablePanel(["message"]);
  const toolMetric = () => unavailableMetric(["tool"]);
  const toolPanel = () => unavailablePanel(["tool"]);
  const compactionMetric = () => unavailableMetric(["message", "run"]);
  const compactionPanel = () => unavailablePanel(["message", "run"]);

  const healthRows = params.states.map((state) => ({
    domain: state.domain,
    status: state.status,
    collectionStartedAt: state.collectionStartedAt,
    reconciledThrough: state.reconciledThrough,
    rollupReadyThrough: state.rollupReadyThrough,
    retentionFloor: state.retentionFloor,
    lastSucceededAt: state.lastSucceededAt,
    expectedSlotCount: 0,
    activeGenerationCount: 0,
    slots: [],
    coverageGaps: { openCount: 0, historicalCount: 0, earliestGapFrom: null, hasOpenGap: false }
  }));

  return {
    overview: {
      monitoringVolume: unavailableMetric([...ALL_FACT_DOMAINS]),
      agentDuration: durationMetric(),
      modelRequests: modelMetric(),
      modelSuccessRate: modelMetric(),
      cacheHitRate: modelMetric(),
      totalTokens: modelMetric()
    },
    overviewTrends: {
      monitoringVolume: unavailablePanel([...ALL_FACT_DOMAINS]),
      agentDuration: unavailablePanel(["agent_duration", "execution"]),
      modelRequests: modelPanel(), modelSuccessRate: modelPanel(), cacheHitRate: modelPanel(), totalTokens: modelPanel()
    },
    agent: {
      metrics: {
        totalDuration: durationMetric(), runCount: runMetric(), primaryRunCount: runMetric(), subtaskRunCount: runMetric(),
        userMessageCount: messageMetric(), assistantMessageCount: messageMetric(), toolCallCount: toolMetric(), toolSuccessRate: toolMetric(),
        manualCompactionCount: compactionMetric(), autoCompactionCount: compactionMetric()
      },
      trends: {
        totalDuration: durationPanel(), runCount: runPanel(), primaryRunCount: runPanel(), subtaskRunCount: runPanel(),
        userMessageCount: messagePanel(), assistantMessageCount: messagePanel(), toolCallCount: toolPanel(), toolSuccessRate: toolPanel(),
        manualCompactionCount: compactionPanel(), autoCompactionCount: compactionPanel()
      },
      runTerminalDistribution: runPanel(), runTypeDistribution: runPanel(), messageTypeDistribution: messagePanel(),
      toolStatusDistribution: toolPanel(), toolDetails: toolPanel()
    },
    model: {
      metrics: {
        requestCount: modelMetric(), successRate: modelMetric(), timeoutRate: modelMetric(), timeoutKindBreakdown: modelMetric(),
        completedAverageDuration: modelMetric(), inputTokens: modelMetric(), outputTokens: modelMetric(), totalTokens: modelMetric(),
        cacheReadTokens: modelMetric(), inputReportedCount: modelMetric(), outputReportedCount: modelMetric(), totalReportedCount: modelMetric(),
        totalDerivedCount: modelMetric(), cacheComparableCount: modelMetric(), inputTokenCoverage: modelMetric(), outputTokenCoverage: modelMetric(),
        totalTokenCoverage: modelMetric(), inputCacheCoverage: modelMetric()
      },
      trends: { requests: modelPanel(), successRate: modelPanel(), timeoutRate: modelPanel(), completedAverageDuration: modelPanel(), tokens: modelPanel(), cacheHitRate: modelPanel() },
      byModel: modelPanel()
    },
    worker: {
      metrics: { unexpectedExits: workerMetric(), restartAttempts: workerMetric(), restartSucceeded: workerMetric(), restartFailed: workerMetric() },
      eventTrend: workerPanel(), restartRecords: workerPanel()
    },
    exceptions: {
      workerLiveSnapshot: {
        ...unavailableMetric(["worker"]), snapshotAt: null, asOf: params.asOf
      },
      domainHealth: {
        status: "available", data: healthRows, completeness: "complete", dataIncomplete: false, requiredDomains: [],
        comparison: COMPARISON_NOT_APPLICABLE, diagnosedAt: params.asOf, asOf: params.asOf
      }
    }
  } as DashboardData;
}

/** Builds a contract-valid empty response without pretending unknown facts are zero. */
export function buildEmptyDashboardResponse(params: {
  request: DashboardQueryRequest;
  asOf: number;
  states: AnalyticsDomainState[];
}): DashboardQuerySuccessResponse | DashboardQueryErrorResponse {
  const resolved = resolveDashboardRange(params.request, {
    rangeId: randomUUID(),
    asOf: params.asOf,
    reportingLagAnchor: params.asOf
  });
  if ("ok" in resolved) return { kind: "error", error: { code: resolved.code } };
  return {
    kind: "success",
    rangeId: resolved.rangeId,
    from: resolved.from,
    to: resolved.to,
    asOf: resolved.asOf,
    timezone: resolved.timezone,
    data: buildEmptyDashboardData({
      asOf: resolved.asOf,
      states: params.states
    })
  };
}
