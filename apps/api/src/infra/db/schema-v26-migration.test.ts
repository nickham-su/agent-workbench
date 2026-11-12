import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { test } from "node:test";
import { AGENT_SCHEMA_VERSION, initSchema } from "./schema.js";
import { ADD_INTERACTIVE_QUEUE_COLUMN, createAgentQueueDomainSchema, ensureAgentQueueIndependentSchema } from "./agent-queue-schema.js";

function releasedV26() {
  const db=new Database(":memory:"); db.pragma("foreign_keys=ON");
  db.exec(readFileSync(new URL("./fixtures/agent-schema-v23.sql",import.meta.url),"utf8"));
  db.exec("alter table agent_session add column visibility text not null default 'listed' check (visibility in ('listed', 'unlisted')); alter table session_run_state add column model_request_error_json text;");
  db.exec(ADD_INTERACTIVE_QUEUE_COLUMN); createAgentQueueDomainSchema(db,true); ensureAgentQueueIndependentSchema(db);
  db.exec(`update agent_schema_meta set version=26;
    insert into workspaces(id,dir_name,title,path,created_at,updated_at) values('w','w','Workspace','/fixture/w',1,1);
    insert into agent_session(id,workspace_id,title,kind,created_at,updated_at) values('s','w','History','primary',1,1);
    insert into agent_message(id,workspace_id,origin_session_id,type,status,depth,updated_revision,created_at,updated_at) values('u','w','s','user','completed',0,1,1,1);
    insert into agent_run(run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values('r','w','s','u','a','p','m','running',1,1);
    insert into agent_session_queue_control values('w','s','paused','run_failed',7,4,1);
    insert into agent_user_message_receipt(id,workspace_id,session_id,client_request_id,sequence,payload_hash,status,input_text,text,payload_bytes,attachment_count,agent_id,provider_id,model_id,message_id,injected_run_id,confirmation_state,created_at,updated_at)
      values('formal','w','s','first',1,'hash','injected','formal','formal',6,0,'a','p','m','u','r','unconfirmed',1,1),
            ('queued','w','s','extra',2,'hash','queued','extra','extra',5,0,'a','p','m',null,null,null,1,1),
            ('tombstone','w','s','cancelled',3,'hash','cancelled',null,null,0,0,'a','p','m',null,null,null,1,1);
    insert into agent_interactive_run_input values('w','s','r','formal');
    insert into agent_attachment_publication_intent(id,workspace_id,session_id,client_request_id,image_position,payload_hash,byte_sha256,attachment_id,storage_key,workspace_dir_name,byte_size,media_type,state,retention_code,publisher_generation,receipt_id,created_at,updated_at)
      values('pub','w','s','extra',0,'hash','hash','att','key','w',7,'image/png','retained','cancelled','generation','queued',1,1);`);
  return db;
}
function data(db:Database.Database) {
  return ["agent_session","agent_message","agent_run","agent_interactive_run_input","agent_attachment_publication_intent","agent_user_message_receipt"].map(table=>({table,rows:(db.prepare(`select * from ${table} order by rowid`).all() as Record<string,unknown>[]).map(({target_run_id:_added,...row})=>row)}));
}

test("v26 to v27 removes only mode columns, retaining history, unconfirmed binding, dedup tombstones and attachment ledger",()=>{
  const db=releasedV26();try {
    const before=data(db);assert.deepEqual(initSchema(db),{fileCleanupPending:false});
    assert.deepEqual(data(db),before);assert.equal(db.pragma("foreign_keys",{simple:true}),1);
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
    assert.equal((db.prepare("select version from agent_schema_meta").get() as {version:number}).version,AGENT_SCHEMA_VERSION);
    assert.deepEqual((db.pragma("table_info(agent_session_queue_control)") as Array<{name:string}>).map(row=>row.name),["workspace_id","session_id","queue_version","next_sequence","updated_at"]);
    assert.deepEqual(db.prepare("select queue_version,next_sequence from agent_session_queue_control").get(),{queue_version:7,next_sequence:4});
    assert.equal((db.prepare("select status from agent_user_message_receipt where id='queued'").get() as {status:string}).status,"queued","startup, not schema migration, owns best-effort buffer discard");
    assert.doesNotThrow(()=>initSchema(db));
    const fresh=new Database(":memory:");try {initSchema(fresh);assert.deepEqual((db.pragma("table_info(agent_user_message_receipt)") as Array<{name:string}>).map(row=>row.name).sort(),(fresh.pragma("table_info(agent_user_message_receipt)") as Array<{name:string}>).map(row=>row.name).sort());}finally{fresh.close();}
  }finally{db.close();}
});

test("failed v26 migration rolls back the rebuilt control table and restores FK enforcement",()=>{
  const db=releasedV26();try {
    const before=data(db), sql=db.prepare("select sql from sqlite_master where name='agent_session_queue_control'").get();
    const prepare=db.prepare.bind(db);
    db.prepare=((text:string)=>{const stmt=prepare(text);if(text.startsWith("update agent_schema_meta set version=?")) stmt.run=(()=>{throw new Error("injected v27 commit failure");}) as typeof stmt.run;return stmt;}) as typeof db.prepare;
    assert.throws(()=>initSchema(db),/injected v27/);assert.deepEqual(data(db),before);
    assert.deepEqual(prepare("select sql from sqlite_master where name='agent_session_queue_control'").get(),sql);
    assert.equal(db.pragma("foreign_keys",{simple:true}),1);assert.deepEqual(db.pragma("foreign_key_check"),[]);
  }finally{db.close();}
});
