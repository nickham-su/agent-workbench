import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { openDb } from "../../infra/db/db.js";
import { dbPath } from "../../infra/fs/paths.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
} from "../agent/testkit/agent-testkit.js";
import { closeAnalyticsDb, openAnalyticsDb } from "./analytics-db.js";
import { BusinessCollector, CollectorSql } from "./business-collector.js";

const fixtures: Array<Awaited<ReturnType<typeof createAgentTestFixture>>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function createFixture() {
  const fixture = await createAgentTestFixture({
    dataDirPrefix: "analytics-collector-",
  });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, {
    id: "ws-collector",
    createdAt: 1,
    updatedAt: 1,
  });
  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES (?, ?, ?, 'primary', ?, ?)",
    )
    .run("session-old", workspace.id, "safe", 10, 10);
  fixture.db
    .prepare(
      `INSERT INTO agent_run (run_id, workspace_id, session_id, agent_id, provider_id, model_id, status, created_at, updated_at, run_kind, execution_phase, terminal_result_code)
    VALUES ('run-old', ?, 'session-old', 'agent', 'provider', 'model', 'running', 10, 10, 'user', 'work_pending', NULL)`,
    )
    .run(workspace.id);
  fixture.db
    .prepare(
      `INSERT INTO agent_message (id, workspace_id, depth, type, status, origin_run_id, updated_revision, created_at, updated_at)
    VALUES ('message-old', ?, 0, 'compaction', 'completed', 'run-old', 0, 10, 10)`,
    )
    .run(workspace.id);
  fixture.db
    .prepare(
      `INSERT INTO agent_message_part (id, message_id, position, type, text, attachment_id, media_type, filename, tool_name, tool_input_json, provider_tool_call_id, updated_revision, created_at, updated_at)
    VALUES ('part-old', 'message-old', 0, 'tool_call', NULL, NULL, NULL, NULL, 'safe_tool', '{}', NULL, 0, 10, 10)`,
    )
    .run();
  fixture.db
    .prepare(
      `INSERT INTO agent_tool_execution (id, call_part_id, origin_session_id, origin_run_id, status, result_preview, result_artifact_path, structured_result_json, error, updated_revision, created_at, updated_at, started_at, completed_at)
    VALUES ('tool-old', 'part-old', 'session-old', 'run-old', 'running', 'secret output', '/secret/path', '{"secret":true}', 'raw error', 0, 10, 10, 10, NULL)`,
    )
    .run();
  return { fixture, workspaceId: workspace.id };
}

function collector(
  db: Database.Database,
  dataDir: string,
  now: number,
  batchSize = 50,
) {
  return new BusinessCollector(db, dataDir, {
    now: () => now,
    batchSize,
    busyTimeoutMs: 20,
    overlapMs: 1_000,
  });
}

function watermark(db: Database.Database, domain: string) {
  return db
    .prepare("SELECT * FROM analytics_collector_watermark WHERE domain = ?")
    .get(domain) as Record<string, unknown>;
}

test("empty source baseline performs no collection until a formal source establishes prospective floors", async (t) => {
  const { fixture, workspaceId } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  for (const now of [20, 40, 60]) {
    const results = new BusinessCollector(analytics, fixture.dataDir, {
      enabledDomains: new Set(), now: () => now,
    }).collectAll();
    assert.deepEqual(results, []);
  }
  assert.equal((analytics.prepare("SELECT COUNT(*) AS count FROM analytics_collector_watermark").get() as { count: number }).count, 0);
  assert.equal((analytics.prepare("SELECT COUNT(*) AS count FROM analytics_run_fact").get() as { count: number }).count, 0);

  const enabledDomains = new Set(["session", "run", "message", "tool"] as const);
  new BusinessCollector(analytics, fixture.dataDir, {
    enabledDomains, enabledAt: 100, now: () => 100, batchSize: 50,
  }).collectAll();
  fixture.db.prepare(
    "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('session-new', ?, 'safe', 'subtask', 101, 101)",
  ).run(workspaceId);
  new BusinessCollector(analytics, fixture.dataDir, {
    enabledDomains, enabledAt: 100, now: () => 200, batchSize: 50,
  }).collectAll();
  assert.equal((analytics.prepare("SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id='session-old'").get() as { count: number }).count, 0);
  assert.equal((analytics.prepare("SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id='session-new'").get() as { count: number }).count, 1);
});

test("first enable sets immutable floors without historical backfill, then collects only new or updated records", async (t) => {
  const { fixture, workspaceId } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));

  const enabled = collector(analytics, fixture.dataDir, 100).collectAll();
  assert.equal(
    enabled.every((result) => result.collected === 0 && result.cycleCompleted),
    true,
  );
  for (const domain of ["session", "run", "message", "tool"]) {
    const state = watermark(analytics, domain);
    assert.equal(state.initial_anchor, 100);
    assert.equal(state.initial_floor_updated_at, 10);
    assert.equal(state.durable_updated_at, 10);
    assert.equal(state.reconciled_through, 100);
  }
  assert.equal(
    (
      analytics
        .prepare("SELECT COUNT(*) AS count FROM analytics_run_fact")
        .get() as { count: number }
    ).count,
    0,
  );
  assert.equal(
    (
      analytics
        .prepare("SELECT COUNT(*) AS count FROM analytics_tool_fact")
        .get() as { count: number }
    ).count,
    0,
  );

  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('session-new', ?, 'safe', 'subtask', 101, 101)",
    )
    .run(workspaceId);
  fixture.db
    .prepare(
      "UPDATE agent_run SET status = 'completed', execution_phase = 'terminal', terminal_result_code = 'done', updated_at = 101 WHERE run_id = 'run-old'",
    )
    .run();
  fixture.db
    .prepare(
      "UPDATE agent_tool_execution SET status = 'completed', completed_at = 121, updated_at = 101 WHERE id = 'tool-old'",
    )
    .run();
  fixture.db
    .prepare(
      "UPDATE agent_message SET updated_at = 101 WHERE id = 'message-old'",
    )
    .run();
  const updated = collector(analytics, fixture.dataDir, 200).collectAll();
  assert.equal(
    updated.every((result) => result.collected >= 1),
    true,
  );
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT run_id, display_status, terminal_at, collected_at FROM analytics_run_fact",
      )
      .get(),
    {
      run_id: "run-old",
      display_status: "completed",
      terminal_at: 200,
      collected_at: 200,
    },
  );
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT tool_name, completed_duration_ms, collected_at FROM analytics_tool_fact",
      )
      .get(),
    {
      tool_name: "safe_tool",
      completed_duration_ms: 111,
      collected_at: 200,
    },
  );
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id = 'session-old'",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id = 'session-new'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
});

test("strict pre-anchor floor excludes history while every enable-millisecond tuple and same-millisecond terminal update is collected", async (t) => {
  const { fixture, workspaceId } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('m-floor', ?, 'safe', 'primary', 99, 99), ('a-anchor', ?, 'safe', 'primary', 100, 100), ('m-anchor', ?, 'safe', 'primary', 100, 100), ('z-anchor', ?, 'safe', 'primary', 100, 100)",
    )
    .run(workspaceId, workspaceId, workspaceId, workspaceId);
  fixture.db
    .prepare(
      `INSERT INTO agent_run (run_id, workspace_id, session_id, agent_id, provider_id, model_id, status, created_at, updated_at, run_kind, execution_phase, terminal_result_code)
    VALUES ('run-anchor', ?, 'a-anchor', 'agent', 'provider', 'model', 'running', 100, 100, 'user', 'work_pending', NULL)`,
    )
    .run(workspaceId);

  collector(analytics, fixture.dataDir, 100).collectAll();
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT session_id FROM analytics_session_fact ORDER BY session_id",
      )
      .all(),
    [
      { session_id: "a-anchor" },
      { session_id: "m-anchor" },
      { session_id: "z-anchor" },
    ],
  );
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id IN ('session-old', 'm-floor')",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.equal(watermark(analytics, "session").initial_floor_updated_at, 99);
  assert.equal(
    watermark(analytics, "session").initial_floor_stable_id,
    "m-floor",
  );

  fixture.db
    .prepare(
      "UPDATE agent_run SET status = 'completed', execution_phase = 'terminal', terminal_result_code = 'done', updated_at = 100 WHERE run_id = 'run-anchor'",
    )
    .run();
  collector(analytics, fixture.dataDir, 101).collectAll();
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT display_status FROM analytics_run_fact WHERE run_id = 'run-anchor'",
        )
        .get() as { display_status: string }
    ).display_status,
    "completed",
  );
});

test("incoming observed running cannot revive inferred interrupted Run or create running plus terminal_at", async (t) => {
  const { fixture } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  collector(analytics, fixture.dataDir, 100).collectAll();
  analytics
    .prepare(
      `INSERT INTO analytics_run_fact(run_id,run_kind,parent_run_id,display_status,status_quality,inferred_evidence_type,created_at,terminal_at,source_updated_at,collected_at)
    VALUES ('run-old','user',NULL,'interrupted','inferred','worker_unexpected_exit',10,99,10,100)
    ON CONFLICT(run_id) DO UPDATE SET display_status='interrupted',status_quality='inferred',inferred_evidence_type='worker_unexpected_exit',terminal_at=99`,
    )
    .run();
  fixture.db
    .prepare(
      "UPDATE agent_run SET status='running', updated_at=200 WHERE run_id='run-old'",
    )
    .run();
  collector(analytics, fixture.dataDir, 201).collectAll();
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT display_status,status_quality,terminal_at FROM analytics_run_fact WHERE run_id='run-old'",
      )
      .get(),
    {
      display_status: "interrupted",
      status_quality: "inferred",
      terminal_at: 99,
    },
  );
});

test("later observed terminal supersedes inferred interruption while retaining its first terminal timestamp", async (t) => {
  const { fixture } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  collector(analytics, fixture.dataDir, 100).collectAll();
  analytics
    .prepare(
      `INSERT INTO analytics_run_fact(run_id,run_kind,parent_run_id,display_status,status_quality,inferred_evidence_type,created_at,terminal_at,source_updated_at,collected_at)
    VALUES ('run-old','user',NULL,'interrupted','inferred','worker_unexpected_exit',10,99,10,100)
    ON CONFLICT(run_id) DO UPDATE SET display_status='interrupted',status_quality='inferred',inferred_evidence_type='worker_unexpected_exit',terminal_at=99`,
    )
    .run();
  fixture.db
    .prepare(
      "UPDATE agent_run SET status='completed', execution_phase='terminal', terminal_result_code='done', updated_at=200 WHERE run_id='run-old'",
    )
    .run();
  collector(analytics, fixture.dataDir, 201).collectAll();
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT display_status,status_quality,inferred_evidence_type,terminal_at FROM analytics_run_fact WHERE run_id='run-old'",
      )
      .get(),
    {
      display_status: "completed",
      status_quality: "observed",
      inferred_evidence_type: null,
      terminal_at: 99,
    },
  );
});

test("scan cycles only reconcile after the anchor is exhausted and overlap catches same-millisecond terminal updates", async (t) => {
  const { fixture, workspaceId } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  collector(analytics, fixture.dataDir, 100).collectAll();

  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('session-a', ?, 'safe', 'primary', 200, 200), ('session-b', ?, 'safe', 'primary', 201, 201)",
    )
    .run(workspaceId, workspaceId);
  collector(analytics, fixture.dataDir, 300, 1).collectAll();
  assert.equal(watermark(analytics, "session").cycle_state, "scanning");
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT reconciled_through FROM analytics_domain_state WHERE domain = 'session'",
        )
        .get() as { reconciled_through: number }
    ).reconciled_through,
    100,
  );
  collector(analytics, fixture.dataDir, 999, 1).collectAll();
  assert.equal(watermark(analytics, "session").cycle_state, "scanning");
  collector(analytics, fixture.dataDir, 999, 1).collectAll();
  assert.equal(watermark(analytics, "session").cycle_state, "idle");
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT reconciled_through FROM analytics_domain_state WHERE domain = 'session'",
        )
        .get() as { reconciled_through: number }
    ).reconciled_through,
    300,
  );

  fixture.db
    .prepare(
      `INSERT INTO agent_run (run_id, workspace_id, session_id, agent_id, provider_id, model_id, status, created_at, updated_at, run_kind, execution_phase, terminal_result_code)
    VALUES ('run-same-ms', ?, 'session-a', 'agent', 'provider', 'model', 'running', 400, 400, 'user', 'work_pending', NULL)`,
    )
    .run(workspaceId);
  collector(analytics, fixture.dataDir, 400, 1).collectAll();
  fixture.db
    .prepare(
      "UPDATE agent_run SET status = 'completed', execution_phase = 'terminal', terminal_result_code = 'done', updated_at = 400 WHERE run_id = 'run-same-ms'",
    )
    .run();
  collector(analytics, fixture.dataDir, 500, 1).collectAll(); // finishes the original anchor after the running tuple
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT display_status FROM analytics_run_fact WHERE run_id = 'run-same-ms'",
        )
        .get() as { display_status: string }
    ).display_status,
    "running",
  );
  collector(analytics, fixture.dataDir, 501, 1).collectAll(); // overlap begins a new cycle
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT display_status FROM analytics_run_fact WHERE run_id = 'run-same-ms'",
        )
        .get() as { display_status: string }
    ).display_status,
    "completed",
  );
  const firstTerminalAt = (
    analytics
      .prepare(
        "SELECT terminal_at FROM analytics_run_fact WHERE run_id = 'run-same-ms'",
      )
      .get() as { terminal_at: number }
  ).terminal_at;
  collector(analytics, fixture.dataDir, 502, 1).collectAll();
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT terminal_at FROM analytics_run_fact WHERE run_id = 'run-same-ms'",
        )
        .get() as { terminal_at: number }
    ).terminal_at,
    firstTerminalAt,
  );
});

test("completed compaction with missing source is unknown, facts exclude sensitive fields, and failures do not advance a cycle cursor", async (t) => {
  const { fixture, workspaceId } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  collector(analytics, fixture.dataDir, 100).collectAll();

  fixture.db.pragma("foreign_keys = OFF");
  fixture.db
    .prepare(
      "INSERT INTO agent_message (id, workspace_id, depth, type, status, origin_run_id, updated_revision, created_at, updated_at) VALUES ('message-missing-run', ?, 0, 'compaction', 'completed', 'not-present', 0, 110, 110)",
    )
    .run(workspaceId);
  fixture.db.pragma("foreign_keys = ON");
  collector(analytics, fixture.dataDir, 200).collectAll();
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT compaction_kind, compaction_source_quality FROM analytics_message_fact WHERE message_id = 'message-missing-run'",
      )
      .get(),
    { compaction_kind: null, compaction_source_quality: "unknown" },
  );
  assert.deepEqual(
    analytics
      .prepare(
        "SELECT status, last_error_code FROM analytics_domain_state WHERE domain = 'message'",
      )
      .get(),
    { status: "degraded", last_error_code: "COLLECTOR_ASSOCIATION_MISSING" },
  );
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_tool_fact'",
        )
        .get() as { sql: string }
    ).sql.includes("result_preview"),
    false,
  );
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_tool_fact'",
        )
        .get() as { sql: string }
    ).sql.includes("artifact_path"),
    false,
  );

  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('session-fail', ?, 'safe', 'primary', 210, 210)",
    )
    .run(workspaceId);
  const before = watermark(analytics, "session");
  analytics.exec(
    "CREATE TRIGGER reject_session_fact BEFORE INSERT ON analytics_session_fact BEGIN SELECT RAISE(ABORT, 'test'); END;",
  );
  const failed = collector(analytics, fixture.dataDir, 300)
    .collectAll()
    .find((result) => result.domain === "session");
  assert.deepEqual(failed, {
    domain: "session",
    collected: 0,
    cursorAdvanced: false,
    cycleCompleted: false,
    degraded: true,
  });
  const after = watermark(analytics, "session");
  assert.equal(after.cycle_cursor_updated_at, before.cycle_cursor_updated_at);
  assert.equal(after.reconciled_through, before.reconciled_through);
});

test("cursor and downstream Fact query plans use the required indexes without temporary sorting", async () => {
  const { fixture } = await createFixture();
  for (const domain of ["session", "run", "message", "tool"] as const) {
    const details = fixture.db
      .prepare(`EXPLAIN QUERY PLAN ${CollectorSql.CURSOR_SQL[domain]}`)
      .all({
        updatedAt: 0,
        stableId: "",
        scanAnchor: 999,
        batchSize: 50,
      }) as Array<{ detail: string }>;
    const plan = details
      .map((row) => row.detail)
      .join(" | ")
      .toLowerCase();
    assert.match(
      plan,
      new RegExp(
        `using index ${CollectorSql.INDEX_BY_DOMAIN[domain]}`.toLowerCase(),
      ),
    );
    assert.equal(plan.includes("use temp b-tree"), false);
  }
  const associationPlans = [
    fixture.db
      .prepare(`EXPLAIN QUERY PLAN ${CollectorSql.compactionAssociationSql(3)}`)
      .all("message-old", "missing-a", "missing-b"),
    fixture.db
      .prepare(`EXPLAIN QUERY PLAN ${CollectorSql.toolNameAssociationSql(3)}`)
      .all("tool-old", "missing-a", "missing-b"),
  ] as Array<Array<{ detail: string }>>;
  for (const details of associationPlans) {
    const plan = details
      .map((row) => row.detail)
      .join(" | ")
      .toLowerCase();
    assert.match(plan, /search .+ using (?:covering )?index/);
    assert.equal(plan.includes("use temp b-tree"), false);
    assert.equal(plan.includes("scan "), false);
  }
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  try {
    for (const [sql, index] of [
      [
        "SELECT run_id FROM analytics_run_fact WHERE created_at >= ? ORDER BY created_at, run_id",
        "analytics_run_fact_created_run_id",
      ],
      [
        "SELECT session_id FROM analytics_session_fact WHERE created_at >= ? ORDER BY created_at, session_id",
        "analytics_session_fact_created_session_id",
      ],
      [
        "SELECT message_id FROM analytics_message_fact WHERE created_at >= ? ORDER BY created_at, message_kind, message_status, compaction_kind",
        "analytics_message_fact_created_kind_status_compaction",
      ],
      [
        "SELECT tool_id FROM analytics_tool_fact WHERE created_at >= ? ORDER BY created_at, tool_name, status",
        "analytics_tool_fact_created_tool_name_status",
      ],
    ] as const) {
      const plan = (
        analytics.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0) as Array<{
          detail: string;
        }>
      )
        .map((row) => row.detail)
        .join(" | ")
        .toLowerCase();
      assert.match(plan, new RegExp(`using (?:covering )?index ${index}`));
      assert.equal(plan.includes("use temp b-tree"), false);
    }
  } finally {
    closeAnalyticsDb(analytics);
  }
});

test("business SQLite lock contention only degrades collector domains", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "awb-analytics-lock-"),
  );
  t.after(async () => fs.rm(dataDir, { recursive: true, force: true }));
  const business = await openDb(dataDir);
  business.close();
  const analytics = await openAnalyticsDb(dataDir, 100);
  t.after(() => closeAnalyticsDb(analytics));
  const lock = new Database(dbPath(dataDir));
  lock.pragma("journal_mode = DELETE");
  lock.pragma("locking_mode = EXCLUSIVE");
  lock.exec("BEGIN EXCLUSIVE");
  try {
    const results = new BusinessCollector(analytics, dataDir, {
      busyTimeoutMs: 5,
      now: () => 1_000,
    }).collectAll();
    assert.equal(
      results.every((result) => result.degraded && !result.cursorAdvanced),
      true,
    );
    assert.equal(
      (
        analytics
          .prepare(
            "SELECT last_error_code FROM analytics_domain_state WHERE domain = 'run'",
          )
          .get() as { last_error_code: string }
      ).last_error_code,
      "COLLECTOR_BUSY",
    );
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  const reopened = await openDb(dataDir);
  reopened.close();
});

test("disabled collectors do not read Facts and a re-enable floor never backfills disabled history", async (t) => {
  const { fixture, workspaceId } = await createFixture();
  const analytics = await openAnalyticsDb(fixture.dataDir, 1);
  t.after(() => closeAnalyticsDb(analytics));
  const disabled = new BusinessCollector(analytics, fixture.dataDir, {
    now: () => 100,
    enabledDomains: new Set(),
    enabledAt: 100,
  });
  assert.deepEqual(disabled.collectAll(), []);
  assert.equal(
    (
      analytics
        .prepare("SELECT COUNT(*) AS count FROM analytics_collector_watermark")
        .get() as { count: number }
    ).count,
    0,
  );
  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('disabled-history', ?, 'safe', 'primary', 110, 110)",
    )
    .run(workspaceId);
  const reenabled = new BusinessCollector(analytics, fixture.dataDir, {
    now: () => 200,
    enabledDomains: new Set(["session"]),
    enabledAt: 200,
  });
  reenabled.collectAll();
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id='disabled-history'",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  fixture.db
    .prepare(
      "INSERT INTO agent_session (id, workspace_id, title, kind, created_at, updated_at) VALUES ('reenabled-now', ?, 'safe', 'primary', 200, 200)",
    )
    .run(workspaceId);
  new BusinessCollector(analytics, fixture.dataDir, {
    now: () => 201,
    enabledDomains: new Set(["session"]),
    enabledAt: 200,
  }).collectAll();
  assert.equal(
    (
      analytics
        .prepare(
          "SELECT COUNT(*) AS count FROM analytics_session_fact WHERE session_id='reenabled-now'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
});
