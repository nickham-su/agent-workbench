import Database from "better-sqlite3";
import type { Db } from "./db.js";

/** Independent DataDir authority: never cascade/drop it with the Agent domain. */
export const AGENT_QUEUE_INDEPENDENT_TABLES = ["agent_attachment_publication_intent", "agent_runtime_instance"] as const;
export const AGENT_QUEUE_DOMAIN_TABLES = ["agent_session_queue_control", "agent_user_message_receipt", "agent_user_message_receipt_attachment", "agent_queue_operation", "agent_interactive_run_input", "agent_queue_input_binding", "agent_queue_model_input", "agent_run_runtime_admission", "agent_session_stop_barrier", "agent_session_stop_target"] as const;
export const INTERACTIVE_QUEUE_COLUMN = "interactive_queue_enabled integer not null default 0 check (interactive_queue_enabled in (0, 1))";
export const ADD_INTERACTIVE_QUEUE_COLUMN = `alter table agent_run add column ${INTERACTIVE_QUEUE_COLUMN}`;

const INDEPENDENT_DDL = `
-- 基础schema独立实体，无Workspace／Session／receipt外键。
create table agent_attachment_publication_intent (
  id text primary key not null,
  workspace_id text not null, session_id text not null, client_request_id text not null,
  image_position integer not null check(image_position between 0 and 3),
  payload_hash text not null, byte_sha256 text not null,
  attachment_id text not null unique, storage_key text not null, workspace_dir_name text not null,
  byte_size integer not null check(byte_size between 1 and 10485760),
  media_type text not null check(media_type in ('image/png','image/jpeg','image/webp')),
  state text not null check(state in ('reserved','publishing','published','retained',
    'released_unpublished','released_offline_maintenance')),
  retention_code text, publisher_generation text not null,
  owned_dev text, owned_ino text, receipt_id text,
  maintenance_id text, released_at integer,
  created_at integer not null, updated_at integer not null,
  unique(workspace_id, session_id, client_request_id, image_position),
  check((state='released_offline_maintenance' and maintenance_id is not null and released_at is not null)
     or (state<>'released_offline_maintenance' and maintenance_id is null and released_at is null)),
  check((owned_dev is null and owned_ino is null) or (owned_dev is not null and owned_ino is not null)),
  check(state<>'published' or (owned_dev is not null and owned_ino is not null))
);
create index idx_agent_publication_charge on agent_attachment_publication_intent(state);

create table agent_runtime_instance (
  runtime_instance_id text primary key not null,
  owner_api_instance_id text not null,
  runtime_kind text not null check(runtime_kind in ('worker','local_fallback')),
  state text not null check(state in ('starting','ready','unknown','exited')),
  process_identity_json text,
  exit_proof_kind text check(exit_proof_kind in ('child_exit','local_shutdown','offline_exit')),
  exit_proof_id text, exit_proof_json text, exit_observed_at integer,
  created_at integer not null, updated_at integer not null,
  check(coalesce((state='exited' and exit_proof_kind is not null
    and exit_proof_id is not null and exit_proof_json is not null and exit_observed_at is not null)
    or (state<>'exited' and exit_proof_kind is null and exit_proof_id is null
    and exit_proof_json is null and exit_observed_at is null), 0))
);
`;
const domainDdl = (legacyV26: boolean) => `
create unique index uq_agent_session_scope on agent_session(workspace_id, id);
create unique index uq_agent_attachment_scope on agent_attachment(workspace_id, id);
create unique index uq_agent_run_scope on agent_run(workspace_id, session_id, run_id);
create unique index uq_agent_message_origin_scope
  on agent_message(workspace_id, origin_session_id, id);

${legacyV26 ? LEGACY_QUEUE_CONTROL_SQL : QUEUE_CONTROL_SQL}

create table agent_user_message_receipt (
  id text primary key not null,
  workspace_id text not null,
  session_id text not null,
  client_request_id text not null,
  sequence integer not null check(typeof(sequence)='integer' and sequence between 1 and 9007199254740991),
  payload_hash text not null,
  status text not null check(status in ('queued','injected','cancelled')),
  input_text text,
  text text,
  payload_bytes integer not null check(payload_bytes >= 0),
  attachment_count integer not null check(attachment_count between 0 and 4),
  agent_id text not null,
  provider_id text not null,
  model_id text not null,
  ui_locale text,
  message_id text unique,
  injected_run_id text,
  ${legacyV26 ? "" : "target_run_id text,"}
  confirmation_state text check(confirmation_state in ('unconfirmed','confirmed','abandoned')),
  confirmed_at integer,
  confirmation_source text check(confirmation_source in ('worker_model','local_fallback')),
  confirmed_by_assistant_id text,
  abandoned_at integer,
  created_at integer not null,
  updated_at integer not null,
  unique(workspace_id, session_id, id),
  unique(workspace_id, session_id, client_request_id),
  unique(session_id, sequence),
  foreign key(workspace_id, session_id)
    references agent_session_queue_control(workspace_id, session_id) on delete cascade,
  foreign key(workspace_id, session_id, message_id)
    references agent_message(workspace_id, origin_session_id, id) on delete restrict,
  foreign key(workspace_id, session_id, injected_run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(workspace_id, session_id, confirmed_by_assistant_id)
    references agent_message(workspace_id, origin_session_id, id) on delete restrict,
  check((status='queued' and text is not null and input_text is not null
          and message_id is null and injected_run_id is null and confirmation_state is null)
     or (status='cancelled' and message_id is null and injected_run_id is null and confirmation_state is null)
     or (status='injected' and message_id is not null and injected_run_id is not null
          and confirmation_state is not null)),
  check(coalesce((confirmation_state='confirmed' and confirmed_at is not null
          and confirmation_source is not null and confirmed_by_assistant_id is not null
          and abandoned_at is null)
     or (confirmation_state='abandoned' and abandoned_at is not null
          and confirmed_at is null and confirmation_source is null and confirmed_by_assistant_id is null)
     or (confirmation_state='unconfirmed' and confirmed_at is null
          and confirmation_source is null and confirmed_by_assistant_id is null and abandoned_at is null)
     or (confirmation_state is null and confirmed_at is null
          and confirmation_source is null and confirmed_by_assistant_id is null and abandoned_at is null), 0))
);
create index idx_agent_receipt_queued
  on agent_user_message_receipt(session_id, sequence) where status='queued';
create index idx_agent_receipt_unconfirmed
  on agent_user_message_receipt(session_id, sequence)
  where status='injected' and confirmation_state='unconfirmed';

create table agent_user_message_receipt_attachment (
  workspace_id text not null,
  session_id text not null,
  receipt_id text not null,
  position integer not null check(position between 0 and 3),
  attachment_id text not null,
  byte_sha256 text not null,
  primary key(receipt_id, position),
  unique(receipt_id, attachment_id),
  foreign key(workspace_id, session_id, receipt_id)
    references agent_user_message_receipt(workspace_id, session_id, id) on delete cascade,
  foreign key(workspace_id, attachment_id)
    references agent_attachment(workspace_id, id) on delete restrict
);

create table agent_queue_operation (
  workspace_id text not null, session_id text not null,
  operation_id text not null,
  kind text not null check(kind in ('stop','resume','abandon','prepare','inject','complete_or_continue')),
  request_hash text not null, result_json text not null, created_at integer not null,
  primary key(workspace_id, session_id, operation_id),
  foreign key(workspace_id, session_id)
    references agent_session_queue_control(workspace_id, session_id) on delete cascade
);
create table agent_interactive_run_input (
  workspace_id text not null, session_id text not null,
  run_id text not null, receipt_id text not null,
  primary key(run_id, receipt_id),
  foreign key(workspace_id, session_id, run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(workspace_id, session_id, receipt_id)
    references agent_user_message_receipt(workspace_id, session_id, id) on delete restrict
);
create table agent_queue_input_binding (
  workspace_id text not null, session_id text not null,
  assistant_message_id text primary key not null, run_id text not null,
  snapshot_hash text not null, input_revision integer not null check(typeof(input_revision)='integer' and input_revision between 0 and 9007199254740991),
  source text not null check(source in ('worker_model','local_fallback')),
  state text not null check(state in ('active','superseded','confirmed')),
  replaces_assistant_id text, created_at integer not null,
  unique(workspace_id, session_id, assistant_message_id),
  foreign key(workspace_id, session_id, assistant_message_id)
    references agent_message(workspace_id, origin_session_id, id) on delete restrict,
  foreign key(workspace_id, session_id, run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(replaces_assistant_id)
    references agent_queue_input_binding(assistant_message_id) on delete set null
);
create table agent_queue_model_input (
  workspace_id text not null, session_id text not null,
  assistant_message_id text not null, receipt_id text not null,
  primary key(assistant_message_id, receipt_id),
  foreign key(workspace_id, session_id, assistant_message_id)
    references agent_queue_input_binding(workspace_id, session_id, assistant_message_id) on delete cascade,
  foreign key(workspace_id, session_id, receipt_id)
    references agent_user_message_receipt(workspace_id, session_id, id) on delete restrict
);

create table agent_run_runtime_admission (
  workspace_id text not null, session_id text not null, run_id text primary key not null,
  runtime_instance_id text,
  state text not null check(state in ('unbound','bound','closed','retired')),
  created_at integer not null, updated_at integer not null,
  unique(workspace_id, session_id, run_id, runtime_instance_id),
  foreign key(workspace_id, session_id, run_id)
    references agent_run(workspace_id, session_id, run_id) on delete restrict,
  foreign key(runtime_instance_id) references agent_runtime_instance(runtime_instance_id) on delete restrict,
  check(state<>'unbound' or runtime_instance_id is null),
  check(state<>'bound' or runtime_instance_id is not null)
);
create index idx_agent_runtime_admission_session
  on agent_run_runtime_admission(workspace_id, session_id, state);
create table agent_session_stop_barrier (
  workspace_id text not null, root_session_id text not null, operation_id text not null,
  state text not null check(state in ('pending','unknown','quiescent')),
  targets_hash text not null check(length(targets_hash)=64 and targets_hash not glob '*[^0-9a-f]*'),
  accepted_queue_version integer not null check(typeof(accepted_queue_version)='integer' and accepted_queue_version between 0 and 9007199254740991),
  last_error_code text,
  created_at integer not null, updated_at integer not null, resolved_at integer,
  primary key(workspace_id, root_session_id, operation_id),
  foreign key(workspace_id, root_session_id, operation_id)
    references agent_queue_operation(workspace_id, session_id, operation_id) on delete restrict,
  check((state='quiescent' and resolved_at is not null and last_error_code is null)
    or (state in ('pending','unknown') and resolved_at is null))
);
create index idx_agent_stop_barrier_pending
  on agent_session_stop_barrier(state, updated_at);
create table agent_session_stop_target (
  workspace_id text not null, root_session_id text not null, operation_id text not null,
  target_session_id text not null, run_id text not null, runtime_instance_id text not null,
  state text not null check(state in ('pending','unknown','quiescent')),
  evidence_kind text check(evidence_kind in ('rpc_quiescent','instance_exit')),
  evidence_id text, evidence_json text, confirmed_at integer,
  last_error_code text, updated_at integer not null,
  primary key(workspace_id, root_session_id, operation_id, target_session_id, run_id, runtime_instance_id),
  foreign key(workspace_id, root_session_id, operation_id)
    references agent_session_stop_barrier(workspace_id, root_session_id, operation_id) on delete restrict,
  foreign key(workspace_id, target_session_id, run_id, runtime_instance_id)
    references agent_run_runtime_admission(workspace_id, session_id, run_id, runtime_instance_id) on delete restrict,
  check(coalesce((state='quiescent' and evidence_kind is not null and evidence_id is not null
    and evidence_json is not null and confirmed_at is not null and last_error_code is null)
    or (state in ('pending','unknown') and evidence_kind is null and evidence_id is null
    and evidence_json is null and confirmed_at is null), 0))
);
create index idx_agent_stop_target_session
  on agent_session_stop_target(workspace_id, target_session_id, state);
create index idx_agent_stop_target_instance
  on agent_session_stop_target(runtime_instance_id, state);
`;

function definitions(db: Db, table: string) {
  return db.prepare("select type,name,tbl_name,sql from sqlite_master where tbl_name=? order by type,name").all(table);
}

/** Canonical SQL comparison is supplied by schema.ts so quoted literals stay opaque. */
export function hasAgentQueueIndependentSchema(db: Db, normalizeSql: (sql: string) => string): boolean {
  const reference = new Database(":memory:");
  try {
    reference.exec(INDEPENDENT_DDL);
    for (const table of AGENT_QUEUE_INDEPENDENT_TABLES) {
      const actual = definitions(db, table) as Array<{type:string; name:string; tbl_name:string; sql:string|null}>;
      if (actual.length === 0) continue; // Additive on an older/clean database.
      const canonical = (rows: typeof actual) => JSON.stringify(rows.map(row => ({...row, sql: row.sql === null ? null : normalizeSql(row.sql)})));
      if (canonical(actual) !== canonical(definitions(reference, table) as typeof actual)) return false;
    }
    return true;
  } finally { reference.close(); }
}

export function ensureAgentQueueIndependentSchema(db: Db) {
  // Caller validated existing authority before entering any modifying path.
  db.transaction(() => {
    const reference = new Database(":memory:");
    try {
      reference.exec(INDEPENDENT_DDL);
      for (const table of AGENT_QUEUE_INDEPENDENT_TABLES) {
        if (definitions(db, table).length > 0) continue;
        const statements = definitions(reference, table) as Array<{type:string; sql:string|null}>;
        for (const row of statements.filter(row => row.type === "table")) if (row.sql) db.exec(row.sql);
        for (const row of statements.filter(row => row.type === "index")) if (row.sql) db.exec(row.sql);
      }
    } finally { reference.close(); }
  })();
}

const LEGACY_QUEUE_CONTROL_SQL = `create table agent_session_queue_control (
  workspace_id text not null,
  session_id text primary key not null,
  mode text not null check(mode in ('active','paused')),
  pause_code text,
  queue_version integer not null check(typeof(queue_version)='integer' and queue_version between 0 and 9007199254740991),
  next_sequence integer not null check(typeof(next_sequence)='integer' and next_sequence between 1 and 9007199254740991),
  updated_at integer not null,
  unique(workspace_id, session_id),
  foreign key(workspace_id, session_id)
    references agent_session(workspace_id, id) on delete cascade,
  check((mode='active' and pause_code is null) or
        (mode='paused' and pause_code is not null))
);`;
export const QUEUE_CONTROL_SQL = `create table agent_session_queue_control (
  workspace_id text not null,
  session_id text primary key not null,
  queue_version integer not null check(typeof(queue_version)='integer' and queue_version between 0 and 9007199254740991),
  next_sequence integer not null check(typeof(next_sequence)='integer' and next_sequence between 1 and 9007199254740991),
  updated_at integer not null,
  unique(workspace_id, session_id),
  foreign key(workspace_id, session_id)
    references agent_session(workspace_id, id) on delete cascade
);`;

export function createAgentQueueDomainSchema(db: Db, legacyV26 = false) {
  db.exec(domainDdl(legacyV26));
}

/** Caller holds the writer transaction with FK enforcement temporarily disabled.
 * Rebuild only the control table: all referencing receipts, bindings and ledgers stay intact. */
export function upgradeAgentQueueBufferSchema(db: Db) {
  db.exec(`create temp table queue_control_backup as select workspace_id,session_id,queue_version,next_sequence,updated_at from agent_session_queue_control;
    drop table agent_session_queue_control;
    ${QUEUE_CONTROL_SQL}
    insert into agent_session_queue_control select * from queue_control_backup;
    drop table queue_control_backup;
    alter table agent_user_message_receipt add column target_run_id text;`);
}
