import type { Db } from "../../infra/db/db.js";
import type { WorkspaceRecord } from "@agent-workbench/shared";

type WorkspaceRow = {
  id: string;
  title: string;
  path: string;
  terminalCredentialId: string | null;
  createdAt: number;
  updatedAt: number;
};

function mapRow(row: any): WorkspaceRecord {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    terminalCredentialId: row.terminalCredentialId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function insertWorkspace(db: Db, ws: WorkspaceRecord) {
  db.prepare(
    `
      insert into workspaces (id, title, path, terminal_credential_id, created_at, updated_at)
      values (@id, @title, @path, @terminalCredentialId, @createdAt, @updatedAt)
    `
  ).run(ws);
}

export function listWorkspaces(db: Db): WorkspaceRecord[] {
  const rows = db
    .prepare(
      `
        select
          id,
          title,
          path,
          terminal_credential_id as terminalCredentialId,
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
          title,
          path,
          terminal_credential_id as terminalCredentialId,
          created_at as createdAt,
          updated_at as updatedAt
        from workspaces
        where id = ?
      `
    )
    .get(workspaceId);
  return row ? mapRow(row) : null;
}

export function updateWorkspaceTitle(db: Db, workspaceId: string, title: string, updatedAt: number) {
  db.prepare(
    `
      update workspaces
      set title = @title, updated_at = @updatedAt
      where id = @workspaceId
    `
  ).run({ workspaceId, title, updatedAt });
}

export function updateWorkspaceTerminalCredentialId(db: Db, workspaceId: string, credentialId: string | null, updatedAt: number) {
  db.prepare(
    `
      update workspaces
      set terminal_credential_id = @credentialId, updated_at = @updatedAt
      where id = @workspaceId
    `
  ).run({ workspaceId, credentialId, updatedAt });
}

export function deleteWorkspaceRecord(db: Db, workspaceId: string) {
  db.prepare(`delete from workspaces where id = ?`).run(workspaceId);
}

export type WorkspaceRepoRecord = {
  workspaceId: string;
  repoId: string;
  dirName: string;
  path: string;
  createdAt: number;
  updatedAt: number;
};

type WorkspaceRepoRow = {
  workspaceId: string;
  repoId: string;
  dirName: string;
  path: string;
  createdAt: number;
  updatedAt: number;
};

function mapRepoRow(row: any): WorkspaceRepoRecord {
  return {
    workspaceId: row.workspaceId,
    repoId: row.repoId,
    dirName: row.dirName,
    path: row.path,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function insertWorkspaceRepo(db: Db, row: WorkspaceRepoRecord) {
  db.prepare(
    `
      insert into workspace_repos (workspace_id, repo_id, dir_name, path, created_at, updated_at)
      values (@workspaceId, @repoId, @dirName, @path, @createdAt, @updatedAt)
    `
  ).run(row);
}

export function listWorkspaceRepos(db: Db, workspaceId: string): WorkspaceRepoRecord[] {
  const rows = db
    .prepare(
      `
        select
          workspace_id as workspaceId,
          repo_id as repoId,
          dir_name as dirName,
          path,
          created_at as createdAt,
          updated_at as updatedAt
        from workspace_repos
        where workspace_id = ?
        -- 尽量保持创建 workspace 时的插入顺序，便于前端在无本地选择记录时“默认选第一个 repo”
        order by rowid asc
      `
    )
    .all(workspaceId) as WorkspaceRepoRow[];
  return rows.map(mapRepoRow);
}

export function getWorkspaceRepoByDirName(db: Db, workspaceId: string, dirName: string): WorkspaceRepoRecord | null {
  const row = db
    .prepare(
      `
        select
          workspace_id as workspaceId,
          repo_id as repoId,
          dir_name as dirName,
          path,
          created_at as createdAt,
          updated_at as updatedAt
        from workspace_repos
        where workspace_id = ? and dir_name = ?
      `
    )
    .get(workspaceId, dirName);
  return row ? mapRepoRow(row) : null;
}

export function deleteWorkspaceReposByWorkspace(db: Db, workspaceId: string) {
  db.prepare(`delete from workspace_repos where workspace_id = ?`).run(workspaceId);
}
