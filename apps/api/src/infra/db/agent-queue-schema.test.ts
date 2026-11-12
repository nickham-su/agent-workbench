import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema, assertAgentSchemaSupported } from "./schema.js";

const hash = "a".repeat(64);
function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return db.prepare(`insert into ${table}(${keys.join(",")}) values (${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
}
function fixture() {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); initSchema(db);
  for (const workspace of ["w1", "w2"]) insert(db, "workspaces", { id: workspace, dir_name: workspace, title: workspace, path: `/fixture/${workspace}`, created_at: 1, updated_at: 1 });
  for (const [session, workspace, run] of [["s1", "w1", "r1"], ["s2", "w1", "r2"], ["s3", "w2", "r3"]]) {
    insert(db, "agent_session", { id: session, workspace_id: workspace, title: session, kind: "primary", created_at: 1, updated_at: 1 });
    insert(db, "agent_run", { run_id: run, workspace_id: workspace, session_id: session, agent_id: "a", provider_id: "p", model_id: "m", status: "running", created_at: 1, updated_at: 1 });
    insert(db, "agent_session_queue_control", control(session!, workspace!));
    insert(db, "agent_message", { id: `u-${session}`, workspace_id: workspace, origin_session_id: session, type: "user", status: "completed", depth: 0, updated_revision: 1, created_at: 1, updated_at: 1 });
    insert(db, "agent_message", { id: `a-${session}`, workspace_id: workspace, origin_session_id: session, origin_run_id: run, type: "assistant", status: "streaming", depth: 0, updated_revision: 1, created_at: 1, updated_at: 1 });
  }
  insert(db, "agent_attachment", { id: "img1", workspace_id: "w1", storage_key: "key1", filename: "img.png", media_type: "image/png", byte_size: 1, created_at: 1 });
  insert(db, "agent_attachment", { id: "img2", workspace_id: "w2", storage_key: "key2", filename: "img.png", media_type: "image/png", byte_size: 1, created_at: 1 });
  return db;
}
function control(session = "s1", workspace = "w1") {
  return { workspace_id: workspace, session_id: session, queue_version: 0, next_sequence: 1, updated_at: 1 };
}
function receipt(id = "receipt", session = "s1", workspace = "w1") {
  return { id, workspace_id: workspace, session_id: session, client_request_id: id, sequence: 1, payload_hash: hash,
    status: "queued", text: "hello", input_text: "hello", payload_bytes: 5, attachment_count: 1,
    agent_id: "a", provider_id: "p", model_id: "m", created_at: 1, updated_at: 1 };
}
function binding() {
  return { workspace_id: "w1", session_id: "s1", assistant_message_id: "a-s1", run_id: "r1", snapshot_hash: hash, input_revision: 1, source: "worker_model", state: "active", input_receipt_ids_json: "[]", created_at: 1 };
}
function stopOperation(id = "stop") { return { workspace_id: "w1", session_id: "s1", operation_id: id, kind: "stop", request_hash: hash, result_json: "{}", created_at: 1 }; }
function barrier(id = "stop") { return { workspace_id: "w1", root_session_id: "s1", operation_id: id, state: "pending", targets_hash: hash, accepted_queue_version: 1, created_at: 1, updated_at: 1 }; }
function target(id = "stop", run = "r1", session = "s1", runtime = "instance") { return { workspace_id: "w1", root_session_id: "s1", operation_id: id, target_session_id: session, run_id: run, runtime_instance_id: runtime, state: "pending", updated_at: 1 }; }
function instance(id = "instance") { return { runtime_instance_id: id, owner_api_instance_id: "owner", runtime_kind: "worker", state: "ready", created_at: 1, updated_at: 1 }; }
function publication() { return { id: "pub", workspace_id: "w1", session_id: "s1", client_request_id: "request", image_position: 0, payload_hash: hash, byte_sha256: hash, attachment_id: "new-image", storage_key: "storage", workspace_dir_name: "w1", byte_size: 1, media_type: "image/png", state: "reserved", publisher_generation: "owner", created_at: 1, updated_at: 1 }; }
function seedStop(db: Database.Database) {
  insert(db, "agent_runtime_instance", instance());
  insert(db, "agent_run_runtime_admission", { workspace_id: "w1", session_id: "s1", run_id: "r1", runtime_instance_id: "instance", state: "bound", created_at: 1, updated_at: 1 });
  insert(db, "agent_queue_operation", stopOperation()); insert(db, "agent_session_stop_barrier", barrier());
}

test("all queue entities form real scoped FKs and admit the complete valid chain", () => {
  const db = fixture();
  try {
    insert(db, "agent_user_message_receipt", receipt());
    insert(db, "agent_user_message_receipt_attachment", { workspace_id: "w1", session_id: "s1", receipt_id: "receipt", position: 0, attachment_id: "img1", byte_sha256: hash });
    db.prepare("update agent_user_message_receipt set status='injected',message_id='u-s1',injected_run_id='r1' where id='receipt'").run();
    insert(db, "agent_queue_input_binding", binding());
    seedStop(db); insert(db, "agent_session_stop_target", target());
    insert(db, "agent_queue_operation", stopOperation("stop-2")); insert(db, "agent_session_stop_barrier", barrier("stop-2")); insert(db, "agent_session_stop_target", target("stop-2"));
    insert(db, "agent_attachment_publication_intent", publication());
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.doesNotThrow(() => assertAgentSchemaSupported(db));
    assert.throws(() => db.exec("delete from agent_run where run_id='r1'"), /FOREIGN KEY/);
    // Explicit leaf-to-parent cleanup; standalone evidence remains even after Workspace deletion.
    for (const table of ["agent_session_stop_target", "agent_session_stop_barrier", "agent_run_runtime_admission", "agent_queue_input_binding", "agent_user_message_receipt_attachment", "agent_user_message_receipt", "agent_queue_operation", "agent_session_queue_control", "agent_run", "agent_message", "agent_attachment", "agent_session", "workspaces"]) db.exec(`delete from ${table}`);
    assert.equal((db.prepare("select count(*) as n from agent_runtime_instance").get() as { n: number }).n, 1);
    assert.equal((db.prepare("select count(*) as n from agent_attachment_publication_intent").get() as { n: number }).n, 1);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("queue FKs reject cross-Workspace/Session/Run/Assistant and runtime targets", () => {
  const db = fixture();
  try {
    insert(db, "agent_user_message_receipt", receipt()); seedStop(db);
    const rejects = (table: string, row: Record<string, unknown>) => assert.throws(() => insert(db, table, row), /FOREIGN KEY/);
    rejects("agent_user_message_receipt", { ...receipt("wrong"), workspace_id: "w2", sequence: 2 });
    rejects("agent_user_message_receipt_attachment", { workspace_id: "w1", session_id: "s1", receipt_id: "receipt", position: 0, attachment_id: "img2", byte_sha256: hash });
    rejects("agent_queue_input_binding", { ...binding(), assistant_message_id: "a-s2" });
    rejects("agent_queue_input_binding", { ...binding(), run_id: "r3" });
    insert(db, "agent_queue_input_binding", binding());
    insert(db, "agent_user_message_receipt", receipt("other", "s2"));
    rejects("agent_session_stop_target", target("stop", "r2", "s1"));
    rejects("agent_session_stop_target", target("stop", "r1", "s1", "different-instance"));
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("NULL cannot bypass receipt/proof checks and counters are safe integers", () => {
  const db = fixture();
  try {
    insert(db, "agent_user_message_receipt", receipt()); seedStop(db);
    const invalidReceipt = [
      "status='injected',message_id=null,injected_run_id='r1'",
      "status='injected',message_id='u-s1',injected_run_id=null",
      "status='queued',text=null", "sequence=1.5", "sequence=9007199254740992", "id=null"
    ];
    for (const json of ["not-json", "null", "{}"])
      assert.throws(() => insert(db, "agent_queue_input_binding", { ...binding(), input_receipt_ids_json: json }), /CHECK/);
    for (const update of invalidReceipt) assert.throws(() => db.exec(`update agent_user_message_receipt set ${update} where id='receipt'`), /CHECK|NOT NULL/);
    for (const update of ["queue_version=-1", "queue_version=1.5", "next_sequence=9007199254740992"])
      assert.throws(() => db.exec(`update agent_session_queue_control set ${update} where session_id='s1'`), /CHECK/);
    assert.throws(() => insert(db, "agent_session_stop_target", { ...target(), state: "quiescent" }), /CHECK/);
    assert.throws(() => db.exec("update agent_runtime_instance set state='exited'"), /CHECK/);
    assert.throws(() => db.exec("update agent_session_stop_barrier set state='quiescent'"), /CHECK/);
    assert.throws(() => db.exec("update agent_run set interactive_queue_enabled=2"), /CHECK/);
    assert.throws(() => insert(db, "agent_attachment_publication_intent", { ...publication(), state: "published" }), /CHECK/);
    assert.throws(() => insert(db, "agent_attachment_publication_intent", { ...publication(), state: "released_offline_maintenance" }), /CHECK/);
    assert.throws(() => insert(db, "agent_attachment_publication_intent", { ...publication(), owned_dev: "1" }), /CHECK/);
  } finally { db.close(); }
});

test("scoped request keys, FIFO sequence and attachment positions are unique", () => {
  const db = fixture();
  try {
    insert(db, "agent_user_message_receipt", receipt());
    assert.throws(() => insert(db, "agent_user_message_receipt", { ...receipt("second"), sequence: 2, client_request_id: "receipt" }), /UNIQUE/);
    assert.throws(() => insert(db, "agent_user_message_receipt", receipt("second")), /UNIQUE/);
    // IDs are global even though client request identities are scoped.
    assert.throws(() => insert(db, "agent_user_message_receipt", receipt("receipt", "s2")), /UNIQUE.*agent_user_message_receipt.id/);
    insert(db, "agent_user_message_receipt", { ...receipt("second", "s2"), client_request_id: "receipt" });
  } finally { db.close(); }
});
