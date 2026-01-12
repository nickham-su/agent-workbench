import type { Db } from "../../infra/db/db.js";
import type { WorkspaceRecord } from "@agent-workbench/shared";

type WorkspaceRow = {
  id: string;
  repoId: string;
  branch: string;
  path: string;
  createdAt: number;
  updatedAt: number;
};

function mapRow(row: any): WorkspaceRecord {
  return {
    id: row.id,
    repoId: row.repoId,
    branch: row.branch,
    path: row.path,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function insertWorkspace(db: Db, ws: WorkspaceRecord) {
  db.prepare(
    `
      insert into workspaces (id, repo_id, branch, path, created_at, updated_at)
      values (@id, @repoId, @branch, @path, @createdAt, @updatedAt)
    `
  ).run(ws);
}

export function listWorkspaces(db: Db): WorkspaceRecord[] {
  const rows = db
    .prepare(
      `
        select
          id,
          repo_id as repoId,
          branch,
          path,
          created_at as createdAt,
          updated_at as updatedAt
        from workspaces
        order by updated_at desc
      `
    )
    .all() as WorkspaceRow[];
  return rows.map(mapRow);
}

export function getWorkspace(db: Db, workspaceId: string): WorkspaceRecord | null {
  const row = db
    .prepare(
      `
        select
          id,
          repo_id as repoId,
          branch,
          path,
          created_at as createdAt,
          updated_at as updatedAt
        from workspaces
        where id = ?
      `
    )
    .get(workspaceId);
  return row ? mapRow(row) : null;
}

export function updateWorkspaceBranch(db: Db, workspaceId: string, branch: string, updatedAt: number) {
  db.prepare(
    `
      update workspaces
      set branch = @branch, updated_at = @updatedAt
      where id = @workspaceId
    `
  ).run({ workspaceId, branch, updatedAt });
}

export function deleteWorkspaceRecord(db: Db, workspaceId: string) {
  db.prepare(`delete from workspaces where id = ?`).run(workspaceId);
}
