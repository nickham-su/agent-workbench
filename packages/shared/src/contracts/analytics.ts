import { Type } from "@sinclair/typebox";
import type { Static, TProperties, TSchema } from "@sinclair/typebox";

function StrictObject<T extends TProperties>(properties: T, options: Record<string, unknown> = {}) {
  return Type.Object(properties, { additionalProperties: false, ...options });
}

const SafeIntegerSchema = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const RatioOrNullSchema = Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);

/** Shared contract for the system-wide, filter-free Analytics Dashboard. */
export const AnalyticsRangeKindSchema = Type.Union([
  Type.Literal("preset_24h"),
  Type.Literal("preset_7d"),
  Type.Literal("preset_30d"),
  Type.Literal("preset_90d"),
  Type.Literal("custom")
]);
export type AnalyticsRangeKind = Static<typeof AnalyticsRangeKindSchema>;

export const AnalyticsDomainSchema = Type.Union([
  Type.Literal("model"), Type.Literal("run"), Type.Literal("execution"), Type.Literal("agent_duration"),
  Type.Literal("tool"), Type.Literal("message"), Type.Literal("session"), Type.Literal("worker"), Type.Literal("git")
]);
export type AnalyticsDomain = Static<typeof AnalyticsDomainSchema>;

const RequiredDomainsSchema = Type.Array(AnalyticsDomainSchema);

export const AnalyticsFactDomainSchema = Type.Union([
  Type.Literal("run"), Type.Literal("session"), Type.Literal("message"), Type.Literal("tool"),
  Type.Literal("execution"), Type.Literal("model"), Type.Literal("worker"), Type.Literal("git")
]);
export type AnalyticsFactDomain = Static<typeof AnalyticsFactDomainSchema>;

export const AnalyticsPartialReasonSchema = Type.Union([
  Type.Literal("coverage_gap"), Type.Literal("range_not_reconciled"), Type.Literal("collector_degraded"),
  Type.Literal("signal_loss"), Type.Literal("dirty_hour"), Type.Literal("open_fact"),
  Type.Literal("configuration_changed"), Type.Literal("repo_not_ready"), Type.Literal("range_before_coverage"),
  Type.Literal("scan_stale"), Type.Literal("mixed_repo_coverage")
]);
export type AnalyticsPartialReason = Static<typeof AnalyticsPartialReasonSchema>;

export const AnalyticsGitPartialReasonSchema = Type.Union([
  Type.Literal("repo_not_ready"), Type.Literal("range_before_coverage"),
  Type.Literal("scan_stale"), Type.Literal("mixed_repo_coverage")
]);
export type AnalyticsGitPartialReason = Static<typeof AnalyticsGitPartialReasonSchema>;

export const AnalyticsUnavailableReasonSchema = Type.Union([
  Type.Literal("domain_disabled"), Type.Literal("domain_unavailable"), Type.Literal("no_safe_data"),
  Type.Literal("no_ready_repo"), Type.Literal("invalid_metric_state")
]);
export type AnalyticsUnavailableReason = Static<typeof AnalyticsUnavailableReasonSchema>;

export const AnalyticsComparisonResultSchema = Type.Union([
  StrictObject({ status: Type.Literal("available"), delta: Type.Number(), kind: Type.Union([Type.Literal("relative"), Type.Literal("percentage_points")]) }),
  ...["range_too_large", "previous_not_covered", "previous_zero", "domain_unavailable", "not_applicable"].map((status) =>
    StrictObject({ status: Type.Literal(status), delta: Type.Null(), kind: Type.Null() })
  )
]);
export type AnalyticsComparisonResult = Static<typeof AnalyticsComparisonResultSchema>;

/** True closed unions: only partial carries partialReason, and unavailable is null. */
export function MetricResultSchema<T extends TSchema>(value: T) {
  return Type.Union([
    StrictObject({ status: Type.Literal("available"), value, completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema }),
    StrictObject({ status: Type.Literal("partial"), value, completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema }),
    StrictObject({ status: Type.Literal("unavailable"), value: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema })
  ]);
}
export type MetricResult<T> =
  | { status: "available"; value: T; completeness: "complete"; dataIncomplete: false; requiredDomains: AnalyticsDomain[]; comparison: AnalyticsComparisonResult }
  | { status: "partial"; value: T; completeness: "partial"; dataIncomplete: true; partialReason: AnalyticsPartialReason; requiredDomains: AnalyticsDomain[]; comparison: AnalyticsComparisonResult }
  | { status: "unavailable"; value: null; dataIncomplete: true; unavailableReason: AnalyticsUnavailableReason; requiredDomains: AnalyticsDomain[]; comparison: AnalyticsComparisonResult };

export function PanelResultSchema<T extends TSchema>(data: T) {
  return Type.Union([
    StrictObject({ status: Type.Literal("available"), data, completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema }),
    StrictObject({ status: Type.Literal("partial"), data, completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema }),
    StrictObject({ status: Type.Literal("unavailable"), data: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema })
  ]);
}
export type PanelResult<T> =
  | { status: "available"; data: T; completeness: "complete"; dataIncomplete: false; requiredDomains: AnalyticsDomain[]; comparison: AnalyticsComparisonResult }
  | { status: "partial"; data: T; completeness: "partial"; dataIncomplete: true; partialReason: AnalyticsPartialReason; requiredDomains: AnalyticsDomain[]; comparison: AnalyticsComparisonResult }
  | { status: "unavailable"; data: null; dataIncomplete: true; unavailableReason: AnalyticsUnavailableReason; requiredDomains: AnalyticsDomain[]; comparison: AnalyticsComparisonResult };

/** Metadata required by every range-based Git result, distinct from heatmap timing. */
const GitRangeMetadataSchema = {
  readyRepoCount: NonNegativeIntegerSchema,
  totalRepoCount: NonNegativeIntegerSchema
};

export function GitMetricResultSchema<T extends TSchema>(value: T) {
  return Type.Union([
    StrictObject({ status: Type.Literal("available"), value, completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...GitRangeMetadataSchema }),
    StrictObject({ status: Type.Literal("partial"), value, completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsGitPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...GitRangeMetadataSchema }),
    StrictObject({ status: Type.Literal("unavailable"), value: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...GitRangeMetadataSchema })
  ]);
}

export function GitPanelResultSchema<T extends TSchema>(data: T) {
  return Type.Union([
    StrictObject({ status: Type.Literal("available"), data, completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...GitRangeMetadataSchema }),
    StrictObject({ status: Type.Literal("partial"), data, completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsGitPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...GitRangeMetadataSchema }),
    StrictObject({ status: Type.Literal("unavailable"), data: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...GitRangeMetadataSchema })
  ]);
}

/** Strict canonical request contract, used by clients and by Analytics IPC. */
export const DashboardQueryRequestSchema = Type.Union([
  StrictObject({ rangeKind: Type.Union([Type.Literal("preset_24h"), Type.Literal("preset_7d"), Type.Literal("preset_30d"), Type.Literal("preset_90d")]), timezone: Type.String({ minLength: 1 }) }),
  StrictObject({ rangeKind: Type.Literal("custom"), timezone: Type.String({ minLength: 1 }), from: SafeIntegerSchema, to: SafeIntegerSchema })
], { $id: "DashboardQueryRequest" });
export type DashboardQueryRequest = Static<typeof DashboardQueryRequestSchema>;

export const DashboardErrorCodeSchema = Type.Union([
  Type.Literal("ANALYTICS_RANGE_INVALID"), Type.Literal("ANALYTICS_RANGE_TOO_LARGE"),
  Type.Literal("ANALYTICS_TIMEZONE_INVALID"), Type.Literal("ANALYTICS_RANGE_NOT_READY"),
  Type.Literal("ANALYTICS_UNAVAILABLE")
]);
export type DashboardErrorCode = Static<typeof DashboardErrorCodeSchema>;

export const DashboardQueryErrorResponseSchema = StrictObject({
  kind: Type.Literal("error"), error: StrictObject({ code: DashboardErrorCodeSchema })
}, { $id: "DashboardQueryErrorResponse" });
export type DashboardQueryErrorResponse = Static<typeof DashboardQueryErrorResponseSchema>;

export const CountTrendPointSchema = StrictObject({ from: SafeIntegerSchema, to: SafeIntegerSchema, count: NonNegativeIntegerSchema });
export const DurationTrendPointSchema = StrictObject({ from: SafeIntegerSchema, to: SafeIntegerSchema, durationMs: NonNegativeIntegerSchema });
export const RatioTrendPointSchema = StrictObject({ from: SafeIntegerSchema, to: SafeIntegerSchema, ratio: RatioOrNullSchema });
/** Each point is a complete status stack; clients must not derive it from a second request. */
export const ModelRequestTrendPointSchema = StrictObject({
  from: SafeIntegerSchema, to: SafeIntegerSchema,
  completed: NonNegativeIntegerSchema, failed: NonNegativeIntegerSchema, timedOut: NonNegativeIntegerSchema, other: NonNegativeIntegerSchema
});
export const ModelCompletedDurationTrendPointSchema = StrictObject({
  from: SafeIntegerSchema, to: SafeIntegerSchema,
  durationMs: Type.Union([NonNegativeIntegerSchema, Type.Null()]), reliableSampleCount: NonNegativeIntegerSchema
});
/** Input/output usage is unknown when a provider does not report it. */
export const ModelTokenTrendPointSchema = StrictObject({
  from: SafeIntegerSchema, to: SafeIntegerSchema,
  inputTokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
  outputTokens: Type.Union([NonNegativeIntegerSchema, Type.Null()])
});
/** Fixed eight-Domain collected-Fact composition used by the overview tooltip. */
export const MonitoringVolumeTrendPointSchema = StrictObject({
  from: SafeIntegerSchema, to: SafeIntegerSchema, total: NonNegativeIntegerSchema,
  run: NonNegativeIntegerSchema, session: NonNegativeIntegerSchema, message: NonNegativeIntegerSchema, tool: NonNegativeIntegerSchema,
  execution: NonNegativeIntegerSchema, model: NonNegativeIntegerSchema, worker: NonNegativeIntegerSchema, git: NonNegativeIntegerSchema
});
export const WorkerEventTrendPointSchema = StrictObject({ from: SafeIntegerSchema, to: SafeIntegerSchema, unexpectedExits: NonNegativeIntegerSchema, restartAttempts: NonNegativeIntegerSchema });

const RatioValueSchema = StrictObject({ ratio: RatioOrNullSchema });
const NullableCountValueSchema = StrictObject({ count: Type.Union([NonNegativeIntegerSchema, Type.Null()]) });
const CompletedDurationValueSchema = StrictObject({ durationMs: Type.Union([NonNegativeIntegerSchema, Type.Null()]), reliableSampleCount: NonNegativeIntegerSchema });
const MonitoringVolumeDataSchema = StrictObject({
  count: NonNegativeIntegerSchema,
  metricDefinitionVersion: Type.Literal("dashboard_collected_fact_v1"),
  collectionConfigVersion: Type.String({ minLength: 1 }),
  configuredDomainsAtAsOf: Type.Array(AnalyticsFactDomainSchema),
  configurationChangedWithinRange: Type.Boolean()
});

const RunStatusDistributionSchema = Type.Array(StrictObject({
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted"), Type.Literal("unknown")]),
  count: NonNegativeIntegerSchema
}));
export const RunTerminalDistributionsByScopeSchema = StrictObject({
  all: RunStatusDistributionSchema,
  main: RunStatusDistributionSchema,
  subtask: RunStatusDistributionSchema
});
const RunTypeDistributionSchema = Type.Array(StrictObject({ kind: Type.Union([Type.Literal("primary"), Type.Literal("subtask"), Type.Literal("other")]), count: NonNegativeIntegerSchema }));
const MessageDistributionSchema = Type.Array(StrictObject({ type: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("runtime"), Type.Literal("system"), Type.Literal("compaction")]), count: NonNegativeIntegerSchema }));
const ToolStatusDistributionSchema = Type.Array(StrictObject({ status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("unknown")]), count: NonNegativeIntegerSchema }));
const ToolDetailKnownRowSchema = StrictObject({ toolName: Type.String({ minLength: 1 }), calls: NonNegativeIntegerSchema, completed: NonNegativeIntegerSchema, failed: NonNegativeIntegerSchema, cancelled: NonNegativeIntegerSchema, unknown: NonNegativeIntegerSchema, completedAverageDurationMs: Type.Union([NonNegativeIntegerSchema, Type.Null()]) });
const ToolDetailPartialRowSchema = StrictObject({ toolName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]), calls: NonNegativeIntegerSchema, completed: NonNegativeIntegerSchema, failed: NonNegativeIntegerSchema, cancelled: NonNegativeIntegerSchema, unknown: NonNegativeIntegerSchema, completedAverageDurationMs: Type.Union([NonNegativeIntegerSchema, Type.Null()]) });
/** Full tool-detail results cannot contain an unknown tool name. */
export const ToolDetailPanelResultSchema = Type.Union([
  StrictObject({ status: Type.Literal("available"), data: Type.Array(ToolDetailKnownRowSchema), completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema }),
  StrictObject({ status: Type.Literal("partial"), data: Type.Array(ToolDetailPartialRowSchema), completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema }),
  StrictObject({ status: Type.Literal("unavailable"), data: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema })
]);
export const ModelTableSchema = Type.Array(StrictObject({
  provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), requests: NonNegativeIntegerSchema,
  successRate: RatioOrNullSchema, timeoutRate: RatioOrNullSchema, completedAverageDurationMs: Type.Union([NonNegativeIntegerSchema, Type.Null()]), reliableDurationSampleCount: NonNegativeIntegerSchema,
  inputTokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]), outputTokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]), totalTokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]),
  cacheReadTokens: Type.Union([NonNegativeIntegerSchema, Type.Null()]), cacheHitRate: RatioOrNullSchema
}));

const GitHeatmapDataSchema = StrictObject({ days: Type.Array(StrictObject({ from: SafeIntegerSchema, to: SafeIntegerSchema, commits: NonNegativeIntegerSchema })) });
const WorkerRestartEventSchema = Type.Union([
  Type.Literal("unexpected_exit"), Type.Literal("restart_attempted"), Type.Literal("restart_succeeded"), Type.Literal("restart_failed")
]);
export const WorkerRestartRecordSchema = StrictObject({
  occurredAt: SafeIntegerSchema,
  event: WorkerRestartEventSchema,
  restartStatus: Type.Union([Type.Literal("recovered"), Type.Literal("not_recovered"), Type.Literal("pending"), Type.Literal("not_applicable")])
});
const WorkerRestartRecordTableSchema = Type.Array(WorkerRestartRecordSchema);
const WorkerSnapshotDataSchema = StrictObject({ running: NonNegativeIntegerSchema, queued: NonNegativeIntegerSchema, concurrency: NonNegativeIntegerSchema, utilization: RatioOrNullSchema, localFallbackRunning: NonNegativeIntegerSchema, lastReadyAt: Type.Union([SafeIntegerSchema, Type.Null()]) });
/** Explicitly exported because TypeBox cannot retain generic spread metadata in Static<>. */
export type WorkerLiveSnapshotData = {
  running: number; queued: number; concurrency: number; utilization: number | null;
  localFallbackRunning: number; lastReadyAt: number | null;
};
export type WorkerLiveSnapshotResult = MetricResult<WorkerLiveSnapshotData> & {
  snapshotAt: number | null;
  asOf: number;
};

const GenerationLifecycleSchema = Type.Union([Type.Literal("registered"), Type.Literal("closing"), Type.Literal("closed"), Type.Literal("stale"), Type.Literal("abandoned")]);
const CoverageGapSummarySchema = StrictObject({ openCount: NonNegativeIntegerSchema, historicalCount: NonNegativeIntegerSchema, earliestGapFrom: Type.Union([SafeIntegerSchema, Type.Null()]), hasOpenGap: Type.Boolean() });
const CheckpointSchema = Type.Union([
  StrictObject({ freshness: Type.Literal("fresh"), observedAt: SafeIntegerSchema }),
  StrictObject({ freshness: Type.Literal("stale"), observedAt: SafeIntegerSchema }),
  StrictObject({ freshness: Type.Literal("missing"), observedAt: Type.Null() })
]);
const DomainHealthSlotSchema = Type.Union([
  StrictObject({
    slotStatus: Type.Literal("generation_active"), producerNamespace: Type.String({ minLength: 1 }), producerId: Type.String({ minLength: 1 }),
    producerGeneration: Type.String({ minLength: 1 }), lifecycle: GenerationLifecycleSchema, checkpoint: CheckpointSchema, coverageGaps: CoverageGapSummarySchema
  }),
  StrictObject({
    slotStatus: Type.Literal("missing_generation"), producerNamespace: Type.String({ minLength: 1 }), producerId: Type.String({ minLength: 1 }),
    producerGeneration: Type.Null(), lifecycle: Type.Null(), checkpoint: StrictObject({ freshness: Type.Literal("missing"), observedAt: Type.Null() }), coverageGaps: CoverageGapSummarySchema
  })
]);
const DomainHealthRowSchema = StrictObject({
  domain: AnalyticsDomainSchema,
  status: Type.Union([Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("stale"), Type.Literal("unavailable"), Type.Literal("disabled")]),
  collectionStartedAt: Type.Union([SafeIntegerSchema, Type.Null()]), reconciledThrough: Type.Union([SafeIntegerSchema, Type.Null()]),
  rollupReadyThrough: Type.Union([SafeIntegerSchema, Type.Null()]), retentionFloor: Type.Union([SafeIntegerSchema, Type.Null()]),
  lastSucceededAt: Type.Union([SafeIntegerSchema, Type.Null()]), expectedSlotCount: NonNegativeIntegerSchema,
  activeGenerationCount: NonNegativeIntegerSchema, slots: Type.Array(DomainHealthSlotSchema), coverageGaps: CoverageGapSummarySchema
});

function ExtendedMetricResultSchema<T extends TSchema>(value: T, metadata: TProperties) {
  return Type.Union([
    StrictObject({ status: Type.Literal("available"), value, completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...metadata }),
    StrictObject({ status: Type.Literal("partial"), value, completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...metadata }),
    StrictObject({ status: Type.Literal("unavailable"), value: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, ...metadata })
  ]);
}

export const GitHeatmap180dSchema = Type.Union([
  StrictObject({ status: Type.Literal("available"), data: GitHeatmapDataSchema, completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, from: SafeIntegerSchema, to: SafeIntegerSchema, asOf: SafeIntegerSchema, readyRepoCount: NonNegativeIntegerSchema, totalRepoCount: NonNegativeIntegerSchema }),
  StrictObject({ status: Type.Literal("partial"), data: GitHeatmapDataSchema, completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsGitPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, from: SafeIntegerSchema, to: SafeIntegerSchema, asOf: SafeIntegerSchema, readyRepoCount: NonNegativeIntegerSchema, totalRepoCount: NonNegativeIntegerSchema }),
  StrictObject({ status: Type.Literal("unavailable"), data: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, from: SafeIntegerSchema, to: SafeIntegerSchema, asOf: SafeIntegerSchema, readyRepoCount: NonNegativeIntegerSchema, totalRepoCount: NonNegativeIntegerSchema })
]);

export const WorkerLiveSnapshotSchema = ExtendedMetricResultSchema(WorkerSnapshotDataSchema, { snapshotAt: Type.Union([SafeIntegerSchema, Type.Null()]), asOf: SafeIntegerSchema });
export const DomainHealthSchema = Type.Union([
  StrictObject({ status: Type.Literal("available"), data: Type.Array(DomainHealthRowSchema), completeness: Type.Literal("complete"), dataIncomplete: Type.Literal(false), requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, diagnosedAt: SafeIntegerSchema, asOf: SafeIntegerSchema }),
  StrictObject({ status: Type.Literal("partial"), data: Type.Array(DomainHealthRowSchema), completeness: Type.Literal("partial"), dataIncomplete: Type.Literal(true), partialReason: AnalyticsPartialReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, diagnosedAt: SafeIntegerSchema, asOf: SafeIntegerSchema }),
  StrictObject({ status: Type.Literal("unavailable"), data: Type.Null(), dataIncomplete: Type.Literal(true), unavailableReason: AnalyticsUnavailableReasonSchema, requiredDomains: RequiredDomainsSchema, comparison: AnalyticsComparisonResultSchema, diagnosedAt: SafeIntegerSchema, asOf: SafeIntegerSchema })
]);

/**
 * Every card, trend, distribution, and table owns a result union. This lets a
 * complete count coexist with partial token or metadata information safely.
 */
export const DashboardDataSchema = StrictObject({
  overview: StrictObject({
    monitoringVolume: MetricResultSchema(MonitoringVolumeDataSchema), agentDuration: MetricResultSchema(NonNegativeIntegerSchema),
    modelRequests: MetricResultSchema(NonNegativeIntegerSchema), modelSuccessRate: MetricResultSchema(RatioValueSchema),
    cacheHitRate: MetricResultSchema(RatioValueSchema), gitCommits: GitMetricResultSchema(NonNegativeIntegerSchema)
  }),
  overviewTrends: StrictObject({
    monitoringVolume: PanelResultSchema(Type.Array(MonitoringVolumeTrendPointSchema)), agentDuration: PanelResultSchema(Type.Array(DurationTrendPointSchema)),
    modelRequests: PanelResultSchema(Type.Array(ModelRequestTrendPointSchema)), modelSuccessRate: PanelResultSchema(Type.Array(RatioTrendPointSchema)),
    cacheHitRate: PanelResultSchema(Type.Array(RatioTrendPointSchema)), gitCommits: GitPanelResultSchema(Type.Array(CountTrendPointSchema))
  }),
  agent: StrictObject({
    metrics: StrictObject({
      totalDuration: MetricResultSchema(NonNegativeIntegerSchema), runCount: MetricResultSchema(NonNegativeIntegerSchema),
      primaryRunCount: MetricResultSchema(NonNegativeIntegerSchema), subtaskRunCount: MetricResultSchema(NonNegativeIntegerSchema),
      userMessageCount: MetricResultSchema(NonNegativeIntegerSchema), assistantMessageCount: MetricResultSchema(NonNegativeIntegerSchema),
      toolCallCount: MetricResultSchema(NonNegativeIntegerSchema), toolSuccessRate: MetricResultSchema(RatioValueSchema),
      manualCompactionCount: MetricResultSchema(NonNegativeIntegerSchema), autoCompactionCount: MetricResultSchema(NonNegativeIntegerSchema)
    }),
    trends: StrictObject({
      totalDuration: PanelResultSchema(Type.Array(DurationTrendPointSchema)), runCount: PanelResultSchema(Type.Array(CountTrendPointSchema)),
      primaryRunCount: PanelResultSchema(Type.Array(CountTrendPointSchema)), subtaskRunCount: PanelResultSchema(Type.Array(CountTrendPointSchema)),
      userMessageCount: PanelResultSchema(Type.Array(CountTrendPointSchema)), assistantMessageCount: PanelResultSchema(Type.Array(CountTrendPointSchema)),
      toolCallCount: PanelResultSchema(Type.Array(CountTrendPointSchema)), toolSuccessRate: PanelResultSchema(Type.Array(RatioTrendPointSchema)),
      manualCompactionCount: PanelResultSchema(Type.Array(CountTrendPointSchema)), autoCompactionCount: PanelResultSchema(Type.Array(CountTrendPointSchema))
    }),
    runTerminalDistribution: PanelResultSchema(RunTerminalDistributionsByScopeSchema),
    runTypeDistribution: PanelResultSchema(RunTypeDistributionSchema), messageTypeDistribution: PanelResultSchema(MessageDistributionSchema),
    toolStatusDistribution: PanelResultSchema(ToolStatusDistributionSchema), toolDetails: ToolDetailPanelResultSchema
  }),
  model: StrictObject({
    metrics: StrictObject({
      requestCount: MetricResultSchema(NonNegativeIntegerSchema), successRate: MetricResultSchema(RatioValueSchema), timeoutRate: MetricResultSchema(RatioValueSchema),
      timeoutKindBreakdown: MetricResultSchema(StrictObject({ idle: NonNegativeIntegerSchema, total: NonNegativeIntegerSchema, none: NonNegativeIntegerSchema })),
      completedAverageDuration: MetricResultSchema(CompletedDurationValueSchema),
      inputTokens: MetricResultSchema(NullableCountValueSchema), outputTokens: MetricResultSchema(NullableCountValueSchema),
      totalTokens: MetricResultSchema(NullableCountValueSchema), cacheReadTokens: MetricResultSchema(NullableCountValueSchema),
      inputReportedCount: MetricResultSchema(NonNegativeIntegerSchema), outputReportedCount: MetricResultSchema(NonNegativeIntegerSchema),
      totalReportedCount: MetricResultSchema(NonNegativeIntegerSchema), totalDerivedCount: MetricResultSchema(NonNegativeIntegerSchema), cacheComparableCount: MetricResultSchema(NonNegativeIntegerSchema),
      inputTokenCoverage: MetricResultSchema(RatioValueSchema), outputTokenCoverage: MetricResultSchema(RatioValueSchema),
      totalTokenCoverage: MetricResultSchema(RatioValueSchema), inputCacheCoverage: MetricResultSchema(RatioValueSchema)
    }),
    trends: StrictObject({
      requests: PanelResultSchema(Type.Array(ModelRequestTrendPointSchema)), successRate: PanelResultSchema(Type.Array(RatioTrendPointSchema)),
      timeoutRate: PanelResultSchema(Type.Array(RatioTrendPointSchema)), completedAverageDuration: PanelResultSchema(Type.Array(ModelCompletedDurationTrendPointSchema)),
      tokens: PanelResultSchema(Type.Array(ModelTokenTrendPointSchema)), cacheHitRate: PanelResultSchema(Type.Array(RatioTrendPointSchema))
    }),
    byModel: PanelResultSchema(ModelTableSchema)
  }),
  git: StrictObject({
    metrics: StrictObject({ commits: GitMetricResultSchema(NonNegativeIntegerSchema), nonMergeCommits: GitMetricResultSchema(NonNegativeIntegerSchema), filesChanged: GitMetricResultSchema(NonNegativeIntegerSchema), linesAdded: GitMetricResultSchema(NonNegativeIntegerSchema), linesDeleted: GitMetricResultSchema(NonNegativeIntegerSchema) }),
    trends: StrictObject({
      commits: GitPanelResultSchema(Type.Array(CountTrendPointSchema)), nonMergeCommits: GitPanelResultSchema(Type.Array(CountTrendPointSchema)),
      filesChanged: GitPanelResultSchema(Type.Array(CountTrendPointSchema)), linesAdded: GitPanelResultSchema(Type.Array(CountTrendPointSchema)),
      linesDeleted: GitPanelResultSchema(Type.Array(CountTrendPointSchema))
    })
  }),
  worker: StrictObject({
    metrics: StrictObject({ unexpectedExits: MetricResultSchema(NonNegativeIntegerSchema), restartAttempts: MetricResultSchema(NonNegativeIntegerSchema), restartSucceeded: MetricResultSchema(NonNegativeIntegerSchema), restartFailed: MetricResultSchema(NonNegativeIntegerSchema) }),
    eventTrend: PanelResultSchema(Type.Array(WorkerEventTrendPointSchema)), restartRecords: PanelResultSchema(WorkerRestartRecordTableSchema)
  }),
  exceptions: StrictObject({ gitHeatmap180d: GitHeatmap180dSchema, workerLiveSnapshot: WorkerLiveSnapshotSchema, domainHealth: DomainHealthSchema })
});
type DashboardDataFromSchema = Static<typeof DashboardDataSchema>;
/** Retain Worker snapshot metadata omitted by TypeBox's generic schema helper. */
export type DashboardData = Omit<DashboardDataFromSchema, "exceptions"> & {
  exceptions: Omit<DashboardDataFromSchema["exceptions"], "workerLiveSnapshot"> & {
    workerLiveSnapshot: WorkerLiveSnapshotResult;
  };
};

export const DashboardQuerySuccessResponseSchema = StrictObject({
  kind: Type.Literal("success"), rangeId: Type.String({ minLength: 1 }), from: SafeIntegerSchema, to: SafeIntegerSchema,
  asOf: SafeIntegerSchema, timezone: Type.String({ minLength: 1 }), data: DashboardDataSchema
}, { $id: "DashboardQuerySuccessResponse" });
type DashboardQuerySuccessResponseFromSchema = Static<typeof DashboardQuerySuccessResponseSchema>;
export type DashboardQuerySuccessResponse = Omit<DashboardQuerySuccessResponseFromSchema, "data"> & { data: DashboardData };
