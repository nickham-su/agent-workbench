import type { FileStatResponse } from "@agent-workbench/shared";
import { ApiError, statWorkspaceFile } from "@/shared/api";

export type TerminalLinkStatStore = {
  ensureStat: (path: string) => Promise<FileStatResponse | null>;
};

const stores = new Map<string, TerminalLinkStatStore>();

export function getTerminalLinkStatStore(workspaceIdRaw: string): TerminalLinkStatStore {
  const workspaceId = String(workspaceIdRaw || "").trim();
  const key = workspaceId || "__default__";
  const existing = stores.get(key);
  if (existing) return existing;

  const cache = new Map<string, FileStatResponse>();
  const inflight = new Map<string, Promise<FileStatResponse | null>>();

  const cacheResponse = (path: string, res: FileStatResponse) => {
    const normalized = res.normalizedPath || res.path;
    cache.set(normalized, res);
    if (path !== normalized) cache.set(path, res);
  };

  const store: TerminalLinkStatStore = {
    async ensureStat(path) {
      if (!workspaceId) return null;
      const k = path;
      const cached = cache.get(k);
      if (cached) return cached;
      const pending = inflight.get(k);
      if (pending) return pending;

      const task = (async () => {
        try {
          const res = await statWorkspaceFile({ workspaceId, path });
          cacheResponse(path, res);
          return res;
        } catch (err) {
          if (err instanceof ApiError && err.status === 403) {
            const res: FileStatResponse = { path, ok: false, reason: "permission_denied" };
            cacheResponse(path, res);
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
