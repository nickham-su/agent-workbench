import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import Database from "better-sqlite3";
import { assertAgentSchemaSupported, initSchema, AGENT_SCHEMA_VERSION, canonicalAgentSql } from "./schema.js";
import { openDb } from "./db.js";
import { createMessageSession } from "../../modules/agent/agent-message.store.js";
import { dbPath, workspaceRoot, workspaceAgentArtifactsRoot } from "../fs/paths.js";

// A frozen released schema, not a current database with its version changed.
const v23Ddl = readFileSync(new URL("./fixtures/agent-schema-v23.sql", import.meta.url), "utf8");
function v23(filename = ":memory:", pending = 0, ddl = v23Ddl) {
  const db = new Database(filename); db.pragma("foreign_keys=ON"); db.exec(ddl);
  db.prepare("update agent_schema_meta set file_cleanup_pending=? where id=1").run(pending);
  for (const id of ["a", "b"]) db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values (?,?,?,?,10,10)").run(id, id, id, `/fixture/${id}`);
  for (const [id, workspaceId, kind] of [["p-default", "a", "primary"], ["p-closed", "a", "primary"], ["p-meaningless", "a", "primary"],
    ["s-default", "a", "subtask"], ["s-open", "a", "subtask"], ["s-meaningless", "a", "subtask"], ["p-b", "b", "primary"]]) {
    db.prepare("insert into agent_session(id,workspace_id,title,kind,created_at,updated_at) values (?,?,?,?,10,10)").run(id, workspaceId, id, kind);
    db.prepare("insert into session_run_state(workspace_id,session_id,status,updated_at) values (?,?,'idle',10)").run(workspaceId, id);
  }
  db.exec(`insert into workspace_session_tab_state values
    ('a','p-closed',0,91),('a','p-meaningless',1,92),('a','s-open',1,93),('a','s-meaningless',0,94),('a','orphan',0,95),('a','p-b',0,96);
    insert into agent_message(id,workspace_id,depth,type,status,origin_session_id,updated_revision,created_at,updated_at)
      values ('user','a',0,'user','completed','p-default',1,11,11);
    insert into agent_message(id,workspace_id,previous_message_id,depth,type,status,origin_session_id,updated_revision,created_at,updated_at)
      values ('assistant','a','user',1,'assistant','completed','p-default',2,12,12);
    insert into agent_message(id,workspace_id,previous_message_id,retained_from_message_id,depth,type,status,origin_session_id,updated_revision,created_at,updated_at)
      values ('summary','a','assistant','user',2,'compaction','completed','p-default',3,13,13);
    update agent_session set head_message_id='summary',context_root_message_id='summary',revision=3 where id='p-default';
    update agent_session set head_message_id='summary',context_root_message_id='summary',forked_from_session_id='p-default',forked_from_message_id='summary' where id='p-closed';
    insert into agent_attachment(id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values ('image','a','fixture-image','fixture.png','image/png',1,11);
    insert into agent_message_part(id,message_id,position,type,text,updated_revision,created_at,updated_at) values ('text','user',0,'text','fixture text',1,11,11);
    insert into agent_message_part(id,message_id,position,type,attachment_id,media_type,filename,updated_revision,created_at,updated_at) values ('image-part','user',1,'image','image','image/png','fixture.png',1,11,11);
    insert into agent_message_part(id,message_id,position,type,tool_name,tool_input_json,updated_revision,created_at,updated_at) values ('call','assistant',0,'tool_call','read','{}',2,12,12);
    insert into agent_message_part(id,message_id,position,type,text,updated_revision,created_at,updated_at) values ('summary-text','summary',0,'text','fixture summary',3,13,13);
    insert into agent_run(run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('run','a','p-default','user','agent','provider','model','running',11,13);
    insert into agent_tool_execution(id,call_part_id,origin_session_id,origin_run_id,status,updated_revision,created_at,updated_at) values ('tool','call','p-default','run','queued',2,12,12);
    insert into agent_client_request values ('a','p-default','request','user','run',11);
    update session_run_state set status='running',active_run_id='run',non_terminal_tool_execution_ids_json='["tool"]' where session_id='p-default';
    insert into agent_archived_text_fts(rowid,text,message_depth,part_position) values (1,'fixture text',0,0);
    insert into agent_text_part_fts_map values ('text',1,11);
    insert into scheduled_agent_task(id,workspace_id,name,enabled,trigger_mode,prompt,agent_id,schedule_json,created_at,updated_at) values ('task','a','fixture',0,'new_session','fixture','agent','{}',10,10);`);
  const snapshot = JSON.stringify({ taskName: "fixture", triggerMode: "new_session", prompt: "fixture", agentId: "agent", sourceSessionId: null, sourceMessageId: null });
  db.prepare(`insert into scheduled_agent_execution(id,task_id,trigger_type,status,task_snapshot_json,client_request_id,session_id,run_id,created_at,updated_at,started_at)
    values ('execution','task','manual','running',?,'request','p-default','run',11,13,11)`).run(snapshot);
  return db;
}
function businessData(db: Database.Database) {
  const tables = ["workspaces", "agent_session", "agent_attachment", "agent_message", "agent_message_part", "agent_run", "agent_tool_execution",
    "agent_client_request", "session_run_state", "agent_archived_text_fts", "agent_text_part_fts_map", "scheduled_agent_task", "scheduled_agent_execution"];
  return tables.map((table) => ({ table, rows: (db.prepare(`select * from ${table} order by rowid`).all() as Record<string, unknown>[])
    .map(({ visibility: _visibility, model_request_error_json: _modelRequestError, interactive_queue_enabled: _interactiveQueue, ...row }) => row) }));
}
function actualStates(db: Database.Database) {
  return db.prepare("select workspace_id as workspaceId, session_id as sessionId, visible, updated_at as updatedAt from workspace_session_tab_state order by workspace_id,session_id").all();
}
const expectedStates = [
  { workspaceId: "a", sessionId: "p-closed", visible: 0, updatedAt: 91 },
  { workspaceId: "a", sessionId: "p-default", visible: 1, updatedAt: 10 },
  { workspaceId: "a", sessionId: "p-meaningless", visible: 1, updatedAt: 10 },
  { workspaceId: "a", sessionId: "s-default", visible: 0, updatedAt: 10 },
  { workspaceId: "a", sessionId: "s-meaningless", visible: 0, updatedAt: 10 },
  { workspaceId: "a", sessionId: "s-open", visible: 1, updatedAt: 93 },
  { workspaceId: "b", sessionId: "p-b", visible: 1, updatedAt: 10 }
];

for (const pending of [0, 1]) test(`v23 incremental migration preserves history, run/task identity and pending=${pending}`, () => {
  const db = v23(":memory:", pending);
  try {
    const before = businessData(db);
    assert.doesNotThrow(() => assertAgentSchemaSupported(db));
    assert.deepEqual(initSchema(db), { fileCleanupPending: pending === 1 });
    assert.deepEqual(businessData(db), before);
    assert.deepEqual(actualStates(db), expectedStates);
    assert.deepEqual(db.prepare("select version,file_cleanup_pending as pending from agent_schema_meta").get(), { version: AGENT_SCHEMA_VERSION, pending });
    assert.equal((db.prepare("select count(*) n from agent_session where visibility <> 'listed'").get() as {n:number}).n, 0);
    assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
    db.exec("update workspace_session_tab_state set visible=1 where session_id='s-default'");
    const states = actualStates(db); initSchema(db);
    assert.deepEqual(actualStates(db), states, "a second startup cannot reinitialize user state");
  } finally { db.close(); }
});

test("fresh and upgraded v24 have identical physical columns/constraints and reopen as current without migration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "v24-reopen-"));
  try {
    const freshFile = path.join(directory, "fresh.sqlite"), upgradedFile = path.join(directory, "upgraded.sqlite");
    const fresh = new Database(freshFile), upgraded = v23(upgradedFile);
    initSchema(fresh); initSchema(upgraded);
    assert.deepEqual(fresh.prepare("pragma table_info(agent_session)").all(), upgraded.prepare("pragma table_info(agent_session)").all());
    for (const db of [fresh, upgraded]) {
      const columns = db.prepare("pragma table_info(agent_session)").all() as {name:string}[];
      assert.deepEqual(columns.slice(-2).map((c) => c.name), ["updated_at", "visibility"]);
      assert.doesNotThrow(() => assertAgentSchemaSupported(db));
      db.exec("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values ('probe','probe','probe','/fixture/probe',1,1)");
      createMessageSession(db, { id: "probe", workspaceId: "probe", title: "probe", kind: "primary", createdAt: 1 });
      assert.deepEqual(db.prepare("select visibility from agent_session where id='probe'").get(), { visibility: "listed" });
      assert.throws(() => db.prepare("update agent_session set visibility=null where id='probe'").run(), /NOT NULL/);
      assert.throws(() => db.prepare("update agent_session set visibility='invalid' where id='probe'").run(), /CHECK/);
      db.prepare("update agent_session set visibility='unlisted' where id='probe'").run();
      db.close();
    }
    for (const file of [freshFile, upgradedFile]) {
      const db = new Database(file);
      try {
        const before = actualStates(db); const exec = db.exec.bind(db);
        db.exec = ((sql: string) => {
          assert.doesNotMatch(sql, /alter table agent_session|delete from workspace_session_tab_state|drop table/i);
          return exec(sql);
        }) as typeof db.exec;
        assert.doesNotThrow(() => assertAgentSchemaSupported(db)); initSchema(db); initSchema(db);
        assert.deepEqual(actualStates(db), before);
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const phase of ["alter", "clear", "backfill", "validate", "version"] as const) test(`migration failure at ${phase} rolls back DDL/data/version and remains a reopenable v23`, () => {
  const db = v23(":memory:", 1);
  const before = businessData(db), states = actualStates(db);
  const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
  let migrated = false, fired = false;
  try {
    db.exec = ((sql: string) => {
      const result = exec(sql);
      if (/alter table agent_session add column visibility/i.test(sql)) {
        migrated = true;
        if (phase === "alter") { fired = true; throw new Error("injected migration failure"); }
      }
      if (migrated && phase === "clear" && sql === "delete from workspace_session_tab_state") { fired = true; throw new Error("injected migration failure"); }
      return result;
    }) as typeof db.exec;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if ((phase === "backfill" && /^insert into workspace_session_tab_state \(workspace_id, session_id, visible, updated_at\)/.test(sql))
        || (phase === "version" && sql.startsWith("update agent_schema_meta set version ="))) {
        const run = statement.run.bind(statement);
        statement.run = ((...args: unknown[]) => { const result = run(...args); if (migrated) { fired = true; throw new Error("injected migration failure"); } return result; }) as typeof statement.run;
      }
      if (phase === "validate" && sql === "pragma foreign_key_check(workspace_session_tab_state)") {
        statement.all = (() => { fired = true; return [{ invalid: 1 }]; }) as typeof statement.all;
      }
      return statement;
    }) as typeof db.prepare;
    assert.throws(() => initSchema(db)); assert.equal(fired, true);
    db.exec = exec; db.prepare = prepare;
    assert.deepEqual(businessData(db), before); assert.deepEqual(actualStates(db), states);
    assert.deepEqual(db.prepare("select version,file_cleanup_pending as pending from agent_schema_meta").get(), { version: 23, pending: 1 });
    assert.equal((db.prepare("pragma table_info(agent_session)").all() as {name:string}[]).some((c) => c.name === "visibility"), false);
    assert.doesNotThrow(() => assertAgentSchemaSupported(db)); assert.doesNotThrow(() => initSchema(db));
  } finally { db.exec = exec; db.prepare = prepare; db.close(); }
});

test("malformed v23 source and v24 visibility constraints fail closed rather than rebuilding history", () => {
  const damaged = new Database(":memory:");
  try {
    damaged.exec(v23Ddl.replace("title_manually_set integer not null default 0 check (title_manually_set in (0, 1)),", ""));
    assert.throws(() => initSchema(damaged), /Unsupported Agent schema/);
    assert.deepEqual(damaged.prepare("select version from agent_schema_meta").get(), { version: 23 });
  } finally { damaged.close(); }
  for (const ddl of [
    "visibility text default 'listed' check (visibility in ('listed','unlisted'))",
    "visibility text not null check (visibility in ('listed','unlisted'))",
    "visibility text not null default 'listed'",
    "visibility text not null default 'listed' check (visibility in ('listed','unlisted') or 1=1) /* check (visibility in ('listed','unlisted')) */"
  ]) {
    const db = new Database(":memory:"); db.exec(v23Ddl);
    try {
      db.exec(`alter table agent_session add column ${ddl}`); db.exec("update agent_schema_meta set version=24");
      const before = businessData(db);
      assert.throws(() => initSchema(db), /Unsupported Agent schema/); assert.deepEqual(businessData(db), before);
    } finally { db.close(); }
  }
});

// H1: mutate actual released DDL, leaving otherwise valid rows and all column names intact.
// Both public preflight and the write-locked initializer must reject without changing any table.
const releasedDefinitions = (() => {
  const db = new Database(":memory:");
  try {
    db.exec(v23Ddl);
    return new Map((db.prepare("select name, sql from sqlite_master where sql is not null").all() as Array<{ name: string; sql: string }>)
      .map((row) => [row.name, row.sql]));
  } finally { db.close(); }
})();

type FrozenSchemaDamage = { name: string; object: string; from: string; to: string; invalidKind?: boolean; installAfterSeed?: boolean };
const frozenSchemaDamage: FrozenSchemaDamage[] = [
  { name: "Session kind CHECK missing", object: "agent_session", from: " check (kind in ('primary', 'subtask'))", to: "" },
  { name: "Session Workspace FK missing", object: "agent_session", from: "foreign key (workspace_id) references workspaces(id) on delete restrict,", to: "" },
  { name: "Session title NOT NULL missing", object: "agent_session", from: "title text not null", to: "title text" },
  { name: "Session kind CHECK missing with invalid kind row", object: "agent_session", from: " check (kind in ('primary', 'subtask'))", to: "", invalidKind: true },
  { name: "Session column type changed", object: "agent_session", from: "title text not null", to: "title blob not null" },
  { name: "Session revision default changed", object: "agent_session", from: "revision integer not null default 0", to: "revision integer not null default 1" },
  { name: "Session kind CHECK bypassed with OR and original comment", object: "agent_session", from: "check (kind in ('primary', 'subtask'))", to: "check (kind in ('primary', 'subtask') or 1=1) /* check (kind in ('primary', 'subtask')) */" },
  { name: "Session boolean CHECK weakened", object: "agent_session", from: "check (title_manually_set in (0, 1))", to: "check (title_manually_set in (0, 1, 2))" },
  { name: "meta primary key missing", object: "agent_schema_meta", from: "id integer primary key", to: "id integer" },
  { name: "meta pending NOT NULL missing", object: "agent_schema_meta", from: "file_cleanup_pending integer not null", to: "file_cleanup_pending integer" },
  { name: "meta pending default changed", object: "agent_schema_meta", from: "file_cleanup_pending integer not null default 0", to: "file_cleanup_pending integer not null default 1" },
  { name: "override composite PK order changed", object: "agent_session_agent_model_override", from: "primary key (session_id, agent_id)", to: "primary key (agent_id, session_id)" },
  { name: "attachment unique constraint missing", object: "agent_attachment", from: "unique (workspace_id, storage_key),", to: "" },
  { name: "attachment FK delete action changed", object: "agent_attachment", from: "on delete restrict", to: "on delete cascade" },
  { name: "message CHECK bypassed with OR and original comment", object: "agent_message", from: "check (type = 'compaction' or retained_from_message_id is null)", to: "check ((type = 'compaction' or retained_from_message_id is null) or 1=1) /* check (type = 'compaction' or retained_from_message_id is null) */" },
  { name: "Run partial arbiter index no longer unique", object: "idx_agent_run_parent_tool_execution_unique", from: "CREATE UNIQUE INDEX", to: "CREATE INDEX" },
  { name: "Run partial arbiter predicate disabled", object: "idx_agent_run_parent_tool_execution_unique", from: "where parent_run_id is not null and parent_tool_execution_id is not null", to: "where parent_run_id is not null and parent_tool_execution_id is not null and 0" },
  { name: "Session key index direction changed", object: "idx_agent_session_workspace_updated", from: "updated_at desc", to: "updated_at asc" },
  { name: "Session key index missing", object: "idx_agent_session_workspace_updated", from: "CREATE INDEX idx_agent_session_workspace_updated on agent_session(workspace_id, updated_at desc)", to: "" },
  { name: "retained index predicate weakened", object: "idx_agent_message_retained_from", from: "where retained_from_message_id is not null", to: "where retained_from_message_id is not null and 0" },
  { name: "message trigger keeps old fragments but no longer aborts", object: "agent_message_previous_workspace_insert", from: "select raise(abort, 'agent_message.previous_message_id must reference the same workspace');", to: "select 1;" },
  { name: "message trigger comment masks removed Workspace condition", object: "agent_message_previous_workspace_insert", from: "and workspace_id = new.workspace_id", to: "/* and workspace_id = new.workspace_id */" },
  { name: "trigger token collision merges IS NOT NULL into identifier", object: "agent_message_previous_workspace_insert", from: "new.previous_message_id is not null", to: "new.previous_message_idisnotnull", installAfterSeed: true },
  { name: "trigger token collision merges AND into identifier", object: "agent_message_previous_workspace_insert", from: "new.previous_message_id and workspace_id", to: "new.previous_message_idandworkspace_id", installAfterSeed: true },
  { name: "trigger literal changed without changing case-insensitive SQL", object: "agent_message_previous_workspace_insert", from: "agent_message.previous_message_id must reference the same workspace", to: "AGENT_MESSAGE.previous_message_id must reference the same workspace" },
  { name: "Tab updated_at NOT NULL missing", object: "workspace_session_tab_state", from: "updated_at integer not null", to: "updated_at integer" },
  { name: "Tab column type changed", object: "workspace_session_tab_state", from: "updated_at integer not null", to: "updated_at text not null" },
  { name: "FTS unindexed column semantics changed", object: "agent_archived_text_fts", from: "message_depth unindexed", to: "message_depth" }
];

function allSchemaAndData(db: Database.Database) {
  const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>;
  return {
    schema: db.prepare("select type,name,tbl_name,sql from sqlite_master order by type,name").all(),
    schemaVersion: db.pragma("schema_version", { simple: true }),
    tables: tables.map(({ name }) => ({ name, rows: db.prepare(`select * from "${name.replaceAll('"', '""')}"`).all() }))
  };
}

for (const target of ["v23", "fresh-v24", "upgraded-v24"] as const) {
  for (const damage of frozenSchemaDamage) {
    for (const entry of ["preflight", "init"] as const) {
      test(`H1 ${target} ${entry}: rejects ${damage.name} without writes`, () => {
        const original = releasedDefinitions.get(damage.object)!;
        assert.ok(original.includes(damage.from), "damage must change the frozen definition");
        const damagedDefinition = original.replace(damage.from, damage.to);
        // Broken trigger references must be installed after valid historical rows
        // are seeded; otherwise fixture INSERT fails before either validator runs.
        let ddl = v23Ddl.replace(original, damage.installAfterSeed ? "" : damagedDefinition);
        assert.notEqual(ddl, v23Ddl);
        if (target === "fresh-v24") ddl = ddl.replace(/CREATE TABLE agent_session \([\s\S]*?\n    \);/, (sessionDdl) =>
          sessionDdl.replace("updated_at integer not null,", "updated_at integer not null,\n      visibility text not null default 'listed' check (visibility in ('listed', 'unlisted')),"));
        for (const pending of [0, 1]) {
          const db = v23(":memory:", pending, ddl);
          try {
            if (damage.installAfterSeed) db.exec(damagedDefinition);
            if (target === "upgraded-v24") db.exec("alter table agent_session add column visibility text not null default 'listed' check (visibility in ('listed', 'unlisted'))");
            if (target !== "v23") db.exec("update agent_schema_meta set version=24");
            if (damage.invalidKind) db.exec("update agent_session set kind='invalid-kind' where id='p-default'");
            const before = allSchemaAndData(db);
            assert.throws(() => entry === "preflight" ? assertAgentSchemaSupported(db) : initSchema(db), /Unsupported Agent schema/);
            assert.deepEqual(allSchemaAndData(db), before, `pending=${pending}: no DDL, Tab, probe or business-data residue`);
          } finally { db.close(); }
        }
      });
    }
  }
}

test("H1b lexical comparison accepts ASCII keyword case and safe whitespace at token boundaries", () => {
  assert.equal(canonicalAgentSql("when new.previous_message_id is not null"), canonicalAgentSql("WHEN\tNEW . previous_message_id\nIS\r\nNOT\fNULL"));
  assert.equal(canonicalAgentSql("check (revision>=0)"), canonicalAgentSql("CHECK\n( revision >= 0 )"));
});

test("H1b lexical comparison distinguishes merged/split identifiers, keywords and operators", () => {
  for (const [left, right] of [
    ["new.previous_message_id is not null", "new.previous_message_idisnotnull"],
    ["new.previous_message_id and workspace_id", "new.previous_message_idandworkspace_id"],
    ["column_name", "column_ name"], ["a >= b", "a > = b"], ["a || b", "a | | b"], ["a ->> b", "a -> > b"], ["a << b", "a < < b"], ["a >> b", "a > > b"]
  ]) assert.notEqual(canonicalAgentSql(left), canonicalAgentSql(right));
});

test("H1b single-quoted literals preserve whitespace, case, backslashes and doubled-quote escapes", () => {
  for (const [left, right] of [["'a b'", "'ab'"], ["'A'", "'a'"], ["'it''s a b'", "'it''s ab'"], ["'a\\b'", "'a b'"]])
    assert.notEqual(canonicalAgentSql(left), canonicalAgentSql(right));
  assert.equal(canonicalAgentSql("CHECK (x = 'it''s a b')"), canonicalAgentSql("check( x='it''s a b' )"));
});

test("H1b double-quoted identifiers preserve internal whitespace, case and escaped double quotes", () => {
  for (const [left, right] of [['"a b"', '"ab"'], ['"A"', '"a"'], ['"a"" b"', '"a""b"']])
    assert.notEqual(canonicalAgentSql(left), canonicalAgentSql(right));
  assert.equal(canonicalAgentSql('NEW."a"" b" IS NULL'), canonicalAgentSql('new . "a"" b"\n is null'));
});

test("H1b backtick identifiers preserve internal whitespace and doubled-backtick escapes", () => {
  assert.notEqual(canonicalAgentSql("`a b`"), canonicalAgentSql("`ab`"));
  assert.notEqual(canonicalAgentSql("`a`` b`"), canonicalAgentSql("`a``b`"));
  assert.equal(canonicalAgentSql("NEW.`a`` b` IS NULL"), canonicalAgentSql("new . `a`` b` is null"));
});

test("H1b bracket identifiers preserve bytes rather than deleting identifier whitespace", () => {
  assert.notEqual(canonicalAgentSql("[a b]"), canonicalAgentSql("[ab]"));
  assert.notEqual(canonicalAgentSql("[A]"), canonicalAgentSql("[a]"));
  assert.equal(canonicalAgentSql("NEW.[a b] IS NULL"), canonicalAgentSql("new . [a b] is null"));
});

test("H1b comments retain bytes and line boundaries instead of disguising SQL tokens", () => {
  for (const [left, right] of [
    ["a--comment\n+b", "a--comment+b"], ["a/* b c */+d", "a/*bc*/+d"],
    ["a/* gap */b", "ab"], ["a--comment\n+b", "a-comment\n+b"], ["a/* OR 1=1 */", "a"], ["a--comment\rb", "a--comment\r b"]
  ]) assert.notEqual(canonicalAgentSql(left), canonicalAgentSql(right));
});

test("H1b unfinished quotes/comments and unsupported bare tokens fail closed", () => {
  for (const sql of ["'unterminated", '"unterminated', "`unterminated", "[unterminated", "/* unterminated", "[a]]b]", "1abc", "x'00'", "new.Kind", "a\u00a0b"])
    assert.throws(() => canonicalAgentSql(sql), /Unsupported Agent schema/);
});

test("H1b released v23, fresh v24 and ALTER v24 accept keyword case and safe whitespace changes", () => {
  const original = releasedDefinitions.get("agent_message_previous_workspace_insert")!;
  const formatted = original.replace("new.previous_message_id is not null", "NEW\t .\nprevious_message_id\tIS\nNOT\tNULL");
  for (const target of ["v23", "fresh-v24", "upgraded-v24"] as const) {
    let ddl = v23Ddl.replace(original, formatted).replaceAll("CREATE TABLE", "create TABLE");
    if (target === "fresh-v24") ddl = ddl.replace(/create TABLE agent_session \([\s\S]*?\n    \);/, (sessionDdl) =>
      sessionDdl.replace("updated_at integer not null,", "updated_at integer not null,\n      visibility text not null default 'listed' check (visibility in ('listed', 'unlisted')),"));
    const db = v23(":memory:", 1, ddl);
    try {
      if (target === "upgraded-v24") db.exec("alter table agent_session add column visibility text not null default 'listed' check (visibility in ('listed', 'unlisted'))");
      if (target !== "v23") db.exec("update agent_schema_meta set version=24");
      const before = allSchemaAndData(db), business = businessData(db);
      assert.doesNotThrow(() => assertAgentSchemaSupported(db));
      assert.deepEqual(allSchemaAndData(db), before, "successful lexical preflight leaves no probe residue");
      assert.deepEqual(initSchema(db), { fileCleanupPending: true });
      assert.deepEqual(businessData(db), business);
    } finally { db.close(); }
  }
});

test("H1 canonical validation accepts missing optional Analytics indexes without repairing current Tab data", () => {
  for (const target of ["v23", "fresh-v24", "upgraded-v24"] as const) {
    const db = target === "fresh-v24" ? new Database(":memory:") : v23(":memory:", 1);
    try {
      if (target !== "v23") initSchema(db);
      if (target === "fresh-v24") {
        db.exec("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('a','a','a','/fixture/a',1,1)");
        createMessageSession(db, { id: "p-default", workspaceId: "a", title: "Session", kind: "primary", createdAt: 1 });
      }
      db.exec(`drop index idx_agent_session_updated_id; drop index idx_agent_run_updated_run_id;
        drop index idx_agent_message_updated_id; drop index idx_agent_tool_execution_updated_id;`);
      if (target !== "v23") db.exec("delete from workspace_session_tab_state where session_id='p-default'");
      const before = businessData(db), tabs = actualStates(db);
      assert.doesNotThrow(() => assertAgentSchemaSupported(db));
      assert.doesNotThrow(() => initSchema(db));
      assert.deepEqual(businessData(db), before);
      if (target !== "v23") assert.deepEqual(actualStates(db), tabs, "current startup cannot repair or globally gate on missing Tab rows");
    } finally { db.close(); }
  }
});

test("H1 initializer revalidates canonical definitions after a successful external preflight", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "h1-revalidate-"));
  const file = path.join(directory, "source.sqlite");
  const db = v23(file, 1), writer = new Database(file);
  try {
    assert.doesNotThrow(() => assertAgentSchemaSupported(db));
    writer.exec("drop index idx_agent_session_workspace_updated");
    const before = allSchemaAndData(db);
    assert.throws(() => initSchema(db), /Unsupported Agent schema/);
    assert.deepEqual(allSchemaAndData(db), before);
    assert.deepEqual(db.prepare("select version,file_cleanup_pending from agent_schema_meta").get(), { version: 23, file_cleanup_pending: 1 });
  } finally { writer.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("version-only upgrades, misplaced visibility columns and damaged v23 FTS fail closed without writes", () => {
  const misplaced = v23Ddl.replace(/CREATE TABLE agent_session \([\s\S]*?\n    \);/, (ddl) =>
    ddl.replace("updated_at integer not null,", "visibility text not null default 'listed' check (visibility in ('listed', 'unlisted')),\n      updated_at integer not null,"));
  assert.notEqual(misplaced, v23Ddl);
  for (const damage of ["version-only", "column-order", "FTS"] as const) {
    const db = v23(":memory:", 0, damage === "column-order" ? misplaced : v23Ddl);
    try {
      if (damage === "FTS") db.exec("drop table agent_archived_text_fts; create virtual table agent_archived_text_fts using fts5(text,message_depth unindexed,part_position unindexed)");
      else db.exec("update agent_schema_meta set version=24");
      if (damage === "column-order") {
        const names = (db.prepare("pragma table_info(agent_session)").all() as { name: string }[]).map((row) => row.name);
        assert.deepEqual(names.slice(-2), ["visibility", "updated_at"]);
        assert.deepEqual(db.prepare("select distinct visibility from agent_session").all(), [{ visibility: "listed" }]);
      }
      const snapshot = () => ({
        schema: db.prepare("select type,name,tbl_name,sql from sqlite_master order by type,name").all(),
        business: businessData(db), tabs: actualStates(db),
        sessions: db.prepare("select * from agent_session order by id").all(),
        meta: db.prepare("select * from agent_schema_meta").all()
      });
      const before = snapshot();
      assert.throws(() => assertAgentSchemaSupported(db), /Unsupported Agent schema/);
      assert.throws(() => initSchema(db), /Unsupported Agent schema/);
      assert.deepEqual(snapshot(), before);
    } finally { db.close(); }
  }
});

test("real openDb v23 upgrade with pending=0 never removes existing Agent artifact files", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "v23-open-"));
  try {
    const old = v23(dbPath(directory)); old.close();
    const artifactDirectory = workspaceAgentArtifactsRoot(workspaceRoot(directory, "a")); mkdirSync(artifactDirectory, { recursive: true });
    const sentinel = path.join(artifactDirectory, "fixture.txt"); writeFileSync(sentinel, "fixture");
    const db = await openDb(directory);
    try { assert.equal(existsSync(sentinel), true); assert.deepEqual(actualStates(db), expectedStates); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("two concurrent SQLite starters upgrade a real v23 once and then both observe v24", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "v23-concurrent-"));
  try {
    const filename = path.join(directory, "database.sqlite"); const old = v23(filename); old.close();
    const schemaUrl = new URL("./schema.ts", import.meta.url).href;
    const start = () => new Promise<void>((resolve, reject) => {
      const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
        (async () => { const { tsImport } = await import('tsx/esm/api');
          const { initSchema } = await tsImport(workerData.schemaUrl, workerData.schemaUrl);
          const Database = require('better-sqlite3'); const db = new Database(workerData.filename);
          db.pragma('busy_timeout=8000'); db.pragma('foreign_keys=ON'); initSchema(db);
          const row=db.prepare('select version from agent_schema_meta').get(); db.close(); parentPort.postMessage(row.version);
        })().catch(error => { throw error; });`, { eval: true, workerData: { filename, schemaUrl } });
      worker.on("message", (version) => { try { assert.equal(version, AGENT_SCHEMA_VERSION); resolve(); } catch (e) { reject(e); } });
      worker.on("error", reject); worker.on("exit", (code) => { if (code !== 0) reject(new Error(`starter exited ${code}`)); });
    });
    await Promise.all([start(), start()]);
    const db = new Database(filename); try { assert.deepEqual(actualStates(db), expectedStates); assert.doesNotThrow(() => initSchema(db)); } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("offline backup and rollback restore the same v23 database and artifact snapshot without relabeling v24", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "v23-deployment-"));
  try {
    const active = path.join(directory, "active"), backup = path.join(directory, "backup"), restored = path.join(directory, "restored");
    mkdirSync(active);
    const old = v23(dbPath(active));
    const expected = businessData(old), states = actualStates(old);
    old.close(); // Offline backup: no writer or WAL is left open while copying.
    const artifactRelative = path.relative(active, path.join(workspaceAgentArtifactsRoot(workspaceRoot(active, "a")), "fixture.txt"));
    mkdirSync(path.dirname(path.join(active, artifactRelative)), { recursive: true });
    writeFileSync(path.join(active, artifactRelative), "before-upgrade fixture");
    cpSync(active, backup, { recursive: true, errorOnExist: true, force: false });

    const upgraded = await openDb(active);
    try {
      assert.deepEqual(upgraded.prepare("select version from agent_schema_meta").get(), { version: AGENT_SCHEMA_VERSION });
      assert.deepEqual(businessData(upgraded), expected);
      createMessageSession(upgraded, { workspaceId: "a", id: "after-upgrade", title: "after upgrade", kind: "primary", visibility: "unlisted", createdAt: 100 });
      writeFileSync(path.join(active, artifactRelative), "after-upgrade fixture");
    } finally { upgraded.close(); }

    // A rollback uses a matching DB+data snapshot, never a version UPDATE or a
    // live overwrite. Restore elsewhere so the test also preserves the failed
    // deployment for diagnosis, just as an operator can do after stopping it.
    cpSync(backup, restored, { recursive: true, errorOnExist: true, force: false });
    const rollback = new Database(dbPath(restored));
    try {
      assert.deepEqual(rollback.prepare("select version from agent_schema_meta").get(), { version: 23 });
      assert.deepEqual(businessData(rollback), expected);
      assert.deepEqual(actualStates(rollback), states);
      assert.equal((rollback.prepare("pragma table_info(agent_session)").all() as { name: string }[]).some((row) => row.name === "visibility"), false);
      assert.equal(readFileSync(path.join(restored, artifactRelative), "utf8"), "before-upgrade fixture");
    } finally { rollback.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
