import type { Db } from "./db.js";

function hasColumn(db: Db, table: string, column: string) {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function ensureColumn(db: Db, params: { table: string; column: string; ddl: string }) {
  if (hasColumn(db, params.table, params.column)) return;
  db.exec(`alter table ${params.table} add column ${params.ddl};`);
}

export function initSchema(db: Db) {
  if (hasColumn(db, "workspaces", "repo_id")) {
    db.exec(`
      drop table if exists terminals;
      drop table if exists workspaces;
    `);
  }

  db.exec(`
    create table if not exists repos (
      id text primary key,
      url text not null unique,
      created_at integer not null,
      updated_at integer not null,
      default_branch text,
      mirror_path text not null,
      sync_status text not null default 'idle',
      sync_error text,
      last_sync_at integer
    );

    create table if not exists credentials (
      id text primary key,
      host text not null,
      kind text not null,
      label text,
      username text,
      secret_enc text not null,
      is_default integer not null default 0,
      created_at integer not null,
      updated_at integer not null
    );

    create index if not exists idx_credentials_host on credentials(host);
    create index if not exists idx_credentials_host_kind on credentials(host, kind);
    create unique index if not exists idx_credentials_host_default on credentials(host) where is_default = 1;

    create table if not exists workspaces (
      id text primary key,
      dir_name text not null,
      title text not null,
      path text not null,
      terminal_credential_id text,
      last_used_at integer,
      created_at integer not null,
      updated_at integer not null
    );

    create table if not exists workspace_repos (
      workspace_id text not null,
      repo_id text not null,
      dir_name text not null,
      path text not null,
      created_at integer not null,
      updated_at integer not null,
      primary key (workspace_id, repo_id),
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (repo_id) references repos(id) on delete restrict
    );

    create unique index if not exists idx_workspace_repos_workspace_dir on workspace_repos(workspace_id, dir_name);
    create index if not exists idx_workspace_repos_repo_id on workspace_repos(repo_id);

    create table if not exists terminals (
      id text primary key,
      workspace_id text not null,
      session_name text not null,
      status text not null,
      created_at integer not null,
      updated_at integer not null,
      foreign key (workspace_id) references workspaces(id) on delete restrict
    );

    create index if not exists idx_terminals_workspace_id on terminals(workspace_id);

    create table if not exists settings (
      key text primary key,
      value_json text not null,
      updated_at integer not null
    );

    create table if not exists agent_session (
      id text primary key,
      workspace_id text not null,
      title text not null,
      kind text not null,
      created_at integer not null,
      updated_at integer not null,
      forked_from_session_id text,
      forked_from_item_id integer,
      foreign key (workspace_id) references workspaces(id) on delete restrict
    );

    create table if not exists agent_session_head (
      workspace_id text not null,
      session_id text not null,
      head_item_id integer,
      updated_at integer not null,
      primary key (workspace_id, session_id),
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table if not exists agent_client_request (
      workspace_id text not null,
      session_id text not null,
      client_request_id text not null,
      message_item_id integer not null,
      run_id text not null,
      created_at integer not null,
      primary key (workspace_id, session_id, client_request_id)
    );

    create table if not exists agent_session_run_state (
      workspace_id text not null,
      session_id text not null,
      status text not null,
      active_run_id text,
      active_assistant_item_id integer,
      last_response_total_tokens integer,
      run_notice_text text not null default '',
      applied_item_id integer not null default 0,
      updated_at integer not null,
      primary key (workspace_id, session_id),
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table if not exists agent_context_item (
      id integer primary key autoincrement,
      workspace_id text not null,
      session_id text not null,
      run_id text,
      turn_id text,
      step integer,
      prev_id integer,
      kind text not null,
      status text not null,
      output_text text not null default '',
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
      output_json text not null default '{}',
      created_at integer not null,
      updated_at integer not null,
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table if not exists agent_run (
      run_id text primary key,
      workspace_id text not null,
      session_id text not null,
      trigger_item_id integer not null,
      agent_id text not null,
      provider_id text not null,
      model_id text not null,
      status text not null,
      created_at integer not null,
      updated_at integer not null,
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    -- IM channels runtime
    create table if not exists channel_conversation_binding (
      plugin_id text not null,
      channel_name text not null,
      account_id text not null,
      conversation_key text not null,
      chat_id text not null,
      chat_type text not null,
      workspace_id text not null,
      session_id text not null,
      selected_agent_id text,
      group_mode text,
      watermark_external_message_id text,
      created_at integer not null,
      updated_at integer not null,
      primary key (plugin_id, channel_name, account_id, conversation_key),
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table if not exists channel_inbound_message (
      id integer primary key autoincrement,
      plugin_id text not null,
      channel_name text not null,
      account_id text not null,
      conversation_key text not null,
      external_message_id text not null,
      sender_id text not null,
      sender_name text,
      mentioned_bot integer not null default 0,
      text text not null,
      created_at_external integer,
      created_at_local integer not null
    );

    create table if not exists channel_reply_job (
      id integer primary key autoincrement,
      plugin_id text not null,
      channel_name text not null,
      account_id text not null,
      conversation_key text not null,
      workspace_id text not null,
      session_id text not null,
      run_id text not null,
      status text not null,
      error_text text,
      created_at integer not null,
      updated_at integer not null,
      foreign key (session_id) references agent_session(id) on delete cascade
    );
  `);

  ensureColumn(db, { table: "repos", column: "credential_id", ddl: "credential_id text" });
  ensureColumn(db, { table: "repos", column: "default_branch", ddl: "default_branch text" });
  ensureColumn(db, { table: "workspaces", column: "dir_name", ddl: "dir_name text" });
  ensureColumn(db, { table: "workspaces", column: "terminal_credential_id", ddl: "terminal_credential_id text" });
  ensureColumn(db, { table: "workspaces", column: "last_used_at", ddl: "last_used_at integer" });
  ensureColumn(db, { table: "agent_session", column: "forked_from_item_id", ddl: "forked_from_item_id integer" });
  ensureColumn(db, { table: "agent_session", column: "forked_from_session_id", ddl: "forked_from_session_id text" });
  ensureColumn(db, { table: "agent_session_head", column: "head_item_id", ddl: "head_item_id integer" });
  ensureColumn(db, { table: "channel_reply_job", column: "reply_to_external_message_id", ddl: "reply_to_external_message_id text" });
  ensureColumn(db, { table: "channel_reply_job", column: "attempt_count", ddl: "attempt_count integer not null default 0" });
  ensureColumn(db, { table: "channel_reply_job", column: "last_attempt_at", ddl: "last_attempt_at integer" });
  ensureColumn(db, { table: "channel_reply_job", column: "max_attempts", ddl: "max_attempts integer not null default 5" });
  ensureColumn(db, { table: "agent_client_request", column: "message_item_id", ddl: "message_item_id integer" });
  ensureColumn(db, { table: "agent_session_run_state", column: "active_assistant_item_id", ddl: "active_assistant_item_id integer" });
  ensureColumn(db, { table: "agent_session_run_state", column: "last_response_total_tokens", ddl: "last_response_total_tokens integer" });
  ensureColumn(db, { table: "agent_session_run_state", column: "run_notice_text", ddl: "run_notice_text text not null default ''" });
  ensureColumn(db, { table: "agent_session_run_state", column: "applied_item_id", ddl: "applied_item_id integer not null default 0" });
  ensureColumn(db, { table: "agent_run", column: "agent_id", ddl: "agent_id text" });
  ensureColumn(db, { table: "agent_run", column: "provider_id", ddl: "provider_id text" });
  ensureColumn(db, { table: "agent_run", column: "model_id", ddl: "model_id text" });
  ensureColumn(db, { table: "agent_run", column: "ui_locale", ddl: "ui_locale text" });
  ensureColumn(db, { table: "agent_context_item", column: "output_text", ddl: "output_text text not null default ''" });
  ensureColumn(db, { table: "agent_context_item", column: "assistant_reasoning_text", ddl: "assistant_reasoning_text text" });
  ensureColumn(db, {
    table: "agent_context_item",
    column: "output_text_truncated",
    ddl: "output_text_truncated integer not null default 0"
  });
  ensureColumn(db, { table: "agent_context_item", column: "output_text_artifact_path", ddl: "output_text_artifact_path text" });
  ensureColumn(db, { table: "agent_context_item", column: "tool_name", ddl: "tool_name text" });
  ensureColumn(db, { table: "agent_context_item", column: "tool_call_id", ddl: "tool_call_id text" });
  ensureColumn(db, { table: "agent_context_item", column: "tool_call_json", ddl: "tool_call_json text" });
  ensureColumn(db, { table: "agent_context_item", column: "tool_result_json", ddl: "tool_result_json text" });
  ensureColumn(db, { table: "agent_context_item", column: "error_message", ddl: "error_message text" });
  ensureColumn(db, { table: "agent_context_item", column: "error_code", ddl: "error_code text" });
  ensureColumn(db, { table: "agent_context_item", column: "boundary_reason", ddl: "boundary_reason text" });
  ensureColumn(db, { table: "agent_context_item", column: "archive_at", ddl: "archive_at integer" });
  createIndexIfNotExists(db, { index: "idx_repos_credential_id", sql: "create index idx_repos_credential_id on repos(credential_id)" });
  createIndexIfNotExists(db, { index: "idx_workspaces_dir_name", sql: "create unique index idx_workspaces_dir_name on workspaces(dir_name)" });
  createIndexIfNotExists(db, { index: "idx_workspaces_last_used_at", sql: "create index idx_workspaces_last_used_at on workspaces(last_used_at)" });
  createIndexIfNotExists(db, {
    index: "idx_agent_session_workspace_updated",
    sql: "create index idx_agent_session_workspace_updated on agent_session(workspace_id, updated_at desc)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_client_request_created",
    sql: "create index idx_agent_client_request_created on agent_client_request(workspace_id, session_id, created_at)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_context_item_session_id_id",
    sql: "create index idx_agent_context_item_session_id_id on agent_context_item(session_id, id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_context_item_session_prev",
    sql: "create index idx_agent_context_item_session_prev on agent_context_item(session_id, prev_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_context_item_run_id",
    sql: "create index idx_agent_context_item_run_id on agent_context_item(run_id, id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_context_item_session_status",
    sql: "create index idx_agent_context_item_session_status on agent_context_item(session_id, status, id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_context_item_session_tool_name",
    sql: "create index idx_agent_context_item_session_tool_name on agent_context_item(session_id, tool_name, id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_context_item_session_archive_id",
    sql: "create index idx_agent_context_item_session_archive_id on agent_context_item(session_id, archive_at, id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_run_session_status",
    sql: "create index idx_agent_run_session_status on agent_run(session_id, status, updated_at desc)"
  });

  createIndexIfNotExists(db, {
    index: "idx_channel_binding_session_id",
    sql: "create index idx_channel_binding_session_id on channel_conversation_binding(session_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_channel_binding_workspace_session",
    sql: "create index idx_channel_binding_workspace_session on channel_conversation_binding(workspace_id, session_id)"
  });

  // dedup: (plugin_id, channel_name, account_id, external_message_id)
  createIndexIfNotExists(db, {
    index: "idx_channel_inbound_message_dedup",
    sql: "create unique index idx_channel_inbound_message_dedup on channel_inbound_message(plugin_id, channel_name, account_id, external_message_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_channel_inbound_message_conversation_created",
    sql: "create index idx_channel_inbound_message_conversation_created on channel_inbound_message(plugin_id, channel_name, account_id, conversation_key, created_at_local)"
  });

  createIndexIfNotExists(db, {
    index: "idx_channel_reply_job_run_id",
    sql: "create unique index idx_channel_reply_job_run_id on channel_reply_job(run_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_channel_reply_job_status",
    sql: "create index idx_channel_reply_job_status on channel_reply_job(status, updated_at desc)"
  });

  // For reply dispatcher polling.
  createIndexIfNotExists(db, {
    index: "idx_channel_reply_job_pending",
    sql: "create index idx_channel_reply_job_pending on channel_reply_job(status, updated_at asc, id asc)"
  });
  createIndexIfNotExists(db, {
    index: "idx_channel_reply_job_session",
    sql: "create index idx_channel_reply_job_session on channel_reply_job(session_id)"
  });
}

function createIndexIfNotExists(db: Db, params: { index: string; sql: string }) {
  const row = db.prepare(`select 1 from sqlite_master where type = 'index' and name = ?`).get(params.index) as any;
  if (row) return;
  db.exec(params.sql);
}
