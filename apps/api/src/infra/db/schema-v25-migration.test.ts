import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { test } from "node:test";
import { AGENT_SCHEMA_VERSION, assertAgentSchemaSupported, initSchema } from "./schema.js";
import { AGENT_QUEUE_DOMAIN_TABLES, ensureAgentQueueIndependentSchema } from "./agent-queue-schema.js";

/** Released structure, not current DDL with a misleading version label. */
const releasedV23 = readFileSync(new URL("./fixtures/agent-schema-v23.sql", import.meta.url), "utf8");
function v25(pending = 0) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(releasedV23);
  db.exec("alter table agent_session add column visibility text not null default 'listed' check (visibility in ('listed', 'unlisted'))");
  db.exec("alter table session_run_state add column model_request_error_json text");
  db.prepare("update agent_schema_meta set version=25,file_cleanup_pending=?").run(pending);
  db.exec(`
    insert into workspaces(id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/fixture/ws',1,1);
    insert into agent_session(id,workspace_id,title,kind,visibility,created_at,updated_at) values ('session','ws','History','primary','unlisted',1,1);
    insert into workspace_session_tab_state values ('ws','session',0,7);
    insert into agent_message(id,workspace_id,depth,type,status,origin_session_id,updated_revision,created_at,updated_at)
      values ('user','ws',0,'user','completed','session',1,2,2);
    insert into agent_message_part(id,message_id,position,type,text,updated_revision,created_at,updated_at)
      values ('part','user',0,'text','preserved v25 history',1,2,2);
    insert into agent_run(run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at)
      values ('run','ws','session','user','agent','provider','model','running',3,3);
    insert into agent_client_request values ('ws','session','request','user','run',3);
    insert into session_run_state(workspace_id,session_id,status,active_run_id,updated_at,model_request_error_json)
      values ('ws','session','running','run',3,'{"message":"preserved"}');
    update agent_session set head_message_id='user',context_root_message_id='user',revision=1 where id='session';
    insert into agent_archived_text_fts(rowid,text,message_depth,part_position) values (17,'archive',0,0);
    insert into agent_text_part_fts_map values ('part',17,2);
  `);
  return db;
}
function history(db: Database.Database) {
  return ["workspaces", "agent_session", "workspace_session_tab_state", "agent_message", "agent_message_part", "agent_run", "agent_client_request", "session_run_state", "agent_archived_text_fts", "agent_text_part_fts_map"].map(table => ({
    table, rows: (db.prepare(`select * from ${table} order by rowid`).all() as Record<string, unknown>[])
      .map(({ interactive_queue_enabled: _added, ...row }) => row)
  }));
}
function schemaSnapshot(db: Database.Database) {
  return db.prepare("select type,name,tbl_name,sql from sqlite_master order by type,name").all();
}

for (const pending of [0, 1]) test(`v25 to v26 preserves history and old-run identity, pending=${pending}`, () => {
  const db = v25(pending);
  try {
    const before = history(db);
    assert.doesNotThrow(() => assertAgentSchemaSupported(db));
    assert.deepEqual(initSchema(db), { fileCleanupPending: pending === 1 });
    assert.equal((db.prepare("select version from agent_schema_meta").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
    assert.deepEqual(history(db), before);
    assert.deepEqual(db.prepare("select interactive_queue_enabled from agent_run").all(), [{ interactive_queue_enabled: 0 }]);
    // Existing runs are not falsely claimed as never-enqueued; S3 owns conservative recovery.
    assert.equal((db.prepare("select count(*) as n from agent_run_runtime_admission").get() as { n: number }).n, 0);
    for (const table of AGENT_QUEUE_DOMAIN_TABLES) assert.equal((db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n, 0);
    const migrated = schemaSnapshot(db);
    initSchema(db);
    assert.deepEqual(schemaSnapshot(db), migrated);
    assert.deepEqual(history(db), before);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

for (const stage of ["ddl", "version"] as const) test(`v25 migration rollback at ${stage} leaves source reopenable`, () => {
  const db = v25();
  const before = schemaSnapshot(db); const data = history(db);
  const exec = db.exec; const prepare = db.prepare;
  try {
    if (stage === "ddl") db.exec = function (sql: string) {
      const result = exec.call(this, sql);
      if (sql.includes("create table agent_session_queue_control")) throw new Error("injected queue DDL failure");
      return result;
    };
    else db.prepare = function (this: Database.Database, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("update agent_schema_meta set version = ?")) {
        const run = statement.run;
        statement.run = function (...args: unknown[]) {
          if (args[0] === 26) throw new Error("injected queue version failure");
          return Reflect.apply(run, this, args);
        };
      }
      return statement;
    } as typeof db.prepare;
    assert.throws(() => initSchema(db), /injected queue/);
    db.exec = exec; db.prepare = prepare;
    assert.deepEqual(schemaSnapshot(db), before); assert.deepEqual(history(db), data);
    assert.doesNotThrow(() => assertAgentSchemaSupported(db));
    assert.doesNotThrow(() => initSchema(db));
  } finally { db.exec = exec; db.prepare = prepare; db.close(); }
});

for (const malformed of ["partial-column", "partial-table", "future", "unknown-object"] as const) test(`v25 rejects ${malformed} without changing data`, () => {
  const db = v25();
  try {
    if (malformed === "partial-column") db.exec("alter table agent_run add column interactive_queue_enabled integer not null default 0 check (interactive_queue_enabled in (0,1))");
    if (malformed === "partial-table") db.exec("create table agent_session_queue_control(session_id text)");
    if (malformed === "future") db.exec("update agent_schema_meta set version=999");
    if (malformed === "unknown-object") db.exec("create table agent_unknown_queue_state(id text)");
    const before = schemaSnapshot(db); const data = history(db);
    assert.throws(() => assertAgentSchemaSupported(db), /Unsupported Agent schema/);
    assert.throws(() => initSchema(db), /Unsupported Agent schema/);
    assert.deepEqual(schemaSnapshot(db), before); assert.deepEqual(history(db), data);
  } finally { db.close(); }
});

test("independent publication/runtime authority survives permitted historical Agent rebuild", () => {
  const db = v25();
  try {
    ensureAgentQueueIndependentSchema(db);
    db.exec(`insert into agent_runtime_instance(runtime_instance_id,owner_api_instance_id,runtime_kind,state,created_at,updated_at)
      values ('instance','owner','worker','unknown',1,1);
      insert into agent_attachment_publication_intent(id,workspace_id,session_id,client_request_id,image_position,payload_hash,byte_sha256,
        attachment_id,storage_key,workspace_dir_name,byte_size,media_type,state,publisher_generation,created_at,updated_at)
      values ('intent','ws','session','request',0,'hash','hash','image','key','ws',1,'image/png','retained','owner',1,1);
      update agent_schema_meta set version=22;`);
    assert.deepEqual(initSchema(db), { fileCleanupPending: true });
    assert.equal((db.prepare("select count(*) as n from agent_run").get() as { n: number }).n, 0);
    assert.equal((db.prepare("select count(*) as n from agent_runtime_instance").get() as { n: number }).n, 1);
    assert.equal((db.prepare("select count(*) as n from agent_attachment_publication_intent").get() as { n: number }).n, 1);
    db.exec("delete from workspaces where id='ws'");
    assert.equal((db.prepare("select count(*) as n from agent_attachment_publication_intent").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("malformed independent authority is refused, not silently recreated", () => {
  const db = v25();
  try {
    db.exec("create table agent_runtime_instance(runtime_instance_id text primary key)");
    const before = schemaSnapshot(db);
    assert.throws(() => initSchema(db), /Unsupported Agent schema/);
    assert.deepEqual(schemaSnapshot(db), before);
  } finally { db.close(); }
});

for (const damage of ["missing-table", "missing-scope-index", "missing-authority", "weakened-check"] as const) {
  test(`v26 ${damage} is rejected without repair or data changes`, () => {
    const db = v25();
    try {
      initSchema(db);
      const data = history(db);
      if (damage === "missing-table") db.exec("drop table agent_queue_operation");
      if (damage === "missing-scope-index") db.exec("drop index uq_agent_run_scope");
      if (damage === "missing-authority") db.exec("drop table agent_runtime_instance");
      if (damage === "weakened-check") {
        const { sql } = db.prepare("select sql from sqlite_master where type='table' and name='agent_session_queue_control'").get() as { sql: string };
        const weakened = sql.replace("next_sequence between 1 and", "next_sequence between 0 and");
        assert.notEqual(weakened, sql);
        db.exec("drop table agent_session_queue_control");
        db.exec(weakened);
      }
      const damaged = schemaSnapshot(db);
      assert.throws(() => assertAgentSchemaSupported(db), /Unsupported Agent schema/);
      assert.throws(() => initSchema(db), /Unsupported Agent schema/);
      assert.deepEqual(schemaSnapshot(db), damaged);
      assert.deepEqual(history(db), data);
    } finally {
      db.close();
    }
  });
}
