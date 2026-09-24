export type DashboardChartKind = "count" | "duration" | "ratio" | "model_status" | "tokens" | "worker_events" | "monitoring" | "monitoring_total";
export type DashboardChartShape = "line" | "stacked-bars";

export type DashboardChartSeries = {
  key: string;
  labelKey: string;
  color: string;
  values: Array<number | null>;
};

export type DashboardChartBucket = {
  from: number | null;
  to: number | null;
  values: Array<number | null>;
  /**
   * The total supplied by the Dashboard DTO when the DTO has one. This is
   * display metadata only: the adapter never repairs, estimates, or rebuckets
   * server metrics.
   */
  reportedTotal: number | null;
};

export type DashboardChartDisplay = {
  kind: DashboardChartKind;
  shape: DashboardChartShape;
  series: DashboardChartSeries[];
  buckets: DashboardChartBucket[];
};

type Definition = { key: string; labelKey: string; color: string };
type UnknownRecord = Record<string, unknown>;

const definitions: Record<DashboardChartKind, Definition[]> = {
  count: [{ key: "count", labelKey: "count", color: "#4f8cff" }],
  duration: [{ key: "durationMs", labelKey: "duration", color: "#8b5cf6" }],
  ratio: [{ key: "ratio", labelKey: "ratio", color: "#22c55e" }],
  model_status: [
    { key: "completed", labelKey: "completed", color: "#22c55e" },
    { key: "failed", labelKey: "failed", color: "#ef4444" },
    { key: "timedOut", labelKey: "timedOut", color: "#f59e0b" },
    { key: "other", labelKey: "other", color: "#94a3b8" },
  ],
  tokens: [
    { key: "inputTokens", labelKey: "inputTokens", color: "#4f8cff" },
    { key: "outputTokens", labelKey: "outputTokens", color: "#a855f7" },
  ],
  worker_events: [
    { key: "unexpectedExits", labelKey: "unexpectedExits", color: "#ef4444" },
    { key: "restartAttempts", labelKey: "restartAttempts", color: "#f59e0b" },
  ],
  monitoring_total: [{ key: "total", labelKey: "monitoringVolume", color: "#4f8cff" }],
  monitoring: [
    { key: "run", labelKey: "monitoringRun", color: "#4f8cff" },
    { key: "session", labelKey: "monitoringSession", color: "#8b5cf6" },
    { key: "message", labelKey: "monitoringMessage", color: "#13a8a8" },
    { key: "tool", labelKey: "monitoringTool", color: "#a855f7" },
    { key: "execution", labelKey: "monitoringExecution", color: "#ec4899" },
    { key: "model", labelKey: "monitoringModel", color: "#22c55e" },
    { key: "worker", labelKey: "monitoringWorker", color: "#f59e0b" },
    { key: "git", labelKey: "monitoringGit", color: "#64748b" },
  ],
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function numericField(row: unknown, key: string): number | null {
  if (!isRecord(row)) return null;
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shapeFor(kind: DashboardChartKind): DashboardChartShape {
  if (kind === "model_status" || kind === "monitoring" || kind === "tokens" || kind === "worker_events") return "stacked-bars";
  return "line";
}

/**
 * Converts already-aggregated Dashboard DTO buckets into rendering primitives.
 * It intentionally owns no analytic calculation: null remains null, reported
 * monitoring totals are retained verbatim, and bucket boundaries are copied.
 */
export function createDashboardChartDisplay(kind: DashboardChartKind, rows: readonly unknown[]): DashboardChartDisplay {
  const seriesDefinitions = definitions[kind];
  const series = seriesDefinitions.map((definition) => ({
    ...definition,
    values: rows.map((row) => numericField(row, definition.key)),
  }));

  return {
    kind,
    shape: shapeFor(kind),
    series,
    buckets: rows.map((row, index) => ({
      from: numericField(row, "from"),
      to: numericField(row, "to"),
      values: series.map((item) => item.values[index] ?? null),
      reportedTotal: (kind === "monitoring" || kind === "monitoring_total") ? numericField(row, "total") : null,
    })),
  };
}

/** A null is a coverage/unknown boundary, not a zero-valued line point. */
export function splitLineSegments(values: readonly (number | null)[]): Array<Array<{ index: number; value: number }>> {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];
  for (const [index, value] of values.entries()) {
    if (value === null) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push({ index, value });
  }
  if (current.length) segments.push(current);
  return segments;
}

/**
 * Keeps unknown composition unknown. A bar may be drawn only when every stack
 * component is supplied by the server; otherwise it cannot silently become 0.
 */
export function knownStackTotal(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
