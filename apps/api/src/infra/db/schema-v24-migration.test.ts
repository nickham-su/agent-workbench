import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { AGENT_SCHEMA_VERSION, assertAgentSchemaSupported, initSchema } from "./schema.js";
import { openDb } from "./db.js";
import { dbPath, workspaceAgentArtifactsRoot, workspaceRoot } from "../fs/paths.js";

// Released v24 is v23 plus visibility, not today's schema with an older version label.
const releasedV23 = readFileSync(new URL("./fixtures/agent-schema-v23.sql", import.meta.url), "utf8");
const visibility = "visibility text not null default 'listed' check (visibility in ('listed', 'unlisted'))";
function v24(filename = ":memory:", freshVisibility = false, pending = 0) {
  const ddl = freshVisibility ? releasedV23.replace(/CREATE TABLE agent_session \([\s\S]*?\n    \);/, (sql) =>
    sql.replace("updated_at integer not null,", `updated_at integer not null,\n      ${visibility},`)) : releasedV23;
  const db = new Database(filename);
  db.pragma("foreign_keys=ON"); db.exec(ddl);
  if (!freshVisibility) db.exec(`alter table agent_session add column ${visibility}`);
  db.prepare("update agent_schema_meta set version=24,file_cleanup_pending=?").run(pending);
  db.exec(`
    insert into workspaces(id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/fixture/ws',1,1);
    insert into agent_session(id,workspace_id,title,kind,visibility,created_at,updated_at) values ('session','ws','History','primary','unlisted',1,1);
    insert into workspace_session_tab_state values ('ws','session',0,7);
    insert into agent_message(id,workspace_id,depth,type,status,origin_session_id,updated_revision,created_at,updated_at)
      values ('user','ws',0,'user','completed','session',1,2,2);
    insert into agent_message_part(id,message_id,position,type,text,updated_revision,created_at,updated_at)
      values ('text','user',0,'text','preserved history',1,2,2);
    insert into agent_run(run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at)
      values ('run','ws','session','user','agent','provider','model','running',3,3);
    insert into session_run_state(workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,updated_at,last_response_total_tokens)
      values ('ws','session','running','run','retrying',2,99,3,123);
    update agent_session set head_message_id='user',context_root_message_id='user',revision=1 where id='session';
    insert into agent_archived_text_fts(rowid,text,message_depth,part_position) values (1,'preserved history',0,0);
    insert into agent_text_part_fts_map values ('text',1,2);
  `);
  return db;
}
function history(db: Database.Database) {
  return ["agent_session", "workspace_session_tab_state", "agent_message", "agent_message_part", "agent_run", "session_run_state", "agent_archived_text_fts", "agent_text_part_fts_map"]
    .map((table) => ({ table, rows: (db.prepare(`select * from ${table} order by rowid`).all() as Record<string, unknown>[])
      .map(({ model_request_error_json: _newField, ...row }) => row) }));
}

for (const freshVisibility of [false, true]) for (const pending of [0, 1]) test(`v24 diagnostics migration preserves history, visibility, run state and cleanup marker (${freshVisibility ? "CREATE" : "ALTER"}, pending=${pending})`, () => {
  const db = v24(":memory:", freshVisibility, pending);
  try {
    const before = history(db);
    assert.doesNotThrow(() => assertAgentSchemaSupported(db));
    assert.deepEqual(initSchema(db), { fileCleanupPending: pending === 1 });
    assert.deepEqual(history(db), before);
    assert.deepEqual(db.prepare("select model_request_error_json from session_run_state").get(), { model_request_error_json: null });
    assert.deepEqual(db.prepare("select version,file_cleanup_pending from agent_schema_meta").get(), { version: AGENT_SCHEMA_VERSION, file_cleanup_pending: pending });
    assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
    const diagnostic = JSON.stringify({ statusCode: 503, responseBody: "retained diagnostic", message: "HTTP 503", truncated: false });
    db.prepare("update session_run_state set model_request_error_json=?").run(diagnostic);
    initSchema(db);
    assert.deepEqual(history(db), before);
    assert.deepEqual(db.prepare("select model_request_error_json from session_run_state").get(), { model_request_error_json: diagnostic });
  } finally { db.close(); }
});

for (const phase of ["alter", "version"] as const) test(`v24 migration rolls back all schema and data changes after ${phase} failure`, () => {
  const db = v24(), before = history(db);
  const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
  let fired = false;
  try {
    if (phase === "alter") db.exec = ((sql: string) => {
      const result = exec(sql);
      if (/alter table session_run_state add column/i.test(sql)) { fired = true; throw new Error("injected diagnostic migration failure"); }
      return result;
    }) as typeof db.exec;
    else db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("update agent_schema_meta set version =")) {
        const run = statement.run.bind(statement);
        statement.run = ((...args: unknown[]) => { run(...args); fired = true; throw new Error("injected diagnostic migration failure"); }) as typeof statement.run;
      }
      return statement;
    }) as typeof db.prepare;
    assert.throws(() => initSchema(db), /injected diagnostic/); assert.equal(fired, true);
    db.exec = exec; db.prepare = prepare;
    assert.deepEqual(history(db), before);
    assert.deepEqual(db.prepare("select version from agent_schema_meta").get(), { version: 24 });
    assert.equal((db.prepare("pragma table_info(session_run_state)").all() as { name: string }[]).some((c) => c.name === "model_request_error_json"), false);
    assert.doesNotThrow(() => initSchema(db));
  } finally { db.exec = exec; db.prepare = prepare; db.close(); }
});

test("v25 canonical validation rejects a version-only upgrade and damaged diagnostic column without rebuilding", () => {
  for (const damagedColumn of [false, true]) {
    const db = v24();
    try {
      if (damagedColumn) db.exec("alter table session_run_state add column model_request_error_json integer");
      db.exec(`update agent_schema_meta set version=${AGENT_SCHEMA_VERSION}`);
      const before = history(db);
      assert.throws(() => assertAgentSchemaSupported(db), /Unsupported Agent schema/);
      assert.throws(() => initSchema(db), /Unsupported Agent schema/);
      assert.deepEqual(history(db), before);
    } finally { db.close(); }
  }
});

test("real openDb v24 upgrade leaves artifact files and database history intact", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "model-error-v24-"));
  try {
    const old = v24(dbPath(directory)), before = history(old); old.close();
    const artifacts = workspaceAgentArtifactsRoot(workspaceRoot(directory, "ws")); mkdirSync(artifacts, { recursive: true });
    const file = path.join(artifacts, "fixture.txt"); writeFileSync(file, "existing artifact");
    const db = await openDb(directory);
    try { assert.deepEqual(history(db), before); assert.equal(readFileSync(file, "utf8"), "existing artifact"); }
    finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
