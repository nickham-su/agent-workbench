export type AgentTimelineRefreshMode = "snapshot" | "delta" | "before";

export type AgentTimelineRefreshRunResult = {
  /** before cursor 已失效时，先 snapshot，再以最新 cursor 继续原 pagination intent。 */
  requestSnapshot?: boolean;
  /** before 在 snapshot 后发现没有更多历史页时，才正常结算 pagination waiter。 */
  paginationExhausted?: boolean;
};

type Deferred = { resolve: () => void; reject: (error: unknown) => void };
type TailMode = "snapshot" | "delta";
type PendingTail = { mode: TailMode; waiters: Deferred[] };
type Runner = (
  mode: AgentTimelineRefreshMode,
  epoch: number,
  signal: AbortSignal,
) => Promise<AgentTimelineRefreshRunResult | void>;

const tailPriority: Record<TailMode, number> = { delta: 1, snapshot: 2 };

/**
 * 单 scope timeline 调度器。
 *
 * tail freshness 与 pagination 是独立 intent：snapshot/delta 可以优先一次，但不能
 * 吞掉或持续饿死 before。结构 snapshot 失败会有限退避重试；普通 delta/before
 * 失败只结算当前请求，避免高频重试循环。
 */
export function createAgentTimelineRefreshScheduler(options?: {
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  structuralRetryDelaysMs?: readonly number[];
}) {
  const scheduleTimer = options?.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = options?.clearTimeout ?? globalThis.clearTimeout;
  const structuralRetryDelaysMs = options?.structuralRetryDelaysMs ?? [250, 500, 1_000, 2_000, 4_000];
  let disposed = false;
  let epoch = 0;
  let active = false;
  let activeController: AbortController | null = null;
  let activeWaiters: Deferred[] = [];
  let pendingTail: PendingTail | null = null;
  let pendingPagination: Deferred[] = [];
  // structural intent 与普通 tail 独立：退避时普通 delta 不得触发它提前重试。
  let structuralPending = false;
  let structuralWaiters: Deferred[] = [];
  let paginationNeedsSnapshot = false;
  let tailTurnSincePagination = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let structuralRetryIndex = 0;

  function settle(waiters: Deferred[], error?: unknown) {
    for (const waiter of waiters) error === undefined ? waiter.resolve() : waiter.reject(error);
  }

  function clearStructuralRetryTimer() {
    if (retryTimer !== null) cancelTimer(retryTimer);
    retryTimer = null;
  }

  function enqueueTail(mode: TailMode, waiter: Deferred | null) {
    if (!pendingTail) pendingTail = { mode, waiters: [] };
    else pendingTail.mode = tailPriority[mode] > tailPriority[pendingTail.mode] ? mode : pendingTail.mode;
    if (waiter) pendingTail.waiters.push(waiter);
  }

  function enqueueStructural(waiter: Deferred | null) {
    structuralPending = true;
    if (waiter) structuralWaiters.push(waiter);
  }

  function takeNext(): { mode: AgentTimelineRefreshMode; waiters: Deferred[]; structural: boolean } | null {
    // 退避窗口只阻止 structural snapshot；已排队 pagination 仍可完成，但不会绕过重试。
    if (retryTimer !== null) {
      if (pendingPagination.length && !paginationNeedsSnapshot) {
        const waiters = pendingPagination;
        pendingPagination = [];
        tailTurnSincePagination = false;
        return { mode: "before", waiters, structural: false };
      }
      return null;
    }
    // cursor reset 后必须先取得 structural snapshot，再继续原 pagination。
    if (structuralPending || paginationNeedsSnapshot) {
      const waiters = structuralWaiters;
      structuralWaiters = [];
      structuralPending = false;
      return { mode: "snapshot", waiters, structural: true };
    }
    // 每执行一次 tail 后让已排队的 pagination 运行，持续 delta 不会饿死 before。
    if (pendingPagination.length && tailTurnSincePagination) {
      const waiters = pendingPagination;
      pendingPagination = [];
      tailTurnSincePagination = false;
      return { mode: "before", waiters, structural: false };
    }
    if (pendingTail) {
      // 只有 pagination 已经排队时，tail 才真正消耗它的一次优先机会。已经
      // 在 pagination 出现前开始的 snapshot/delta 不应让后续 before 被抢跑。
      const paginationWasPending = pendingPagination.length > 0;
      const current = pendingTail;
      pendingTail = null;
      if (paginationWasPending) tailTurnSincePagination = true;
      return { ...current, structural: false };
    }
    if (pendingPagination.length) {
      const waiters = pendingPagination;
      pendingPagination = [];
      tailTurnSincePagination = false;
      return { mode: "before", waiters, structural: false };
    }
    return null;
  }

  function scheduleStructuralRetry(runner: Runner) {
    if (disposed || retryTimer !== null || !structuralPending) return;
    const delay = structuralRetryDelaysMs[structuralRetryIndex];
    if (delay === undefined) return;
    structuralRetryIndex += 1;
    retryTimer = scheduleTimer(() => {
      retryTimer = null;
      void drain(runner);
    }, delay);
  }

  function failExhaustedStructural(error: unknown, waiters: Deferred[]) {
    clearStructuralRetryTimer();
    structuralRetryIndex = 0;
    structuralPending = false;
    paginationNeedsSnapshot = false;
    settle(pendingPagination, error);
    pendingPagination = [];
    const allWaiters = [...waiters, ...structuralWaiters];
    structuralWaiters = [];
    settle(allWaiters, error);
  }

  async function drain(runner: Runner) {
    if (active || disposed) return;
    active = true;
    try {
      while (!disposed) {
        const current = takeNext();
        if (!current) return;
        const controller = new AbortController();
        activeController = controller;
        activeWaiters = current.waiters;
        let result: AgentTimelineRefreshRunResult | void;
        try {
          result = await runner(current.mode, epoch, controller.signal);
        } catch (error) {
          activeWaiters = [];
          if (disposed || controller.signal.aborted) {
            settle(current.waiters);
            continue;
          }
          if (current.structural) {
            // 初始一次加上每个配置 delay 对应的一次重试；耗尽后必须释放 UI waiter。
            if (structuralRetryIndex < structuralRetryDelaysMs.length) {
              structuralWaiters.unshift(...current.waiters);
              structuralPending = true;
              scheduleStructuralRetry(runner);
            } else {
              failExhaustedStructural(error, current.waiters);
            }
            return;
          }
          settle(current.waiters, error);
          continue;
        } finally {
          if (activeController === controller) activeController = null;
        }
        activeWaiters = [];
        if (current.structural) {
          clearStructuralRetryTimer();
          structuralRetryIndex = 0;
        }
        if (current.mode === "snapshot" && paginationNeedsSnapshot) paginationNeedsSnapshot = false;
        if (current.mode === "before" && result?.requestSnapshot) {
          pendingPagination.unshift(...current.waiters);
          paginationNeedsSnapshot = true;
          enqueueStructural(null);
          continue;
        }
        // pagination intent 不由“成功返回一页”满足：只要服务端仍给出 cursor，
        // 就继续使用最新 cursor 读取，直到明确耗尽，避免 snapshot/reset 抢走
        // before waiter 后历史页悄然丢失。
        if (current.mode === "before" && !result?.paginationExhausted) {
          pendingPagination.unshift(...current.waiters);
          continue;
        }
        settle(current.waiters);
      }
    } finally {
      active = false;
      if (
        !disposed &&
        retryTimer === null &&
        (structuralPending || pendingTail || pendingPagination.length)
      )
        void drain(runner);
    }
  }

  function request(mode: AgentTimelineRefreshMode, runner: Runner, options?: { structural?: boolean }) {
    if (disposed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (mode === "before") pendingPagination.push(waiter);
      else if (options?.structural) enqueueStructural(waiter);
      else enqueueTail(mode, waiter);
      void drain(runner);
    });
  }

  return {
    request,
    requestStructuralSnapshot(runner: Runner) {
      return request("snapshot", runner, { structural: true });
    },
    /** 使所有已发 timeline 响应失效；调用方随后应请求结构 snapshot。 */
    invalidate() {
      epoch += 1;
      return epoch;
    },
    currentEpoch() {
      return epoch;
    },
    hasPending() {
      return active || structuralPending || pendingTail !== null || pendingPagination.length > 0 || retryTimer !== null;
    },
    dispose() {
      disposed = true;
      epoch += 1;
      activeController?.abort();
      clearStructuralRetryTimer();
      settle(activeWaiters);
      settle(structuralWaiters);
      if (pendingTail) settle(pendingTail.waiters);
      settle(pendingPagination);
      activeWaiters = [];
      structuralWaiters = [];
      structuralPending = false;
      pendingTail = null;
      pendingPagination = [];
      paginationNeedsSnapshot = false;
      structuralRetryIndex = 0;
    },
  };
}
