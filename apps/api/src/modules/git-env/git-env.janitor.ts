import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { rmrf } from "../../infra/fs/fs.js";
import { tmpRoot } from "../../infra/fs/paths.js";

export function gitEnvLeaseRoot(dataDir: string) {
  return path.join(tmpRoot(dataDir), "git-env");
}

function parseExpiresAt(meta: any): number | null {
  const raw = meta && typeof meta === "object" ? (meta as any).expiresAt : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

export async function cleanupExpiredGitEnvLeases(params: {
  dataDir: string;
  logger?: FastifyBaseLogger;
  nowMs?: number;
  /** meta.json 不可读时基于目录 mtime 的兜底 TTL */
  fallbackTtlMs?: number;
}) {
  const now = params.nowMs ?? Date.now();
  const root = gitEnvLeaseRoot(params.dataDir);
  const fallbackTtlMs = params.fallbackTtlMs ?? 30 * 60 * 1000;

  let dirents: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    dirents = (await fs.readdir(root, { withFileTypes: true })) as any;
  } catch {
    return;
  }

  await Promise.all(
    dirents
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const leaseDir = path.join(root, d.name);
        try {
          const metaPath = path.join(leaseDir, "meta.json");
          let expiresAt: number | null = null;
          try {
            const metaTxt = await fs.readFile(metaPath, "utf-8");
            expiresAt = parseExpiresAt(JSON.parse(metaTxt));
          } catch {
            // ignore
          }

          if (expiresAt === null) {
            const st = await fs.stat(leaseDir);
            if (now - st.mtimeMs <= fallbackTtlMs) return;
          } else {
            if (now <= expiresAt) return;
          }

          await rmrf(leaseDir);
        } catch (err) {
          params.logger?.warn({ err, leaseDir }, "git-env janitor: cleanup failed");
        }
      })
  );
}

export function startGitEnvJanitor(params: {
  app: { addHook: (name: "onClose" | "onReady", cb: () => void | Promise<void>) => void };
  dataDir: string;
  logger?: FastifyBaseLogger;
  intervalMs?: number;
}) {
  const intervalMs = params.intervalMs ?? 5 * 60 * 1000;

  let timer: NodeJS.Timeout | null = null;
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  params.app.addHook("onReady", async () => {
    // initial best-effort sweep
    await cleanupExpiredGitEnvLeases({ dataDir: params.dataDir, logger: params.logger });

    timer = setInterval(() => {
      void cleanupExpiredGitEnvLeases({ dataDir: params.dataDir, logger: params.logger });
    }, intervalMs);
    timer.unref?.();
  });

  params.app.addHook("onClose", async () => {
    stop();
  });
}
