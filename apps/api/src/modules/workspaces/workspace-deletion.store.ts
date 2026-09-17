import type { Db } from "../../infra/db/db.js";

export type WorkspaceDeletionIntent = {
  workspaceId: string;
  dirName: string;
  requestedAt: number;
  updatedAt: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

function mapRow(row: any): WorkspaceDeletionIntent {
  return {
    workspaceId: row.workspaceId,
    dirName: row.dirName,
    requestedAt: row.requestedAt,
    updatedAt: row.updatedAt,
    lastErrorCode: row.lastErrorCode ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
  };
}

export function getWorkspaceDeletionIntent(db: Db, workspaceId: string): WorkspaceDeletionIntent | null {
  const row = db.prepare(`
    select workspace_id as workspaceId, dir_name as dirName, requested_at as requestedAt,
           updated_at as updatedAt, last_error_code as lastErrorCode,
           last_error_message as lastErrorMessage
    from workspace_deletion where workspace_id = ?
  `).get(workspaceId);
  return row ? mapRow(row) : null;
}

export function listWorkspaceDeletionIntents(db: Db): WorkspaceDeletionIntent[] {
  return (db.prepare(`
    select workspace_id as workspaceId, dir_name as dirName, requested_at as requestedAt,
           updated_at as updatedAt, last_error_code as lastErrorCode,
           last_error_message as lastErrorMessage
    from workspace_deletion order by requested_at, workspace_id
  `).all() as any[]).map(mapRow);
}

export function upsertWorkspaceDeletionIntent(db: Db, input: { workspaceId: string; dirName: string; now: number }) {
  db.prepare(`
    insert into workspace_deletion (workspace_id, dir_name, requested_at, updated_at, last_error_code, last_error_message)
    values (@workspaceId, @dirName, @now, @now, null, null)
    on conflict(workspace_id) do update set
      dir_name = excluded.dir_name,
      updated_at = excluded.updated_at,
      last_error_code = null,
      last_error_message = null
  `).run(input);
}

export function recordWorkspaceDeletionFailure(db: Db, input: {
  workspaceId: string;
  now: number;
  code: string;
  message: string;
}) {
  db.prepare(`
    update workspace_deletion
    set updated_at = @now, last_error_code = @code, last_error_message = @message
    where workspace_id = @workspaceId
  `).run(input);
}
