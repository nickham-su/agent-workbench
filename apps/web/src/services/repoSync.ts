import { getRepo } from "./api";

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitRepoReadyOrThrow(
  repoId: string,
  opts: { timeoutMs?: number; intervalMs?: number; t?: (key: string, params?: Record<string, unknown>) => string } = {}
) {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const intervalMs = opts.intervalMs ?? 1500;
  const t = opts.t;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const repo = await getRepo(repoId);
    if (repo.syncStatus === "idle") return;
    if (repo.syncStatus === "failed") throw new Error(repo.syncError || (t ? t("repos.sync.failed") : "Repo sync failed"));
    await sleep(intervalMs);
  }
  throw new Error(t ? t("repos.sync.timeout") : "Repo sync timed out. Please try again later.");
}
