import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, test } from "node:test";
import { openDb } from "./db.js";
import { AGENT_SCHEMA_VERSION, initSchema, isAgentFileCleanupPending, markAgentFileCleanupComplete } from "./schema.js";
import { dbPath, workspaceAgentArtifactsRoot, workspaceRoot } from "../fs/paths.js";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function tableExistsForTest(db: Database.Database, name: string) {
  return Boolean(
    db.prepare("select 1 from sqlite_master where type in ('table', 'view') and name = ?").get(name)
  );
}

function insertWorkspace(db: Database.Database, id = "ws-a") {
  db.prepare(
    "insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
  ).run(id, `${id}-dir`, "Workspace", `/workspaces/${id}`, 1, 1);
}

function insertSession(db: Database.Database, id = "session-a", workspaceId = "ws-a") {
  db.prepare(
    "insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
  ).run(id, workspaceId, "Session", "primary", 1, 1);
}

function insertMessage(db: Database.Database, input: {
  id: string;
  workspaceId?: string;
  previousMessageId?: string | null;
  originSessionId?: string | null;
  originRunId?: string | null;
  type?: string;
  status?: string;
  depth?: number;
}): void {
  db.prepare(`
    insert into agent_message (
      id, workspace_id, previous_message_id, replaces_message_id, depth, type, status,
      origin_session_id, origin_run_id, updated_revision, created_at, updated_at
    ) values (?, ?, ?, null, ?, ?, ?, ?, ?, 0, 1, 1)
  `).run(
    input.id,
    input.workspaceId ?? "ws-a",
    input.previousMessageId ?? null,
    input.depth ?? 0,
    input.type ?? "assistant",
    input.status ?? "completed",
    input.originSessionId ?? null,
    input.originRunId ?? null
  );
}

test("v23 retained anchor enforces compaction-only, same-workspace and immutable semantics", () => {
  const db = createDb();
  insertWorkspace(db, "ws-a"); insertWorkspace(db, "ws-b");
  insertSession(db, "session-a", "ws-a"); insertSession(db, "session-b", "ws-b");
  insertMessage(db, { id: "a", workspaceId: "ws-a", originSessionId: "session-a", type: "user" });
  insertMessage(db, { id: "b", workspaceId: "ws-b", originSessionId: "session-b", type: "user" });
  assert.throws(() => db.prepare("update agent_message set retained_from_message_id='a' where id='a'").run(), /immutable/);
  assert.throws(() => db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('ordinary','ws-a','a',null,'a',1,'assistant','completed','session-a',null,0,2,2)`).run(), /CHECK/);
  assert.throws(() => db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('cross','ws-a','a',null,'b',1,'compaction','completed','session-a',null,0,2,2)`).run(), /same workspace/);
  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('compaction','ws-a','a',null,'a',1,'compaction','completed','session-a',null,0,2,2)`).run();
  assert.throws(() => db.prepare("update agent_message set retained_from_message_id=null where id='compaction'").run(), /immutable/);
  assert.ok(db.prepare("select 1 from sqlite_master where type='index' and name='idx_agent_message_retained_from'").get());
  db.close();
});

test("v23 Run phase check enforces intended and actual terminal-result nullability", () => {
  const db = createDb(); insertWorkspace(db); insertSession(db);
  const insertRun = db.prepare(`insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at)
    values (?, 'ws-a', 'session-a', null, 'agent', 'provider', 'model', ?, 1, 1)`);
  insertRun.run("pending", "running");
  assert.deepEqual(db.prepare("select status,execution_phase,intended_terminal_code,terminal_result_code from agent_run where run_id='pending'").get(), {
    status: "running", execution_phase: "work_pending", intended_terminal_code: null, terminal_result_code: null,
  });
  assert.throws(() => db.prepare("update agent_run set intended_terminal_code='run_completed' where run_id='pending'").run(), /CHECK/);
  db.prepare(`update agent_run set execution_phase='terminal_intent_persisted', intended_terminal_status='completed', intended_terminal_code='run_completed' where run_id='pending'`).run();
  assert.throws(() => db.prepare("update agent_run set terminal_result_code='run_completed' where run_id='pending'").run(), /CHECK/);
  db.prepare(`update agent_run set status='completed', execution_phase='terminal', intended_terminal_status=null, intended_terminal_code=null, terminal_result_code='run_completed' where run_id='pending'`).run();
  assert.throws(() => insertRun.run("bad-terminal", "completed"), /CHECK/);
  assert.throws(() => db.prepare(`update agent_run set terminal_result_detail=? where run_id='pending'`).run("x".repeat(241)), /CHECK/);
  assert.ok(db.prepare("select 1 from sqlite_master where type='index' and name='idx_agent_run_terminal_recovery'").get());
  db.close();
});

test("v23 current-schema semantic damage fails closed without rebuilding", () => {
  for (const statement of [
    "drop trigger agent_message_retained_immutable_update",
    "drop trigger agent_message_retained_workspace_insert",
    "drop index idx_agent_message_retained_from",
    "drop index idx_agent_run_terminal_recovery",
  ]) {
    const db = createDb();
    const before = db.prepare("select version, file_cleanup_pending from agent_schema_meta where id=1").get();
    db.exec(statement);
    assert.throws(() => initSchema(db), /Unsupported Agent schema/);
    assert.deepEqual(db.prepare("select version, file_cleanup_pending from agent_schema_meta where id=1").get(), before);
    db.close();
  }
});

function insertToolCallPart(db: Database.Database, id: string, messageId: string) {
  db.prepare(`
    insert into agent_message_part (
      id, message_id, position, type, text, attachment_id, media_type, filename,
      tool_name, tool_input_json, provider_tool_call_id, updated_revision, created_at, updated_at
    ) values (?, ?, 0, 'tool_call', null, null, null, null, 'bash', '{}', null, 0, 1, 1)
  `).run(id, messageId);
}

const LEGACY_SINGLE_ROW_WITH_PHASE_DDL = `
  create table terminal_auth_cleanup_intents (
    terminal_id text not null primary key,
    phase text not null check (phase in ('armed', 'recoverable', 'unresolved')),
    artifact_name text not null,
    diagnostic text not null,
    updated_at integer not null,
    foreign key (terminal_id) references terminals(id) on delete restrict
  ); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`;
const LEGACY_SINGLE_ROW_WITHOUT_PHASE_DDL = `
  create table terminal_auth_cleanup_intents (
    terminal_id text not null primary key,
    artifact_name text not null,
    diagnostic text not null,
    updated_at integer not null,
    foreign key (terminal_id) references terminals(id) on delete restrict
  ); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`;

function terminalAuthSchemaSnapshot(db: Database.Database) {
  return {
    objects: db.prepare(`select type, name, tbl_name, sql from sqlite_master
      where tbl_name = 'terminal_auth_cleanup_intents' or name = 'terminal_auth_cleanup_intents'
      order by type, name`).all(),
    rows: db.prepare("select * from terminal_auth_cleanup_intents order by terminal_id").all(),
    agentMeta: db.prepare("select id, version, file_cleanup_pending from agent_schema_meta order by id").all(),
    agentObjects: db.prepare(`select type, name, tbl_name, sql from sqlite_master
      where name like 'agent_%' or name = 'session_run_state'
      order by type, name`).all(),
  };
}

test("new Agent schema exposes Message/Part/Execution, Session state and FTS foundations", () => {
  const db = createDb();
  const tables = db.prepare(`
    select name from sqlite_master
    where name in (
      'agent_schema_meta', 'agent_message', 'agent_message_part', 'agent_tool_execution',
      'agent_session', 'session_run_state', 'agent_archived_text_fts', 'agent_text_part_fts_map'
    ) order by name
  `).all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), [
    "agent_archived_text_fts",
    "agent_message",
    "agent_message_part",
    "agent_schema_meta",
    "agent_session",
    "agent_text_part_fts_map",
    "agent_tool_execution",
    "session_run_state"
  ]);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  assert.equal((db.prepare("select count(*) as count from sqlite_master where name = 'agent_context_item'").get() as { count: number }).count, 0);
  db.close();
});

test("本轮 per-artifact intent 表缺 root anchor 时事务性迁为 unresolved", () => {
  const db = createDb();
  db.exec("drop table terminal_auth_cleanup_intents; create table terminal_auth_cleanup_intents (terminal_id text not null, artifact_kind text not null check (artifact_kind in ('ssh-key', 'askpass', 'askpass-token', 'legacy')), phase text not null check (phase in ('armed', 'recoverable', 'unresolved')), artifact_name text not null, expected_dev integer, expected_ino integer, diagnostic text not null, updated_at integer not null, primary key (terminal_id, artifact_kind), foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);");
  insertWorkspace(db);
  db.prepare("insert into terminals (id, workspace_id, session_name, status, created_at, updated_at) values ('per_artifact_old', 'ws-a', 'per_artifact_old', 'errored', 1, 1)").run();
  db.prepare("insert into terminal_auth_cleanup_intents values ('per_artifact_old', 'ssh-key', 'recoverable', 'old-name', 1, 2, 'old-diagnostic', 1)").run();
  initSchema(db);
  assert.deepEqual(db.prepare("select artifact_kind, phase, root_dev, root_ino, diagnostic from terminal_auth_cleanup_intents where terminal_id = 'per_artifact_old'").get(), {
    artifact_kind: "ssh-key", phase: "unresolved", root_dev: null, root_ino: null, diagnostic: "legacy terminal auth cleanup locator: old-diagnostic",
  });
  db.close();
});

test("terminal auth per-artifact intent 绑定 terminal 并以复合主键阻止误删", () => {
  const db = createDb();
  insertWorkspace(db);
  db.prepare("insert into terminals (id, workspace_id, session_name, status, created_at, updated_at) values ('term_auth_intent', 'ws-a', 'term_auth_intent', 'errored', 1, 1)").run();
  db.prepare(`insert into terminal_auth_cleanup_intents (
    terminal_id, artifact_kind, phase, artifact_name, expected_dev, expected_ino, root_dev, root_ino, diagnostic, updated_at
  ) values ('term_auth_intent', 'ssh-key', 'unresolved', '.terminal-auth-live-v1-ssh-key-term_auth_intent', null, null, null, null, 'unresolved', 1)`).run();
  assert.throws(() => db.prepare("delete from terminals where id = 'term_auth_intent'").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare(`insert into terminal_auth_cleanup_intents (
    terminal_id, artifact_kind, phase, artifact_name, expected_dev, expected_ino, root_dev, root_ino, diagnostic, updated_at
  ) values ('term_auth_intent', 'ssh-key', 'armed', 'other', null, null, 1, 1, 'duplicate', 2)`).run(), /UNIQUE/);
  db.close();
});

for (const [name, ddl, values] of [
  ["含 phase", LEGACY_SINGLE_ROW_WITH_PHASE_DDL, "'legacy_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["缺 phase", LEGACY_SINGLE_ROW_WITHOUT_PHASE_DDL, "'legacy_intent', 'old-name', 'old-diagnostic', 1"],
] as const) {
test(`精确已知单行旧表（${name}）事务性 rebuild 为 legacy/unresolved`, () => {
  const db = createDb();
  db.exec(`drop table terminal_auth_cleanup_intents; ${ddl}`);
  insertWorkspace(db);
  db.prepare("insert into terminals (id, workspace_id, session_name, status, created_at, updated_at) values ('legacy_intent', 'ws-a', 'legacy_intent', 'errored', 1, 1)").run();
  db.prepare(`insert into terminal_auth_cleanup_intents values (${values})`).run();
  initSchema(db);
  const row = db.prepare("select artifact_kind, phase, artifact_name, diagnostic from terminal_auth_cleanup_intents where terminal_id = 'legacy_intent'").get() as { artifact_kind: string; phase: string; artifact_name: string; diagnostic: string };
  assert.deepEqual(row, { artifact_kind: "legacy", phase: "unresolved", artifact_name: "old-name", diagnostic: "legacy terminal auth cleanup locator: old-diagnostic" });
  db.close();
});
}

for (const [name, ddl, values] of [
  ["无 phase CHECK", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null, artifact_name text not null, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["错误 phase CHECK", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null check (phase in ('armed', 'recoverable', 'unresolved', 'other')), artifact_name text not null, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["缺少 updated_at index", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null check (phase in ('armed', 'recoverable', 'unresolved')), artifact_name text not null, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete restrict);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["updated_at index 错误列", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null check (phase in ('armed', 'recoverable', 'unresolved')), artifact_name text not null, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(artifact_name);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["updated_at index 错误 unique", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null check (phase in ('armed', 'recoverable', 'unresolved')), artifact_name text not null, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete restrict); create unique index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["额外索引", `${LEGACY_SINGLE_ROW_WITH_PHASE_DDL} create index idx_terminal_auth_cleanup_intents_diagnostic on terminal_auth_cleanup_intents(diagnostic);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["错误 Terminal FK action", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null check (phase in ('armed', 'recoverable', 'unresolved')), artifact_name text not null, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete cascade); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1"],
  ["额外列", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, phase text not null check (phase in ('armed', 'recoverable', 'unresolved')), artifact_name text not null, diagnostic text not null, updated_at integer not null, extra text, foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`, "'broken_intent', 'recoverable', 'old-name', 'old-diagnostic', 1, null"],
] as const) {
  test(`单行旧表 ${name} 时 fail-closed，且不改写 schema、rows 或 Agent 状态`, () => {
    const db = createDb();
    db.exec(`drop table terminal_auth_cleanup_intents; ${ddl}`);
    insertWorkspace(db);
    db.prepare("insert into terminals (id, workspace_id, session_name, status, created_at, updated_at) values ('broken_intent', 'ws-a', 'broken_intent', 'errored', 1, 1)").run();
    db.prepare(`insert into terminal_auth_cleanup_intents values (${values})`).run();
    const before = terminalAuthSchemaSnapshot(db);
    assert.throws(() => initSchema(db), /Unsupported terminal auth cleanup intent schema\. Refusing unsafe repair\./);
    assert.deepEqual(terminalAuthSchemaSnapshot(db), before);
    db.close();
  });
}

test("精确含 phase 旧 DDL 被约束绕过写入非法 phase row 时 fail-closed 且不改写", () => {
  const db = createDb();
  db.exec(`drop table terminal_auth_cleanup_intents; ${LEGACY_SINGLE_ROW_WITH_PHASE_DDL}`);
  insertWorkspace(db);
  db.prepare("insert into terminals (id, workspace_id, session_name, status, created_at, updated_at) values ('invalid_phase', 'ws-a', 'invalid_phase', 'errored', 1, 1)").run();
  db.pragma("ignore_check_constraints = ON");
  db.prepare("insert into terminal_auth_cleanup_intents values ('invalid_phase', 'unknown', 'old-name', 'old-diagnostic', 1)").run();
  db.pragma("ignore_check_constraints = OFF");
  const before = terminalAuthSchemaSnapshot(db);
  assert.throws(() => initSchema(db), /Unsupported terminal auth cleanup intent schema\. Refusing unsafe repair\./);
  assert.deepEqual(terminalAuthSchemaSnapshot(db), before);
  db.close();
});

test("v19 缺 terminal auth intent 表时创建 per-artifact canonical", () => {
  const db = createDb();
  db.exec("drop table terminal_auth_cleanup_intents");
  initSchema(db);
  const columns = db.prepare("pragma table_info(terminal_auth_cleanup_intents)").all() as Array<{ name: string; pk: number }>;
  assert.deepEqual(columns.map((column) => column.name), ["terminal_id", "artifact_kind", "phase", "artifact_name", "expected_dev", "expected_ino", "root_dev", "root_ino", "diagnostic", "updated_at"]);
  assert.deepEqual(columns.filter((column) => column.pk > 0).map((column) => column.name), ["terminal_id", "artifact_kind"]);
  db.close();
});

test("canonical root anchor 约束禁止 armed/recoverable 缺失或越界 identity", () => {
  const db = createDb();
  insertWorkspace(db);
  db.prepare("insert into terminals (id, workspace_id, session_name, status, created_at, updated_at) values ('root_check', 'ws-a', 'root_check', 'errored', 1, 1)").run();
  const insert = db.prepare(`insert into terminal_auth_cleanup_intents (
    terminal_id, artifact_kind, phase, artifact_name, expected_dev, expected_ino, root_dev, root_ino, diagnostic, updated_at
  ) values (?, ?, ?, 'name', null, null, ?, ?, 'test', 1)`);
  assert.throws(() => insert.run('root_check', 'ssh-key', 'armed', null, null), /CHECK/);
  assert.throws(() => insert.run('root_check', 'ssh-key', 'recoverable', -1, 1), /CHECK/);
  assert.throws(() => insert.run('root_check', 'ssh-key', 'unresolved', -1, 1), /CHECK/);
  assert.throws(() => insert.run('root_check', 'ssh-key', 'unresolved', 1, null), /CHECK/);
  assert.doesNotThrow(() => insert.run('root_check', 'ssh-key', 'unresolved', null, null));
  db.close();
});

function recreateTerminalAuthCleanupIntentTable(db: Database.Database, ddl: string) { db.exec(`drop table terminal_auth_cleanup_intents; ${ddl}`); }
for (const [name, ddl] of [
  ["无 phase CHECK", `create table terminal_auth_cleanup_intents (terminal_id text not null, artifact_kind text not null check (artifact_kind in ('ssh-key','askpass','askpass-token','legacy')), phase text not null, artifact_name text not null, expected_dev integer, expected_ino integer, diagnostic text not null, updated_at integer not null, primary key (terminal_id, artifact_kind), foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`],
  ["单列而非复合 PK", `create table terminal_auth_cleanup_intents (terminal_id text not null primary key, artifact_kind text not null check (artifact_kind in ('ssh-key','askpass','askpass-token','legacy')), phase text not null check (phase in ('armed','recoverable','unresolved')), artifact_name text not null, expected_dev integer, expected_ino integer, diagnostic text not null, updated_at integer not null, foreign key (terminal_id) references terminals(id) on delete restrict); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`],
  ["错误 FK action", `create table terminal_auth_cleanup_intents (terminal_id text not null, artifact_kind text not null check (artifact_kind in ('ssh-key','askpass','askpass-token','legacy')), phase text not null check (phase in ('armed','recoverable','unresolved')), artifact_name text not null, expected_dev integer, expected_ino integer, diagnostic text not null, updated_at integer not null, primary key (terminal_id, artifact_kind), foreign key (terminal_id) references terminals(id) on delete cascade); create index idx_terminal_auth_cleanup_intents_updated_at on terminal_auth_cleanup_intents(updated_at);`],
] as const) {
  test(`per-artifact intent ${name} 时 fail-closed 且不破坏原表`, () => {
    const db = createDb(); recreateTerminalAuthCleanupIntentTable(db, ddl);
    const before = (db.prepare("select sql from sqlite_master where type = 'table' and name = 'terminal_auth_cleanup_intents'").get() as { sql: string }).sql;
    assert.throws(() => initSchema(db), /Unsupported terminal auth cleanup intent schema/);
    assert.equal((db.prepare("select sql from sqlite_master where type = 'table' and name = 'terminal_auth_cleanup_intents'").get() as { sql: string }).sql, before);
    db.close();
  });
}

test("Message Part constraints retain ordered typed parts without an attachment relation table", () => {
  const db = createDb();
  insertWorkspace(db);
  insertSession(db);
  insertMessage(db, { id: "message-a", originSessionId: "session-a" });
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('text-a', 'message-a', 0, 'text', 'hello', 0, 1, 1)`).run();

  assert.throws(() => db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('text-b', 'message-a', 0, 'text', 'duplicate', 0, 1, 1)`).run(), /UNIQUE/);
  assert.throws(() => db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('image-invalid', 'message-a', 1, 'image', 'not valid', 0, 1, 1)`).run(), /CHECK/);
  assert.equal((db.prepare("select count(*) as count from sqlite_master where name = 'agent_context_item_attachment'").get() as { count: number }).count, 0);
  db.close();
});

test("ToolExecution is one-to-one with a same-workspace ToolCallPart", () => {
  const db = createDb();
  insertWorkspace(db, "ws-a");
  insertWorkspace(db, "ws-b");
  insertSession(db, "session-a", "ws-a");
  insertSession(db, "session-b", "ws-b");
  insertMessage(db, { id: "head-a", workspaceId: "ws-a" });
  insertMessage(db, { id: "head-b", workspaceId: "ws-b" });
  db.prepare("update agent_session set head_message_id = ?, context_root_message_id = ? where id = 'session-a'").run("head-a", "head-a");
  assert.throws(() => db.prepare("update agent_session set head_message_id = ? where id = 'session-a'").run("head-b"), /same workspace/);
  insertMessage(db, { id: "message-a", workspaceId: "ws-a", originSessionId: "session-a" });
  insertMessage(db, { id: "message-b", workspaceId: "ws-b", originSessionId: "session-b" });
  insertToolCallPart(db, "call-a", "message-a");
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('text-b', 'message-b', 0, 'text', 'hello', 0, 1, 1)`).run();

  db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, status, updated_revision, created_at, updated_at)
    values ('execution-a', 'call-a', 'session-a', 'queued', 0, 1, 1)`).run();
  assert.throws(() => db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, status, updated_revision, created_at, updated_at)
    values ('execution-b', 'call-a', 'session-a', 'queued', 0, 1, 1)`).run(), /UNIQUE/);
  assert.throws(() => db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, status, updated_revision, created_at, updated_at)
    values ('execution-c', 'text-b', 'session-b', 'queued', 0, 1, 1)`).run(), /same-workspace tool_call/);
  assert.throws(() => db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, status, updated_revision, created_at, updated_at)
    values ('execution-d', 'call-a', 'session-b', 'queued', 0, 1, 1)`).run(), /same-workspace tool_call/);
  db.close();
});

test("Session deletion preserves shared messages and executions while origin references become null", () => {
  const db = createDb();
  insertWorkspace(db);
  insertSession(db);
  insertMessage(db, { id: "message-a", originSessionId: "session-a" });
  insertToolCallPart(db, "call-a", "message-a");
  db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, status, updated_revision, created_at, updated_at)
    values ('execution-a', 'call-a', 'session-a', 'completed', 0, 1, 1)`).run();
  db.prepare(`insert into session_run_state (workspace_id, session_id, status, updated_at)
    values ('ws-a', 'session-a', 'idle', 1)`).run();

  db.prepare("delete from agent_session where id = 'session-a'").run();
  assert.deepEqual(db.prepare("select id, origin_session_id as originSessionId from agent_message").get(), {
    id: "message-a",
    originSessionId: null
  });
  assert.deepEqual(db.prepare("select id, origin_session_id as originSessionId from agent_tool_execution").get(), {
    id: "execution-a",
    originSessionId: null
  });
  assert.equal((db.prepare("select count(*) as count from session_run_state").get() as { count: number }).count, 0);
  db.close();
});

test("FTS map enforces one global rowid per Part and uses trigram tokenizer", () => {
  const db = createDb();
  insertWorkspace(db);
  insertMessage(db, { id: "message-a", type: "user" });
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('part-a', 'message-a', 0, 'text', '中文检索文本', 0, 1, 1)`).run();
  db.prepare("insert into agent_archived_text_fts (rowid, text, message_depth, part_position) values (101, ?, 0, 0)").run("中文检索文本");
  db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values ('part-a', 101, 1)").run();
  assert.throws(() => db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values ('part-a', 102, 1)").run(), /UNIQUE/);
  assert.throws(() => db.prepare("insert into agent_text_part_fts_map (part_id, fts_rowid, created_at) values ('part-b', 101, 1)").run(), /UNIQUE/);
  assert.equal((db.prepare("select count(*) as count from agent_archived_text_fts where agent_archived_text_fts match '中文检'").get() as { count: number }).count, 1);
  db.close();
});

function snapshotAgentObjects(db: Database.Database) {
  return db.prepare(`
    select name, type, sql
    from sqlite_master
    where type in ('table', 'view')
      and (name like 'agent\\_%' escape '\\' or name = 'session_run_state')
    order by name
  `).all();
}

function snapshotAgentData(db: Database.Database) {
  const objects = snapshotAgentObjects(db) as Array<{ name: string; type: "table" | "view"; sql: string | null }>;
  return objects
    .filter((object): object is { name: string; type: "table"; sql: string | null } => object.type === "table")
    .map((object) => ({
      name: object.name,
      rows: db.prepare(`select * from "${object.name.replaceAll('"', '""')}"`).all()
    }));
}

function assertUnsupportedSchemaIsUntouched(db: Database.Database) {
  const beforeObjects = snapshotAgentObjects(db);
  const beforeData = snapshotAgentData(db);
  const beforeSentinel = db.prepare("select value from schema_test_sentinel where id = 1").get();
  assert.throws(() => initSchema(db), /Unsupported Agent schema state/);
  assert.deepEqual(snapshotAgentObjects(db), beforeObjects);
  assert.deepEqual(snapshotAgentData(db), beforeData);
  assert.deepEqual(db.prepare("select value from schema_test_sentinel where id = 1").get(), beforeSentinel);
}

function createCurrentSchemaFixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.exec("create table schema_test_sentinel (id integer primary key, value text not null);");
  db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
  return db;
}

function assertDamagedCurrentSchemaIsRejected(damage: (db: Database.Database) => void) {
  const db = createCurrentSchemaFixture();
  damage(db);
  assertUnsupportedSchemaIsUntouched(db);
  db.close();
}

function damageTableSqlFragment(db: Database.Database, table: "agent_run" | "agent_message", fragment: string, damagedFragment: string) {
  const tableSql = (db.prepare("select sql from sqlite_master where type='table' and name=?").get(table) as { sql: string }).sql;
  const indexSql = db.prepare("select sql from sqlite_master where type='index' and tbl_name=? and sql is not null").all(table) as Array<{ sql: string }>;
  const columns = (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name).join(", ");
  const damagedTable = `${table}_damaged`;
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(tableSql.replace(new RegExp(`create\\s+table\\s+${table}`, "i"), `create table ${damagedTable}`).replace(fragment, damagedFragment));
  db.exec(`insert into ${damagedTable} (${columns}) select ${columns} from ${table}; alter table ${table} rename to ${table}_old; alter table ${damagedTable} rename to ${table}; drop table ${table}_old;`);
  db.pragma("legacy_alter_table = OFF");
  for (const { sql } of indexSql) db.exec(sql);
  db.pragma("foreign_keys = ON");
}

async function createUnsupportedFileDatabase(dataDir: string) {
  await fs.mkdir(dataDir, { recursive: true });
  const db = new Database(dbPath(dataDir));
  db.pragma("journal_mode = DELETE");
  db.exec(`
    create table agent_unknown_future (id text primary key, payload text not null);
    create table schema_test_sentinel (id integer primary key, value text not null);
  `);
  db.prepare("insert into agent_unknown_future values ('unknown-a', 'keep')").run();
  db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
  db.close();
}

function snapshotFileDatabase(dataDir: string) {
  const db = new Database(dbPath(dataDir), { readonly: true });
  const journalMode = String((db.pragma("journal_mode", { simple: true }) as string) || "").toLowerCase();
  const schema = db.prepare("select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name").all();
  const data = {
    future: db.prepare("select * from agent_unknown_future").all(),
    sentinel: db.prepare("select * from schema_test_sentinel").all()
  };
  db.close();
  return { journalMode, schema, data };
}

function createLegacyContextItemTable(db: Database.Database) {
  db.exec(`
    create table agent_context_item (
      id integer primary key,
      workspace_id text not null,
      session_id text not null,
      run_id text,
      turn_id text,
      step integer,
      prev_id integer,
      kind text not null,
      status text not null,
      output_text text not null,
      assistant_reasoning_text text,
      output_text_truncated integer not null default 0,
      output_text_artifact_path text,
      tool_name text,
      tool_call_id text,
      tool_call_json text,
      tool_result_json text,
      error_message text,
      error_code text,
      boundary_reason text,
      archive_at integer,
      output_json text not null,
      created_at integer not null,
      updated_at integer not null
    );
  `);
}

function createLegacyContextItemAttachmentTable(db: Database.Database) {
  db.exec(`
    create table agent_context_item_attachment (
      context_item_id integer not null,
      attachment_id text not null,
      position integer not null,
      primary key (context_item_id, attachment_id),
      foreign key (context_item_id) references agent_context_item(id) on delete cascade,
      foreign key (attachment_id) references agent_attachment(id) on delete restrict
    );
  `);
}

test("Agent schema classifier accepts a clean database before first initialization", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  assert.equal(initSchema(db).fileCleanupPending, false);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  db.close();
});

test("Agent schema classifier accepts the current FTS5 schema including its SQLite shadow tables", () => {
  const db = createDb();
  const shadows = db.prepare("select count(*) as count from sqlite_master where name like 'agent_archived_text_fts_%'").get() as { count: number };
  assert.ok(shadows.count > 0);
  assert.doesNotThrow(() => initSchema(db));
  db.close();
});

test("current Agent schema semantic damage fails closed without writes", () => {
  assertDamagedCurrentSchemaIsRejected((db) => {
    db.exec("drop trigger agent_tool_execution_call_part_insert;");
  });
  assertDamagedCurrentSchemaIsRejected((db) => {
    db.exec(`
      create table agent_tool_execution_rebuilt (
        id text primary key,
        call_part_id text not null,
        origin_session_id text,
        origin_run_id text,
        status text not null,
        result_preview text,
        result_truncated integer not null,
        result_artifact_path text,
        structured_result_json text,
        error text,
        updated_revision integer not null,
        created_at integer not null,
        updated_at integer not null,
        started_at integer,
        completed_at integer
      );
      insert into agent_tool_execution_rebuilt select * from agent_tool_execution;
      drop table agent_tool_execution;
      alter table agent_tool_execution_rebuilt rename to agent_tool_execution;
    `);
  });
  for (const [fragment, damagedFragment] of [
    ["run_kind text not null default 'user' check (run_kind in ('user', 'manual_compaction', 'subtask'))", "run_kind text"],
    ["execution_phase text not null default 'work_pending' check (execution_phase in ('work_pending', 'work_in_progress', 'terminal_intent_persisted', 'terminal'))", "execution_phase text"],
    ["intended_terminal_status text check (intended_terminal_status is null or intended_terminal_status in ('completed', 'failed', 'cancelled'))", "intended_terminal_status text"],
    ["intended_terminal_code text check (intended_terminal_code is null or length(intended_terminal_code) between 1 and 80)", "intended_terminal_code text"],
    ["terminal_result_code text check (terminal_result_code is null or length(terminal_result_code) between 1 and 80)", "terminal_result_code text"],
    ["status = 'running' and execution_phase in ('work_pending', 'work_in_progress')", "1=1"],
    ["status = 'running' and execution_phase = 'terminal_intent_persisted'", "1=1"],
    ["status in ('completed', 'failed', 'cancelled') and execution_phase = 'terminal'", "1=1"],
    ["terminal_result_code is not null", "1=1"],
  ]) {
    assertDamagedCurrentSchemaIsRejected((db) => {
      damageTableSqlFragment(db, "agent_run", fragment, damagedFragment);
    });
  }
  // 保留片段且只放宽 running/terminal 分支；完整字段的 running/terminal probe 必须捕获。
  assertDamagedCurrentSchemaIsRejected((db) => {
    damageTableSqlFragment(
      db, "agent_run", "status = 'running' and execution_phase in ('work_pending', 'work_in_progress')",
      "status = 'running' and execution_phase in ('work_pending', 'work_in_progress', 'terminal')",
    );
  });
  // 额外收紧 run kind，必须由 manual_compaction/subtask 的合法 probe 捕获。
  assertDamagedCurrentSchemaIsRejected((db) => {
    damageTableSqlFragment(
      db, "agent_run", "run_kind text not null default 'user' check (run_kind in ('user', 'manual_compaction', 'subtask'))",
      "run_kind text not null default 'user' check (run_kind = 'user')",
    );
  });
  // 保留所有 fragment：仅局部放宽 terminal result 的非空条件，必须由行为探针拒绝。
  assertDamagedCurrentSchemaIsRejected((db) => {
    damageTableSqlFragment(
      db, "agent_run", "and terminal_result_code is not null)",
      "and (terminal_result_code is not null or terminal_result_code is null))",
    );
  });
  // 同样保留所有 fragment：额外约束会令合法 user terminal Run 失败，也必须 fail-closed。
  assertDamagedCurrentSchemaIsRejected((db) => {
    damageTableSqlFragment(
      db, "agent_run", "and terminal_result_code is not null)",
      "and terminal_result_code is not null and run_kind <> 'user')",
    );
  });
  assertDamagedCurrentSchemaIsRejected((db) => {
    damageTableSqlFragment(
      db, "agent_run", "and terminal_result_code is not null)\n      )",
      "and terminal_result_code is not null) or 1=1\n      )",
    );
  });
  assertDamagedCurrentSchemaIsRejected((db) => {
    damageTableSqlFragment(
      db,
      "agent_message",
      "check (type = 'compaction' or retained_from_message_id is null)",
      "check (retained_from_message_id is null or retained_from_message_id is not null)",
    );
  });
  assertDamagedCurrentSchemaIsRejected((db) => {
    db.exec(`
      drop trigger agent_tool_execution_call_part_insert;
      drop trigger agent_tool_execution_call_part_update;
      create table agent_tool_execution_rebuilt (
        id text primary key,
        call_part_id text not null unique,
        origin_session_id text,
        origin_run_id text,
        status text not null,
        result_preview text,
        result_truncated integer not null,
        result_artifact_path text,
        structured_result_json text,
        error text,
        updated_revision integer not null,
        created_at integer not null,
        updated_at integer not null,
        started_at integer,
        completed_at integer,
        foreign key (call_part_id) references agent_message_part(id) on delete restrict,
        foreign key (origin_session_id) references agent_session(id) on delete set null
      );
      insert into agent_tool_execution_rebuilt select * from agent_tool_execution;
      drop table agent_tool_execution;
      alter table agent_tool_execution_rebuilt rename to agent_tool_execution;
    `);
  });
  assertDamagedCurrentSchemaIsRejected((db) => {
    db.exec(`
      drop table agent_archived_text_fts;
      create virtual table agent_archived_text_fts using fts5(
        text,
        message_depth unindexed,
        part_position unindexed
      );
    `);
  });
});

test("openDb rejects unsupported file databases before persistent changes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-unsupported-file-"));
  tempDirs.push(dataDir);
  await createUnsupportedFileDatabase(dataDir);
  const before = snapshotFileDatabase(dataDir);
  assert.equal(before.journalMode, "delete");

  await assert.rejects(() => openDb(dataDir), /Unsupported Agent schema state/);

  assert.deepEqual(snapshotFileDatabase(dataDir), before);
});

test("Agent schema classifier accepts a real unversioned ContextItem schema and marks destructive cleanup pending", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createLegacyContextItemTable(db);
  db.prepare(`insert into agent_context_item (id, workspace_id, session_id, kind, status, output_text, output_text_truncated, output_json, created_at, updated_at)
    values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)`).run();
  assert.equal(initSchema(db).fileCleanupPending, true);
  assert.equal((db.prepare("select count(*) as count from agent_schema_meta").get() as { count: number }).count, 1);
  db.close();
});

test("legacy Agent rebuild tolerates a relation whose foreign key parent table is missing", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("create table schema_test_sentinel (id integer primary key, value text not null);");
  db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
  createLegacyContextItemTable(db);
  createLegacyContextItemAttachmentTable(db);

  const result = initSchema(db);

  assert.equal(result.fileCleanupPending, true);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  assert.deepEqual(db.prepare("select * from schema_test_sentinel").all(), [{ id: 1, value: "keep" }]);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(tableExistsForTest(db, "agent_context_item"), false);
  assert.equal(tableExistsForTest(db, "agent_context_item_attachment"), false);
  db.close();
});

test("legacy Agent rebuild tolerates dangling relation rows", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  createLegacyContextItemTable(db);
  createLegacyContextItemAttachmentTable(db);
  db.prepare(`insert into agent_context_item (
    id, workspace_id, session_id, kind, status, output_text, output_text_truncated,
    output_json, created_at, updated_at
  ) values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)`).run();
  db.prepare("insert into agent_context_item_attachment values (1, 'missing-attachment', 0)").run();

  const result = initSchema(db);

  assert.equal(result.fileCleanupPending, true);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 0);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal((db.prepare("select count(*) as count from agent_schema_meta").get() as { count: number }).count, 1);
  db.close();
});

test("failed legacy Agent rebuild rolls back dropped data and restores foreign_keys", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec("create table schema_test_sentinel (id integer primary key, value text not null);");
  db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
  createLegacyContextItemTable(db);
  createLegacyContextItemAttachmentTable(db);
  db.prepare(`insert into agent_context_item (
    id, workspace_id, session_id, kind, status, output_text, output_text_truncated,
    output_json, created_at, updated_at
  ) values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)`).run();
  db.prepare("insert into agent_context_item_attachment values (1, 'missing-attachment', 0)").run();
  db.exec(`
    create trigger agent_message_previous_workspace_insert
    before insert on schema_test_sentinel
    begin
      select 1;
    end;
  `);
  db.pragma("foreign_keys = ON");

  assert.throws(() => initSchema(db), /trigger agent_message_previous_workspace_insert already exists/);

  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.deepEqual(db.prepare("select id, output_text from agent_context_item").all(), [{ id: 1, output_text: "legacy" }]);
  assert.deepEqual(db.prepare("select * from agent_context_item_attachment").all(), [{ context_item_id: 1, attachment_id: "missing-attachment", position: 0 }]);
  assert.deepEqual(db.prepare("select * from schema_test_sentinel").all(), [{ id: 1, value: "keep" }]);
  assert.equal(tableExistsForTest(db, "agent_schema_meta"), false);
  assert.equal(tableExistsForTest(db, "agent_message"), false);
  db.close();
});

test("legacy Agent rebuild refuses an outer transaction without changing foreign_keys or data", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createLegacyContextItemTable(db);
  db.prepare(`insert into agent_context_item (
    id, workspace_id, session_id, kind, status, output_text, output_text_truncated,
    output_json, created_at, updated_at
  ) values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)`).run();

  db.exec("begin");
  try {
    assert.throws(() => initSchema(db), /must run outside an active transaction/);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(db.prepare("select id, output_text from agent_context_item").all(), [{ id: 1, output_text: "legacy" }]);
    assert.equal(tableExistsForTest(db, "agent_schema_meta"), false);
  } finally {
    if (db.inTransaction) db.exec("rollback");
  }
  db.close();
});

test("Agent schema classifier rejects malformed meta and unversioned target or unknown Agent objects without writes", () => {
  const cases: Array<{ name: string; setup: (db: Database.Database) => void }> = [
    {
      name: "meta missing id=1 row",
      setup: (db) => {
        initSchema(db);
        db.exec("delete from agent_schema_meta; create table schema_test_sentinel (id integer primary key, value text not null);");
        db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
      }
    },
    {
      name: "meta illegal version value",
      setup: (db) => {
        initSchema(db);
        db.exec("update agent_schema_meta set version = 'invalid'; create table schema_test_sentinel (id integer primary key, value text not null);");
        db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
      }
    },
    {
      name: "meta extra version row",
      setup: (db) => {
        db.exec(`
          create table agent_schema_meta (id integer, version integer not null, file_cleanup_pending integer not null, updated_at integer not null);
          insert into agent_schema_meta values (1, ${AGENT_SCHEMA_VERSION}, 0, 1);
          insert into agent_schema_meta values (2, ${AGENT_SCHEMA_VERSION}, 0, 1);
          create table schema_test_sentinel (id integer primary key, value text not null);
        `);
        db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
      }
    },
    {
      name: "target Message table without meta",
      setup: (db) => {
        db.exec("create table agent_message (id text primary key, payload text not null); create table schema_test_sentinel (id integer primary key, value text not null);");
        db.prepare("insert into agent_message values ('message-a', 'keep')").run();
        db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
      }
    },
    {
      name: "unknown agent table",
      setup: (db) => {
        db.exec("create table agent_unknown_future (id text primary key, payload text not null); create table schema_test_sentinel (id integer primary key, value text not null);");
        db.prepare("insert into agent_unknown_future values ('unknown-a', 'keep')").run();
        db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
      }
    },
    {
      name: "mixed legacy and target tables",
      setup: (db) => {
        createLegacyContextItemTable(db);
        db.exec("create table agent_message_part (id text primary key, payload text not null); create table schema_test_sentinel (id integer primary key, value text not null);");
        db.prepare("insert into agent_context_item (id, workspace_id, session_id, kind, status, output_text, output_text_truncated, output_json, created_at, updated_at) values (1, 'ws-a', 'session-a', 'user', 'completed', 'keep', 0, '{}', 1, 1)").run();
        db.prepare("insert into agent_message_part values ('part-a', 'keep')").run();
        db.prepare("insert into schema_test_sentinel values (1, 'keep')").run();
      }
    }
  ];

  for (const entry of cases) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    entry.setup(db);
    assertUnsupportedSchemaIsUntouched(db);
    db.close();
  }
});

test("destructive Agent-only upgrade clears old Agent tables but preserves Workspace data and records pending file cleanup", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    create table credentials (id text primary key, host text not null, kind text not null, label text, username text, secret_enc text not null, is_default integer not null, created_at integer not null, updated_at integer not null);
    create table repos (id text primary key, url text not null unique, credential_id text, default_branch text, mirror_path text not null, sync_status text not null, sync_error text, last_sync_at integer, created_at integer not null, updated_at integer not null);
    create table workspaces (id text primary key, dir_name text not null, title text not null, path text not null, terminal_credential_id text, last_used_at integer, created_at integer not null, updated_at integer not null);
    create table workspace_repos (workspace_id text not null, repo_id text not null, dir_name text not null, path text not null, created_at integer not null, updated_at integer not null, primary key (workspace_id, repo_id), foreign key (workspace_id) references workspaces(id) on delete restrict, foreign key (repo_id) references repos(id) on delete restrict);
    create table settings (key text primary key, value_json text not null, updated_at integer not null);
  `);
  createLegacyContextItemTable(db);
  db.prepare("insert into credentials (id, host, kind, secret_enc, is_default, created_at, updated_at) values ('cred-a', 'example.test', 'token', 'encrypted', 1, 1, 1)").run();
  db.prepare("insert into repos (id, url, credential_id, default_branch, mirror_path, sync_status, created_at, updated_at) values ('repo-a', 'https://example.test/repo.git', 'cred-a', 'main', '/repos/repo-a', 'idle', 1, 1)").run();
  db.prepare("insert into workspaces (id, dir_name, title, path, terminal_credential_id, created_at, updated_at) values ('ws-a', 'kept-workspace', 'Kept workspace', '/workspace/a', 'cred-a', 1, 1)").run();
  db.prepare("insert into workspace_repos (workspace_id, repo_id, dir_name, path, created_at, updated_at) values ('ws-a', 'repo-a', 'repo-a', '/workspace/a/repo-a', 1, 1)").run();
  db.prepare("insert into settings (key, value_json, updated_at) values ('plugin.feishu', '{\"enabled\":true}', 1)").run();
  db.prepare("insert into agent_context_item (id, workspace_id, session_id, kind, status, output_text, output_text_truncated, output_json, created_at, updated_at) values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)").run();

  const result = initSchema(db);
  assert.equal(result.fileCleanupPending, true);
  assert.equal(isAgentFileCleanupPending(db), true);
  assert.deepEqual(db.prepare("select id, title, path from workspaces where id = 'ws-a'").get(), {
    id: "ws-a", title: "Kept workspace", path: "/workspace/a"
  });
  assert.deepEqual(db.prepare("select id, host, secret_enc from credentials where id = 'cred-a'").get(), { id: "cred-a", host: "example.test", secret_enc: "encrypted" });
  assert.deepEqual(db.prepare("select id, url, credential_id, default_branch from repos where id = 'repo-a'").get(), { id: "repo-a", url: "https://example.test/repo.git", credential_id: "cred-a", default_branch: "main" });
  assert.deepEqual(db.prepare("select workspace_id, repo_id, dir_name from workspace_repos where workspace_id = 'ws-a'").get(), { workspace_id: "ws-a", repo_id: "repo-a", dir_name: "repo-a" });
  assert.deepEqual(db.prepare("select key, value_json from settings where key = 'plugin.feishu'").get(), { key: "plugin.feishu", value_json: "{\"enabled\":true}" });
  assert.equal((db.prepare("select count(*) as count from agent_session").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from sqlite_master where name = 'agent_context_item'").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_schema_meta where version = ?").get(AGENT_SCHEMA_VERSION) as { count: number }).count, 1);
  assert.equal(initSchema(db).fileCleanupPending, true);
  markAgentFileCleanupComplete(db);
  assert.equal(isAgentFileCleanupPending(db), false);
  assert.equal(initSchema(db).fileCleanupPending, false);
  db.close();
});

test("unknown Agent schema version fails closed without clearing Agent data", () => {
  const db = createDb();
  db.prepare("update agent_schema_meta set version = ? where id = 1").run(AGENT_SCHEMA_VERSION + 1);
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values ('ws-a', 'ws-a', 'Workspace', '/workspaces/ws-a', 1, 1)").run();
  db.prepare("insert into agent_session (id, workspace_id, title, kind, created_at, updated_at) values ('session-a', 'ws-a', 'Session', 'primary', 1, 1)").run();
  assert.throws(() => initSchema(db), /Unsupported Agent schema state/);
  assert.equal((db.prepare("select count(*) as count from agent_session").get() as { count: number }).count, 1);
  db.close();
});

test("destructive file cleanup derives artifact paths from dataDir and safely retries pending cleanup", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-upgrade-"));
  tempDirs.push(dataDir);
  let db = new Database(dbPath(dataDir));
  db.pragma("foreign_keys = ON");
  db.exec(`
    create table workspaces (id text primary key, dir_name text not null, title text not null, path text not null, created_at integer not null, updated_at integer not null);
  `);
  createLegacyContextItemTable(db);
  const attackerWorkspace = path.join(dataDir, "attacker-workspace");
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, 1, 1)")
    .run("ws-a", "trusted-workspace", "Workspace", attackerWorkspace);
  db.prepare("insert into agent_context_item (id, workspace_id, session_id, kind, status, output_text, output_text_truncated, output_json, created_at, updated_at) values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)").run();
  db.close();

  const trustedWorkspace = workspaceRoot(dataDir, "trusted-workspace");
  const trustedArtifacts = workspaceAgentArtifactsRoot(trustedWorkspace);
  const attackerArtifacts = workspaceAgentArtifactsRoot(attackerWorkspace);
  await fs.mkdir(trustedArtifacts, { recursive: true });
  await fs.mkdir(attackerArtifacts, { recursive: true });
  await fs.writeFile(path.join(trustedArtifacts, "legacy.txt"), "remove me");
  await fs.writeFile(path.join(attackerArtifacts, "keep.txt"), "keep me");
  await fs.mkdir(path.join(dataDir, "agent"), { recursive: true });
  const outside = path.join(dataDir, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(dataDir, "agent", "archive"));

  const first = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(first), true);
  first.close();
  await assert.doesNotReject(() => fs.access(path.join(attackerArtifacts, "keep.txt")));
  await assert.doesNotReject(() => fs.access(outside));
  await assert.rejects(() => fs.access(path.join(trustedArtifacts, "legacy.txt")));

  await fs.unlink(path.join(dataDir, "agent", "archive"));
  const second = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(second), false);
  second.close();

  const workspaceRootDir = path.join(dataDir, "workspaces");
  const workspaceRootRealDir = path.join(dataDir, "workspaces-real");
  const workspaceArtifact = workspaceAgentArtifactsRoot(workspaceRoot(dataDir, "trusted-workspace"));
  await fs.rm(workspaceRootDir, { recursive: true, force: true });
  await fs.mkdir(workspaceAgentArtifactsRoot(path.join(workspaceRootRealDir, "trusted-workspace")), { recursive: true });
  await fs.writeFile(path.join(workspaceAgentArtifactsRoot(path.join(workspaceRootRealDir, "trusted-workspace")), "keep.txt"), "keep me");
  await fs.symlink(workspaceRootRealDir, workspaceRootDir);

  db = new Database(dbPath(dataDir));
  db.pragma("foreign_keys = ON");
  db.prepare("update agent_schema_meta set file_cleanup_pending = 1 where id = 1").run();
  db.close();

  const third = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(third), true);
  third.close();
  await assert.doesNotReject(() => fs.access(path.join(workspaceArtifact, "keep.txt")));

  await fs.unlink(workspaceRootDir);
  await fs.rename(workspaceRootRealDir, workspaceRootDir);
  const fourth = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(fourth), false);
  fourth.close();
  await assert.rejects(() => fs.access(path.join(workspaceArtifact, "keep.txt")));
});

test("destructive file cleanup keeps file_cleanup_pending when a replacement marker survives retry", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-upgrade-marker-"));
  tempDirs.push(dataDir);
  let db = new Database(dbPath(dataDir));
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("update agent_schema_meta set file_cleanup_pending = 1 where id = 1").run();
  db.close();
  const marker = path.join(dataDir, ".agent-upgrade-quarantine", ".delete-replacement-pending-victim");
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, "victim");

  const first = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(first), true);
  first.close();
  const second = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(second), true);
  second.close();
  assert.equal(await fs.readFile(marker, "utf8"), "victim");
});

test("destructive file cleanup fails closed when artifact parent is replaced by an external symlink", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-upgrade-race-"));
  tempDirs.push(dataDir);
  const db = new Database(dbPath(dataDir));
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("update agent_schema_meta set file_cleanup_pending = 1 where id = 1").run();
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, 1, 1)")
    .run("ws-race", "ws-race", "Workspace", workspaceRoot(dataDir, "ws-race"));
  db.close();

  const workspacePath = workspaceRoot(dataDir, "ws-race");
  const outside = path.join(dataDir, "outside");
  await fs.mkdir(workspaceAgentArtifactsRoot(workspacePath), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "victim.txt"), "keep");
  await fs.rm(path.join(workspacePath, ".agent-workbench"), { recursive: true, force: true });
  await fs.symlink(outside, path.join(workspacePath, ".agent-workbench"));

  const opened = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(opened), true);
  opened.close();
  await assert.doesNotReject(() => fs.access(path.join(outside, "victim.txt")));
});

test("destructive file cleanup rejects a symbolic link in the artifact parent path", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "awb-agent-upgrade-parent-link-"));
  tempDirs.push(dataDir);
  const db = new Database(dbPath(dataDir));
  db.pragma("foreign_keys = ON");
  db.exec(`
    create table workspaces (id text primary key, dir_name text not null, title text not null, path text not null, created_at integer not null, updated_at integer not null);
  `);
  createLegacyContextItemTable(db);
  db.prepare("insert into workspaces (id, dir_name, title, path, created_at, updated_at) values (?, ?, ?, ?, 1, 1)")
    .run("ws-a", "trusted-workspace", "Workspace", "/untrusted/path");
  db.prepare("insert into agent_context_item (id, workspace_id, session_id, kind, status, output_text, output_text_truncated, output_json, created_at, updated_at) values (1, 'ws-a', 'session-a', 'user', 'completed', 'legacy', 0, '{}', 1, 1)").run();
  db.close();

  const workspacePath = workspaceRoot(dataDir, "trusted-workspace");
  const artifactParent = path.join(workspacePath, ".agent-workbench", "internal");
  const outside = path.join(dataDir, "outside-artifacts");
  await fs.mkdir(outside);
  await fs.mkdir(path.dirname(artifactParent), { recursive: true });
  await fs.symlink(outside, artifactParent);
  await fs.writeFile(path.join(outside, "keep.txt"), "keep me");

  const first = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(first), true);
  first.close();
  await assert.doesNotReject(() => fs.access(path.join(outside, "keep.txt")));

  await fs.unlink(artifactParent);
  await fs.mkdir(artifactParent, { recursive: true });
  const second = await openDb(dataDir);
  assert.equal(isAgentFileCleanupPending(second), false);
  second.close();
});

test("v19 通过破坏性重建收敛到目标 schema", () => {
  const db = createDb();
  insertWorkspace(db);
  insertSession(db);
  insertMessage(db, { id: "message-v19", originSessionId: "session-a", type: "assistant", status: "completed" });
  db.prepare(`insert into agent_message_part (id,message_id,position,type,text,updated_revision,created_at,updated_at)
    values ('part-v19','message-v19',0,'reasoning','summary',7,10,11)`).run();
  db.prepare("update agent_schema_meta set version = 19, file_cleanup_pending = 1 where id = 1").run();
  db.exec("alter table agent_run drop column ui_locale");
  db.exec("alter table agent_message_part drop column provider_replay_json");
  db.exec("alter table session_run_state drop column last_response_total_tokens");

  const first = initSchema(db);
  assert.equal(first.fileCleanupPending, true);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  assert.equal((db.prepare("select count(*) as count from agent_message").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_message_part").get() as { count: number }).count, 0);
  const second = initSchema(db);
  assert.equal(second.fileCleanupPending, true);
  db.close();
});

test("v20 通过破坏性重建收敛到目标 schema", () => {
  const db = createDb();
  insertWorkspace(db);
  insertSession(db);
  db.prepare(`insert into session_run_state (workspace_id, session_id, status, run_notice_text, retry_count, updated_at)
    values ('ws-a', 'session-a', 'idle', 'preserved', 2, 9)`).run();
  db.prepare("update agent_schema_meta set version = 20 where id = 1").run();
  db.exec("alter table agent_run drop column ui_locale");
  db.exec("alter table session_run_state drop column last_response_total_tokens");

  initSchema(db);

  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  assert.equal((db.prepare("select count(*) as count from agent_session").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from session_run_state").get() as { count: number }).count, 0);
  db.close();
});

test("v21 通过破坏性重建收敛到目标 schema", () => {
  const db = createDb();
  insertWorkspace(db);
  insertSession(db);
  db.prepare(`insert into agent_run (run_id, workspace_id, session_id, trigger_message_id, agent_id, provider_id, ui_locale, model_id, subtask_depth, parent_run_id, parent_tool_execution_id, status, created_at, updated_at, run_kind)
    values ('run-v21', 'ws-a', 'session-a', null, 'agent', 'provider', 'zh-CN', 'model', 0, null, null, 'running', 10, 11, 'user')`).run();
  db.prepare("update agent_schema_meta set version = 21 where id = 1").run();
  db.exec("alter table agent_run drop column ui_locale");

  initSchema(db);

  assert.equal((db.prepare("select count(*) as count from agent_run").get() as { count: number }).count, 0);
  assert.equal(isAgentFileCleanupPending(db), true);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  db.close();
});

test("agent_run run_kind 在目标 schema 升级时保留数据并回填 user", () => {
  const db = createDb();
  db.prepare("update agent_schema_meta set version = 18 where id = 1").run();
  db.exec("alter table agent_run drop column ui_locale");
  db.exec("alter table agent_run drop column run_kind");
  db.exec("alter table agent_message_part drop column provider_replay_json");
  db.exec("alter table session_run_state drop column last_response_total_tokens");
  initSchema(db);
  const columns = db.prepare("pragma table_info(agent_run)").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "run_kind"));
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
});

test("v22 通过破坏性重建收敛到目标 schema 并保留非 Agent 数据", () => {
  const db = createDb();
  db.exec("create table schema_v22_sentinel (id integer primary key, value text not null);");
  db.prepare("insert into schema_v22_sentinel values (1, 'keep')").run();
  insertWorkspace(db); insertSession(db);
  insertMessage(db, { id: "message-v22", originSessionId: "session-a", type: "assistant", status: "completed" });
  db.prepare("update agent_schema_meta set version = 22, file_cleanup_pending = 1 where id = 1").run();

  const result = initSchema(db);

  assert.equal(result.fileCleanupPending, true);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  assert.equal((db.prepare("select count(*) as count from agent_message").get() as { count: number }).count, 0);
  assert.deepEqual(db.prepare("select * from schema_v22_sentinel").all(), [{ id: 1, value: "keep" }]);
  db.close();
});

test("v18 Message 数据图通过破坏性重建并保留 file cleanup pending", () => {
  const db = createDb();
  insertWorkspace(db);
  insertSession(db);
  db.prepare(`insert into agent_run (run_id, workspace_id, session_id, trigger_message_id, agent_id, provider_id, model_id, subtask_depth, parent_run_id, parent_tool_execution_id, status, created_at, updated_at, run_kind)
    values ('run-v18', 'ws-a', 'session-a', null, 'agent', 'provider', 'model', null, null, null, 'running', 10, 11, 'user')`).run();
  insertMessage(db, { id: "user-v18", originSessionId: "session-a", originRunId: "run-v18", type: "user", status: "completed", depth: 0 });
  insertMessage(db, { id: "assistant-v18", previousMessageId: "user-v18", originSessionId: "session-a", originRunId: "run-v18", type: "assistant", status: "completed", depth: 1 });
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('text-v18', 'user-v18', 0, 'text', 'input', 4, 10, 11)`).run();
  db.prepare(`insert into agent_message_part (id, message_id, position, type, tool_name, tool_input_json, updated_revision, created_at, updated_at)
    values ('call-v18', 'assistant-v18', 0, 'tool_call', 'bash', '{}', 5, 12, 13)`).run();
  db.prepare(`insert into agent_tool_execution (id, call_part_id, origin_session_id, origin_run_id, status, result_preview, result_truncated, updated_revision, created_at, updated_at)
    values ('execution-v18', 'call-v18', 'session-a', 'run-v18', 'completed', 'done', 0, 6, 14, 15)`).run();
  db.prepare(`update agent_session set head_message_id = 'assistant-v18', context_root_message_id = 'user-v18', revision = 6, updated_at = 16 where id = 'session-a'`).run();
  db.prepare(`insert into session_run_state (workspace_id, session_id, status, active_run_id, run_notice_text, retry_count, next_retry_at, active_assistant_message_id, non_terminal_message_ids_json, non_terminal_tool_execution_ids_json, updated_at)
    values ('ws-a', 'session-a', 'running', 'run-v18', 'recovering', 2, 99, null, '[]', '[]', 17)`).run();
  db.prepare("update agent_schema_meta set version = 18, file_cleanup_pending = 1 where id = 1").run();
  db.exec("alter table agent_run drop column ui_locale");
  db.exec("alter table agent_run drop column run_kind");
  db.exec("alter table agent_message_part drop column provider_replay_json");
  db.exec("alter table session_run_state drop column last_response_total_tokens");

  initSchema(db);

  assert.equal((db.prepare("select count(*) as count from agent_run").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_message").get() as { count: number }).count, 0);
  assert.equal(isAgentFileCleanupPending(db), true);
  assert.equal((db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
  db.close();
});
