import assert from "node:assert/strict";
import test from "node:test";
import { isRequestResponseWritable, mergeStaleProtectedSessionList } from "./agentSessionTitle";
import {
  canScheduleRetryRefresh,
  canStartRefresh,
  convergeMutationCache,
  createTitleMutationCache
} from "./agentSessionRefreshCoordination";

/** 可控 Promise：允许测试手动决定 resolve/reject 时机。 */
function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 简化版刷新协调器，复刻 AgentToolView.refreshSessions 的控制流，
 * 用可控 Promise 验证文档 05 的并发时间线。
 */
function createHarness() {
  let generation = 1;
  let workspaceId = "ws-a";
  let disposed = false;
  let active: { generation: number; workspaceId: string } | null = null;
  let retry: { generation: number; workspaceId: string } | null = null;
  // 与生产 AgentToolView 使用同一协调模块状态（createTitleMutationCache）。
  const mutationCache = createTitleMutationCache();
  const serverSessions: { id: string; title: string }[] = [];
  const effects: string[] = [];
  const drafts: string[] = [];
  let initialized = false;

  const writable = (g: number, w: string) =>
    isRequestResponseWritable({
      disposed,
      currentGeneration: generation,
      requestGeneration: g,
      currentWorkspaceId: workspaceId,
      requestWorkspaceId: w
    });

  async function refreshSessions() {
    const g = generation;
    const w = workspaceId;
    if (!canStartRefresh(active, g, w)) return false;
    active = { generation: g, workspaceId: w };
    const requestRevision = mutationCache.revision;
    let ok = false;
    let usedProtection = false;
    try {
      const list = await listSessions();
      if (!writable(g, w)) return false;
      let merged = list;
      if (mutationCache.revision > requestRevision) {
        const result = mergeStaleProtectedSessionList(list, {
          requestRevision,
          mutationRevisionBySession: mutationCache.revisionBySession,
          mutationRecordBySession: mutationCache.recordBySession
        }, (r) => r.id);
        merged = result.merged;
        usedProtection = result.protectedSessionIds.length > 0;
      }
      // 收敛：与生产一致，使用 convergeMutationCache 清理远端仍存在 Session 的临时缓存。
      const cleared = convergeMutationCache(mutationCache, requestRevision, new Set(merged.map((r) => r.id)));
      for (const id of cleared) effects.push(`converged:${id}`);
      serverSessions.splice(0, serverSessions.length, ...merged);
      effects.push(`applied:g${g}`);
      ok = true;
    } catch {
      // 请求失败：不写状态，仅释放 active，保留重试能力。
      effects.push(`failed:g${g}`);
    } finally {
      if (active && active.generation === g && active.workspaceId === w) {
        active = null;
        effects.push(`cleared-active:g${g}`);
      }
    }
    if (usedProtection && ok) {
      if (canScheduleRetryRefresh(retry, g, w) && !disposed) {
        const token = { generation: g, workspaceId: w };
        retry = token;
        effects.push(`schedule-r2:g${g}`);
        void refreshSessions()
          .catch(() => undefined)
          .finally(() => {
            if (retry === token) {
              retry = null;
              effects.push(`cleared-r2:g${g}`);
            }
          });
      }
    }
    return ok;
  }

  // 可替换的列表请求实现
  let listSessions: () => Promise<{ id: string; title: string }[]> = async () => [];
  function setListSessions(fn: () => Promise<{ id: string; title: string }[]>) {
    listSessions = fn;
  }

  return {
    effects,
    serverSessions,
    setListSessions,
    refreshSessions,
    mutateTitle(sessionId: string, title: string) {
      mutationCache.revision += 1;
      mutationCache.revisionBySession.set(sessionId, mutationCache.revision);
      mutationCache.recordBySession.set(sessionId, { id: sessionId, title });
      const idx = serverSessions.findIndex((s) => s.id === sessionId);
      if (idx >= 0) serverSessions[idx] = { id: sessionId, title };
      else serverSessions.push({ id: sessionId, title });
    },
    switchWorkspace(nextWorkspaceId: string) {
      generation += 1;
      workspaceId = nextWorkspaceId;
      active = null;
      retry = null;
      mutationCache.revisionBySession.clear();
      mutationCache.recordBySession.clear();
      mutationCache.revision = 0;
      serverSessions.splice(0, serverSessions.length);
      effects.push(`switch:g${generation}`);
    },
    unmount() {
      disposed = true;
      generation += 1;
      active = null;
      retry = null;
    },
    /** 模拟 watcher 初始化尾部决策：只有列表请求真正成功才进入初始化/建 draft 逻辑。 */
    runWatcherTail: async function (sessionsLoadedOk: boolean) {
      if (disposed) return;
      if (!sessionsLoadedOk) return;
      if (serverSessions.length === 0 && drafts.length === 0) {
        drafts.push(`draft-g${generation}`);
        effects.push(`created-draft:g${generation}`);
      }
      initialized = true;
      effects.push(`initialized:g${generation}`);
    },
    /** 模拟 onActivated 在未初始化时的重试路径。 */
    activateRetry: async function () {
      if (initialized || disposed) return;
      const ok = await refreshSessions();
      if (!ok || disposed) return;
      // 权威列表已成功：标记初始化；仅当列表为空时补建 draft。
      initialized = true;
      effects.push(`initialized:g${generation}`);
      if (serverSessions.length > 0) return;
      if (drafts.length > 0) return;
      drafts.push(`draft-g${generation}`);
      effects.push(`created-draft:g${generation}`);
    },
    getState() {
      return { generation, workspaceId, disposed, active, retry, revision: mutationCache.revision, initialized, drafts: [...drafts] };
    }
  };
}

test("时间线：R1 命中完整 record 保护后只调度一次 R2，R2 收敛并清理缓存", async () => {
  const h = createHarness();
  h.setListSessions(async () => [{ id: "s1", title: "服务端-旧" }]);
  await h.refreshSessions();
  assert.equal(h.serverSessions[0].title, "服务端-旧");

  // R1 开始（pending），期间发生手动 mutation
  const r1 = controlled<typeof h.serverSessions>();
  h.setListSessions(() => r1.promise);
  const refreshP = h.refreshSessions();
  h.mutateTitle("s1", "手动标题");

  // R2（同步递归发起）使用服务端权威值；先替换列表实现再让 R1 返回
  h.setListSessions(async () => [{ id: "s1", title: "服务端-权威" }]);
  r1.resolve([{ id: "s1", title: "服务端-旧" }]);
  await refreshP;
  // R1 合并时完整保留 mutation record（不回退），随后同步调度 R2
  assert.ok(h.effects.includes("applied:g1"));
  assert.ok(h.effects.includes("schedule-r2:g1"));
  // R2 已采用服务端权威值并收敛缓存
  assert.equal(h.serverSessions[0].title, "服务端-权威");
  assert.ok(h.effects.includes("converged:s1"));
});

test("时间线：Workspace 切换时旧请求不阻塞新请求，旧 finally 不清新 token", async () => {
  const h = createHarness();
  const slow = controlled<never>();
  h.setListSessions(() => slow.promise as Promise<never>);
  const r1 = h.refreshSessions(); // G1 在途
  assert.deepEqual(h.getState().active, { generation: 1, workspaceId: "ws-a" });

  h.switchWorkspace("ws-b");
  // G2 可立即发起，不受 G1 占用影响
  h.setListSessions(async () => [{ id: "s2", title: "W2 会话" }]);
  const r2 = h.refreshSessions();
  await r2;
  assert.equal(h.serverSessions[0]?.title, "W2 会话");
  assert.ok(h.effects.includes("cleared-active:g2"));

  // G1 慢请求返回：响应不可写，不得清理 G2 的 active token
  slow.resolve([] as never);
  await r1;
  const state = h.getState();
  assert.equal(state.active, null); // G2 已自行清理
  assert.equal(state.workspaceId, "ws-b");
  assert.equal(h.serverSessions.length, 1);
  assert.equal(h.serverSessions[0].id, "s2");
});

test("时间线：旧 baseline 恢复前校验 generation（模拟 title-sync retry）", async () => {
  const h = createHarness();
  const g1 = h.getState().generation;
  const w1 = "ws-a";
  const baseline = { sessionId: "s1", updatedAt: 100 };

  h.switchWorkspace("ws-b");
  // 旧 generation 的失败回调：不得恢复 baseline
  const writable = isRequestResponseWritable({
    disposed: h.getState().disposed,
    currentGeneration: h.getState().generation,
    requestGeneration: g1,
    currentWorkspaceId: h.getState().workspaceId,
    requestWorkspaceId: w1
  });
  assert.equal(writable, false);
  void baseline;
});

test("时间线：卸载后在途响应不写状态", async () => {
  const h = createHarness();
  const pending = controlled<never>();
  h.setListSessions(() => pending.promise as Promise<never>);
  const p = h.refreshSessions();
  h.unmount();
  pending.resolve([] as never);
  const ok = await p;
  assert.equal(ok, false);
  assert.equal(h.serverSessions.length, 0);
  assert.equal(h.effects.includes("applied:g1"), false);
});

test("时间线：R2 失败时保留 mutation record，等待后续刷新收敛", async () => {
  const h = createHarness();
  h.setListSessions(async () => [{ id: "s1", title: "旧" }]);
  await h.refreshSessions();

  const r1 = controlled<typeof h.serverSessions>();
  h.setListSessions(() => r1.promise);
  const refreshP = h.refreshSessions();
  h.mutateTitle("s1", "手动");

  // R2（同步递归发起）失败：先替换为失败实现再让 R1 返回
  let r2Calls = 0;
  h.setListSessions(() => {
    r2Calls += 1;
    return Promise.reject(new Error("network"));
  });
  r1.resolve([{ id: "s1", title: "旧" }]);
  // R2 随 R1 的 finally 同步递归发起，需等待其失败 Promise 结算
  await refreshP;
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.effects.includes("schedule-r2:g1"));
  assert.ok(r2Calls >= 1);
  // mutation record 仍保留，标题不回退
  assert.equal(h.serverSessions[0].title, "手动");

  // 后续刷新成功：完整采用服务端权威并收敛
  h.setListSessions(async () => [{ id: "s1", title: "权威" }]);
  await h.refreshSessions();
  assert.equal(h.serverSessions[0].title, "权威");
  assert.ok(h.effects.includes("converged:s1"));
});


test("时间线：当前 generation 列表请求失败时不创建 draft、保留重试能力", async () => {
  const h = createHarness();
  h.setListSessions(() => Promise.reject(new Error("network")));
  const ok = await h.refreshSessions();
  assert.equal(ok, false);
  // 失败：不写任何会话，列表为空但不得视为“已确认空列表”
  assert.equal(h.serverSessions.length, 0);
  assert.equal(h.effects.includes("applied:g1"), false);
  // loading/active 已释放，后续重试可成功
  assert.equal(h.getState().active, null);
  h.setListSessions(async () => [{ id: "s1", title: "重试成功" }]);
  const ok2 = await h.refreshSessions();
  assert.equal(ok2, true);
  assert.equal(h.serverSessions[0].title, "重试成功");
});

test("时间线：W1 保存 pending 时切 W2，W1 的 finally 不得清理 W2 新保存的 saving", async () => {
  // 模拟组件级 activeTitleSave token 语义：旧 token 的 finally 只在仍是当前 token 时清理。
  type SaveToken = { generation: number; workspaceId: string; sessionId: string; requestId: number };
  let activeSave: SaveToken | null = null;
  let nextRequestId = 0;
  let saving = false;
  const savingLog: string[] = [];

  const w1Token: SaveToken = { generation: 1, workspaceId: "ws-a", sessionId: "s1", requestId: ++nextRequestId };
  activeSave = w1Token;
  saving = true;
  savingLog.push("w1:start");

  // 切换到 W2：组件强制失效，清空 activeSave 与 saving
  activeSave = null;
  saving = false;
  savingLog.push("switch:cleared");

  // W2 发起新保存
  const w2Token: SaveToken = { generation: 2, workspaceId: "ws-b", sessionId: "s2", requestId: ++nextRequestId };
  activeSave = w2Token;
  saving = true;
  savingLog.push("w2:start");

  // W1 的保存请求晚到：其 finally 只在 activeSave === w1Token 时清理
  if (activeSave === w1Token) {
    saving = false;
    savingLog.push("w1:cleared");
  }
  // W2 的 saving 仍保持
  assert.equal(saving, true);
  assert.deepEqual(savingLog, ["w1:start", "switch:cleared", "w2:start"]);
  assert.equal(activeSave, w2Token);

  // W2 完成：正常清理
  if (activeSave === w2Token) {
    activeSave = null;
    saving = false;
    savingLog.push("w2:cleared");
  }
  assert.equal(saving, false);
  assert.deepEqual(savingLog, ["w1:start", "switch:cleared", "w2:start", "w2:cleared"]);
});


test("初始化决策：首次列表失败 -> 不建 draft、未初始化；激活重试返回已有 Session -> 不建 draft", async () => {
  const h = createHarness();
  h.setListSessions(() => Promise.reject(new Error("network")));
  const ok1 = await h.refreshSessions();
  await h.runWatcherTail(ok1);
  // 首次失败：不建 draft、不标记初始化
  assert.equal(h.getState().initialized, false);
  assert.deepEqual(h.getState().drafts, []);

  // 激活重试：列表已有真实 Session -> 不建 draft
  h.setListSessions(async () => [{ id: "s1", title: "真实会话" }]);
  await h.activateRetry();
  assert.equal(h.getState().initialized, true);
  assert.deepEqual(h.getState().drafts, []);
  assert.equal(h.serverSessions[0].title, "真实会话");
});

test("初始化决策：首次失败 -> 激活重试成功且列表为空 -> 此时才建 draft", async () => {
  const h = createHarness();
  h.setListSessions(() => Promise.reject(new Error("network")));
  const ok1 = await h.refreshSessions();
  await h.runWatcherTail(ok1);
  assert.equal(h.getState().initialized, false);
  assert.deepEqual(h.getState().drafts, []);

  // 激活重试成功且列表为空 -> 建 draft
  h.setListSessions(async () => []);
  await h.activateRetry();
  assert.equal(h.getState().initialized, true);
  assert.deepEqual(h.getState().drafts, ["draft-g1"]);

  // 已初始化后再激活：draft 已存在，不重复创建
  await h.activateRetry();
  assert.deepEqual(h.getState().drafts, ["draft-g1"]);
});

test("初始化决策：首次成功且列表为空 -> watcher 直接建 draft 并标记初始化", async () => {
  const h = createHarness();
  h.setListSessions(async () => []);
  const ok = await h.refreshSessions();
  await h.runWatcherTail(ok);
  assert.equal(h.getState().initialized, true);
  assert.deepEqual(h.getState().drafts, ["draft-g1"]);
});


test("时间线：W1 onActivated 重试即将完成时切 W2，旧回调不得修改 W2 初始化状态或创建 W2 draft", async () => {
  const h = createHarness();
  // W1 首次失败
  h.setListSessions(() => Promise.reject(new Error("network")));
  const ok1 = await h.refreshSessions();
  await h.runWatcherTail(ok1);
  assert.equal(h.getState().initialized, false);

  // W1 激活重试：请求 pending
  const pending = controlled<{ id: string; title: string }[]>();
  h.setListSessions(() => pending.promise);
  const retryPromise = (async () => {
    const g = h.getState().generation;
    const w = "ws-a";
    const ok = await h.refreshSessions();
    // 生产 onActivated 回调：执行前校验发起时的 generation/workspace
    if (!ok) return;
    const writable = isRequestResponseWritable({
      disposed: h.getState().disposed,
      currentGeneration: h.getState().generation,
      requestGeneration: g,
      currentWorkspaceId: h.getState().workspaceId,
      requestWorkspaceId: w
    });
    if (!writable) return;
    await h.runWatcherTail(ok);
  })();

  // 重试即将完成前切换 W2
  h.switchWorkspace("ws-b");
  // W1 重试返回成功，但回调应因 generation 过期而丢弃
  pending.resolve([]);
  await retryPromise;

  // W2 未被旧回调污染：未初始化、无 draft
  assert.equal(h.getState().initialized, false);
  assert.deepEqual(h.getState().drafts, []);
  assert.equal(h.getState().workspaceId, "ws-b");

  // W2 自行激活重试：成功且空列表 -> 正常初始化并建 draft
  h.setListSessions(async () => []);
  await h.activateRetry();
  assert.equal(h.getState().initialized, true);
  assert.deepEqual(h.getState().drafts, ["draft-g2"]);
});
