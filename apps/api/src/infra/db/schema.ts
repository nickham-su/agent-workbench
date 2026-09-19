import type { Db } from "./db.js";

/**
 * Message/Part/ToolExecution 数据模型的首个版本。
 *
 * 该版本是破坏性升级：旧 ContextItem 数据不会迁移，也不能和此版本共存。
 */
export const AGENT_SCHEMA_VERSION = 20;

export type AgentSchemaInitResult = {
  /** 旧 Agent 数据已被清理，仍需要由 openDb 清理对应的文件系统数据。 */
  fileCleanupPending: boolean;
};

function tableExists(db: Db, table: string) {
  return Boolean(
    db.prepare("select 1 from sqlite_master where type in ('table', 'view') and name = ?").get(table)
  );
}

function hasColumn(db: Db, table: string, column: string) {
  if (!tableExists(db, table)) return false;
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureColumn(db: Db, params: { table: string; column: string; ddl: string }) {
  if (hasColumn(db, params.table, params.column)) return;
  db.exec(`alter table ${params.table} add column ${params.ddl};`);
}

const TERMINAL_AUTH_CLEANUP_INTENTS = "terminal_auth_cleanup_intents";
const TERMINAL_AUTH_CLEANUP_INDEX = "idx_terminal_auth_cleanup_intents_updated_at";
const TERMINAL_AUTH_CLEANUP_SCHEMA_ERROR = "Unsupported terminal auth cleanup intent schema. Refusing unsafe repair.";

type TableColumn = { name: string; type: string; notnull: number; pk: number };
type ForeignKey = { table: string; from: string; to: string; on_delete: string; on_update: string; match: string };
type Index = { name: string; unique: number; origin: string; partial: number };

function createTerminalAuthCleanupIntentTable(db: Db) {
  db.exec(`
    create table ${TERMINAL_AUTH_CLEANUP_INTENTS} (
      terminal_id text not null,
      artifact_kind text not null check (artifact_kind in ('ssh-key', 'askpass', 'askpass-token', 'legacy')),
      phase text not null check (phase in ('armed', 'recoverable', 'unresolved')),
      artifact_name text not null,
      expected_dev integer,
      expected_ino integer,
      root_dev integer,
      root_ino integer,
      diagnostic text not null,
      updated_at integer not null,
      check (
        (root_dev is null and root_ino is null) or (
          root_dev is not null and root_ino is not null
          and typeof(root_dev) = 'integer' and root_dev >= 0 and root_dev <= 9007199254740991
          and typeof(root_ino) = 'integer' and root_ino >= 0 and root_ino <= 9007199254740991
        )
      ),
      check (
        phase = 'unresolved' or (root_dev is not null and root_ino is not null)
      ),
      primary key (terminal_id, artifact_kind),
      foreign key (terminal_id) references terminals(id) on delete restrict
    );
    create index ${TERMINAL_AUTH_CLEANUP_INDEX}
      on ${TERMINAL_AUTH_CLEANUP_INTENTS}(updated_at);
  `);
}

function terminalAuthCleanupIntentColumns(db: Db, table = TERMINAL_AUTH_CLEANUP_INTENTS) {
  return db.prepare(`pragma table_info(${table})`).all() as TableColumn[];
}

function hasTerminalAuthCleanupIntentForeignKey(db: Db, table = TERMINAL_AUTH_CLEANUP_INTENTS) {
  const foreignKeys = db.prepare(`pragma foreign_key_list(${table})`).all() as ForeignKey[];
  return foreignKeys.length === 1
    && foreignKeys[0]?.table === "terminals"
    && foreignKeys[0]?.from === "terminal_id"
    && foreignKeys[0]?.to === "id"
    && foreignKeys[0]?.on_delete.toUpperCase() === "RESTRICT"
    && foreignKeys[0]?.on_update.toUpperCase() === "NO ACTION"
    && foreignKeys[0]?.match.toUpperCase() === "NONE";
}

function isTextColumn(column: TableColumn | undefined, name: string, requireNotNull = true) {
  return column?.name === name && column.type.toUpperCase() === "TEXT" && (!requireNotNull || column.notnull === 1);
}
function isIntegerColumn(column: TableColumn | undefined, name: string, requireNotNull = true) {
  return column?.name === name && column.type.toUpperCase() === "INTEGER" && (!requireNotNull || column.notnull === 1);
}
function hasPrimaryKey(columns: TableColumn[], expected: Array<{ name: string; position: number }>) {
  return columns.filter((column) => column.pk > 0).length === expected.length
    && expected.every(({ name, position }) => columns.find((column) => column.name === name)?.pk === position);
}
function hasUpdatedAtIndex(db: Db) {
  const indexes = db.prepare(`pragma index_list(${TERMINAL_AUTH_CLEANUP_INTENTS})`).all() as Index[];
  const index = indexes.find((item) => item.name === TERMINAL_AUTH_CLEANUP_INDEX);
  if (!index || index.unique !== 0 || index.origin !== "c" || index.partial !== 0) return false;
  const columns = db.prepare(`pragma index_info(${TERMINAL_AUTH_CLEANUP_INDEX})`).all() as Array<{ seqno: number; name: string }>;
  return columns.length === 1 && columns[0]?.seqno === 0 && columns[0]?.name === "updated_at";
}
function hasOnlyLegacyUpdatedAtIndex(db: Db) {
  const indexes = db.prepare(`pragma index_list(${TERMINAL_AUTH_CLEANUP_INTENTS})`).all() as Index[];
  const explicit = indexes.filter((index) => index.origin === "c");
  const primaryKey = indexes.filter((index) => index.origin === "pk");
  return indexes.length === 2
    && explicit.length === 1 && primaryKey.length === 1
    && hasUpdatedAtIndex(db)
    && primaryKey[0]?.unique === 1 && primaryKey[0]?.partial === 0;
}
function tableSql(db: Db, table: string = TERMINAL_AUTH_CLEANUP_INTENTS) {
  return (db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(table) as { sql?: string } | undefined)?.sql ?? "";
}
function normalizedTableSql(db: Db, table: string = TERMINAL_AUTH_CLEANUP_INTENTS) {
  return tableSql(db, table).toLowerCase().replace(/[\s`"\[\]]/g, "");
}
function hasCanonicalChecks(db: Db) {
  const sql = normalizedTableSql(db);
  return sql.includes("check(phasein('armed','recoverable','unresolved'))")
    && sql.includes("check(artifact_kindin('ssh-key','askpass','askpass-token','legacy'))")
    && sql.includes("(root_devisnullandroot_inoisnull)or(root_devisnotnullandroot_inoisnotnullandtypeof(root_dev)='integer'androot_dev>=0androot_dev<=9007199254740991andtypeof(root_ino)='integer'androot_ino>=0androot_ino<=9007199254740991)")
    && sql.includes("phase='unresolved'or(root_devisnotnullandroot_inoisnotnull)");
}
function noForeignKeyViolations(db: Db) {
  return (db.prepare(`pragma foreign_key_check(${TERMINAL_AUTH_CLEANUP_INTENTS})`).all() as unknown[]).length === 0;
}

function hasOnlyKnownLegacyPhases(db: Db) {
  const invalid = db.prepare(`select 1 from ${TERMINAL_AUTH_CLEANUP_INTENTS}
    where phase not in ('armed', 'recoverable', 'unresolved') limit 1`).get();
  return !invalid;
}

const LEGACY_SINGLE_ROW_WITH_PHASE_SQL = /^createtableterminal_auth_cleanup_intents\(terminal_idtextnotnullprimarykey,phasetextnotnullcheck\(phasein\('armed','recoverable','unresolved'\)\),artifact_nametextnotnull,diagnostictextnotnull,updated_atintegernotnull,foreignkey\(terminal_id\)referencesterminals\(id\)ondeleterestrict\)$/;
const LEGACY_SINGLE_ROW_WITHOUT_PHASE_SQL = /^createtableterminal_auth_cleanup_intents\(terminal_idtextnotnullprimarykey,artifact_nametextnotnull,diagnostictextnotnull,updated_atintegernotnull,foreignkey\(terminal_id\)referencesterminals\(id\)ondeleterestrict\)$/;

function isKnownSingleRowLegacySchema(db: Db) {
  const columns = terminalAuthCleanupIntentColumns(db);
  const shared = hasPrimaryKey(columns, [{ name: "terminal_id", position: 1 }])
    && hasTerminalAuthCleanupIntentForeignKey(db)
    && hasOnlyLegacyUpdatedAtIndex(db)
    && noForeignKeyViolations(db);
  if (!shared) return false;

  const oldWithoutPhase = columns.length === 4
    && isTextColumn(columns[0], "terminal_id")
    && isTextColumn(columns[1], "artifact_name")
    && isTextColumn(columns[2], "diagnostic")
    && isIntegerColumn(columns[3], "updated_at")
    && LEGACY_SINGLE_ROW_WITHOUT_PHASE_SQL.test(normalizedTableSql(db));
  const oldWithPhase = columns.length === 5
    && isTextColumn(columns[0], "terminal_id")
    && isTextColumn(columns[1], "phase")
    && isTextColumn(columns[2], "artifact_name")
    && isTextColumn(columns[3], "diagnostic")
    && isIntegerColumn(columns[4], "updated_at")
    && hasOnlyKnownLegacyPhases(db)
    && LEGACY_SINGLE_ROW_WITH_PHASE_SQL.test(normalizedTableSql(db));
  return oldWithoutPhase || oldWithPhase;
}

function isKnownPerArtifactSchemaWithoutRootAnchor(db: Db) {
  const columns = terminalAuthCleanupIntentColumns(db);
  const sql = normalizedTableSql(db);
  const hasOldChecks = sql.includes("check(phasein('armed','recoverable','unresolved'))")
    && sql.includes("check(artifact_kindin('ssh-key','askpass','askpass-token','legacy'))");
  return columns.length === 8
    && isTextColumn(columns[0], "terminal_id")
    && isTextColumn(columns[1], "artifact_kind")
    && isTextColumn(columns[2], "phase")
    && isTextColumn(columns[3], "artifact_name")
    && isIntegerColumn(columns[4], "expected_dev", false)
    && isIntegerColumn(columns[5], "expected_ino", false)
    && isTextColumn(columns[6], "diagnostic")
    && isIntegerColumn(columns[7], "updated_at")
    && hasPrimaryKey(columns, [{ name: "terminal_id", position: 1 }, { name: "artifact_kind", position: 2 }])
    && hasTerminalAuthCleanupIntentForeignKey(db)
    && hasUpdatedAtIndex(db)
    && hasOldChecks
    && noForeignKeyViolations(db);
}

function isCanonicalTerminalAuthCleanupIntentSchema(db: Db) {
  const columns = terminalAuthCleanupIntentColumns(db);
  return columns.length === 10
    && isTextColumn(columns[0], "terminal_id")
    && isTextColumn(columns[1], "artifact_kind")
    && isTextColumn(columns[2], "phase")
    && isTextColumn(columns[3], "artifact_name")
    && isIntegerColumn(columns[4], "expected_dev", false)
    && isIntegerColumn(columns[5], "expected_ino", false)
    && isIntegerColumn(columns[6], "root_dev", false)
    && isIntegerColumn(columns[7], "root_ino", false)
    && isTextColumn(columns[8], "diagnostic")
    && isIntegerColumn(columns[9], "updated_at")
    && hasPrimaryKey(columns, [{ name: "terminal_id", position: 1 }, { name: "artifact_kind", position: 2 }])
    && hasCanonicalChecks(db)
    && hasTerminalAuthCleanupIntentForeignKey(db)
    && hasUpdatedAtIndex(db)
    && noForeignKeyViolations(db);
}

/**
 * terminal auth root artifact locator 的完整语义验证。正式 v19 缺表可直接创建；
 * 本轮未提交的单 Terminal 旧表只能保守迁为 legacy/unresolved，未知结构拒绝修复。
 */
export function ensureTerminalAuthCleanupIntentSchema(db: Db) {
  const object = db.prepare("select type from sqlite_master where name = ?").get(TERMINAL_AUTH_CLEANUP_INTENTS) as { type: string } | undefined;
  if (!object) {
    createTerminalAuthCleanupIntentTable(db);
    return;
  }
  if (object.type !== "table") throw new Error(TERMINAL_AUTH_CLEANUP_SCHEMA_ERROR);
  if (isCanonicalTerminalAuthCleanupIntentSchema(db)) return;
  const knownSingleRow = isKnownSingleRowLegacySchema(db);
  const knownPerArtifactWithoutRoot = isKnownPerArtifactSchemaWithoutRootAnchor(db);
  if (!knownSingleRow && !knownPerArtifactWithoutRoot) throw new Error(TERMINAL_AUTH_CLEANUP_SCHEMA_ERROR);

  db.transaction(() => {
    db.exec(`drop index if exists ${TERMINAL_AUTH_CLEANUP_INDEX};`);
    db.exec(`alter table ${TERMINAL_AUTH_CLEANUP_INTENTS} rename to terminal_auth_cleanup_intents_legacy_v19;`);
    createTerminalAuthCleanupIntentTable(db);
    db.exec(`
      insert into ${TERMINAL_AUTH_CLEANUP_INTENTS} (
        terminal_id, artifact_kind, phase, artifact_name, expected_dev, expected_ino, root_dev, root_ino, diagnostic, updated_at
      )
      select terminal_id, ${knownPerArtifactWithoutRoot ? "artifact_kind" : "'legacy'"}, 'unresolved', artifact_name, null, null, null, null,
        'legacy terminal auth cleanup locator: ' || diagnostic, updated_at
      from terminal_auth_cleanup_intents_legacy_v19;
      drop table terminal_auth_cleanup_intents_legacy_v19;
    `);
  })();
  if (!isCanonicalTerminalAuthCleanupIntentSchema(db)) throw new Error(TERMINAL_AUTH_CLEANUP_SCHEMA_ERROR);
}

function createBaseSchema(db: Db) {
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

    create table if not exists workspace_deletion (
      workspace_id text primary key,
      dir_name text not null,
      requested_at integer not null,
      updated_at integer not null,
      last_error_code text,
      last_error_message text,
      foreign key (workspace_id) references workspaces(id) on delete cascade
    );
    create index if not exists idx_workspace_deletion_updated_at
      on workspace_deletion(updated_at);

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

  // 历史基础表的增列仅作用于非 Agent 域，绝不重置 Workspace/Repo/凭证数据。
  ensureColumn(db, { table: "repos", column: "credential_id", ddl: "credential_id text" });
  ensureColumn(db, { table: "repos", column: "default_branch", ddl: "default_branch text" });
  ensureColumn(db, { table: "workspaces", column: "dir_name", ddl: "dir_name text" });
  ensureColumn(db, { table: "workspaces", column: "terminal_credential_id", ddl: "terminal_credential_id text" });
  ensureColumn(db, { table: "workspaces", column: "last_used_at", ddl: "last_used_at integer" });
  ensureTerminalAuthCleanupIntentSchema(db);
}

const AGENT_DOMAIN_TABLES = [
  "agent_text_part_fts_map",
  "agent_archived_text_fts",
  "agent_tool_execution",
  "agent_message_part",
  "agent_client_request",
  "session_run_state",
  "agent_session_run_state",
  "agent_session_head",
  "agent_context_item_attachment",
  "agent_context_item",
  "agent_run",
  "agent_session_agent_model_override",
  "agent_message",
  "agent_attachment",
  "agent_session",
  "agent_schema_meta"
] as const;

const LEGACY_AGENT_TABLES = new Set([
  "agent_session",
  "agent_session_agent_model_override",
  "agent_attachment",
  "agent_context_item",
  "agent_context_item_attachment",
  "agent_run",
  "agent_session_head",
  "agent_session_run_state",
  "agent_client_request"
]);

type LegacyAgentTableSignature = { required: readonly string[]; allowed: readonly string[] };

/**
 * 仅列出 ContextItem 时代实际出现过的字段。允许老版本尚未拥有后续可选字段，
 * 但不能接受未知字段或任何目标 Message 模型字段。
 */
const LEGACY_AGENT_TABLE_SIGNATURES: Record<string, LegacyAgentTableSignature> = {
  agent_session: { required: ["id", "workspace_id", "title", "kind", "created_at", "updated_at"], allowed: ["id", "workspace_id", "title", "title_manually_set", "kind", "forked_from_session_id", "forked_from_item_id", "created_at", "updated_at"] },
  agent_session_agent_model_override: { required: ["session_id", "agent_id", "provider_id", "model_id", "updated_at"], allowed: ["session_id", "agent_id", "provider_id", "model_id", "updated_at"] },
  agent_attachment: { required: ["id", "workspace_id", "storage_key", "filename", "media_type", "byte_size", "created_at"], allowed: ["id", "workspace_id", "storage_key", "filename", "media_type", "byte_size", "created_at"] },
  agent_context_item: { required: ["id", "workspace_id", "session_id", "kind", "status", "output_json", "created_at", "updated_at"], allowed: ["id", "workspace_id", "session_id", "run_id", "turn_id", "step", "prev_id", "kind", "status", "output_text", "assistant_reasoning_text", "output_text_truncated", "output_text_artifact_path", "tool_name", "tool_call_id", "tool_call_json", "tool_result_json", "error_message", "error_code", "boundary_reason", "archive_at", "output_json", "created_at", "updated_at"] },
  agent_context_item_attachment: { required: ["context_item_id", "attachment_id", "position"], allowed: ["context_item_id", "attachment_id", "position"] },
  agent_run: { required: ["run_id", "workspace_id", "session_id", "trigger_item_id", "agent_id", "provider_id", "model_id", "status", "created_at", "updated_at"], allowed: ["run_id", "workspace_id", "session_id", "trigger_item_id", "agent_id", "provider_id", "ui_locale", "model_id", "subtask_depth", "parent_run_id", "parent_tool_item_id", "status", "created_at", "updated_at"] },
  agent_session_head: { required: ["workspace_id", "session_id", "head_item_id", "updated_at"], allowed: ["workspace_id", "session_id", "head_item_id", "updated_at"] },
  agent_session_run_state: { required: ["workspace_id", "session_id", "status", "active_run_id", "active_assistant_item_id", "updated_at"], allowed: ["workspace_id", "session_id", "status", "active_run_id", "active_assistant_item_id", "last_response_total_tokens", "run_notice_text", "updated_at", "applied_item_id"] },
  agent_client_request: { required: ["workspace_id", "session_id", "client_request_id", "message_item_id", "run_id", "created_at"], allowed: ["workspace_id", "session_id", "client_request_id", "message_item_id", "run_id", "created_at"] }
};

const TARGET_AGENT_TABLES = new Set([
  "agent_schema_meta",
  "agent_session",
  "agent_session_agent_model_override",
  "agent_attachment",
  "agent_run",
  "agent_message",
  "agent_message_part",
  "agent_tool_execution",
  "agent_client_request",
  "session_run_state",
  "agent_text_part_fts_map",
  "agent_archived_text_fts"
]);

const TARGET_AGENT_TABLE_COLUMNS: Record<string, readonly string[]> = {
  agent_schema_meta: ["id", "version", "file_cleanup_pending", "updated_at"],
  agent_session: ["id", "workspace_id", "title", "title_manually_set", "kind", "head_message_id", "context_root_message_id", "revision", "forked_from_session_id", "forked_from_message_id", "created_at", "updated_at"],
  agent_session_agent_model_override: ["session_id", "agent_id", "provider_id", "model_id", "updated_at"],
  agent_attachment: ["id", "workspace_id", "storage_key", "filename", "media_type", "byte_size", "created_at"],
  agent_run: ["run_id", "workspace_id", "session_id", "trigger_message_id", "agent_id", "provider_id", "model_id", "subtask_depth", "parent_run_id", "parent_tool_execution_id", "status", "created_at", "updated_at", "run_kind"],
  agent_message: ["id", "workspace_id", "previous_message_id", "replaces_message_id", "depth", "type", "status", "origin_session_id", "origin_run_id", "updated_revision", "created_at", "updated_at"],
  agent_message_part: ["id", "message_id", "position", "type", "text", "attachment_id", "media_type", "filename", "tool_name", "tool_input_json", "provider_tool_call_id", "updated_revision", "created_at", "updated_at", "provider_replay_json"],
  agent_tool_execution: ["id", "call_part_id", "origin_session_id", "origin_run_id", "status", "result_preview", "result_truncated", "result_artifact_path", "structured_result_json", "error", "updated_revision", "created_at", "updated_at", "started_at", "completed_at"],
  agent_client_request: ["workspace_id", "session_id", "client_request_id", "message_id", "run_id", "created_at"],
  session_run_state: ["workspace_id", "session_id", "status", "active_run_id", "run_notice_text", "retry_count", "next_retry_at", "active_assistant_message_id", "non_terminal_message_ids_json", "non_terminal_tool_execution_ids_json", "updated_at"],
  agent_text_part_fts_map: ["part_id", "fts_rowid", "created_at"],
  agent_archived_text_fts: ["text", "message_depth", "part_position"]
};

const PRE_RUN_KIND_AGENT_RUN_COLUMNS = ["run_id", "workspace_id", "session_id", "trigger_message_id", "agent_id", "provider_id", "model_id", "subtask_depth", "parent_run_id", "parent_tool_execution_id", "status", "created_at", "updated_at"] as const;
const PRE_PROVIDER_REPLAY_AGENT_MESSAGE_PART_COLUMNS = TARGET_AGENT_TABLE_COLUMNS.agent_message_part.filter((column) => column !== "provider_replay_json");

type AgentSchemaClassification = "clean" | "legacy-unversioned" | "current" | "upgradeable" | "unsupported";

function listAgentSchemaObjects(db: Db) {
  return (db.prepare(`
    select name, type, sql
    from sqlite_master
    where (type = 'table' or type = 'view')
      and (name like 'agent\\_%' escape '\\' or name = 'session_run_state')
  `).all() as Array<{ name: string; type: "table" | "view"; sql: string | null }>);
}

function isAgentFtsShadowTable(name: string) {
  return /^agent_archived_text_fts_(?:data|idx|content|docsize|config)$/.test(name);
}

function tableColumns(db: Db, table: string) {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function hasExactColumns(db: Db, table: string, expected: readonly string[]) {
  const actual = tableColumns(db, table);
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function hasUniqueIndex(db: Db, table: string, columns: readonly string[]) {
  const indexes = db.prepare(`pragma index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  return indexes.some((index) => {
    if (index.unique !== 1) return false;
    const indexedColumns = (db.prepare(`pragma index_info(${index.name})`).all() as Array<{ name: string }>).map((row) => row.name);
    return indexedColumns.length === columns.length && indexedColumns.every((column, index) => column === columns[index]);
  });
}

function hasForeignKey(db: Db, table: string, params: { from: string; table: string; to: string; onDelete: string }) {
  return (db.prepare(`pragma foreign_key_list(${table})`).all() as Array<{ from: string; table: string; to: string; on_delete: string }>).some((foreignKey) => (
    foreignKey.from === params.from
    && foreignKey.table === params.table
    && foreignKey.to === params.to
    && foreignKey.on_delete.toLowerCase() === params.onDelete.toLowerCase()
  ));
}

function hasTriggerSemantics(db: Db, name: string, fragments: readonly string[]) {
  const row = db.prepare("select sql from sqlite_master where type = 'trigger' and name = ?").get(name) as { sql: string | null } | undefined;
  const sql = row?.sql?.toLowerCase();
  return Boolean(sql && fragments.every((fragment) => sql.includes(fragment.toLowerCase())));
}

function hasCurrentSchemaSemantics(db: Db, ftsSql: string | null) {
  const normalizedFtsSql = ftsSql?.toLowerCase() ?? "";
  if (!normalizedFtsSql.includes("create virtual table") || !normalizedFtsSql.includes("using fts5") || !normalizedFtsSql.includes("tokenize = 'trigram'")) return false;

  const uniqueConstraints = [
    ["agent_message_part", ["message_id", "position"]],
    ["agent_tool_execution", ["call_part_id"]],
    ["agent_text_part_fts_map", ["part_id"]],
    ["agent_text_part_fts_map", ["fts_rowid"]]
  ] as const;
  if (uniqueConstraints.some(([table, columns]) => !hasUniqueIndex(db, table, columns))) return false;

  const foreignKeys = [
    ["agent_message_part", { from: "message_id", table: "agent_message", to: "id", onDelete: "restrict" }],
    ["agent_message_part", { from: "attachment_id", table: "agent_attachment", to: "id", onDelete: "restrict" }],
    ["agent_tool_execution", { from: "call_part_id", table: "agent_message_part", to: "id", onDelete: "restrict" }],
    ["agent_tool_execution", { from: "origin_session_id", table: "agent_session", to: "id", onDelete: "set null" }],
    ["agent_tool_execution", { from: "origin_run_id", table: "agent_run", to: "run_id", onDelete: "set null" }],
    ["agent_text_part_fts_map", { from: "part_id", table: "agent_message_part", to: "id", onDelete: "restrict" }],
    ["agent_message", { from: "origin_session_id", table: "agent_session", to: "id", onDelete: "set null" }],
    ["agent_message", { from: "origin_run_id", table: "agent_run", to: "run_id", onDelete: "set null" }],
    ["agent_session", { from: "head_message_id", table: "agent_message", to: "id", onDelete: "restrict" }],
    ["agent_session", { from: "context_root_message_id", table: "agent_message", to: "id", onDelete: "restrict" }]
  ] as const;
  if (foreignKeys.some(([table, params]) => !hasForeignKey(db, table, params))) return false;

  return hasTriggerSemantics(db, "agent_message_previous_workspace_insert", ["before insert on agent_message", "new.previous_message_id", "workspace_id = new.workspace_id"])
    && hasTriggerSemantics(db, "agent_message_replaces_workspace_insert", ["before insert on agent_message", "new.replaces_message_id", "workspace_id = new.workspace_id"])
    && hasTriggerSemantics(db, "agent_tool_execution_call_part_insert", ["before insert on agent_tool_execution", "part.type = 'tool_call'", "message.workspace_id", "session.workspace_id = message.workspace_id", "run.workspace_id = message.workspace_id"])
    && hasTriggerSemantics(db, "agent_tool_execution_call_part_update", ["before update of call_part_id, origin_session_id, origin_run_id on agent_tool_execution", "part.type = 'tool_call'", "message.workspace_id"])
    && hasTriggerSemantics(db, "agent_message_session_head_workspace_update", ["before update of head_message_id, context_root_message_id on agent_session", "workspace_id = new.workspace_id"])
    && hasTriggerSemantics(db, "agent_message_session_head_workspace_insert", ["before insert on agent_session", "workspace_id = new.workspace_id"]);
}

function hasLegacySchemaSignature(db: Db, table: string) {
  const signature = LEGACY_AGENT_TABLE_SIGNATURES[table];
  if (!signature) return false;
  const actual = tableColumns(db, table);
  return signature.required.every((column) => actual.includes(column))
    && actual.every((column) => signature.allowed.includes(column));
}

function classifyAgentSchema(db: Db): AgentSchemaClassification {
  const allObjects = listAgentSchemaObjects(db);
  const ftsShadows = allObjects.filter((object) => isAgentFtsShadowTable(object.name));
  const objects = allObjects.filter((object) => !isAgentFtsShadowTable(object.name));
  const names = new Set(objects.map((object) => object.name));
  const hasMeta = names.has("agent_schema_meta");

  if (ftsShadows.length > 0 && !names.has("agent_archived_text_fts")) return "unsupported";

  if (hasMeta) {
    if (objects.some((object) => object.type !== "table") || names.size !== TARGET_AGENT_TABLES.size || [...names].some((name) => !TARGET_AGENT_TABLES.has(name))) {
      return "unsupported";
    }
    const rows = db.prepare("select id, version from agent_schema_meta").all() as Array<{ id: unknown; version: unknown }>;
    if (rows.length !== 1 || rows[0]?.id !== 1) return "unsupported";
    const version = rows[0]?.version;
    const expectedColumns = [...TARGET_AGENT_TABLES].every((table) => {
      if (table === "agent_run") {
        return version === 18
          ? hasExactColumns(db, table, PRE_RUN_KIND_AGENT_RUN_COLUMNS)
          : hasExactColumns(db, table, TARGET_AGENT_TABLE_COLUMNS[table]!);
      }
      if (table === "agent_message_part") {
        return version === 18 || version === 19
          ? hasExactColumns(db, table, PRE_PROVIDER_REPLAY_AGENT_MESSAGE_PART_COLUMNS)
          : hasExactColumns(db, table, TARGET_AGENT_TABLE_COLUMNS[table]!);
      }
      return hasExactColumns(db, table, TARGET_AGENT_TABLE_COLUMNS[table]!);
    });
    if (!expectedColumns) return "unsupported";
    const fts = objects.find((object) => object.name === "agent_archived_text_fts");
    if (!hasCurrentSchemaSemantics(db, fts?.sql ?? null)) return "unsupported";
    if (version === AGENT_SCHEMA_VERSION) return "current";
    if (version === 18 || version === 19) return "upgradeable";
    return "unsupported";
  }

  if (objects.length === 0) return "clean";
  if (objects.some((object) => object.type !== "table" || !LEGACY_AGENT_TABLES.has(object.name))) return "unsupported";
  if (!names.has("agent_context_item")) return "unsupported";
  if ([...names].some((table) => !hasLegacySchemaSignature(db, table))) return "unsupported";
  return "legacy-unversioned";
}

function clearAndDropAgentDomain(db: Db) {
  // 该分支会完整放弃旧 Agent 域，无需先逐行 DELETE。旧版本或中断升级可能
  // 留下引用已缺失父表的外键；调用方会在事务外暂时关闭 foreign_keys，使这里
  // 只依赖已知对象名，而不依赖旧外键图仍然完整。
  for (const table of [...AGENT_DOMAIN_TABLES].reverse()) {
    if (tableExists(db, table)) db.exec(`drop table ${table};`);
  }
}

function assertAgentForeignKeysValid(db: Db) {
  for (const table of TARGET_AGENT_TABLES) {
    if (table === "agent_archived_text_fts") continue;
    const violations = db.prepare(`pragma foreign_key_check("${table}")`).all() as unknown[];
    if (violations.length > 0) {
      throw new Error(`Agent schema foreign key check failed for ${table}.`);
    }
  }
}

function rebuildAgentDomain(db: Db, fileCleanupPending: boolean) {
  if (db.inTransaction) {
    throw new Error("Agent domain rebuild must run outside an active transaction.");
  }
  const foreignKeysEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  db.pragma("foreign_keys = OFF");
  if (Number(db.pragma("foreign_keys", { simple: true })) !== 0) {
    throw new Error("Agent domain rebuild must run outside an active transaction.");
  }
  try {
    db.transaction(() => {
      clearAndDropAgentDomain(db);
      createAgentSchema(db, fileCleanupPending);
      assertAgentForeignKeysValid(db);
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
  }
}

function createAgentSchema(db: Db, fileCleanupPending: boolean) {
  db.exec(`
    create table agent_schema_meta (
      id integer primary key check (id = 1),
      version integer not null,
      file_cleanup_pending integer not null default 0 check (file_cleanup_pending in (0, 1)),
      updated_at integer not null
    );

    create table agent_session (
      id text primary key,
      workspace_id text not null,
      title text not null,
      title_manually_set integer not null default 0 check (title_manually_set in (0, 1)),
      kind text not null check (kind in ('primary', 'subtask')),
      head_message_id text,
      context_root_message_id text,
      revision integer not null default 0 check (revision >= 0),
      forked_from_session_id text,
      forked_from_message_id text,
      created_at integer not null,
      updated_at integer not null,
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (head_message_id) references agent_message(id) on delete restrict,
      foreign key (context_root_message_id) references agent_message(id) on delete restrict
    );
    create index idx_agent_session_workspace_updated on agent_session(workspace_id, updated_at desc);

    create table agent_session_agent_model_override (
      session_id text not null,
      agent_id text not null,
      provider_id text not null,
      model_id text not null,
      updated_at integer not null,
      primary key (session_id, agent_id),
      foreign key (session_id) references agent_session(id) on delete cascade
    );

    create table agent_attachment (
      id text primary key,
      workspace_id text not null,
      storage_key text not null,
      filename text not null check (length(filename) between 1 and 255),
      media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
      byte_size integer not null check (byte_size between 1 and 10485760),
      created_at integer not null,
      unique (workspace_id, storage_key),
      foreign key (workspace_id) references workspaces(id) on delete restrict
    );
    create index idx_agent_attachment_workspace_created on agent_attachment(workspace_id, created_at desc);

    create table agent_run (
      run_id text primary key,
      workspace_id text not null,
      session_id text not null,
      trigger_message_id text,
      agent_id text not null,
      provider_id text not null,
      model_id text not null,
      subtask_depth integer,
      parent_run_id text,
      parent_tool_execution_id text,
      status text not null,
      created_at integer not null,
      updated_at integer not null,
      run_kind text not null default 'user' check (run_kind in ('user', 'manual_compaction', 'subtask')),
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (session_id) references agent_session(id) on delete cascade,
      foreign key (trigger_message_id) references agent_message(id) on delete restrict,
      foreign key (parent_run_id) references agent_run(run_id) on delete set null,
      foreign key (parent_tool_execution_id) references agent_tool_execution(id) on delete set null
    );
    create unique index idx_agent_run_parent_tool_execution_unique on agent_run(parent_run_id, parent_tool_execution_id) where parent_run_id is not null and parent_tool_execution_id is not null;
    create index idx_agent_run_session_status on agent_run(session_id, status);

    create table agent_message (
      id text primary key,
      workspace_id text not null,
      previous_message_id text,
      replaces_message_id text,
      depth integer not null check (depth >= 0),
      type text not null check (type in ('user', 'assistant', 'system', 'compaction', 'runtime')),
      status text not null check (status in ('streaming', 'completed', 'failed', 'cancelled', 'superseded')),
      origin_session_id text,
      origin_run_id text,
      updated_revision integer not null check (updated_revision >= 0),
      created_at integer not null,
      updated_at integer not null,
      foreign key (workspace_id) references workspaces(id) on delete restrict,
      foreign key (previous_message_id) references agent_message(id) on delete restrict,
      foreign key (replaces_message_id) references agent_message(id) on delete restrict,
      foreign key (origin_session_id) references agent_session(id) on delete set null,
      foreign key (origin_run_id) references agent_run(run_id) on delete set null
    );
    create index idx_agent_message_workspace_depth on agent_message(workspace_id, depth);
    create index idx_agent_message_origin_revision on agent_message(origin_session_id, updated_revision);

    create table agent_message_part (
      id text primary key,
      message_id text not null,
      position integer not null check (position >= 0),
      type text not null check (type in ('text', 'reasoning', 'image', 'tool_call')),
      text text,
      attachment_id text,
      media_type text,
      filename text,
      tool_name text,
      tool_input_json text,
      provider_tool_call_id text,
      updated_revision integer not null check (updated_revision >= 0),
      created_at integer not null,
      updated_at integer not null,
      provider_replay_json text,
      unique (message_id, position),
      check (
        (type in ('text', 'reasoning') and text is not null and attachment_id is null and media_type is null and filename is null and tool_name is null and tool_input_json is null and provider_tool_call_id is null)
        or (type = 'image' and text is null and attachment_id is not null and media_type is not null and filename is not null and tool_name is null and tool_input_json is null and provider_tool_call_id is null)
        or (type = 'tool_call' and text is null and attachment_id is null and media_type is null and filename is null and tool_name is not null and tool_input_json is not null)
      ),
      foreign key (message_id) references agent_message(id) on delete restrict,
      foreign key (attachment_id) references agent_attachment(id) on delete restrict
    );
    create index idx_agent_part_message_type_position on agent_message_part(message_id, type, position);

    create table agent_tool_execution (
      id text primary key,
      call_part_id text not null unique,
      origin_session_id text,
      origin_run_id text,
      status text not null check (status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown')),
      result_preview text,
      result_truncated integer not null default 0 check (result_truncated in (0, 1)),
      result_artifact_path text,
      structured_result_json text,
      error text,
      updated_revision integer not null check (updated_revision >= 0),
      created_at integer not null,
      updated_at integer not null,
      started_at integer,
      completed_at integer,
      foreign key (call_part_id) references agent_message_part(id) on delete restrict,
      foreign key (origin_session_id) references agent_session(id) on delete set null,
      foreign key (origin_run_id) references agent_run(run_id) on delete set null
    );
    create index idx_agent_tool_execution_origin_revision on agent_tool_execution(origin_session_id, updated_revision);
    create index idx_agent_tool_execution_status_origin on agent_tool_execution(origin_run_id, status);

    create table agent_client_request (
      workspace_id text not null,
      session_id text not null,
      client_request_id text not null,
      message_id text not null,
      run_id text not null,
      created_at integer not null,
      primary key (workspace_id, session_id, client_request_id),
      foreign key (session_id) references agent_session(id) on delete cascade,
      foreign key (message_id) references agent_message(id) on delete restrict,
      foreign key (run_id) references agent_run(run_id) on delete cascade
    );

    create table session_run_state (
      workspace_id text not null,
      session_id text not null,
      status text not null check (status in ('idle', 'running')),
      active_run_id text,
      run_notice_text text not null default '',
      retry_count integer not null default 0 check (retry_count >= 0),
      next_retry_at integer,
      active_assistant_message_id text,
      non_terminal_message_ids_json text not null default '[]',
      non_terminal_tool_execution_ids_json text not null default '[]',
      updated_at integer not null,
      primary key (workspace_id, session_id),
      foreign key (session_id) references agent_session(id) on delete cascade,
      foreign key (active_run_id) references agent_run(run_id) on delete set null,
      foreign key (active_assistant_message_id) references agent_message(id) on delete set null
    );

    create virtual table agent_archived_text_fts using fts5(
      text,
      message_depth unindexed,
      part_position unindexed,
      tokenize = 'trigram'
    );

    create table agent_text_part_fts_map (
      part_id text primary key,
      fts_rowid integer not null unique,
      created_at integer not null,
      foreign key (part_id) references agent_message_part(id) on delete restrict
    );

    create trigger agent_message_previous_workspace_insert
    before insert on agent_message
    when new.previous_message_id is not null
      and not exists (select 1 from agent_message where id = new.previous_message_id and workspace_id = new.workspace_id)
    begin
      select raise(abort, 'agent_message.previous_message_id must reference the same workspace');
    end;

    create trigger agent_message_replaces_workspace_insert
    before insert on agent_message
    when new.replaces_message_id is not null
      and not exists (select 1 from agent_message where id = new.replaces_message_id and workspace_id = new.workspace_id)
    begin
      select raise(abort, 'agent_message.replaces_message_id must reference the same workspace');
    end;

    create trigger agent_tool_execution_call_part_insert
    before insert on agent_tool_execution
    when not exists (
      select 1
      from agent_message_part part
      join agent_message message on message.id = part.message_id
      where part.id = new.call_part_id
        and part.type = 'tool_call'
        and (new.origin_session_id is null or exists (
          select 1 from agent_session session where session.id = new.origin_session_id and session.workspace_id = message.workspace_id
        ))
        and (new.origin_run_id is null or exists (
          select 1 from agent_run run where run.run_id = new.origin_run_id and run.workspace_id = message.workspace_id
        ))
    )
    begin
      select raise(abort, 'agent_tool_execution.call_part_id must reference a same-workspace tool_call part');
    end;

    create trigger agent_tool_execution_call_part_update
    before update of call_part_id, origin_session_id, origin_run_id on agent_tool_execution
    when not exists (
      select 1
      from agent_message_part part
      join agent_message message on message.id = part.message_id
      where part.id = new.call_part_id
        and part.type = 'tool_call'
        and (new.origin_session_id is null or exists (
          select 1 from agent_session session where session.id = new.origin_session_id and session.workspace_id = message.workspace_id
        ))
        and (new.origin_run_id is null or exists (
          select 1 from agent_run run where run.run_id = new.origin_run_id and run.workspace_id = message.workspace_id
        ))
    )
    begin
      select raise(abort, 'agent_tool_execution.call_part_id must reference a same-workspace tool_call part');
    end;

    create trigger agent_message_session_head_workspace_update
    before update of head_message_id, context_root_message_id on agent_session
    when (new.head_message_id is not null and not exists (select 1 from agent_message where id = new.head_message_id and workspace_id = new.workspace_id))
      or (new.context_root_message_id is not null and not exists (select 1 from agent_message where id = new.context_root_message_id and workspace_id = new.workspace_id))
    begin
      select raise(abort, 'agent_session message pointers must reference the same workspace');
    end;

    create trigger agent_message_session_head_workspace_insert
    before insert on agent_session
    when (new.head_message_id is not null and not exists (select 1 from agent_message where id = new.head_message_id and workspace_id = new.workspace_id))
      or (new.context_root_message_id is not null and not exists (select 1 from agent_message where id = new.context_root_message_id and workspace_id = new.workspace_id))
    begin
      select raise(abort, 'agent_session message pointers must reference the same workspace');
    end;
  `);

  db.prepare(
    "insert into agent_schema_meta (id, version, file_cleanup_pending, updated_at) values (1, ?, ?, ?)"
  ).run(AGENT_SCHEMA_VERSION, fileCleanupPending ? 1 : 0, Date.now());
}

/**
 * 初始化非 Agent 基础表，并在需要时以单事务清空旧 Agent 域后建立目标模型。
 * 文件系统清理由 openDb 在事务提交后完成；失败时 pending 标记保留并在下次启动重试。
 */
export function initSchema(db: Db): AgentSchemaInitResult {
  const classification = classifyAgentSchema(db);
  if (classification === "unsupported") throwUnsupportedAgentSchema();

  createBaseSchema(db);

  if (classification === "current") {
    const row = db.prepare("select file_cleanup_pending as fileCleanupPending from agent_schema_meta where id = 1").get() as {
      fileCleanupPending: number;
    };
    return { fileCleanupPending: row.fileCleanupPending === 1 };
  }

  if (classification === "upgradeable") {
    db.transaction(() => {
      const row = db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number };
      if (row.version === 18) {
        ensureColumn(db, {
          table: "agent_run",
          column: "run_kind",
          ddl: "run_kind text not null default 'user' check (run_kind in ('user', 'manual_compaction', 'subtask'))",
        });
        db.prepare("update agent_schema_meta set version = 19, updated_at = ? where id = 1").run(Date.now());
      }
      const current = db.prepare("select version from agent_schema_meta where id = 1").get() as { version: number };
      if (current.version === 19) {
        ensureColumn(db, {
          table: "agent_message_part",
          column: "provider_replay_json",
          ddl: "provider_replay_json text",
        });
        db.prepare("update agent_schema_meta set version = ?, updated_at = ? where id = 1").run(AGENT_SCHEMA_VERSION, Date.now());
      }
    })();
    const row = db.prepare("select file_cleanup_pending as fileCleanupPending from agent_schema_meta where id = 1").get() as { fileCleanupPending: number };
    return { fileCleanupPending: row.fileCleanupPending === 1 };
  }

  const hadAgentDomain = classification === "legacy-unversioned";
  rebuildAgentDomain(db, hadAgentDomain);
  return { fileCleanupPending: hadAgentDomain };
}

function throwUnsupportedAgentSchema(): never {
  throw new Error("Unsupported Agent schema state. Refusing destructive upgrade.");
}

export function assertAgentSchemaSupported(db: Db) {
  if (classifyAgentSchema(db) === "unsupported") {
    throwUnsupportedAgentSchema();
  }
}

export function isAgentFileCleanupPending(db: Db) {
  if (classifyAgentSchema(db) !== "current") return false;
  const row = db.prepare("select file_cleanup_pending as fileCleanupPending from agent_schema_meta where id = 1").get() as {
    fileCleanupPending: number;
  };
  return row.fileCleanupPending === 1;
}

export function markAgentFileCleanupComplete(db: Db) {
  db.prepare("update agent_schema_meta set file_cleanup_pending = 0, updated_at = ? where id = 1").run(Date.now());
}
