import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dbPath } from "../../infra/fs/paths.js";
import type { AnalyticsDb } from "./analytics-db.js";
import { markDirtyHour } from "./analytics-rollups.js";

const BUSINESS_DOMAINS = ["session", "run", "message", "tool"] as const;
type BusinessDomain = (typeof BUSINESS_DOMAINS)[number];
type Cursor = { updatedAt: number; stableId: string };
type CycleState = "idle" | "scanning";
type CollectorErrorCode =
  | "BUSINESS_DB_UNAVAILABLE"
  | "COLLECTOR_BUSY"
  | "COLLECTOR_INDEX_MISSING"
  | "COLLECTOR_PLAN_DEGRADED"
  | "COLLECTOR_QUERY_FAILED"
  | "COLLECTOR_ASSOCIATION_MISSING";

export type BusinessCollectorOptions = {
  /** Current configuration is prospective; a re-enabled collector starts at this floor. */
  enabledDomains?: ReadonlySet<BusinessDomain>;
  enabledAt?: number;
  batchSize?: number;
  busyTimeoutMs?: number;
  overlapMs?: number;
  now?: () => number;
};

export type CollectionResult = {
  domain: BusinessDomain;
  collected: number;
  cursorAdvanced: boolean;
  cycleCompleted: boolean;
  degraded: boolean;
};

type SessionRow = {
  id: string;
  kind: string;
  created_at: number;
  updated_at: number;
};
type RunRow = {
  run_id: string;
  run_kind: string;
  parent_run_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
};
type MessageRow = {
  id: string;
  type: string;
  status: string;
  origin_run_id: string | null;
  created_at: number;
  updated_at: number;
};
type ToolRow = {
  id: string;
  call_part_id: string;
  origin_run_id: string | null;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
};
type SourceDb = Database.Database;
type Watermark = {
  domain: BusinessDomain;
  initialAnchor: number;
  initialFloor: Cursor;
  durableFrontier: Cursor;
  scanAnchor: number | null;
  cycleCursor: Cursor | null;
  cycleState: CycleState;
  reconciledThrough: number | null;
};

const INDEX_BY_DOMAIN: Record<BusinessDomain, string> = {
  session: "idx_agent_session_updated_id",
  run: "idx_agent_run_updated_run_id",
  message: "idx_agent_message_updated_id",
  tool: "idx_agent_tool_execution_updated_id",
};

const CURSOR_SQL: Record<BusinessDomain, string> = {
  session: `
    SELECT id, kind, created_at, updated_at
    FROM agent_session
    WHERE ((updated_at > @updatedAt) OR (updated_at = @updatedAt AND id > @stableId))
      AND updated_at <= @scanAnchor
    ORDER BY updated_at ASC, id ASC LIMIT @batchSize`,
  run: `
    SELECT run_id, run_kind, parent_run_id, status, created_at, updated_at
    FROM agent_run
    WHERE ((updated_at > @updatedAt) OR (updated_at = @updatedAt AND run_id > @stableId))
      AND updated_at <= @scanAnchor
    ORDER BY updated_at ASC, run_id ASC LIMIT @batchSize`,
  message: `
    SELECT id, type, status, origin_run_id, created_at, updated_at
    FROM agent_message
    WHERE ((updated_at > @updatedAt) OR (updated_at = @updatedAt AND id > @stableId))
      AND updated_at <= @scanAnchor
    ORDER BY updated_at ASC, id ASC LIMIT @batchSize`,
  tool: `
    SELECT id, call_part_id, origin_run_id, status, created_at, started_at, completed_at, updated_at
    FROM agent_tool_execution
    WHERE ((updated_at > @updatedAt) OR (updated_at = @updatedAt AND id > @stableId))
      AND updated_at <= @scanAnchor
    ORDER BY updated_at ASC, id ASC LIMIT @batchSize`,
};

const TAIL_SQL: Record<BusinessDomain, string> = {
  session:
    "SELECT updated_at, id AS stable_id FROM agent_session WHERE updated_at < ? ORDER BY updated_at DESC, id DESC LIMIT 1",
  run: "SELECT updated_at, run_id AS stable_id FROM agent_run WHERE updated_at < ? ORDER BY updated_at DESC, run_id DESC LIMIT 1",
  message:
    "SELECT updated_at, id AS stable_id FROM agent_message WHERE updated_at < ? ORDER BY updated_at DESC, id DESC LIMIT 1",
  tool: "SELECT updated_at, id AS stable_id FROM agent_tool_execution WHERE updated_at < ? ORDER BY updated_at DESC, id DESC LIMIT 1",
};

function compactionAssociationSql(count: number) {
  return `SELECT message.id, run.run_kind FROM agent_message message LEFT JOIN agent_run run ON run.run_id = message.origin_run_id WHERE message.id IN (${placeholders(count)}) AND message.type = 'compaction' AND message.status = 'completed'`;
}

function toolNameAssociationSql(count: number) {
  return `SELECT tool.id, part.tool_name FROM agent_tool_execution tool LEFT JOIN agent_message_part part ON part.id = tool.call_part_id WHERE tool.id IN (${placeholders(count)})`;
}

function safeBatchSize(value: number | undefined) {
  const size = value ?? 100;
  if (!Number.isInteger(size) || size < 1 || size > 500)
    throw new Error("invalid collector batch size");
  return size;
}

function safeOverlap(value: number | undefined) {
  const overlap = value ?? 1_000;
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap > 10_000)
    throw new Error("invalid collector overlap");
  return overlap;
}

function openBusinessDbReadonly(
  dataDir: string,
  busyTimeoutMs: number,
): SourceDb {
  const path = dbPath(dataDir);
  if (!existsSync(path))
    throw Object.assign(new Error("business database unavailable"), {
      code: "BUSINESS_DB_UNAVAILABLE",
    });
  const source = new Database(path, { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    source.pragma(`busy_timeout = ${busyTimeoutMs}`);
    return source;
  } catch (error) {
    source.close();
    throw error;
  }
}

function sourceErrorCode(error: unknown): CollectorErrorCode {
  const code = String((error as { code?: unknown })?.code ?? "").toUpperCase();
  if (code === "BUSINESS_DB_UNAVAILABLE") return "BUSINESS_DB_UNAVAILABLE";
  if (code.includes("BUSY") || code.includes("LOCKED")) return "COLLECTOR_BUSY";
  if (code === "COLLECTOR_INDEX_MISSING") return "COLLECTOR_INDEX_MISSING";
  if (code === "COLLECTOR_PLAN_DEGRADED") return "COLLECTOR_PLAN_DEGRADED";
  return "COLLECTOR_QUERY_FAILED";
}

function placeholders(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 500)
    throw new Error("invalid association batch");
  return Array.from({ length: count }, () => "?").join(", ");
}

function asCursor(
  row: { updated_at: number; stable_id: string } | undefined,
): Cursor {
  return row
    ? { updatedAt: row.updated_at, stableId: row.stable_id }
    : { updatedAt: 0, stableId: "" };
}

function maxCursor(left: Cursor, right: Cursor) {
  if (
    right.updatedAt > left.updatedAt ||
    (right.updatedAt === left.updatedAt && right.stableId > left.stableId)
  )
    return right;
  return left;
}

function targetCursor(
  rows: Array<{ updated_at: number } & Record<string, unknown>>,
  stableKey: string,
): Cursor | null {
  const row = rows.at(-1);
  if (
    !row ||
    typeof row.updated_at !== "number" ||
    typeof row[stableKey] !== "string"
  )
    return null;
  return { updatedAt: row.updated_at, stableId: row[stableKey] as string };
}

function assertCursorIndex(
  source: SourceDb,
  domain: BusinessDomain,
  cursor: Cursor,
  scanAnchor: number,
  batchSize: number,
) {
  const plan = source
    .prepare(`EXPLAIN QUERY PLAN ${CURSOR_SQL[domain]}`)
    .all({ ...cursor, scanAnchor, batchSize }) as Array<{ detail: string }>;
  const detail = plan
    .map((row) => row.detail)
    .join(" | ")
    .toLowerCase();
  if (
    !detail.includes(`using index ${INDEX_BY_DOMAIN[domain]}`.toLowerCase()) ||
    detail.includes("use temp b-tree")
  ) {
    throw Object.assign(new Error("collector query plan degraded"), {
      code: "COLLECTOR_PLAN_DEGRADED",
    });
  }
}

function assertAssociationPlan(
  source: SourceDb,
  sql: string,
  ids: readonly string[],
) {
  const plan = source
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...ids) as Array<{ detail: string }>;
  const detail = plan
    .map((row) => row.detail)
    .join(" | ")
    .toLowerCase();
  // Both legs must be indexed point lookups. A scan or temporary sort turns a
  // bounded collection batch into an unbounded source-db operation.
  if (
    detail.includes("scan ") ||
    detail.includes("temp b-tree") ||
    !detail.includes("search ") ||
    !detail.includes("using ")
  ) {
    throw Object.assign(
      new Error("collector association query plan degraded"),
      { code: "COLLECTOR_PLAN_DEGRADED" },
    );
  }
}

function assertIndexes(source: SourceDb, domain: BusinessDomain) {
  const actual = source
    .prepare(`PRAGMA index_info(${INDEX_BY_DOMAIN[domain]})`)
    .all() as Array<{ name: string }>;
  const expected =
    domain === "run" ? ["updated_at", "run_id"] : ["updated_at", "id"];
  if (
    actual.length !== expected.length ||
    actual.some((column, index) => column.name !== expected[index])
  ) {
    throw Object.assign(new Error("collector index missing"), {
      code: "COLLECTOR_INDEX_MISSING",
    });
  }
}

function readWatermark(
  db: AnalyticsDb,
  domain: BusinessDomain,
): Watermark | null {
  const row = db
    .prepare(
      `
    SELECT initial_anchor, initial_floor_updated_at, initial_floor_stable_id,
      durable_updated_at, durable_stable_id, scan_anchor,
      cycle_cursor_updated_at, cycle_cursor_stable_id, cycle_state, reconciled_through
    FROM analytics_collector_watermark WHERE domain = ?
  `,
    )
    .get(domain) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    domain,
    initialAnchor: row.initial_anchor as number,
    initialFloor: {
      updatedAt: row.initial_floor_updated_at as number,
      stableId: row.initial_floor_stable_id as string,
    },
    durableFrontier: {
      updatedAt: row.durable_updated_at as number,
      stableId: row.durable_stable_id as string,
    },
    scanAnchor: row.scan_anchor as number | null,
    cycleCursor:
      row.cycle_cursor_updated_at === null
        ? null
        : {
            updatedAt: row.cycle_cursor_updated_at as number,
            stableId: row.cycle_cursor_stable_id as string,
          },
    cycleState: row.cycle_state as CycleState,
    reconciledThrough: row.reconciled_through as number | null,
  };
}

function writeWatermark(db: AnalyticsDb, watermark: Watermark, now: number) {
  db.prepare(
    `
    INSERT INTO analytics_collector_watermark (
      domain, initial_anchor, initial_floor_updated_at, initial_floor_stable_id,
      durable_updated_at, durable_stable_id, scan_anchor, cycle_cursor_updated_at,
      cycle_cursor_stable_id, cycle_state, reconciled_through, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      initial_anchor = excluded.initial_anchor,
      initial_floor_updated_at = excluded.initial_floor_updated_at,
      initial_floor_stable_id = excluded.initial_floor_stable_id,
      durable_updated_at = excluded.durable_updated_at,
      durable_stable_id = excluded.durable_stable_id,
      scan_anchor = excluded.scan_anchor,
      cycle_cursor_updated_at = excluded.cycle_cursor_updated_at,
      cycle_cursor_stable_id = excluded.cycle_cursor_stable_id,
      cycle_state = excluded.cycle_state,
      reconciled_through = excluded.reconciled_through,
      updated_at = excluded.updated_at
  `,
  ).run(
    watermark.domain,
    watermark.initialAnchor,
    watermark.initialFloor.updatedAt,
    watermark.initialFloor.stableId,
    watermark.durableFrontier.updatedAt,
    watermark.durableFrontier.stableId,
    watermark.scanAnchor,
    watermark.cycleCursor?.updatedAt ?? null,
    watermark.cycleCursor?.stableId ?? null,
    watermark.cycleState,
    watermark.reconciledThrough,
    now,
  );
}

function setDomainFailure(
  db: AnalyticsDb,
  domain: BusinessDomain,
  code: CollectorErrorCode,
  now: number,
) {
  db.prepare(
    `UPDATE analytics_domain_state SET status = 'degraded', last_error_code = ?, updated_at = ? WHERE domain = ?`,
  ).run(code, now, domain);
}

function setDomainScanning(
  db: AnalyticsDb,
  domain: BusinessDomain,
  watermark: Watermark,
  now: number,
) {
  db.prepare(
    `UPDATE analytics_domain_state
    SET collection_started_at = COALESCE(collection_started_at, ?), status = 'degraded',
      last_error_code = NULL, updated_at = ? WHERE domain = ?`,
  ).run(watermark.initialAnchor, now, domain);
}

function setDomainCycleState(
  db: AnalyticsDb,
  domain: BusinessDomain,
  watermark: Watermark,
  now: number,
  completed: boolean,
  degraded: boolean,
) {
  db.prepare(
    `
    UPDATE analytics_domain_state
    SET collection_started_at = COALESCE(collection_started_at, ?),
      reconciled_through = CASE WHEN ? THEN ? ELSE reconciled_through END,
      status = ?, last_succeeded_at = ?, last_error_code = ?, updated_at = ?
    WHERE domain = ?
  `,
  ).run(
    watermark.initialAnchor,
    completed ? 1 : 0,
    completed ? watermark.scanAnchor : null,
    completed && !degraded ? "healthy" : "degraded",
    now,
    degraded ? "COLLECTOR_ASSOCIATION_MISSING" : null,
    now,
    domain,
  );
}

function displayRunStatus(status: string) {
  return ["running", "completed", "failed", "cancelled"].includes(status)
    ? status
    : "unknown";
}

function storeSessions(db: AnalyticsDb, rows: SessionRow[], now: number) {
  const statement = db.prepare(`
    INSERT INTO analytics_session_fact (session_id, session_kind, created_at, source_updated_at, collected_at)
    VALUES (@id, @kind, @created_at, @updated_at, @collectedAt)
    ON CONFLICT(session_id) DO UPDATE SET
      session_kind = excluded.session_kind, created_at = excluded.created_at, source_updated_at = excluded.source_updated_at
  `);
  for (const row of rows) statement.run({ ...row, collectedAt: now });
}

function storeRuns(db: AnalyticsDb, rows: RunRow[], now: number) {
  const statement = db.prepare(`
    INSERT INTO analytics_run_fact (
      run_id, run_kind, parent_run_id, display_status, status_quality, inferred_evidence_type,
      created_at, terminal_at, source_updated_at, collected_at
    ) VALUES (@run_id, @run_kind, @parent_run_id, @display_status, 'observed', NULL,
      @created_at, @terminal_at, @updated_at, @collectedAt)
    ON CONFLICT(run_id) DO UPDATE SET
      run_kind = excluded.run_kind, parent_run_id = excluded.parent_run_id,
      display_status = CASE
        WHEN excluded.display_status='running' AND (analytics_run_fact.terminal_at IS NOT NULL
          OR (analytics_run_fact.status_quality='inferred' AND analytics_run_fact.display_status IN ('interrupted','unknown')))
          THEN analytics_run_fact.display_status
        ELSE excluded.display_status
      END,
      status_quality = CASE
        WHEN excluded.display_status='running' AND (analytics_run_fact.terminal_at IS NOT NULL
          OR (analytics_run_fact.status_quality='inferred' AND analytics_run_fact.display_status IN ('interrupted','unknown')))
          THEN analytics_run_fact.status_quality
        ELSE 'observed'
      END,
      inferred_evidence_type = CASE WHEN excluded.display_status='running' AND (analytics_run_fact.terminal_at IS NOT NULL
          OR (analytics_run_fact.status_quality='inferred' AND analytics_run_fact.display_status IN ('interrupted','unknown')))
          THEN analytics_run_fact.inferred_evidence_type ELSE NULL END,
      created_at = excluded.created_at,
      terminal_at = COALESCE(analytics_run_fact.terminal_at, excluded.terminal_at),
      source_updated_at = excluded.source_updated_at
  `);
  for (const row of rows) {
    const status = displayRunStatus(row.status);
    statement.run({
      ...row,
      display_status: status,
      terminal_at: ["completed", "failed", "cancelled"].includes(status)
        ? now
        : null,
      collectedAt: now,
    });
  }
}

function compactionQualities(source: SourceDb, rows: MessageRow[]) {
  const result = new Map<
    string,
    {
      compaction_kind: "manual" | "auto" | null;
      compaction_source_quality: "known" | "unknown" | "not_applicable";
    }
  >();
  for (const row of rows)
    result.set(row.id, {
      compaction_kind: null,
      compaction_source_quality:
        row.type === "compaction" && row.status === "completed"
          ? "unknown"
          : "not_applicable",
    });
  const candidates = rows.filter(
    (row) => row.type === "compaction" && row.status === "completed",
  );
  if (candidates.length === 0) return result;
  const ids = candidates.map((row) => row.id);
  assertAssociationPlan(source, compactionAssociationSql(ids.length), ids);
  const joined = source
    .prepare(compactionAssociationSql(ids.length))
    .all(...ids) as Array<{ id: string; run_kind: string | null }>;
  for (const row of joined) {
    result.set(
      row.id,
      row.run_kind === null
        ? { compaction_kind: null, compaction_source_quality: "unknown" }
        : {
            compaction_kind:
              row.run_kind === "manual_compaction" ? "manual" : "auto",
            compaction_source_quality: "known",
          },
    );
  }
  return result;
}

function storeMessages(
  db: AnalyticsDb,
  rows: MessageRow[],
  qualities: ReturnType<typeof compactionQualities>,
  now: number,
) {
  const statement = db.prepare(`
    INSERT INTO analytics_message_fact (
      message_id, message_kind, message_status, origin_run_id, compaction_kind,
      compaction_source_quality, created_at, source_updated_at, collected_at
    ) VALUES (@id, @type, @status, @origin_run_id, @compaction_kind, @compaction_source_quality,
      @created_at, @updated_at, @collectedAt)
    ON CONFLICT(message_id) DO UPDATE SET
      message_kind = excluded.message_kind, message_status = excluded.message_status,
      origin_run_id = excluded.origin_run_id, compaction_kind = excluded.compaction_kind,
      compaction_source_quality = excluded.compaction_source_quality,
      created_at = excluded.created_at, source_updated_at = excluded.source_updated_at
  `);
  for (const row of rows) {
    statement.run({ ...row, ...qualities.get(row.id)!, collectedAt: now });
    markDirtyHour(db, "message", row.created_at, now);
  }
}

function toolNames(source: SourceDb, rows: ToolRow[]) {
  const names = new Map<string, string | null>();
  if (rows.length === 0) return names;
  const ids = rows.map((row) => row.id);
  assertAssociationPlan(source, toolNameAssociationSql(ids.length), ids);
  const joined = source
    .prepare(toolNameAssociationSql(ids.length))
    .all(...ids) as Array<{ id: string; tool_name: string | null }>;
  for (const row of joined)
    names.set(row.id, typeof row.tool_name === "string" ? row.tool_name : null);
  return names;
}

function storeTools(
  db: AnalyticsDb,
  rows: ToolRow[],
  names: Map<string, string | null>,
  now: number,
) {
  const statement = db.prepare(`
    INSERT INTO analytics_tool_fact (
      tool_id, tool_name, tool_name_quality, status, created_at, started_at, completed_at,
      completed_duration_ms, source_updated_at, collected_at
    ) VALUES (@id, @tool_name, @tool_name_quality, @status, @created_at, @started_at, @completed_at,
      @completed_duration_ms, @updated_at, @collectedAt)
    ON CONFLICT(tool_id) DO UPDATE SET
      tool_name = excluded.tool_name, tool_name_quality = excluded.tool_name_quality,
      status = excluded.status, created_at = excluded.created_at, started_at = excluded.started_at,
      completed_at = excluded.completed_at, completed_duration_ms = excluded.completed_duration_ms,
      source_updated_at = excluded.source_updated_at
  `);
  for (const row of rows) {
    const name = names.get(row.id) ?? null;
    const reliableDuration =
      row.status === "completed" &&
      row.started_at !== null &&
      row.completed_at !== null &&
      row.completed_at >= row.started_at
        ? row.completed_at - row.started_at
        : null;
    statement.run({
      ...row,
      tool_name: name,
      tool_name_quality: name === null ? "unavailable" : "known",
      completed_duration_ms: reliableDuration,
      collectedAt: now,
    });
    markDirtyHour(db, "tool", row.created_at, now);
  }
}

function hasPersistedAssociationGap(db: AnalyticsDb, domain: BusinessDomain) {
  if (domain === "tool")
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM analytics_tool_fact WHERE tool_name_quality = 'unavailable' LIMIT 1",
        )
        .get(),
    );
  if (domain === "message")
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM analytics_message_fact WHERE compaction_source_quality = 'unknown' LIMIT 1",
        )
        .get(),
    );
  return false;
}

function startCursor(watermark: Watermark, overlapMs: number): Cursor {
  const overlapAt = Math.max(
    watermark.initialFloor.updatedAt,
    watermark.durableFrontier.updatedAt - overlapMs,
  );
  if (overlapAt === watermark.initialFloor.updatedAt)
    return watermark.initialFloor;
  // The cursor predicate is strictly greater-than. Use the preceding
  // millisecond so that every tuple at the overlap boundary is replayed,
  // including IDs that sort before an empty-string pseudo-ID.
  return { updatedAt: overlapAt - 1, stableId: "" };
}

export class BusinessCollector {
  private readonly batchSize: number;
  private readonly busyTimeoutMs: number;
  private readonly overlapMs: number;
  private readonly now: () => number;
  private readonly enabledDomains: ReadonlySet<BusinessDomain>;
  private readonly enabledAt: number | null;

  constructor(
    private readonly analyticsDb: AnalyticsDb,
    private readonly dataDir: string,
    options: BusinessCollectorOptions = {},
  ) {
    this.batchSize = safeBatchSize(options.batchSize);
    this.busyTimeoutMs = options.busyTimeoutMs ?? 100;
    this.overlapMs = safeOverlap(options.overlapMs);
    this.now = options.now ?? Date.now;
    this.enabledDomains = options.enabledDomains ?? new Set(BUSINESS_DOMAINS);
    this.enabledAt = options.enabledAt ?? null;
  }

  collectAll(): CollectionResult[] {
    const enabled = BUSINESS_DOMAINS.filter((domain) =>
      this.enabledDomains.has(domain),
    );
    if (enabled.length === 0) return [];
    let source: SourceDb;
    try {
      source = openBusinessDbReadonly(this.dataDir, this.busyTimeoutMs);
    } catch (error) {
      const now = this.now();
      const code = sourceErrorCode(error);
      this.analyticsDb.transaction(() => {
        for (const domain of enabled)
          setDomainFailure(this.analyticsDb, domain, code, now);
      })();
      return enabled.map((domain) => ({
        domain,
        collected: 0,
        cursorAdvanced: false,
        cycleCompleted: false,
        degraded: true,
      }));
    }
    try {
      return enabled.map((domain) => this.collectDomain(source, domain));
    } finally {
      source.close();
    }
  }

  collectDomain(source: SourceDb, domain: BusinessDomain): CollectionResult {
    const now = this.now();
    try {
      return source.transaction(() => {
        assertIndexes(source, domain);
        let watermark = readWatermark(this.analyticsDb, domain);
        if (!watermark) {
          const initialAnchor =
            this.enabledAt === null ? now : Math.min(now, this.enabledAt);
          const floor = asCursor(
            source.prepare(TAIL_SQL[domain]).get(initialAnchor) as
              { updated_at: number; stable_id: string } | undefined,
          );
          watermark = {
            domain,
            initialAnchor,
            initialFloor: floor,
            durableFrontier: floor,
            scanAnchor: initialAnchor,
            cycleCursor: floor,
            cycleState: "scanning",
            reconciledThrough: null,
          };
          // Persist the no-backfill boundary before attempting Fact writes. If
          // a later association/Fact transaction fails, retry resumes from the
          // same immutable enable-time snapshot instead of silently moving the
          // boundary forward and losing post-enable updates.
          this.analyticsDb.transaction(() => {
            writeWatermark(this.analyticsDb, watermark!, now);
            setDomainScanning(this.analyticsDb, domain, watermark!, now);
          })();
        } else if (watermark.cycleState === "idle") {
          const cursor = startCursor(watermark, this.overlapMs);
          watermark = {
            ...watermark,
            scanAnchor: now,
            cycleCursor: cursor,
            cycleState: "scanning",
          };
        }
        if (watermark.scanAnchor === null || watermark.cycleCursor === null)
          throw new Error("invalid collector cycle");
        assertCursorIndex(
          source,
          domain,
          watermark.cycleCursor,
          watermark.scanAnchor,
          this.batchSize,
        );
        const rows = source
          .prepare(CURSOR_SQL[domain])
          .all({
            ...watermark.cycleCursor,
            scanAnchor: watermark.scanAnchor,
            batchSize: this.batchSize,
          }) as SessionRow[] | RunRow[] | MessageRow[] | ToolRow[];
        let degraded = false;
        let nextCursor =
          targetCursor(
            rows as Array<{ updated_at: number } & Record<string, unknown>>,
            domain === "run" ? "run_id" : "id",
          ) ?? watermark.cycleCursor;
        this.analyticsDb.transaction(() => {
          if (domain === "session")
            storeSessions(this.analyticsDb, rows as SessionRow[], now);
          if (domain === "run")
            storeRuns(this.analyticsDb, rows as RunRow[], now);
          if (domain === "message") {
            const qualities = compactionQualities(source, rows as MessageRow[]);
            storeMessages(
              this.analyticsDb,
              rows as MessageRow[],
              qualities,
              now,
            );
          }
          if (domain === "tool") {
            const names = toolNames(source, rows as ToolRow[]);
            storeTools(this.analyticsDb, rows as ToolRow[], names, now);
          }
          degraded = hasPersistedAssociationGap(this.analyticsDb, domain);
          const complete = rows.length < this.batchSize;
          const next: Watermark = complete
            ? {
                ...watermark!,
                durableFrontier: maxCursor(
                  watermark!.durableFrontier,
                  nextCursor,
                ),
                scanAnchor: null,
                cycleCursor: null,
                cycleState: "idle",
                reconciledThrough: watermark!.scanAnchor,
              }
            : {
                ...watermark!,
                cycleCursor: nextCursor,
                cycleState: "scanning",
              };
          writeWatermark(this.analyticsDb, next, now);
          setDomainCycleState(
            this.analyticsDb,
            domain,
            watermark!,
            now,
            complete,
            degraded,
          );
        })();
        return {
          domain,
          collected: rows.length,
          cursorAdvanced: rows.length > 0,
          cycleCompleted: rows.length < this.batchSize,
          degraded,
        };
      })();
    } catch (error) {
      const code = sourceErrorCode(error);
      this.analyticsDb.transaction(() =>
        setDomainFailure(this.analyticsDb, domain, code, now),
      )();
      return {
        domain,
        collected: 0,
        cursorAdvanced: false,
        cycleCompleted: false,
        degraded: true,
      };
    }
  }
}

export const CollectorSql = {
  CURSOR_SQL,
  INDEX_BY_DOMAIN,
  TAIL_SQL,
  placeholders,
  compactionAssociationSql,
  toolNameAssociationSql,
};
