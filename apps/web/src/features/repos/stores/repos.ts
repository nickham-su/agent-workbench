import { ref } from "vue";
import type { RepoRecord } from "@agent-workbench/shared";
import { listRepos } from "@/shared/api";

type RefreshReposOptions = {
  // 轮询场景下使用：不打断 UI，也不抛出异常
  silent?: boolean;
  // 是否驱动 loading（轮询时应为 false，避免 UI 闪烁）
  showLoading?: boolean;
};

type WaitRepoOptions = {
  timeoutMs?: number;
  t?: (key: string, params?: Record<string, unknown>) => string;
};

const repos = ref<RepoRecord[]>([]);
const loading = ref(false);
const polling = ref(false);

const listeners = new Set<() => void>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let forcePollingCount = 0;

const pollIntervalMs = 1500;

function notify() {
  for (const fn of listeners) fn();
}

function hasSyncing(list: RepoRecord[]) {
  return list.some((r) => r.syncStatus === "syncing");
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void pollTick();
  }, pollIntervalMs);
  polling.value = true;
  // 立即跑一次，缩短“状态刚变化但 UI 还没更新”的窗口
  void pollTick();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  polling.value = false;
}

function ensurePollingState(nextRepos?: RepoRecord[]) {
  const list = nextRepos ?? repos.value;
  const shouldPoll = forcePollingCount > 0 || hasSyncing(list);
  if (shouldPoll) startPolling();
  else stopPolling();
}

async function pollTick() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await refreshRepos({ silent: true, showLoading: false });
  } finally {
    pollInFlight = false;
  }
}

export function onReposUpdated(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshRepos(opts: RefreshReposOptions = {}) {
  const silent = opts.silent ?? false;
  const showLoading = opts.showLoading ?? true;
  if (showLoading) loading.value = true;
  try {
    const data = await listRepos();
    repos.value = data;
    notify();
    ensurePollingState(data);
    return data;
  } catch (err) {
    // 轮询失败时不打断 UI；显式刷新则交给调用方处理错误展示
    if (!silent) throw err;
    return repos.value;
  } finally {
    if (showLoading) loading.value = false;
  }
}

export async function waitRepoSettledOrThrow(repoId: string, opts: WaitRepoOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const t = opts.t;

  const startedAt = Date.now();
  forcePollingCount++;
  try {
    ensurePollingState();
    await refreshRepos({ silent: true, showLoading: false });

    return await new Promise<void>((resolve, reject) => {
      let done = false;
      let unsub: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (unsub) unsub();
      };

      const check = () => {
        const repo = repos.value.find((r) => r.id === repoId) ?? null;
        if (!repo) {
          cleanup();
          reject(new Error("Repo not found"));
          return;
        }
        if (repo.syncStatus === "idle") {
          cleanup();
          resolve();
          return;
        }
        if (repo.syncStatus === "failed") {
          cleanup();
          reject(new Error(repo.syncError || (t ? t("repos.sync.failed") : "Repo sync failed")));
        }
      };

      timer = setTimeout(() => {
        // 超时：交给用户决定是否继续（例如手动再点一次刷新/同步）
        cleanup();
        reject(new Error(t ? t("repos.sync.timeout") : "Repo sync timed out. Please try again later."));
      }, Math.max(0, timeoutMs - (Date.now() - startedAt)));

      unsub = onReposUpdated(check);
      check();
    });
  } finally {
    forcePollingCount = Math.max(0, forcePollingCount - 1);
    ensurePollingState();
  }
}

export function useReposState() {
  return { repos, loading, polling, refreshRepos };
}
