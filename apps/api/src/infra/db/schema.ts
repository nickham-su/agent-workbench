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
      title text not null,
      path text not null,
      terminal_credential_id text,
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
  `);

  ensureColumn(db, { table: "repos", column: "credential_id", ddl: "credential_id text" });
  ensureColumn(db, { table: "repos", column: "default_branch", ddl: "default_branch text" });
  ensureColumn(db, { table: "workspaces", column: "terminal_credential_id", ddl: "terminal_credential_id text" });
  createIndexIfNotExists(db, { index: "idx_repos_credential_id", sql: "create index idx_repos_credential_id on repos(credential_id)" });
}

function createIndexIfNotExists(db: Db, params: { index: string; sql: string }) {
  const row = db.prepare(`select 1 from sqlite_master where type = 'index' and name = ?`).get(params.index) as any;
  if (row) return;
  db.exec(params.sql);
}
