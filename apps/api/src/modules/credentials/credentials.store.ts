import type { Db } from "../../infra/db/db.js";
import type { CredentialKind, CredentialRecord } from "@agent-workbench/shared";

type CredentialRow = {
  id: string;
  host: string;
  kind: CredentialKind;
  label: string | null;
  username: string | null;
  isDefault: number;
  createdAt: number;
  updatedAt: number;
  secretEnc: string;
};

function mapRow(row: any): CredentialRecord {
  return {
    id: row.id,
    host: row.host,
    kind: row.kind,
    label: row.label ?? null,
    username: row.username ?? null,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function listCredentials(db: Db): CredentialRecord[] {
  const rows = db
    .prepare(
      `
        select
          id,
          host,
          kind,
          label,
          username,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        from credentials
        order by updated_at desc
      `
    )
    .all() as Array<Omit<CredentialRow, "secretEnc">>;
  return rows.map(mapRow);
}

export function getCredentialWithSecret(db: Db, credentialId: string): { record: CredentialRecord; secretEnc: string } | null {
  const row = db
    .prepare(
      `
        select
          id,
          host,
          kind,
          label,
          username,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt,
          secret_enc as secretEnc
        from credentials
        where id = ?
      `
    )
    .get(credentialId) as CredentialRow | undefined;
  if (!row) return null;
  return { record: mapRow(row), secretEnc: row.secretEnc };
}

export function getDefaultCredentialWithSecret(db: Db, host: string): { record: CredentialRecord; secretEnc: string } | null {
  const row = db
    .prepare(
      `
        select
          id,
          host,
          kind,
          label,
          username,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt,
          secret_enc as secretEnc
        from credentials
        where host = ? and is_default = 1
        limit 1
      `
    )
    .get(host) as CredentialRow | undefined;
  if (!row) return null;
  return { record: mapRow(row), secretEnc: row.secretEnc };
}

export function pickCredentialWithSecretForHost(
  db: Db,
  params: { host: string; preferredKind?: CredentialKind | null }
): { record: CredentialRecord; secretEnc: string } | null {
  const host = params.host;
  const preferredKind = params.preferredKind ?? null;

  if (preferredKind) {
    const byKindDefault = db
      .prepare(
        `
          select
            id,
            host,
            kind,
            label,
            username,
            is_default as isDefault,
            created_at as createdAt,
            updated_at as updatedAt,
            secret_enc as secretEnc
          from credentials
          where host = ? and kind = ? and is_default = 1
          limit 1
        `
      )
      .get(host, preferredKind) as CredentialRow | undefined;
    if (byKindDefault) return { record: mapRow(byKindDefault), secretEnc: byKindDefault.secretEnc };

    const byKindLatest = db
      .prepare(
        `
          select
            id,
            host,
            kind,
            label,
            username,
            is_default as isDefault,
            created_at as createdAt,
            updated_at as updatedAt,
            secret_enc as secretEnc
          from credentials
          where host = ? and kind = ?
          order by updated_at desc
          limit 1
        `
      )
      .get(host, preferredKind) as CredentialRow | undefined;
    if (byKindLatest) return { record: mapRow(byKindLatest), secretEnc: byKindLatest.secretEnc };

    // URL 明确指向某种协议时，不回退到其他 kind 的 default，避免错误注入（尤其是写出不必要的 token/key 文件）
    return null;
  }

  const anyDefault = getDefaultCredentialWithSecret(db, host);
  if (anyDefault) return anyDefault;

  return null;
}

export function clearDefaultForHost(db: Db, host: string) {
  db.prepare(`update credentials set is_default = 0 where host = ? and is_default = 1`).run(host);
}

export function insertCredential(
  db: Db,
  cred: CredentialRecord & { secretEnc: string }
) {
  db.prepare(
    `
      insert into credentials (id, host, kind, label, username, secret_enc, is_default, created_at, updated_at)
      values (@id, @host, @kind, @label, @username, @secretEnc, @isDefault, @createdAt, @updatedAt)
    `
  ).run({ ...cred, isDefault: cred.isDefault ? 1 : 0 });
}

export function updateCredentialRecord(
  db: Db,
  params: { id: string; label: string | null; username: string | null; secretEnc: string; isDefault: boolean; updatedAt: number }
) {
  db.prepare(
    `
      update credentials
      set
        label = @label,
        username = @username,
        secret_enc = @secretEnc,
        is_default = @isDefault,
        updated_at = @updatedAt
      where id = @id
    `
  ).run({ ...params, isDefault: params.isDefault ? 1 : 0 });
}

export function deleteCredentialRecord(db: Db, credentialId: string) {
  db.prepare(`delete from credentials where id = ?`).run(credentialId);
}
