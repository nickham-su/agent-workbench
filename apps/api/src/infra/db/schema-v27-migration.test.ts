import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { test } from "node:test";
import { AGENT_SCHEMA_VERSION, initSchema } from "./schema.js";
import { ADD_INTERACTIVE_QUEUE_COLUMN, createAgentQueueDomainSchema, ensureAgentQueueIndependentSchema } from "./agent-queue-schema.js";
import { ModelContextResolver } from "../../modules/agent/read-side/model-context-resolver.js";
import { Value } from "@sinclair/typebox/value";
import { AgentApiInjectInteractiveInputResponseSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentInteractiveInputService } from "../../modules/agent/message-queue/interactive-input.service.js";
import { queuePayloadHash } from "../../modules/agent/message-queue/message-queue.store.js";
import { readEffectiveInputPolicy } from "../../modules/agent/message-queue/interactive-input-binding.store.js";

const injectRequest = { workspaceId: "w", sessionId: "s", runId: "r", operationId: "inject",
  expectedHeadMessageId: "u1", expectedRevision: 1, receiptIds: ["r2"], preparationSnapshotHash: "a".repeat(64), estimatorVersion: "queue-input-estimator-v1" as const };

function releasedV27() {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  db.exec(readFileSync(new URL("./fixtures/agent-schema-v23.sql", import.meta.url), "utf8"));
  db.exec("alter table agent_session add column visibility text not null default 'listed' check (visibility in ('listed', 'unlisted')); alter table session_run_state add column model_request_error_json text;");
  db.exec(ADD_INTERACTIVE_QUEUE_COLUMN); createAgentQueueDomainSchema(db, false, true); ensureAgentQueueIndependentSchema(db);
  db.exec(`update agent_schema_meta set version=27;
    insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('w','w','Workspace','/fixture/w',1,1);
    insert into agent_session(id,workspace_id,title,kind,created_at,updated_at) values('s','w','History','primary',1,1);
    insert into agent_run(run_id,workspace_id,session_id,agent_id,provider_id,model_id,status,interactive_queue_enabled,created_at,updated_at) values('r','w','s','a','p','m','running',1,1,1);
    insert into agent_message(id,workspace_id,origin_session_id,origin_run_id,previous_message_id,type,status,depth,updated_revision,created_at,updated_at)
      values('u1','w','s','r',null,'user','completed',0,1,1,1),('u2','w','s','r','u1','user','completed',1,2,1,1),
        ('u3','w','s','r','u2','user','completed',2,3,1,1),('a','w','s','r','u3','assistant','completed',3,4,1,1);
    update agent_session set head_message_id='a',revision=4 where id='s';
    insert into session_run_state(workspace_id,session_id,status,updated_at) values('w','s','idle',1);
    insert into agent_message_part(id,message_id,position,type,text,updated_revision,created_at,updated_at)
      values('p1','u1',0,'text','first history',1,1,1),('p2','u2',0,'text','second history',2,1,1),('p3','u3',0,'text','previously abandoned history',3,1,1);
    insert into agent_message_part(id,message_id,position,type,tool_name,tool_input_json,provider_tool_call_id,updated_revision,created_at,updated_at)
      values('call','a',0,'tool_call','read','{"filePath":"fixture.txt"}','provider-call',4,1,1);
    insert into agent_tool_execution(id,call_part_id,origin_session_id,origin_run_id,status,result_preview,updated_revision,created_at,updated_at)
      values('execution','call','s','r','completed','historical tool result',4,1,1);
    insert into agent_client_request values('w','s','legacy-request','u1','r',1);
    insert into agent_session_queue_control values('w','s',7,6,1);
    insert into agent_user_message_receipt(id,workspace_id,session_id,client_request_id,sequence,payload_hash,status,input_text,text,payload_bytes,attachment_count,agent_id,provider_id,model_id,message_id,injected_run_id,confirmation_state,confirmed_at,confirmation_source,confirmed_by_assistant_id,abandoned_at,created_at,updated_at)
      values('r1','w','s','request1',1,'hash','injected','first','first',5,0,'a','p','m','u1','r','confirmed',1,'worker_model','a',null,1,1),
        ('r2','w','s','request2',2,'hash','injected','second','second',6,0,'a','p','m','u2','r','unconfirmed',null,null,null,null,1,1),
        ('r3','w','s','request3',3,'hash','injected','third','third',5,0,'a','p','m','u3','r','abandoned',null,null,null,1,1,1),
        ('queued','w','s','request4',4,'hash','queued','extra','extra',5,0,'a','p','m',null,null,null,null,null,null,null,1,1),
        ('tombstone','w','s','request5',5,'hash','cancelled',null,null,0,0,'a','p','m',null,null,null,null,null,null,null,1,1);
    insert into agent_interactive_run_input values('w','s','r','r1'),('w','s','r','r2'),('w','s','r','r3');
    insert into agent_queue_input_binding values('w','s','a','r','snapshot',3,'worker_model','confirmed',null,1);
    insert into agent_queue_model_input values('w','s','a','r2'),('w','s','a','r1');
    insert into agent_queue_operation values('w','s','old-resume','resume','hash','{}',1),('w','s','old-abandon','abandon','hash','{}',1),('w','s','inject','inject','hash','{}',1);
    insert into agent_attachment(id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values('image','w','fixture-key','picture.png','image/png',7,1);
    insert into agent_user_message_receipt_attachment values('w','s','r3',0,'image','hash');
    insert into agent_attachment_publication_intent(id,workspace_id,session_id,client_request_id,image_position,payload_hash,byte_sha256,attachment_id,storage_key,workspace_dir_name,byte_size,media_type,state,retention_code,publisher_generation,receipt_id,created_at,updated_at)
      values('pub','w','s','request3',0,'hash','hash','image','fixture-key','w',7,'image/png','retained','abandoned','generation','r3',1,1);`);
  const response = { operationId: "inject", headMessageId: "u2", revision: 2,
    receipts: [{ id: "r2", clientRequestId: "request2", sequence: 2, status: "injected", messageId: "u2", runId: "r", createdAt: 1, updatedAt: 1,
      confirmationState: "unconfirmed", confirmationSource: null }], queue: { unconfirmedInputCount: 2, recoveryIdentity: { agentId: "a", providerId: "p", modelId: "m" } } };
  db.prepare("update agent_queue_operation set request_hash=?,result_json=? where operation_id='inject'")
    .run(queuePayloadHash(injectRequest), JSON.stringify({ runId: "r", response }));
  return db;
}
const stableTables = ["agent_session", "agent_message", "agent_message_part", "agent_tool_execution", "agent_run", "agent_client_request", "session_run_state", "agent_session_queue_control", "agent_attachment", "agent_user_message_receipt_attachment", "agent_attachment_publication_intent"];
const snapshot = (db: Database.Database) => stableTables.map(table => ({ table, rows: db.prepare(`select * from ${table} order by rowid`).all() }));

test("v27 removes input-state columns and redundant maps while preserving history, snapshots, receipt identities and attachments", () => {
  const db = releasedV27();
  try {
    const before = snapshot(db);
    const receipts = db.prepare("select id,client_request_id,status,message_id,injected_run_id,target_run_id from agent_user_message_receipt order by id").all();
    assert.deepEqual(initSchema(db), { fileCleanupPending: false });
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(db.prepare("select id,client_request_id,status,message_id,injected_run_id,target_run_id from agent_user_message_receipt order by id").all(), receipts);
    const columns = (db.pragma("table_info(agent_user_message_receipt)") as Array<{ name: string }>).map(row => row.name);
    for (const field of ["confirmation_state", "confirmed_at", "confirmation_source", "confirmed_by_assistant_id", "abandoned_at"]) assert.ok(!columns.includes(field));
    for (const table of ["agent_interactive_run_input", "agent_queue_model_input"]) assert.equal(db.prepare("select 1 from sqlite_master where name=?").get(table), undefined);
    assert.deepEqual(db.prepare("select state,input_receipt_ids_json from agent_queue_input_binding").get(), { state: "active", input_receipt_ids_json: '["r1","r2"]' });
    assert.deepEqual(db.prepare("select kind from agent_queue_operation").all(), [{ kind: "inject" }]);
    assert.deepEqual(readEffectiveInputPolicy(db, { workspaceId: "w", sessionId: "s", runId: "r" }).inputReceiptIds, ["r1", "r2", "r3"]);
    const resolved = new ModelContextResolver(db).resolve({ workspaceId: "w", sessionId: "s" });
    assert.ok(resolved.messages.some(message => message.id === "u3"), "formerly abandoned input is ordinary history");
    assert.equal((db.prepare("select version from agent_schema_meta").get() as { version: number }).version, AGENT_SCHEMA_VERSION);
    assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.doesNotThrow(() => initSchema(db));
    const fresh = new Database(":memory:");
    try {
      initSchema(fresh);
      for (const table of ["agent_user_message_receipt", "agent_queue_input_binding", "agent_queue_operation"]) {
        const ddl = (database: Database.Database) => database.prepare("select sql from sqlite_master where tbl_name=? and sql is not null order by type,name").all(table);
        assert.deepEqual(ddl(db), ddl(fresh));
      }
    } finally { fresh.close(); }
  } finally { db.close(); }
});

for (const state of ["active", "superseded"] as const) test(`v27 preserves ${state} binding state and migrates an empty bound input set`, () => {
  const db = releasedV27();
  try {
    db.prepare("update agent_queue_input_binding set state=?").run(state);
    db.exec("delete from agent_queue_model_input");
    initSchema(db);
    assert.deepEqual(db.prepare("select state,input_receipt_ids_json from agent_queue_input_binding").get(), { state, input_receipt_ids_json: "[]" });
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("v27 injected-operation replay keeps its tombstone and original ownership without removed confirmation fields", t => {
  const db = releasedV27(); t.after(() => db.close()); initSchema(db);
  const service = new AgentInteractiveInputService(db, async () => { throw new Error("replay must not prepare or execute"); });
  t.after(() => service.closeAdmission());
  const before = snapshot(db);
  const replay = service.inject(injectRequest);
  assert.equal(Value.Check(AgentApiInjectInteractiveInputResponseSchema, replay), true);
  assert.deepEqual(replay.receipts, [{ id: "r2", clientRequestId: "request2", sequence: 2, status: "injected", messageId: "u2", runId: "r", createdAt: 1, updatedAt: 1 }]);
  assert.equal(replay.headMessageId, "u2"); assert.equal(replay.revision, 2);
  assert.deepEqual(snapshot(db), before);
  assert.throws(() => service.inject({ ...injectRequest, receiptIds: ["r1"] }), { code: "AGENT_QUEUE_OPERATION_CONFLICT" });
  assert.equal((db.prepare("select request_hash from agent_queue_operation where operation_id='inject'").get() as { request_hash: string }).request_hash, queuePayloadHash(injectRequest));
  const persisted = (db.prepare("select result_json from agent_queue_operation where operation_id='inject'").get() as { result_json: string }).result_json;
  assert.equal(persisted.includes("confirmationState"), false); assert.equal(persisted.includes("confirmationSource"), false);
  assert.equal("queue" in JSON.parse(persisted).response, false);
});

test("v27 migration rolls back all table replacements and restores foreign-key enforcement on failure", () => {
  const db = releasedV27();
  try {
    const before = snapshot(db), ddl = db.prepare("select name,sql from sqlite_master order by name").all();
    const legacyTables = ["agent_user_message_receipt", "agent_queue_input_binding", "agent_interactive_run_input", "agent_queue_model_input", "agent_queue_operation"];
    const legacyData = () => legacyTables.map(table => db.prepare(`select * from ${table} order by rowid`).all());
    const beforeLegacy = legacyData();
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith("update agent_schema_meta set version=?")) statement.run = (() => { throw new Error("injected migration failure"); }) as typeof statement.run;
      return statement;
    }) as typeof db.prepare;
    assert.throws(() => initSchema(db), /injected migration failure/);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(prepare("select name,sql from sqlite_master order by name").all(), ddl);
    assert.deepEqual(legacyData(), beforeLegacy);
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1); assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal((prepare("select version from agent_schema_meta").get() as { version: number }).version, 27);
  } finally { db.close(); }
});
