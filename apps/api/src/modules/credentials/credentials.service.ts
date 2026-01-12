import type { FastifyBaseLogger } from "fastify";
import type { CreateCredentialRequest, CredentialKind, CredentialRecord, UpdateCredentialRequest } from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import { encryptUtf8 } from "../../infra/crypto/secretBox.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { countReposReferencingCredential } from "../repos/repo.store.js";
import {
  clearDefaultForHost,
  deleteCredentialRecord,
  getCredentialWithSecret,
  insertCredential,
  listCredentials as listCredentialRecords,
  updateCredentialRecord
} from "./credentials.store.js";

function normalizeHost(raw: unknown) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("/") || s.includes(":")) return "";
  if (s.includes(" ")) return "";
  return s;
}

function normalizeLabel(raw: unknown) {
  const s = String(raw || "").trim();
  return s ? s : null;
}

function normalizeUsername(raw: unknown) {
  const s = String(raw || "").trim();
  return s ? s : null;
}

function validateAndNormalizeSecret(params: { kind: CredentialKind; secret: unknown }) {
  const s = String(params.secret || "").trim();
  if (!s) throw new HttpError(400, "secret is required");

  if (params.kind === "https") {
    return s;
  }

  // ssh
  const lower = s.toLowerCase();
  if (!lower.includes("private key")) {
    throw new HttpError(400, "Invalid SSH private key. Paste an OpenSSH private key.");
  }
  if (lower.includes("encrypted") || lower.includes("proc-type: 4,encrypted")) {
    throw new HttpError(400, "Encrypted (passphrase-protected) SSH private keys are not supported. Use an unencrypted key.");
  }
  return s.endsWith("\n") ? s : s + "\n";
}

export function listCredentials(ctx: AppContext): CredentialRecord[] {
  return listCredentialRecords(ctx.db);
}

export async function createCredential(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  bodyRaw: unknown
): Promise<CredentialRecord> {
  const body = (bodyRaw ?? {}) as CreateCredentialRequest;
  const host = normalizeHost((body as any).host);
  if (!host) throw new HttpError(400, "Invalid host");
  const kind = (body as any).kind as CredentialKind;
  if (kind !== "https" && kind !== "ssh") throw new HttpError(400, 'Invalid kind. Expected "https" or "ssh".');

  const label = normalizeLabel((body as any).label);
  const username = normalizeUsername((body as any).username);
  const secret = validateAndNormalizeSecret({ kind, secret: (body as any).secret });
  const isDefault = Boolean((body as any).isDefault);

  const id = newId("cred");
  const ts = nowMs();
  const enc = encryptUtf8({ key: ctx.credentialMasterKey, plaintext: secret });

  ctx.db.transaction(() => {
    if (isDefault) clearDefaultForHost(ctx.db, host);
    insertCredential(ctx.db, {
      id,
      host,
      kind,
      label,
      username,
      isDefault,
      createdAt: ts,
      updatedAt: ts,
      secretEnc: enc
    });
  })();

  logger.info({ credentialId: id, host, kind, isDefault }, "credential created");
  const created = getCredentialWithSecret(ctx.db, id);
  if (!created) throw new HttpError(500, "Failed to read credential after create");
  return created.record;
}

export async function updateCredential(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  credentialId: string,
  bodyRaw: unknown
): Promise<CredentialRecord> {
  const id = String(credentialId || "").trim();
  if (!id) throw new HttpError(400, "credentialId is required");

  const current = getCredentialWithSecret(ctx.db, id);
  if (!current) throw new HttpError(404, "Credential not found");

  const body = (bodyRaw ?? {}) as UpdateCredentialRequest;
  const nextLabel = (body as any).label !== undefined ? normalizeLabel((body as any).label) : current.record.label;
  const nextUsername = (body as any).username !== undefined ? normalizeUsername((body as any).username) : current.record.username;
  const nextIsDefault = (body as any).isDefault !== undefined ? Boolean((body as any).isDefault) : current.record.isDefault;

  let nextSecretEnc = current.secretEnc;
  if ((body as any).secret !== undefined) {
    const nextSecret = validateAndNormalizeSecret({ kind: current.record.kind, secret: (body as any).secret });
    nextSecretEnc = encryptUtf8({ key: ctx.credentialMasterKey, plaintext: nextSecret });
  }

  const updatedAt = nowMs();
  ctx.db.transaction(() => {
    if (nextIsDefault) clearDefaultForHost(ctx.db, current.record.host);
    updateCredentialRecord(ctx.db, {
      id,
      label: nextLabel,
      username: nextUsername,
      isDefault: nextIsDefault,
      secretEnc: nextSecretEnc,
      updatedAt
    });
  })();

  logger.info({ credentialId: id }, "credential updated");
  const updated = getCredentialWithSecret(ctx.db, id);
  if (!updated) throw new HttpError(500, "Failed to read credential after update");
  return updated.record;
}

export async function deleteCredential(ctx: AppContext, logger: FastifyBaseLogger, credentialId: string) {
  const id = String(credentialId || "").trim();
  if (!id) throw new HttpError(400, "credentialId is required");

  const current = getCredentialWithSecret(ctx.db, id);
  if (!current) throw new HttpError(404, "Credential not found");

  const refs = countReposReferencingCredential(ctx.db, id);
  if (refs > 0) throw new HttpError(409, "Credential is referenced by repos and cannot be deleted");

  deleteCredentialRecord(ctx.db, id);
  logger.info({ credentialId: id }, "credential deleted");
}
