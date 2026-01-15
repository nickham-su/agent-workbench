import type { Db } from "../../infra/db/db.js";
import type { RepoRecord, RepoSyncStatus } from "@agent-workbench/shared";

type RepoRow = {
  id: string;
  url: string;
  credentialId: string | null;
  defaultBranch: string | null;
  mirrorPath: string;
  syncStatus: RepoSyncStatus;
  syncError: string | null;
  lastSyncAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function mapRow(row: any): RepoRecord {
  return {
    id: row.id,
    url: row.url,
    credentialId: row.credentialId ?? null,
    defaultBranch: row.defaultBranch ?? null,
    mirrorPath: row.mirrorPath,
    syncStatus: row.syncStatus,
    syncError: row.syncError ?? null,
    lastSyncAt: row.lastSyncAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function findRepoByUrl(db: Db, url: string): RepoRecord | null {
  const row = db
    .prepare(
      `
        select
          id,
          url,
          credential_id as credentialId,
          default_branch as defaultBranch,
          mirror_path as mirrorPath,
          sync_status as syncStatus,
          sync_error as syncError,
          last_sync_at as lastSyncAt,
          created_at as createdAt,
          updated_at as updatedAt
        from repos
        where url = ?
      `
    )
    .get(url);
  return row ? mapRow(row) : null;
}

export function insertRepo(db: Db, repo: RepoRecord) {
  db.prepare(
    `
      insert into repos (id, url, credential_id, default_branch, created_at, updated_at, mirror_path, sync_status, sync_error, last_sync_at)
      values (@id, @url, @credentialId, @defaultBranch, @createdAt, @updatedAt, @mirrorPath, @syncStatus, @syncError, @lastSyncAt)
    `
  ).run(repo);
}

export function listRepos(db: Db): RepoRecord[] {
  const rows = db
    .prepare(
      `
        select
          id,
          url,
          credential_id as credentialId,
          default_branch as defaultBranch,
          mirror_path as mirrorPath,
          sync_status as syncStatus,
          sync_error as syncError,
          last_sync_at as lastSyncAt,
          created_at as createdAt,
          updated_at as updatedAt
        from repos
        order by updated_at desc
      `
    )
    .all() as RepoRow[];
  return rows.map(mapRow);
}

export function getRepo(db: Db, repoId: string): RepoRecord | null {
  const row = db
    .prepare(
      `
        select
          id,
          url,
          credential_id as credentialId,
          default_branch as defaultBranch,
          mirror_path as mirrorPath,
          sync_status as syncStatus,
          sync_error as syncError,
          last_sync_at as lastSyncAt,
          created_at as createdAt,
          updated_at as updatedAt
        from repos
        where id = ?
      `
    )
    .get(repoId);
  return row ? mapRow(row) : null;
}

export function setRepoSyncStatus(
  db: Db,
  repoId: string,
  status: RepoSyncStatus,
  params: { error?: string | null; lastSyncAt?: number | null } = {}
) {
  db.prepare(
    `
      update repos
      set
        sync_status = @status,
        sync_error = @syncError,
        last_sync_at = @lastSyncAt,
        updated_at = @updatedAt
      where id = @repoId
    `
  ).run({
    repoId,
    status,
    syncError: params.error ?? null,
    lastSyncAt: params.lastSyncAt ?? null,
    updatedAt: Date.now()
  });
}

export function updateRepoCredentialId(db: Db, repoId: string, credentialId: string | null, updatedAt: number) {
  db.prepare(
    `
      update repos
      set credential_id = @credentialId, updated_at = @updatedAt
      where id = @repoId
    `
  ).run({ repoId, credentialId, updatedAt });
}

export function updateRepoDefaultBranch(db: Db, repoId: string, defaultBranch: string | null, updatedAt: number) {
  db.prepare(
    `
      update repos
      set default_branch = @defaultBranch, updated_at = @updatedAt
      where id = @repoId
    `
  ).run({ repoId, defaultBranch, updatedAt });
}

export function deleteRepoRecord(db: Db, repoId: string) {
  db.prepare(`delete from repos where id = ?`).run(repoId);
}

export function countWorkspacesReferencingRepo(db: Db, repoId: string) {
  const row = db.prepare(`select count(1) as cnt from workspace_repos where repo_id = ?`).get(repoId) as { cnt: number };
  return row.cnt;
}

export function countReposReferencingCredential(db: Db, credentialId: string) {
  const row = db
    .prepare(`select count(1) as cnt from repos where credential_id = ?`)
    .get(credentialId) as { cnt: number };
  return row.cnt;
}
