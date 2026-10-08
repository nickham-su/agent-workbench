import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SqliteSessionActivityQuery } from "./sqlite-session-activity-query.js";
import type { SessionActivityQuery } from "./session-activity-query.js";
import { createSessionActivityFixture } from "./test-fixtures/session-activity.fixture.js";

const NOW = 100_000;
const input: SessionActivityQuery = { workspaceId: "a", updatedWithinSeconds: 10, kind: "all", status: "all" };
const stateError = { statusCode: 500, code: "AGENT_SESSION_QUERY_STATE_INVALID" };

function fixture(t: TestContext, now: () => number = () => NOW) {
  const seed = createSessionActivityFixture();
  t.after(() => seed.db.close());
  return { ...seed, query: new SqliteSessionActivityQuery(seed.db, now) };
}

test("activity query checks Workspace before clock and returns an empty consistent window", (t) => {
  let clockCalls = 0;
  const f = fixture(t, () => NOW + clockCalls++);
  assert.throws(() => f.query.querySessions({ ...input, workspaceId: "missing" }), {
    statusCode: 404, code: "WORKSPACE_NOT_FOUND"
  });
  assert.equal(clockCalls, 0);
  assert.deepEqual(f.query.querySessions(input), {
    ...input, updatedFrom: 90_000, updatedTo: NOW, total: 0, items: []
  });
  assert.equal(clockCalls, 1);
  assert.equal(f.db.inTransaction, false);
});

test("activity query includes both window ends and preserves empty titles/headless sessions", (t) => {
  const f = fixture(t);
  for (const [id, updatedAt] of [["from", 90_000], ["to", NOW], ["old", 89_999], ["future", NOW + 1]] as const) {
    f.insertSession({ id, updatedAt });
  }
  f.insertSession({ id: "foreign", workspaceId: "b", updatedAt: NOW });
  const result = f.query.querySessions(input);
  assert.deepEqual(result.items.map((item) => item.id), ["to", "from"]);
  assert.equal(result.total, 2);
  for (const item of result.items) {
    assert.equal(item.title, "");
    assert.equal(item.userMessageCount, 0);
    assert.equal(item.completedAssistantMessageCount, 0);
    assert.deepEqual(Object.keys(item), ["id", "title", "kind", "status", "updatedAt", "userMessageCount", "completedAssistantMessageCount"]);
  }
});

test("activity query applies all nine kind/status combinations without page visibility", (t) => {
  const f = fixture(t);
  for (const kind of ["primary", "subtask"] as const) {
    for (const status of ["idle", "running"] as const) f.insertSession({ id: `${kind}-${status}`, kind, status, updatedAt: NOW });
  }
  // A visibility table is deliberately absent; neither closed primary nor unopened subtask is filtered.
  for (const kind of ["all", "primary", "subtask"] as const) {
    for (const status of ["all", "idle", "running"] as const) {
      const result = f.query.querySessions({ ...input, kind, status });
      assert.equal(result.total, (kind === "all" ? 2 : 1) * (status === "all" ? 2 : 1));
      assert.ok(result.items.every((item) => (kind === "all" || item.kind === kind) && (status === "all" || item.status === status)));
      assert.equal(result.kind, kind);
      assert.equal(result.status, status);
    }
  }
});

test("activity query returns 160+ items in BINARY order and runs in a read-only transaction", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 160; i++) f.insertSession({ id: `session-${String(i).padStart(3, "0")}`, updatedAt: NOW });
  for (const id of ["Z", "a", "é", "中", "😀"]) f.insertSession({ id, updatedAt: NOW });
  f.db.pragma("query_only = ON");
  const result = f.query.querySessions(input);
  assert.equal(result.total, 165);
  assert.equal(new Set(result.items.map((item) => item.id)).size, 165);
  const sorted = f.db.prepare("select id from agent_session order by updated_at desc, id collate binary desc").all() as { id: string }[];
  assert.deepEqual(result.items.map((item) => item.id), sorted.map((row) => row.id));
  assert.equal("nextCursor" in result, false);
  assert.equal(f.db.inTransaction, false);
});

test("activity counts retained native completed messages, independently of time and other detail tables", (t) => {
  const f = fixture(t);
  f.insertSession({ id: "one", updatedAt: NOW });
  f.insertSession({ id: "two", updatedAt: NOW });
  f.insertSession({ id: "zero", updatedAt: NOW });
  for (let i = 0; i < 2; i++) f.insertMessage({ id: `u-${i}`, originSessionId: "one", type: "user", createdAt: 1 });
  for (let i = 0; i < 3; i++) f.insertMessage({ id: `a-${i}`, originSessionId: "one", type: "assistant", createdAt: 1 });
  for (const type of ["system", "runtime", "compaction"] as const) f.insertMessage({ id: type, originSessionId: "one", type });
  for (const status of ["streaming", "failed", "cancelled", "superseded"] as const) {
    for (const type of ["user", "assistant"] as const) f.insertMessage({ id: `${type}-${status}`, originSessionId: "one", type, status });
  }
  f.insertMessage({ id: "foreign", workspaceId: "b", originSessionId: "one", type: "assistant" });
  f.insertMessage({ id: "unowned", originSessionId: null, type: "assistant" });
  f.insertMessage({ id: "two-user", originSessionId: "two", type: "user" });
  const result = f.query.querySessions(input);
  assert.deepEqual(result.items.map((item) => [item.id, item.userMessageCount, item.completedAssistantMessageCount]), [
    ["zero", 0, 0], ["two", 1, 0], ["one", 2, 3]
  ]);
  assert.equal(f.db.prepare("select 1 from sqlite_master where name in ('agent_run', 'agent_message_part', 'analytics')").get(), undefined);
});

test("activity counts do not inherit fork history or shrink after compaction/revert pointers", (t) => {
  const f = fixture(t);
  f.insertSession({ id: "source", updatedAt: NOW, headMessageId: "source-a", contextRootMessageId: "source-u" });
  f.insertMessage({ id: "source-u", originSessionId: "source", type: "user" });
  f.insertMessage({ id: "source-a", originSessionId: "source", type: "assistant", originRunId: "failed-run" });
  f.insertSession({ id: "fork", kind: "subtask", updatedAt: NOW, forkedFromSessionId: "source", headMessageId: "source-a", contextRootMessageId: "source-u" });
  f.insertMessage({ id: "fork-u", originSessionId: "fork", type: "user" });
  const before = f.query.querySessions(input);
  assert.deepEqual(before.items.map((item) => [item.id, item.userMessageCount, item.completedAssistantMessageCount]), [["source", 1, 1], ["fork", 1, 0]]);
  f.insertMessage({ id: "automatic-summary", originSessionId: "source", type: "compaction" });
  f.insertMessage({ id: "manual-summary", originSessionId: "source", type: "compaction", originRunId: "manual-compaction-run" });
  f.db.prepare("update agent_session set head_message_id = ?, context_root_message_id = ? where id = 'source'").run("manual-summary", "automatic-summary");
  assert.deepEqual(f.query.querySessions(input), before);
  f.db.prepare("update agent_session set head_message_id = null, context_root_message_id = null where id = 'source'").run();
  assert.deepEqual(f.query.querySessions(input), before);
});

test("activity rejects missing/corrupt candidate RunState before any status filter", (t) => {
  for (const status of [null, "broken"]) {
    const f = fixture(t);
    f.insertSession({ id: "valid", updatedAt: NOW, status: "idle" });
    f.insertSession({ id: "bad", updatedAt: NOW, status });
    for (const filter of ["all", "idle", "running"] as const) {
      assert.throws(() => f.query.querySessions({ ...input, status: filter }), stateError);
      assert.equal(f.db.inTransaction, false);
    }
  }
});

test("activity checks only time/kind candidates and joins RunState in the same Workspace", (t) => {
  const f = fixture(t);
  f.insertSession({ id: "valid", updatedAt: NOW });
  f.insertSession({ id: "old-bad", updatedAt: 1, status: null });
  f.insertSession({ id: "subtask-bad", kind: "subtask", updatedAt: NOW, status: null });
  assert.equal(f.query.querySessions({ ...input, kind: "primary" }).total, 1);
  f.db.prepare("insert into session_run_state values ('b', 'subtask-bad', 'idle')").run();
  assert.throws(() => f.query.querySessions(input), stateError);
});

test("activity rejects non-integer/out-of-Date-range windows and candidate timestamps", (t) => {
  for (const now of [NaN, Infinity, 100_000.5, Number.MAX_SAFE_INTEGER, -8_640_000_000_000_000]) {
    const f = fixture(t, () => now);
    assert.throws(() => f.query.querySessions(input), stateError);
  }
  const f = fixture(t);
  f.insertSession({ id: "fractional", updatedAt: NOW - 0.5 });
  assert.throws(() => f.query.querySessions(input), stateError);
});

test("activity rejects unsafe/negative aggregates instead of emitting rounded counts", (t) => {
  for (const result of [BigInt(Number.MAX_SAFE_INTEGER) + 1n, -1n]) {
    const f = fixture(t);
    f.insertSession({ id: "one", updatedAt: NOW });
    f.insertMessage({ id: "u", originSessionId: "one", type: "user" });
    // Controlled aggregate fault injection avoids generating quadrillions of rows.
    f.db.aggregate("sum", { start: 0, step: (acc: number, _value: unknown) => acc, result: () => result });
    assert.throws(() => f.query.querySessions(input), stateError);
  }
});

test("activity accepts a safe-integer SQLite connection without serializing bigint", (t) => {
  const f = fixture(t);
  f.insertSession({ id: "one", updatedAt: NOW });
  f.insertMessage({ id: "a", originSessionId: "one", type: "assistant" });
  f.db.defaultSafeIntegers(true);
  const result = f.query.querySessions(input);
  assert.equal(result.items[0].updatedAt, NOW);
  assert.equal(result.items[0].completedAssistantMessageCount, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});
