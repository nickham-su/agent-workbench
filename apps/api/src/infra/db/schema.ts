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
      forked_from_event_id text,
      foreign key (workspace_id) references workspaces(id) on delete restrict
    );

    create table if not exists agent_session_head (
      workspace_id text not null,
      session_id text not null,
      head_event_id text,
      updated_at integer not null,
      primary key (workspace_id, session_id),
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table if not exists agent_event (
      event_id integer primary key autoincrement,
      id text not null unique,
      workspace_id text not null,
      session_id text not null,
      lane text not null,
      prev_id text,
      type text not null,
      schema_version integer not null,
      correlation_id text,
      causation_id text,
      created_at integer not null,
      payload_json text not null,
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table if not exists agent_client_request (
      workspace_id text not null,
      session_id text not null,
      client_request_id text not null,
      message_event_id text not null,
      run_id text not null,
      created_at integer not null,
      primary key (workspace_id, session_id, client_request_id)
    );

    create table if not exists agent_session_run_state (
      workspace_id text not null,
      session_id text not null,
      status text not null,
      active_run_id text,
      updated_at integer not null,
      applied_event_id integer not null,
      primary key (workspace_id, session_id),
      foreign key (session_id) references agent_session(id) on delete cascade
    );
  `);

  ensureColumn(db, { table: "repos", column: "credential_id", ddl: "credential_id text" });
  ensureColumn(db, { table: "repos", column: "default_branch", ddl: "default_branch text" });
  ensureColumn(db, { table: "workspaces", column: "dir_name", ddl: "dir_name text" });
  ensureColumn(db, { table: "workspaces", column: "terminal_credential_id", ddl: "terminal_credential_id text" });
  ensureColumn(db, { table: "workspaces", column: "last_used_at", ddl: "last_used_at integer" });
  createIndexIfNotExists(db, { index: "idx_repos_credential_id", sql: "create index idx_repos_credential_id on repos(credential_id)" });
  createIndexIfNotExists(db, { index: "idx_workspaces_dir_name", sql: "create unique index idx_workspaces_dir_name on workspaces(dir_name)" });
  createIndexIfNotExists(db, { index: "idx_workspaces_last_used_at", sql: "create index idx_workspaces_last_used_at on workspaces(last_used_at)" });
  createIndexIfNotExists(db, {
    index: "idx_agent_session_workspace_updated",
    sql: "create index idx_agent_session_workspace_updated on agent_session(workspace_id, updated_at desc)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_event_workspace_event_id",
    sql: "create index idx_agent_event_workspace_event_id on agent_event(workspace_id, event_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_event_workspace_session_event_id",
    sql: "create index idx_agent_event_workspace_session_event_id on agent_event(workspace_id, session_id, event_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_event_session_lane_prev",
    sql: "create index idx_agent_event_session_lane_prev on agent_event(session_id, lane, prev_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_event_workspace_lane_event_id",
    sql: "create index idx_agent_event_workspace_lane_event_id on agent_event(workspace_id, lane, event_id)"
  });
  createIndexIfNotExists(db, {
    index: "idx_agent_client_request_created",
    sql: "create index idx_agent_client_request_created on agent_client_request(workspace_id, session_id, created_at)"
  });
}

function createIndexIfNotExists(db: Db, params: { index: string; sql: string }) {
  const row = db.prepare(`select 1 from sqlite_master where type = 'index' and name = ?`).get(params.index) as any;
  if (row) return;
  db.exec(params.sql);
}
