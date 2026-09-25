import { Value } from "@sinclair/typebox/value";
import {
  DashboardQuerySuccessResponseSchema,
  type DashboardQueryErrorResponse,
} from "@agent-workbench/shared";
import { queryDashboard } from "./analytics-dashboard-query.js";
import {
  rebuildCollectedRollup,
  rebuildDirtyRollups,
} from "./analytics-rollups.js";
import { applyAnalyticsRetention } from "./analytics-maintenance.js";
import { BusinessCollector } from "./business-collector.js";
import {
  closeAnalyticsDb,
  openAnalyticsDb,
  readAnalyticsDomainStates,
  type AnalyticsDb,
} from "./analytics-db.js";
import {
  acceptAnalyticsSignal,
  authenticateSignalDomain,
  abandonLocalFallbackGeneration,
  diagnoseOutboxCorrupt,
  markStaleGenerations,
  readCurrentFactDomainConfig,
} from "./signal-store.js";
import {
  AnalyticsChildMessageSchema,
  isAnalyticsParentMessage,
  type AnalyticsChildMessage,
  type AnalyticsParentMessage,
} from "./analytics.protocol.js";

const analyticsDataDir = process.env.AWB_ANALYTICS_DATA_DIR;
const collectorEnabled = process.env.AWB_ANALYTICS_COLLECTOR_ENABLED !== "0";
const collectorIntervalMs = boundedPositiveInteger(
  process.env.AWB_ANALYTICS_COLLECTOR_INTERVAL_MS,
  1_000,
  50,
  60_000,
);
const collectorBatchSize = boundedPositiveInteger(
  process.env.AWB_ANALYTICS_COLLECTOR_BATCH_SIZE,
  100,
  1,
  500,
);
let db: AnalyticsDb | null = null;
let initialized = false;
let closing = false;
let collectorTimer: NodeJS.Timeout | null = null;
let staleTimer: NodeJS.Timeout | null = null;
let collectorStarted = false;
let lastMaintenanceAt = 0;

function boundedPositiveInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function stopCollector() {
  if (collectorTimer) clearTimeout(collectorTimer);
  collectorTimer = null;
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = null;
}

function startCollector() {
  if (collectorStarted) return;
  collectorStarted = true;
  if (!db || closing) return;
  staleTimer ??= setInterval(() => {
    if (!db || closing) return;
    try {
      markStaleGenerations(db);
      // Authentication is periodic as well as event-driven: a receipt gap,
      // stale checkpoint, or open fact can never become trusted merely because
      // no new Signal happens to arrive.
      const config = readCurrentFactDomainConfig(db);
      for (const domain of ["execution", "model", "worker"] as const)
        if (config.enabled.has(domain)) authenticateSignalDomain(db, domain);
      rebuildDirtyRollups(db, Date.now(), 24);
      const closedTo =
        Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000;
      const cursor = db
        .prepare(
          "SELECT last_succeeded_at FROM analytics_maintenance_state WHERE task_name='collected_rollup'",
        )
        .get() as { last_succeeded_at: number | null } | undefined;
      const earliest = db
        .prepare(
          `SELECT MIN(collected_at) AS value FROM (
        SELECT collected_at FROM analytics_run_fact UNION ALL SELECT collected_at FROM analytics_session_fact UNION ALL SELECT collected_at FROM analytics_message_fact UNION ALL SELECT collected_at FROM analytics_tool_fact
        UNION ALL SELECT collected_at FROM analytics_execution_fact UNION ALL SELECT collected_at FROM analytics_model_call_fact UNION ALL SELECT collected_at FROM analytics_worker_event_fact
      )`,
        )
        .get() as { value: number | null };
      const collectedFrom =
        cursor?.last_succeeded_at ??
        (earliest.value === null
          ? closedTo
          : Math.floor(earliest.value / (60 * 60 * 1000)) * 60 * 60 * 1000);
      // A persistent cursor catches stopped-child history without reopening old ranges every tick.
      if (collectedFrom < closedTo)
        rebuildCollectedRollup(
          db,
          collectedFrom,
          Math.min(closedTo, collectedFrom + 24 * 60 * 60 * 1000),
        );
      if (Date.now() - lastMaintenanceAt >= 60 * 60 * 1000) {
        applyAnalyticsRetention(db, Date.now());
        lastMaintenanceAt = Date.now();
      }
    } catch {
      // Maintenance is strictly best-effort. A corrupted or unavailable
      // Analytics store must not take down the child or business paths.
    }
  }, 5_000);
  staleTimer.unref();
  if (!collectorEnabled) return;
  let retryDelayMs = collectorIntervalMs;
  const run = () => {
    collectorTimer = null;
    if (!db || closing) return;
    let allDegraded = true;
    try {
      // One bounded batch per domain per turn. The next pass is scheduled only
      // after returning to the event loop, allowing IPC/dashboard work to win.
      const config = readCurrentFactDomainConfig(db);
      const enabledBusinessDomains = new Set(
        ["run", "session", "message", "tool"].filter((domain) =>
          config.enabled.has(
            domain as "run" | "session" | "message" | "tool",
          ),
        ),
      ) as ReadonlySet<"run" | "session" | "message" | "tool">;
      const results = new BusinessCollector(db, analyticsDataDir!, {
        batchSize: collectorBatchSize,
        enabledDomains: enabledBusinessDomains,
        enabledAt: config.effectiveAt,
      }).collectAll();
      allDegraded = results.length > 0 && results.every((result) => result.degraded);
    } catch {
      // Per-domain failures are recorded by BusinessCollector. This final guard
      // keeps a future collector bug from terminating the privileged child.
    }
    // Locked/missing source stores should not spin against the business path.
    // A healthy pass immediately returns to the normal poll cadence.
    retryDelayMs = allDegraded
      ? Math.min(retryDelayMs * 2, 60_000)
      : collectorIntervalMs;
    if (!closing) collectorTimer = setTimeout(run, retryDelayMs);
  };
  collectorTimer = setTimeout(run, 0);
}

function send(message: AnalyticsChildMessage) {
  // Validate even locally so a future worker refactor cannot accidentally send
  // an unconstrained object over this privileged boundary.
  if (!Value.Check(AnalyticsChildMessageSchema, message)) {
    process.exit(1);
    return;
  }
  if (typeof process.send === "function" && process.connected)
    process.send(message);
}

function unavailableResponse(): DashboardQueryErrorResponse {
  return { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } };
}

function retire() {
  closing = true;
  stopCollector();
  closeAnalyticsDb(db);
  db = null;
  process.disconnect?.();
  // `disconnect` is normally enough, but the explicit exit covers test and
  // process-manager environments that do not emit it.
  setImmediate(() => process.exit(1));
}

async function handleMessage(message: AnalyticsParentMessage) {
  if (message.type === "initialize") {
    if (initialized || closing || !analyticsDataDir) return retire();
    try {
      db = await openAnalyticsDb(analyticsDataDir);
      initialized = true;
      send({ type: "ready", requestId: message.requestId });
    } catch {
      send({ type: "initialization_failed", requestId: message.requestId });
      retire();
    }
    return;
  }

  if (message.type === "dashboard_query") {
    if (!initialized || !db) return retire();
    try {
      // rangeId/from/to/asOf are established in the same child-owned SQLite
      // read transaction that observes Domain State.
      const response = queryDashboard(db, message.request, Date.now());
      if (
        response.kind === "success" &&
        !Value.Check(DashboardQuerySuccessResponseSchema, response)
      )
        return retire();
      send({
        type: "dashboard_result",
        requestId: message.requestId,
        response,
      });
    } catch {
      send({
        type: "dashboard_result",
        requestId: message.requestId,
        response: unavailableResponse(),
      });
    }
    return;
  }

  if (message.type === "outbox_corrupt") {
    if (!initialized || !db) {
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: { accepted: false, receipt: null },
      });
      return;
    }
    try {
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: { accepted: diagnoseOutboxCorrupt(db, message), receipt: null },
      });
    } catch {
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: { accepted: false, receipt: null },
      });
    }
    return;
  }

  if (message.type === "local_fallback_abandon") {
    if (!initialized || !db) {
      send({ type: "signal_result", requestId: message.requestId, result: { accepted: false, receipt: null } });
      return;
    }
    try {
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: {
          accepted: abandonLocalFallbackGeneration(
            db,
            message.producerGeneration,
            message.recordedAt,
          ),
          receipt: null,
        },
      });
    } catch {
      send({ type: "signal_result", requestId: message.requestId, result: { accepted: false, receipt: null } });
    }
    return;
  }

  if (message.type === "signal") {
    if (!initialized || !db) {
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: { accepted: false, receipt: null },
      });
      return;
    }
    try {
      const result = acceptAnalyticsSignal(db, message.signal);
      if (result.accepted && message.signal.kind === "expected_slots_config")
        startCollector();
      // `committedAt` is an internal store detail, not part of the strict IPC
      // result contract. Forward only the public receipt identity.
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: result.receipt
          ? {
              accepted: result.accepted,
              receipt: {
                eventId: result.receipt.eventId,
                fingerprint: result.receipt.fingerprint,
              },
            }
          : result,
      });
    } catch {
      // Signal rejection is never allowed to crash Analytics or affect business.
      send({
        type: "signal_result",
        requestId: message.requestId,
        result: { accepted: false, receipt: null },
      });
    }
    return;
  }

  if (message.type === "shutdown") {
    closing = true;
    stopCollector();
    closeAnalyticsDb(db);
    db = null;
    initialized = false;
    send({ type: "shutdown_complete", requestId: message.requestId });
    process.disconnect?.();
  }
}

process.on("message", (message) => {
  // A malformed parent message is a protocol violation, not an input error.
  // Retire rather than guessing how to continue a privileged worker session.
  if (!isAnalyticsParentMessage(message)) return retire();
  void handleMessage(message);
});
process.on("disconnect", () => {
  closing = true;
  stopCollector();
  closeAnalyticsDb(db);
  process.exit(0);
});
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));
