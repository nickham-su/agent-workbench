import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { Value } from "@sinclair/typebox/value";
import { RepoGitEnvLeaseIdSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { rmrf } from "../../infra/fs/fs.js";
import { assertSecureDirectoryCurrent, closeSecureDirectories, openExistingSecureChildDirectory, openSecureRootDirectory, type SecureDirectory } from "../../infra/fs/secure-directory.js";
import { cleanupExpiredRepoGitEnvLeases, gitEnvLeaseRoot } from "./git-env.lease.js";
export { gitEnvLeaseRoot };

function parseExpiresAt(meta: unknown): number | null {
  const raw = meta && typeof meta === "object" ? (meta as { expiresAt?: unknown }).expiresAt : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

async function readLegacyExpiry(directory: SecureDirectory) {
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(path.join(directory.fdPath, "meta.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return parseExpiresAt(JSON.parse(await file.readFile("utf-8")));
  } catch { return null; }
  finally { await file?.close().catch(() => undefined); }
}

export async function cleanupExpiredGitEnvLeases(params: {
  dataDir: string;
  logger?: FastifyBaseLogger;
  nowMs?: number;
  /** v1 only: unreadable meta retains the original mtime fallback. */
  fallbackTtlMs?: number;
}) {
  const now = params.nowMs ?? Date.now();
  const fallbackTtlMs = params.fallbackTtlMs ?? 30 * 60 * 1000;
  const directories: SecureDirectory[] = [];
  try {
    const data = await openSecureRootDirectory(params.dataDir);
    directories.push(data);
    const tmp = await openExistingSecureChildDirectory(data, "tmp");
    directories.push(tmp);
    const root = await openExistingSecureChildDirectory(tmp, "git-env");
    directories.push(root);
    for (const directory of directories) await assertSecureDirectoryCurrent(directory, data.realPath);
    const dirents = await fs.readdir(root.fdPath, { withFileTypes: true });
    // v2 is a namespace, never a v1 candidate with missing meta/old mtime.
    for (const entry of dirents) {
      if (entry.name === "v2" || !entry.isDirectory() || !Value.Check(RepoGitEnvLeaseIdSchema, entry.name)) continue;
      let lease: SecureDirectory | undefined;
      try {
        lease = await openExistingSecureChildDirectory(root, entry.name);
        const expiresAt = await readLegacyExpiry(lease);
        if (expiresAt === null ? now - lease.stat.mtimeMs <= fallbackTtlMs : now <= expiresAt) continue;
        for (const directory of directories) await assertSecureDirectoryCurrent(directory, data.realPath);
        await assertSecureDirectoryCurrent(lease, data.realPath);
        await rmrf(path.join(root.fdPath, entry.name));
      } catch {
        params.logger?.warn({ code: "GIT_LEGACY_LEASE_CLEANUP_FAILED" }, "Git lease cleanup failed");
      } finally { await closeSecureDirectories(lease); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") params.logger?.warn({ code: "GIT_LEASE_SCAN_FAILED" }, "Git lease scan failed");
  } finally { await closeSecureDirectories(...directories.reverse()); }

  await cleanupExpiredRepoGitEnvLeases({
    dataDir: params.dataDir, nowMs: now,
    onFailure: () => params.logger?.warn({ code: "GIT_REPO_LEASE_CLEANUP_FAILED" }, "Git lease state retained; maintenance may be required"),
  });
}

export function startGitEnvJanitor(params: {
  app: { addHook: (name: "onClose" | "onReady", cb: () => void | Promise<void>) => void };
  dataDir: string;
  logger?: FastifyBaseLogger;
  intervalMs?: number;
}) {
  const intervalMs = params.intervalMs ?? 5 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  params.app.addHook("onReady", async () => {
    await cleanupExpiredGitEnvLeases({ dataDir: params.dataDir, logger: params.logger });
    timer = setInterval(() => { void cleanupExpiredGitEnvLeases({ dataDir: params.dataDir, logger: params.logger }); }, intervalMs);
    timer.unref?.();
  });
  params.app.addHook("onClose", async () => { stop(); });
}
