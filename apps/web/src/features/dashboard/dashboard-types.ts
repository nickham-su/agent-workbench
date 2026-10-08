import type { DashboardData, MetricResult, PanelResult } from "@agent-workbench/shared";

export type DashboardSection = "overview" | "agent" | "model" | "worker";
export type CountResult = MetricResult<number>;
export type RatioResult = MetricResult<{ ratio: number | null }>;
export type NullableCountResult = MetricResult<{ count: number | null }>;
export type DurationResult = MetricResult<number>;
export type CountPanel = PanelResult<Array<{ from: number; to: number; count: number }>>;
export type NullableCountPanel = DashboardData["overviewTrends"]["totalTokens"];
export type DurationPanel = PanelResult<Array<{ from: number; to: number; durationMs: number }>>;
export type RatioPanel = PanelResult<Array<{ from: number; to: number; ratio: number | null }>>;
export type ModelRequestPanel = DashboardData["model"]["trends"]["requests"];
export type ModelCompletedDurationPanel = DashboardData["model"]["trends"]["completedAverageDuration"];
export type TokenPanel = DashboardData["model"]["trends"]["tokens"];
export type WorkerEventPanel = DashboardData["worker"]["eventTrend"];
export type MonitoringPanel = DashboardData["overviewTrends"]["monitoringVolume"];
export type DashboardTrendPanel = CountPanel | NullableCountPanel | DurationPanel | RatioPanel | ModelRequestPanel | ModelCompletedDurationPanel | TokenPanel | WorkerEventPanel | MonitoringPanel;

export function metricNumberValue(result: CountResult | DurationResult): number | null { return result.status === "unavailable" ? null : result.value; }
export function metricRatioValue(result: RatioResult): number | null { return result.status === "unavailable" ? null : result.value.ratio; }
export function metricNullableCountValue(result: NullableCountResult): number | null { return result.status === "unavailable" ? null : result.value.count; }
