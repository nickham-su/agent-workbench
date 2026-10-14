import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GitRepoNameSchema, RepoGitEnvLeaseIdSchema, RepoGitEnvLeaseOwnerSchema, ReleaseRepoGitEnvRequestSchema, type ReleaseRepoGitEnvRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../app/errors.js";
import { tmpRoot } from "../../infra/fs/paths.js";
import { assertSecureDirectoryCurrent, closeSecureDirectories, openExistingSecureChildDirectory, openSecureChildDirectory, openSecureRootDirectory, type SecureDirectory } from "../../infra/fs/secure-directory.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";
import { assertRepoGitEnvMaintenanceRequest, assertKnownMaintenanceProcessesAbsent, type MaintenanceProcessProbe } from "./git-env.recovery-policy.js";

import type { GitEnvArtifactDirectory } from "../../infra/git/gitEnv.js";
export function gitEnvLeaseRoot(dataDir: string) { return path.join(tmpRoot(dataDir), "git-env"); }
export function repoGitEnvLeaseRoot(dataDir: string) { return path.join(gitEnvLeaseRoot(dataDir), "v2"); }
export const REPO_GIT_ENV_LEASE_MIN_TTL_MS = 15 * 60_000;
export const REPO_GIT_ENV_LEASE_GRACE_MS = 5 * 60_000;
const MAX_META_BYTES = 64 * 1024;

const MetaSchema = Type.Object({
  ...RepoGitEnvLeaseOwnerSchema.properties,
  schemaVersion: Type.Literal(2), purpose: Type.Literal("git"), leaseId: RepoGitEnvLeaseIdSchema,
  repo: GitRepoNameSchema, repoId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("none"), Type.Literal("https"), Type.Literal("ssh")]),
  createdAt: Type.String({ minLength: 1 }), expiresAt: Type.String({ minLength: 1 }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 3_600_000, multipleOf: 1000 }),
  stopState: Type.Union([Type.Literal("unconfirmed"), Type.Literal("stopped")]),
}, { additionalProperties: false });
export type RepoGitEnvLeaseMeta = Static<typeof MetaSchema>;
export type RepoGitEnvLeaseInspection = { leaseId: string; meta: RepoGitEnvLeaseMeta | null; state: "unreadable" | RepoGitEnvLeaseMeta["stopState"] };

function isMissing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function stateUnavailable() { return new HttpError(409, "Git lease state is unavailable; keep the target protected and use the documented maintenance window.", "GIT_LEASE_STATE_UNAVAILABLE"); }
function assertLeaseId(leaseId: string) {
  if (!Value.Check(RepoGitEnvLeaseIdSchema, leaseId)) throw new HttpError(400, "Invalid Git lease identifier.", "LEASE_ID_INVALID");
}
function assertTrustedPermissions(directory: SecureDirectory, privateDirectory = false) {
  const uid = process.getuid?.();
  if ((uid !== undefined && directory.stat.uid !== uid) || (directory.stat.mode & 0o022) !== 0
    || (privateDirectory && (directory.stat.mode & 0o777) !== 0o700)) throw stateUnavailable();
}

type LeaseRoots = { data: SecureDirectory; v2: SecureDirectory; chain: SecureDirectory[] };
/** Directory-fd traversal pins every fixed ancestor. Read/release/scan never mkdir. */
async function withLeaseRoots<T>(dataDir: string, create: boolean, fn: (roots: LeaseRoots) => Promise<T>): Promise<T | null> {
  const chain: SecureDirectory[] = [];
  try {
    const data = await openSecureRootDirectory(dataDir);
    chain.push(data);
    assertTrustedPermissions(data);
    let parent = data;
    for (const name of ["tmp", "git-env", "v2"]) {
      try {
        parent = await (create ? openSecureChildDirectory(parent, name) : openExistingSecureChildDirectory(parent, name));
      } catch (error) {
        if (!create && isMissing(error)) return null;
        throw error;
      }
      chain.push(parent);
      assertTrustedPermissions(parent, name === "v2");
    }
    for (const directory of chain) await assertSecureDirectoryCurrent(directory, data.realPath);
    return await fn({ data, v2: parent, chain });
  } finally { await closeSecureDirectories(...[...chain].reverse()); }
}

async function openLease(roots: LeaseRoots, leaseId: string): Promise<SecureDirectory | null> {
  try {
    const directory = await openExistingSecureChildDirectory(roots.v2, leaseId);
    try { assertTrustedPermissions(directory, true); return directory; }
    catch (error) { await closeSecureDirectories(directory); throw error; }
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
async function assertLeaseCurrent(roots: LeaseRoots, lease: SecureDirectory) {
  for (const directory of roots.chain) await assertSecureDirectoryCurrent(directory, roots.data.realPath);
  await assertSecureDirectoryCurrent(lease, roots.data.realPath);
}

async function readMeta(lease: SecureDirectory, leaseId: string): Promise<RepoGitEnvLeaseMeta | null> {
  let file: fs.FileHandle | undefined;
  try {
    // Reject special files after opening without waiting for a FIFO writer.
    // Keep the fd-based identity/type/permission/size checks and closure below.
    file = await fs.open(path.join(lease.fdPath, "meta.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_META_BYTES || (stat.mode & 0o777) !== 0o600) return null;
    const buffer = Buffer.alloc(MAX_META_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_META_BYTES) return null;
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf-8"));
    if (!Value.Check(MetaSchema, value) || value.leaseId !== leaseId) return null;
    const createdAt = Date.parse(value.createdAt), expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
      || expiresAt - createdAt !== Math.max(REPO_GIT_ENV_LEASE_MIN_TTL_MS, value.timeoutMs + REPO_GIT_ENV_LEASE_GRACE_MS)) return null;
    return value;
  } catch { return null; }
  finally { await file?.close().catch(() => undefined); }
}

async function writeMeta(roots: LeaseRoots, lease: SecureDirectory, meta: RepoGitEnvLeaseMeta) {
  await assertLeaseCurrent(roots, lease);
  const temporaryName = `.meta-${randomUUID()}.tmp`;
  const temporaryPath = path.join(lease.fdPath, temporaryName);
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(meta), "utf-8");
    await file.sync();
    await file.close(); file = undefined;
    await assertLeaseCurrent(roots, lease);
    await fs.rename(temporaryPath, path.join(lease.fdPath, "meta.json"));
  } finally {
    await file?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

/** Flat, private artifacts only. unlink/rmdir use pinned parents and never follow links. */
async function deleteLease(roots: LeaseRoots, lease: SecureDirectory, meta: RepoGitEnvLeaseMeta | null) {
  await assertLeaseCurrent(roots, lease);
  const names = await fs.readdir(lease.fdPath);
  for (const name of names) {
    const stat = await fs.lstat(path.join(lease.fdPath, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw stateUnavailable();
  }
  // Keep stopped meta throughout ordinary credential-unlink failures.
  for (const name of names.filter((name) => name !== "meta.json")) await fs.unlink(path.join(lease.fdPath, name));
  await assertLeaseCurrent(roots, lease);
  await fs.unlink(path.join(lease.fdPath, "meta.json")).catch((error) => { if (!isMissing(error)) throw error; });
  try {
    await assertLeaseCurrent(roots, lease);
    await fs.rmdir(path.join(roots.v2.fdPath, meta?.leaseId ?? path.basename(lease.logicalPath)));
  } catch (error) {
    // If the same directory remains, retain the already-confirmed state. No mkdir,
    // no recreation of an absent/replaced lease, and no downgrade to unconfirmed.
    if (meta) {
      await assertLeaseCurrent(roots, lease).then(() => writeMeta(roots, lease, meta)).catch(() => undefined);
    }
    throw error;
  }
}

export type RepoGitEnvLeasePreparation = {
  artifactDir: GitEnvArtifactDirectory;
  complete: (meta: RepoGitEnvLeaseMeta) => Promise<void>;
  /** Prepare-only rollback, bound to this creation's physical identities. */
  releaseUnstarted: () => Promise<void>;
};

/** Hold the exclusively created lease and its ancestors until preparation ends. */
export async function withCreatedRepoGitEnvLease<T>(params: { dataDir: string; meta: RepoGitEnvLeaseMeta }, prepare: (lease: RepoGitEnvLeasePreparation) => Promise<T>): Promise<T> {
  assertLeaseId(params.meta.leaseId);
  if (!Value.Check(MetaSchema, params.meta) || params.meta.stopState !== "unconfirmed") throw stateUnavailable();
  const result = await withLeaseRoots(params.dataDir, true, async (roots) => {
    const leaseId = params.meta.leaseId;
    await fs.mkdir(path.join(roots.v2.fdPath, leaseId), { mode: 0o700 }); // exclusive
    const lease = await openLease(roots, leaseId);
    if (!lease) throw stateUnavailable();
    try {
      try {
        await lease.handle.chmod(0o700);
        await writeMeta(roots, lease, params.meta);
      } catch (error) {
        // No auth files yet. Failed removal remains unknown/held.
        await deleteLease(roots, lease, null).catch(() => undefined);
        throw error;
      }
      return { value: await prepare({
        artifactDir: { directory: lease, assertCurrent: () => assertLeaseCurrent(roots, lease) },
        complete: (meta) => completeRepoGitEnvLeasePreparation(roots, lease, meta),
        releaseUnstarted: async () => {
          await releaseLease({ dataDir: params.dataDir, request: {
            workspaceId: params.meta.workspaceId, sessionId: params.meta.sessionId,
            runId: params.meta.runId, toolExecutionId: params.meta.toolExecutionId,
            leaseId, stopEvidence: "not_started",
          } }, { roots, lease });
        },
      }) };
    } finally { await closeSecureDirectories(lease); }
  });
  if (!result) throw stateUnavailable();
  return result.value;
}

/** Metadata-only creation; credential construction must use the held capability. */
export async function createRepoGitEnvLease(params: { dataDir: string; meta: RepoGitEnvLeaseMeta }) {
  return withCreatedRepoGitEnvLease(params, async (lease) => lease.artifactDir.directory.logicalPath);
}

/** Prepare-only: publish on the same pinned identity, never reopen a path. */
async function completeRepoGitEnvLeasePreparation(roots: LeaseRoots, lease: SecureDirectory, meta: RepoGitEnvLeaseMeta) {
  if (!Value.Check(MetaSchema, meta) || meta.stopState !== "unconfirmed" || meta.leaseId !== path.basename(lease.logicalPath)) throw stateUnavailable();
  await withRepoLock(`git-env:v2:${meta.leaseId}`, async () => {
    await assertLeaseCurrent(roots, lease);
    const current = await readMeta(lease, meta.leaseId);
    if (!current || current.stopState !== "unconfirmed" || !sameOwner(current, meta)) throw stateUnavailable();
    await writeMeta(roots, lease, meta);
    await assertLeaseCurrent(roots, lease);
  });
}

function sameOwner(a: RepoGitEnvLeaseMeta, b: Pick<RepoGitEnvLeaseMeta, "workspaceId" | "sessionId" | "runId" | "toolExecutionId">) {
  return a.workspaceId === b.workspaceId && a.sessionId === b.sessionId && a.runId === b.runId && a.toolExecutionId === b.toolExecutionId;
}

export async function releaseRepoGitEnvLease(params: { dataDir: string; request: ReleaseRepoGitEnvRequest }) {
  return releaseLease(params);
}

/** Expected identities are local prepare authority, never RPC or persisted data. */
async function releaseLease(params: { dataDir: string; request: ReleaseRepoGitEnvRequest }, expectedCreatedLease?: { roots: LeaseRoots; lease: SecureDirectory }) {
  if (!Value.Check(ReleaseRepoGitEnvRequestSchema, params.request)) throw new HttpError(400, "Invalid Git lease release request.", "LEASE_RELEASE_INVALID");
  const { leaseId } = params.request;
  try {
    await withRepoLock(`git-env:v2:${leaseId}`, async () => {
      // Check after acquiring the lease lock, never reuse a check made before waiting.
      if (expectedCreatedLease) await assertLeaseCurrent(expectedCreatedLease.roots, expectedCreatedLease.lease);
      await withLeaseRoots(params.dataDir, false, async (roots) => {
        const lease = await openLease(roots, leaseId);
        if (!lease) return;
        try {
          if (expectedCreatedLease) {
            const expected = [...expectedCreatedLease.roots.chain, expectedCreatedLease.lease];
            const opened = [...roots.chain, lease];
            if (opened.length !== expected.length || opened.some((directory, index) => directory.stat.dev !== expected[index]!.stat.dev || directory.stat.ino !== expected[index]!.stat.ino)) throw stateUnavailable();
            await assertLeaseCurrent(roots, lease);
          }
          const current = await readMeta(lease, leaseId);
          if (!current) throw stateUnavailable();
          if (!sameOwner(current, params.request)) throw new HttpError(403, "Git lease owner does not match.", "LEASE_OWNER_MISMATCH");
          const stopped = { ...current, stopState: "stopped" as const };
          if (current.stopState !== "stopped") await writeMeta(roots, lease, stopped);
          await deleteLease(roots, lease, stopped);
        } finally { await closeSecureDirectories(lease); }
      });
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw stateUnavailable();
  }
  return { ok: true as const };
}

/** Local, exclusive maintenance window only. No DB/runtime or HTTP authority. */
export async function releaseRepoGitEnvLeaseForMaintenance(params: {
  dataDir: string; request: unknown; probe?: MaintenanceProcessProbe;
}) {
  assertRepoGitEnvMaintenanceRequest(params.request);
  const request = params.request;
  try {
    await withRepoLock(`git-env:v2:${request.leaseId}`, async () => {
      assertKnownMaintenanceProcessesAbsent(request, params.probe);
      await withLeaseRoots(params.dataDir, false, async (roots) => {
        const lease = await openLease(roots, request.leaseId);
        if (!lease) return;
        try {
          const current = await readMeta(lease, request.leaseId);
          await assertLeaseCurrent(roots, lease);
          if ((current?.stopState ?? "unreadable") !== request.expectedState
            || (current ? request.expectedOwner === null || !sameOwner(current, request.expectedOwner) : request.expectedOwner !== null)) {
            throw new HttpError(409, "Git lease changed or does not match the exact maintenance expectations.", "GIT_LEASE_MAINTENANCE_EXPECTATION_MISMATCH");
          }
          // Reuse the ordinary monotonic transition and pinned deletion. Unknown
          // metadata is removed only under the separately confirmed full window;
          // never invent an owner, a stopped record or a replacement directory.
          const stopped = current ? { ...current, stopState: "stopped" as const } : null;
          if (current && current.stopState !== "stopped") await writeMeta(roots, lease, stopped!);
          await deleteLease(roots, lease, stopped);
        } finally { await closeSecureDirectories(lease); }
      });
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw stateUnavailable();
  }
  return { ok: true as const };
}

/** Bounded safe metadata only; never opens key/token/askpass files. For CLI reuse. */
export async function inspectRepoGitEnvLease(params: { dataDir: string; leaseId: string }): Promise<RepoGitEnvLeaseInspection | null> {
  assertLeaseId(params.leaseId);
  try {
    return await withLeaseRoots(params.dataDir, false, async (roots) => {
      const lease = await openLease(roots, params.leaseId);
      if (!lease) return null;
      try {
        const meta = await readMeta(lease, params.leaseId);
        await assertLeaseCurrent(roots, lease);
        return { leaseId: params.leaseId, meta, state: meta?.stopState ?? "unreadable" };
      } finally { await closeSecureDirectories(lease); }
    });
  } catch { throw stateUnavailable(); }
}

export async function listRepoGitEnvLeaseIds(dataDir: string): Promise<string[]> {
  try {
    return await withLeaseRoots(dataDir, false, async (roots) => {
      const entries = await fs.readdir(roots.v2.fdPath, { withFileTypes: true });
      // Unknown container entries are not guessed into someone else's ownership.
      if (entries.some((entry) => !Value.Check(RepoGitEnvLeaseIdSchema, entry.name) || !entry.isDirectory() || entry.isSymbolicLink())) throw stateUnavailable();
      return entries.map((entry) => entry.name);
    }) ?? [];
  } catch { throw stateUnavailable(); }
}

export async function assertNoRepoGitEnvLeaseHold(params: { dataDir: string; workspaceId: string; repoId?: string; nowMs?: number }) {
  const now = params.nowMs ?? Date.now();
  for (const leaseId of await listRepoGitEnvLeaseIds(params.dataDir)) {
    const inspection = await withRepoLock(`git-env:v2:${leaseId}`, () => inspectRepoGitEnvLease({ dataDir: params.dataDir, leaseId }));
    if (!inspection) continue;
    if (!inspection.meta) throw stateUnavailable();
    const meta = inspection.meta;
    if (meta.workspaceId !== params.workspaceId || (params.repoId !== undefined && meta.repoId !== params.repoId)) continue;
    if (meta.stopState === "unconfirmed" || now <= Date.parse(meta.expiresAt)) {
      throw new HttpError(409, "A Git lease still protects this target; confirm execution has stopped before maintenance release.", "REPO_GIT_BUSY");
    }
  }
}

export async function cleanupExpiredRepoGitEnvLeases(params: { dataDir: string; nowMs?: number; onFailure?: () => void }) {
  let ids: string[];
  try { ids = await listRepoGitEnvLeaseIds(params.dataDir); }
  catch { params.onFailure?.(); return; }
  for (const leaseId of ids) {
    try {
      await withRepoLock(`git-env:v2:${leaseId}`, async () => {
        await withLeaseRoots(params.dataDir, false, async (roots) => {
          const lease = await openLease(roots, leaseId);
          if (!lease) return;
          try {
            const meta = await readMeta(lease, leaseId);
            if (!meta || meta.stopState !== "stopped" || (params.nowMs ?? Date.now()) <= Date.parse(meta.expiresAt)) return;
            await deleteLease(roots, lease, meta);
          } finally { await closeSecureDirectories(lease); }
        });
      });
    } catch { params.onFailure?.(); }
  }
}
