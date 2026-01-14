import type { FastifyBaseLogger } from "fastify";
import type { RepoBranchesResponse, RepoRecord } from "@agent-workbench/shared";
import { repoMirrorPath, repoRoot } from "../../infra/fs/paths.js";
import { rmrf } from "../../infra/fs/fs.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { ensureRepoMirror } from "../../infra/git/mirror.js";
import { getOriginDefaultBranch, listHeadsBranches } from "../../infra/git/refs.js";
import { buildGitEnv } from "../../infra/git/gitEnv.js";
import { HttpError } from "../../app/errors.js";
import type { AppContext } from "../../app/context.js";
import { newId } from "../../utils/ids.js";
import { nowMs } from "../../utils/time.js";
import { extractGitHost, inferGitCredentialKindFromUrl } from "../../infra/git/gitHost.js";
import {
  countWorkspacesReferencingRepo,
  deleteRepoRecord,
  findRepoByUrl,
  getRepo,
  insertRepo,
  setRepoSyncStatus,
  updateRepoCredentialId
} from "./repo.store.js";
import { getCredentialWithSecret } from "../credentials/credentials.store.js";

function validateRepoCredentialCompatibility(params: {
  repoUrl: string;
  cred: { host: string; kind: "https" | "ssh" };
}) {
  const urlHost = extractGitHost(params.repoUrl);
  if (urlHost && params.cred.host !== urlHost) {
    throw new HttpError(
      400,
      `Credential host mismatch. URL host is ${urlHost}, but the credential is for ${params.cred.host}.`
    );
  }

  const urlKind = inferGitCredentialKindFromUrl(params.repoUrl);
  if (urlKind && params.cred.kind !== urlKind) {
    throw new HttpError(
      400,
      `Credential kind mismatch. URL protocol is ${urlKind}, but the credential type is ${params.cred.kind}.`
    );
  }
}

export async function createRepo(
  ctx: AppContext,
  logger: FastifyBaseLogger,
  params: { url: string; credentialId?: string | null }
): Promise<RepoRecord> {
  const url = params.url.trim();
  if (!url) throw new HttpError(400, "url is required");

  const existing = findRepoByUrl(ctx.db, url);
  if (existing) throw new HttpError(409, "Repo already exists (duplicate URL)");

  const credentialId = typeof params.credentialId === "string" ? params.credentialId.trim() : "";
  const normalizedCredentialId = credentialId ? credentialId : null;
  if (normalizedCredentialId) {
    const cred = getCredentialWithSecret(ctx.db, normalizedCredentialId);
    if (!cred) throw new HttpError(404, "Credential not found");
    validateRepoCredentialCompatibility({
      repoUrl: url,
      cred: { host: cred.record.host, kind: cred.record.kind }
    });
  }

  const id = newId("repo");
  const mirrorPath = repoMirrorPath(ctx.dataDir, id);
  const ts = nowMs();
  const repo: RepoRecord = {
    id,
    url,
    credentialId: normalizedCredentialId,
    mirrorPath,
    syncStatus: "syncing",
    syncError: null,
    lastSyncAt: null,
    createdAt: ts,
    updatedAt: ts
  };

  insertRepo(ctx.db, repo);

  void startRepoSync(ctx, logger, repo);
  return repo;
}

export async function syncRepo(ctx: AppContext, logger: FastifyBaseLogger, repoId: string) {
  const repo = getRepo(ctx.db, repoId);
  if (!repo) throw new HttpError(404, "Repo not found");
  if (repo.syncStatus === "syncing") return { accepted: true as const, started: false };

  setRepoSyncStatus(ctx.db, repo.id, "syncing", { error: null });
  void startRepoSync(ctx, logger, { ...repo, syncStatus: "syncing", syncError: null });
  return { accepted: true as const, started: true };
}

export async function getRepoById(ctx: AppContext, repoId: string) {
  const repo = getRepo(ctx.db, repoId);
  if (!repo) throw new HttpError(404, "Repo not found");
  return repo;
}

export async function updateRepo(ctx: AppContext, logger: FastifyBaseLogger, repoId: string, params: { credentialId?: string | null }) {
  const repo = await getRepoById(ctx, repoId);
  if (repo.syncStatus === "syncing") throw new HttpError(409, "Repo is syncing");

  const credentialId = typeof params.credentialId === "string" ? params.credentialId.trim() : "";
  const normalizedCredentialId = credentialId ? credentialId : null;
  if (normalizedCredentialId) {
    const cred = getCredentialWithSecret(ctx.db, normalizedCredentialId);
    if (!cred) throw new HttpError(404, "Credential not found");
    validateRepoCredentialCompatibility({
      repoUrl: repo.url,
      cred: { host: cred.record.host, kind: cred.record.kind }
    });
  }

  updateRepoCredentialId(ctx.db, repo.id, normalizedCredentialId, nowMs());
  logger.info({ repoId: repo.id, credentialId: normalizedCredentialId }, "repo updated");
  return getRepoById(ctx, repo.id);
}

export async function listRepoBranches(ctx: AppContext, repoId: string): Promise<RepoBranchesResponse> {
  const repo = await getRepoById(ctx, repoId);
  if (repo.syncStatus === "syncing") throw new HttpError(409, "Repo is syncing");
  if (repo.syncStatus === "failed") throw new HttpError(409, "Repo sync failed. Retry sync first.");

  const branches = await listHeadsBranches({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir });
  const defaultBranch = await getOriginDefaultBranch({ mirrorPath: repo.mirrorPath, cwd: ctx.dataDir });
  return { defaultBranch, branches };
}

export async function deleteRepo(ctx: AppContext, repoId: string) {
  const repo = await getRepoById(ctx, repoId);
  if (repo.syncStatus === "syncing") throw new HttpError(409, "Repo is syncing and cannot be deleted");
  const refs = countWorkspacesReferencingRepo(ctx.db, repo.id);
  if (refs > 0) throw new HttpError(409, "Repo is referenced by workspaces and cannot be deleted");

  await rmrf(repoRoot(ctx.dataDir, repo.id));
  deleteRepoRecord(ctx.db, repo.id);
}

async function startRepoSync(ctx: AppContext, logger: FastifyBaseLogger, repo: RepoRecord) {
  void withRepoLock(repo.id, async () => {
    const gitEnv = await buildGitEnv({ ctx, repoUrl: repo.url, credentialId: repo.credentialId });
    try {
      await ensureRepoMirror({
        repoId: repo.id,
        url: repo.url,
        dataDir: ctx.dataDir,
        mirrorPath: repoMirrorPath(ctx.dataDir, repo.id),
        env: gitEnv.env
      });
      setRepoSyncStatus(ctx.db, repo.id, "idle", { error: null, lastSyncAt: nowMs() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ repoId: repo.id, err: message }, "repo sync failed");
      setRepoSyncStatus(ctx.db, repo.id, "failed", { error: message });
    } finally {
      await gitEnv.cleanup();
    }
  });
}
