import type { Db } from "../../infra/db/db.js";
import type { TerminalRecord, TerminalStatus } from "@agent-workbench/shared";

type TerminalRow = {
  id: string;
  workspaceId: string;
  configId: string | null;
  sessionName: string;
  status: TerminalStatus;
  createdAt: number;
  updatedAt: number;
};

type TerminalCountRow = {
  workspaceId: string;
  cnt: number;
};

function mapRow(row: any): TerminalRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    configId: row.configId,
    sessionName: row.sessionName,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function insertTerminal(db: Db, term: TerminalRecord) {
  db.prepare(
    `
      insert into terminals (id, workspace_id, config_id, session_name, status, created_at, updated_at)
      values (@id, @workspaceId, @configId, @sessionName, @status, @createdAt, @updatedAt)
    `
  ).run({ ...term, configId: term.configId ?? null });
}

export function listTerminalsByWorkspace(db: Db, workspaceId: string): TerminalRecord[] {
  const rows = db
    .prepare(
      `
        select
          id,
          workspace_id as workspaceId,
          config_id as configId,
          session_name as sessionName,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from terminals
        where workspace_id = ?
        order by created_at asc
      `
    )
    .all(workspaceId) as TerminalRow[];
  return rows.map(mapRow);
}

export function listActiveTerminalsByWorkspace(db: Db, workspaceId: string): TerminalRecord[] {
  const rows = db
    .prepare(
      `
        select
          id,
          workspace_id as workspaceId,
          config_id as configId,
          session_name as sessionName,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from terminals
        where workspace_id = ? and status = 'active'
        order by created_at asc
      `
    )
    .all(workspaceId) as TerminalRow[];
  return rows.map(mapRow);
}

export function countActiveTerminalsByWorkspace(db: Db, workspaceId: string): number {
  const row = db
    .prepare(
      `
        select count(*) as cnt
        from terminals
        where workspace_id = ? and status = 'active'
      `
    )
    .get(workspaceId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function countActiveTerminalsByWorkspaceIds(db: Db, workspaceIds: string[]): Record<string, number> {
  if (workspaceIds.length === 0) return {};
  const placeholders = workspaceIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
        select workspace_id as workspaceId, count(*) as cnt
        from terminals
        where status = 'active' and workspace_id in (${placeholders})
        group by workspace_id
      `
    )
    .all(...workspaceIds) as TerminalCountRow[];

  const out: Record<string, number> = {};
  for (const row of rows) out[row.workspaceId] = row.cnt;
  return out;
}

export function getTerminal(db: Db, terminalId: string): TerminalRecord | null {
  const row = db
    .prepare(
      `
        select
          id,
          workspace_id as workspaceId,
          config_id as configId,
          session_name as sessionName,
          status,
          created_at as createdAt,
          updated_at as updatedAt
        from terminals
        where id = ?
      `
    )
    .get(terminalId);
  return row ? mapRow(row) : null;
}

export function updateTerminalStatus(db: Db, terminalId: string, status: TerminalStatus, updatedAt: number) {
  db.prepare(
    `
      update terminals
      set status = @status, updated_at = @updatedAt
      where id = @terminalId
    `
  ).run({ terminalId, status, updatedAt });
}

/** Hide a logically deleted managed terminal without losing its cleanup authority. */
export function clearTerminalConfigAssociation(db: Db, terminalId: string) {
  db.prepare(`update terminals set config_id = null where id = ?`).run(terminalId);
}

export function deleteTerminalRecord(db: Db, terminalId: string) {
  db.prepare(`delete from terminals where id = ?`).run(terminalId);
}

export function deleteTerminalRecordsByWorkspace(db: Db, workspaceId: string) {
  db.prepare(`delete from terminals where workspace_id = ?`).run(workspaceId);
}

/** Managed terminals retain their tab after a failed restart; ordinary closed terminals stay hidden. */
export function listVisibleTerminalsByWorkspace(db: Db, workspaceId: string): TerminalRecord[] {
  return listTerminalsByWorkspace(db, workspaceId).filter((term) => term.status === "active" || term.configId != null);
}

export function getTerminalByConfig(db: Db, workspaceId: string, configId: string): TerminalRecord | null {
  const row = db.prepare(`select id from terminals where workspace_id = ? and config_id = ?`).get(workspaceId, configId) as { id: string } | undefined;
  return row ? getTerminal(db, row.id) : null;
}

export function restartTerminalRecord(db: Db, term: TerminalRecord) {
  db.prepare(`update terminals set session_name = @sessionName, status = 'creating', updated_at = @updatedAt where id = @id`)
    .run({ id: term.id, sessionName: term.sessionName, updatedAt: term.updatedAt });
}
