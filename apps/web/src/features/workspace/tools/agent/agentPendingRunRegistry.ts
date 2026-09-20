import type { AgentRunKind, AgentRunStatusResponse } from "@agent-workbench/shared";

export const AGENT_PENDING_RUN_STORAGE_PREFIX = "agent-workbench.agent.pending-run.v1/";
export const AGENT_PENDING_RUN_SCHEMA_VERSION = 1;
export const AGENT_PENDING_RUN_MAX_CONCURRENT = 3;
export const AGENT_PENDING_RUN_STALE_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_CONSUMED_KEYS = 500;

export type WebPendingAgentRunKind = Extract<AgentRunKind, "user" | "manual_compaction">;

export type PendingAgentRun = {
  schemaVersion: typeof AGENT_PENDING_RUN_SCHEMA_VERSION;
  workspaceId: string;
  sessionId: string;
  runKind: WebPendingAgentRunKind;
  runId: string;
  createdAt: number;
  retryCount?: number;
  nextAttemptAt?: number;
};

export type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const WEB_RUN_KINDS = new Set<WebPendingAgentRunKind>(["user", "manual_compaction"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWebPendingRunKind(value: unknown): value is WebPendingAgentRunKind {
  return typeof value === "string" && WEB_RUN_KINDS.has(value as WebPendingAgentRunKind);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is PendingAgentRun {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === AGENT_PENDING_RUN_SCHEMA_VERSION
    && isNonEmptyString(item.workspaceId)
    && isNonEmptyString(item.sessionId)
    && isWebPendingRunKind(item.runKind)
    && isNonEmptyString(item.runId)
    && isFiniteNumber(item.createdAt)
    && (item.retryCount === undefined || (Number.isInteger(item.retryCount) && (item.retryCount as number) >= 0))
    && (item.nextAttemptAt === undefined || isFiniteNumber(item.nextAttemptAt));
}

function keyComponent(value: string) {
  return encodeURIComponent(value);
}

function decodeKeyComponent(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return isNonEmptyString(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function pendingAgentRunStorageKey(input: Pick<PendingAgentRun, "workspaceId" | "sessionId" | "runKind" | "runId">) {
  return `${AGENT_PENDING_RUN_STORAGE_PREFIX}${keyComponent(input.workspaceId)}/${keyComponent(input.sessionId)}/${keyComponent(input.runKind)}/${keyComponent(input.runId)}`;
}

function parseKey(key: string) {
  if (!key.startsWith(AGENT_PENDING_RUN_STORAGE_PREFIX)) return null;
  const parts = key.slice(AGENT_PENDING_RUN_STORAGE_PREFIX.length).split("/");
  if (parts.length !== 4) return null;
  const [workspaceId, sessionId, runKind, runId] = parts.map(decodeKeyComponent);
  if (!workspaceId || !sessionId || !isWebPendingRunKind(runKind) || !runId) return null;
  return { workspaceId, sessionId, runKind, runId };
}

function safeRemove(storage: SessionStorageLike | null | undefined, key: string) {
  try { storage?.removeItem(key); } catch { /* storage failure only disables recovery */ }
}

function safeGet(storage: SessionStorageLike | null | undefined, key: string) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function safeSet(storage: SessionStorageLike | null | undefined, key: string, value: string) {
  try { storage?.setItem(key, value); } catch { /* normal send must not be affected */ }
}

function storageKeys(storage: SessionStorageLike | null | undefined) {
  let length = 0;
  try { length = storage?.length ?? 0; } catch { return []; }
  const keys: string[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const key = storage?.key(index) ?? null;
      if (key) keys.push(key);
    } catch { /* skip an unreadable storage slot */ }
  }
  return keys;
}

/**
 * 每条 pending Run 使用独立 sessionStorage key。所有 list 都重新扫描 storage，
 * 因而草稿 Pane 到真实 Session 的交接和多个 Pane 的交错登记不会覆盖彼此。
 */
export function createAgentPendingRunRegistry(storage: SessionStorageLike | null | undefined, now = () => Date.now()) {
  function scan() {
    const records: PendingAgentRun[] = [];
    // 先取稳定快照再做物理清理；Storage 删除会改变后续 index，不能边枚举边 removeItem。
    for (const key of storageKeys(storage)) {
      if (!key || !key.startsWith(AGENT_PENDING_RUN_STORAGE_PREFIX)) continue;
      const keyParts = parseKey(key);
      const raw = safeGet(storage, key);
      if (!keyParts || raw === null) {
        safeRemove(storage, key);
        continue;
      }
      try {
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value)
          || value.workspaceId !== keyParts.workspaceId
          || value.sessionId !== keyParts.sessionId
          || value.runKind !== keyParts.runKind
          || value.runId !== keyParts.runId
          || pendingAgentRunStorageKey(value) !== key
          || now() - value.createdAt > AGENT_PENDING_RUN_STALE_MS) {
          safeRemove(storage, key);
          continue;
        }
        records.push(value);
      } catch {
        safeRemove(storage, key);
      }
    }
    return records.sort((left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId));
  }

  return {
    register(input: { workspaceId: string; sessionId: string; runKind: WebPendingAgentRunKind; runId: string }) {
      if (!isNonEmptyString(input.workspaceId) || !isNonEmptyString(input.sessionId) || !isWebPendingRunKind(input.runKind) || !isNonEmptyString(input.runId)) return;
      const key = pendingAgentRunStorageKey(input);
      const previousRaw = safeGet(storage, key);
      let createdAt = now();
      if (previousRaw) {
        try {
          const previous: unknown = JSON.parse(previousRaw);
          if (isRecord(previous)) createdAt = previous.createdAt;
        } catch { /* overwrite corrupted own key */ }
      }
      safeSet(storage, key, JSON.stringify({ schemaVersion: AGENT_PENDING_RUN_SCHEMA_VERSION, ...input, createdAt } satisfies PendingAgentRun));
      notifyPendingRunScope(input.workspaceId, input.sessionId);
    },
    list(workspaceId: string, sessionId: string) {
      return scan().filter((item) => item.workspaceId === workspaceId && item.sessionId === sessionId);
    },
    remove(input: Pick<PendingAgentRun, "workspaceId" | "sessionId" | "runKind" | "runId">) {
      safeRemove(storage, pendingAgentRunStorageKey(input));
    },
    clearScope(workspaceId: string, sessionId: string) {
      for (const key of storageKeys(storage)) {
        const parts = parseKey(key);
        if (parts?.workspaceId === workspaceId && parts.sessionId === sessionId) safeRemove(storage, key);
      }
    },
    clearWorkspace(workspaceId: string) {
      for (const key of storageKeys(storage)) {
        const parts = parseKey(key);
        if (parts?.workspaceId === workspaceId) safeRemove(storage, key);
      }
    },
    recordSuccess(item: PendingAgentRun) {
      const next: PendingAgentRun = { ...item, nextAttemptAt: now() + RETRY_BASE_MS };
      delete next.retryCount;
      safeSet(storage, pendingAgentRunStorageKey(next), JSON.stringify(next));
      return next;
    },
    recordTransientFailure(item: PendingAgentRun) {
      const retryCount = (item.retryCount ?? 0) + 1;
      const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(retryCount - 1, 5), RETRY_MAX_MS);
      const next: PendingAgentRun = { ...item, retryCount, nextAttemptAt: now() + delay };
      safeSet(storage, pendingAgentRunStorageKey(next), JSON.stringify(next));
      return next;
    },
  };
}

/** Workspace 删除已被服务端确认后，清除该标签页内所有待恢复 Run。 */
export function clearPendingAgentRunsForWorkspace(storage: SessionStorageLike | null | undefined, workspaceId: string) {
  createAgentPendingRunRegistry(storage).clearWorkspace(workspaceId);
}

export function isTerminalAgentRun(run: AgentRunStatusResponse) {
  return run.status !== "running";
}

export function isPendingRunResponseFor(record: PendingAgentRun, response: AgentRunStatusResponse) {
  return response.workspaceId === record.workspaceId
    && response.sessionId === record.sessionId
    && response.runId === record.runId
    && response.runKind === record.runKind;
}

export type PendingRunPollCoordinator = {
  pollingScopes: Set<string>;
  inFlightKeys: Set<string>;
  consumedKeys: Set<string>;
  consumedKeyOrder: string[];
  scopeSubscribers: Map<string, Set<() => void>>;
};

const tabCoordinator: PendingRunPollCoordinator = {
  pollingScopes: new Set(), inFlightKeys: new Set(), consumedKeys: new Set(), consumedKeyOrder: [], scopeSubscribers: new Map(),
};

export function createPendingRunPollCoordinator(): PendingRunPollCoordinator {
  return { pollingScopes: new Set(), inFlightKeys: new Set(), consumedKeys: new Set(), consumedKeyOrder: [], scopeSubscribers: new Map() };
}

function consumeOnce(coordinator: PendingRunPollCoordinator, key: string) {
  if (coordinator.consumedKeys.has(key)) return false;
  coordinator.consumedKeys.add(key);
  coordinator.consumedKeyOrder.push(key);
  while (coordinator.consumedKeyOrder.length > MAX_CONSUMED_KEYS) {
    const oldest = coordinator.consumedKeyOrder.shift();
    if (oldest) coordinator.consumedKeys.delete(oldest);
  }
  return true;
}

function scopeKey(workspaceId: string, sessionId: string) {
  return `${keyComponent(workspaceId)}/${keyComponent(sessionId)}`;
}

export function subscribePendingRunScope(
  workspaceId: string,
  sessionId: string,
  subscriber: () => void,
) {
  const coordinator = tabCoordinator;
  const key = scopeKey(workspaceId, sessionId);
  const subscribers = coordinator.scopeSubscribers.get(key) ?? new Set<() => void>();
  subscribers.add(subscriber);
  coordinator.scopeSubscribers.set(key, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) coordinator.scopeSubscribers.delete(key);
  };
}

function notifyPendingRunScope(
  workspaceId: string,
  sessionId: string,
) {
  const coordinator = tabCoordinator;
  const subscribers = coordinator.scopeSubscribers.get(scopeKey(workspaceId, sessionId));
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) subscriber();
}

function classifyError(error: unknown) {
  const status = typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "permanent" as const;
  return "transient" as const;
}

/**
 * 一次轮询会按 FIFO 处理全部到期记录，每批最多三个在途请求。模块级协调器让同一标签页
 * 的多个 Pane 不会重复 fetch 或重复 toast；调用方可提供独立 coordinator 以便测试。
 */
export async function pollPendingAgentRuns(params: {
  registry: ReturnType<typeof createAgentPendingRunRegistry>;
  workspaceId: string;
  sessionId: string;
  fetchRun: (runId: string) => Promise<AgentRunStatusResponse>;
  onTerminal: (run: AgentRunStatusResponse) => void | boolean;
  onStale: () => void | boolean;
  coordinator?: PendingRunPollCoordinator;
  now?: () => number;
}) {
  const coordinator = params.coordinator ?? tabCoordinator;
  const now = params.now ?? (() => Date.now());
  const scope = scopeKey(params.workspaceId, params.sessionId);
  if (coordinator.pollingScopes.has(scope)) return;
  coordinator.pollingScopes.add(scope);
  try {
    const eligible = params.registry.list(params.workspaceId, params.sessionId)
      .filter((item) => (item.nextAttemptAt ?? 0) <= now())
      .filter((item) => !coordinator.inFlightKeys.has(pendingAgentRunStorageKey(item)));
    for (let offset = 0; offset < eligible.length; offset += AGENT_PENDING_RUN_MAX_CONCURRENT) {
      const batch = eligible.slice(offset, offset + AGENT_PENDING_RUN_MAX_CONCURRENT);
      await Promise.all(batch.map(async (item) => {
        const key = pendingAgentRunStorageKey(item);
        coordinator.inFlightKeys.add(key);
        try {
          const response = await params.fetchRun(item.runId);
          if (!isPendingRunResponseFor(item, response)) {
            if (!coordinator.consumedKeys.has(key) && params.onStale() !== false) {
              params.registry.remove(item);
              consumeOnce(coordinator, key);
            }
            return;
          }
          if (isTerminalAgentRun(response)) {
            if (!coordinator.consumedKeys.has(key) && params.onTerminal(response) !== false) {
              params.registry.remove(item);
              consumeOnce(coordinator, key);
            }
          } else {
            params.registry.recordSuccess(item);
          }
        } catch (error) {
          if (classifyError(error) === "permanent") {
            if (!coordinator.consumedKeys.has(key) && params.onStale() !== false) {
              params.registry.remove(item);
              consumeOnce(coordinator, key);
            }
          } else {
            params.registry.recordTransientFailure(item);
          }
        } finally {
          coordinator.inFlightKeys.delete(key);
        }
      }));
    }
  } finally {
    coordinator.pollingScopes.delete(scope);
  }
}
