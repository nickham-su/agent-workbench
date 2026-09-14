/**
 * Session 列表刷新协调的纯状态集合。
 *
 * 与 AgentToolView.vue 中的运行时状态一一对应：
 * - 按 generation/workspace 隔离的 active 刷新 token（旧请求不阻止新请求）；
 * - R2 收敛重试 token（去重、跨 generation 隔离、finally 只清自身）；
 * - mutation revision 与完整 record 缓存（陈旧响应保护）。
 *
 * 所有方法只操作传入状态，便于用可控 Promise 做时序测试。
 */

export type CoordinationGeneration = number;
export type CoordinationWorkspaceId = string;

export type ActiveRefreshState = {
  generation: CoordinationGeneration;
  workspaceId: CoordinationWorkspaceId;
} | null;

export type RetryRefreshState = {
  generation: CoordinationGeneration;
  workspaceId: CoordinationWorkspaceId;
} | null;

export type TitleMutationCacheState = {
  revision: number;
  revisionBySession: Map<string, number>;
  recordBySession: Map<string, unknown>;
};

export function createTitleMutationCache(): TitleMutationCacheState {
  return { revision: 0, revisionBySession: new Map(), recordBySession: new Map() };
}

/** 请求开始时是否可以发起刷新：同 generation/workspace 已有在途请求则跳过。 */
export function canStartRefresh(
  active: ActiveRefreshState,
  generation: CoordinationGeneration,
  workspaceId: CoordinationWorkspaceId
): boolean {
  if (!active) return true;
  return !(active.generation === generation && active.workspaceId === workspaceId);
}

/** 是否可以调度 R2 收敛刷新：同 generation/workspace 已调度则跳过。 */
export function canScheduleRetryRefresh(
  retry: RetryRefreshState,
  generation: CoordinationGeneration,
  workspaceId: CoordinationWorkspaceId
): boolean {
  if (!retry) return true;
  return !(retry.generation === generation && retry.workspaceId === workspaceId);
}

/**
 * 成功采用服务端 record 后，收敛（清理）mutation 缓存：
 * - 请求开始 revision 不早于任何成功 mutation 时，服务端为权威；
 * - 仅清理存在于远端列表中的 Session，避免误清已在服务端删除的缓存。
 */
export function convergeMutationCache<T>(
  cache: TitleMutationCacheState,
  requestRevision: number,
  remoteIds: ReadonlySet<string>
): string[] {
  const cleared: string[] = [];
  if (cache.revision > requestRevision) return cleared;
  for (const sessionId of [...cache.revisionBySession.keys()]) {
    if (!remoteIds.has(sessionId)) continue;
    cache.revisionBySession.delete(sessionId);
    cache.recordBySession.delete(sessionId);
    cleared.push(sessionId);
  }
  return cleared;
}
