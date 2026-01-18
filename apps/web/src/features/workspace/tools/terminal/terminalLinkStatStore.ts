import type { FileStatResponse, GitTarget } from "@agent-workbench/shared";
import { ApiError, statFile } from "@/shared/api";

export type TerminalLinkStatStore = {
  ensureStat: (params: { target: GitTarget; path: string }) => Promise<FileStatResponse | null>;
};

const stores = new Map<string, TerminalLinkStatStore>();

export function getTerminalLinkStatStore(workspaceId: string): TerminalLinkStatStore {
  const key = String(workspaceId || "").trim() || "__default__";
  const existing = stores.get(key);
  if (existing) return existing;

  const cache = new Map<string, FileStatResponse>();
  const inflight = new Map<string, Promise<FileStatResponse | null>>();

  const buildKey = (target: GitTarget, path: string) => `${target.dirName}:${path}`;
  const cacheResponse = (target: GitTarget, path: string, res: FileStatResponse) => {
    const normalized = res.normalizedPath || res.path;
    const canonicalKey = buildKey(target, normalized);
    const rawKey = buildKey(target, path);
    cache.set(canonicalKey, res);
    if (rawKey !== canonicalKey) cache.set(rawKey, res);
  };

  const store: TerminalLinkStatStore = {
    async ensureStat(params) {
      const k = buildKey(params.target, params.path);
      const cached = cache.get(k);
      if (cached) return cached;
      const pending = inflight.get(k);
      if (pending) return pending;

      const task = (async () => {
        try {
          const res = await statFile({ target: params.target, path: params.path });
          cacheResponse(params.target, params.path, res);
          return res;
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            const res: FileStatResponse = { path: params.path, ok: false, reason: "permission_denied" };
            cacheResponse(params.target, params.path, res);
            return res;
          }
          return null;
        } finally {
          inflight.delete(k);
        }
      })();

      inflight.set(k, task);
      return task;
    }
  };

  stores.set(key, store);
  return store;
}
