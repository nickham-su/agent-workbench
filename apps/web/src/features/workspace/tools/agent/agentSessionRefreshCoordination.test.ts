import assert from "node:assert/strict";
import test from "node:test";
import {
  canScheduleRetryRefresh,
  canStartRefresh,
  convergeMutationCache,
  createTitleMutationCache
} from "./agentSessionRefreshCoordination";

test("canStartRefresh：同 generation/workspace 在途则拒绝，其他情况允许", () => {
  const active = { generation: 1, workspaceId: "ws-a" };
  assert.equal(canStartRefresh(active, 1, "ws-a"), false);
  assert.equal(canStartRefresh(active, 2, "ws-a"), true);
  assert.equal(canStartRefresh(active, 1, "ws-b"), true);
  assert.equal(canStartRefresh(null, 1, "ws-a"), true);
});

test("canStartRefresh：Workspace 切换时旧 generation 不阻止新请求（G1 在途 -> G2 可发起）", () => {
  const g1Active = { generation: 1, workspaceId: "ws-a" };
  // G2/W2 与 G1/W1 不同 generation，可立即发起
  assert.equal(canStartRefresh(g1Active, 2, "ws-b"), true);
});

test("canScheduleRetryRefresh：R2 去重且跨 generation 独立", () => {
  const retry = { generation: 1, workspaceId: "ws-a" };
  assert.equal(canScheduleRetryRefresh(retry, 1, "ws-a"), false);
  // 多个受保护 Session 只调度一次 R2（同 generation/workspace）
  assert.equal(canScheduleRetryRefresh(retry, 1, "ws-a"), false);
  // 新 Workspace 可独立调度自己的 R2
  assert.equal(canScheduleRetryRefresh(retry, 2, "ws-b"), true);
  assert.equal(canScheduleRetryRefresh(retry, 2, "ws-a"), true);
  assert.equal(canScheduleRetryRefresh(null, 1, "ws-a"), true);
});

test("convergeMutationCache：mutation 后开始的请求收敛已命中缓存", () => {
  const cache = createTitleMutationCache();
  cache.revision = 3;
  cache.revisionBySession.set("s1", 3);
  cache.recordBySession.set("s1", { id: "s1" });
  cache.revisionBySession.set("s2", 2);
  cache.recordBySession.set("s2", { id: "s2" });

  // 请求开始于 mutation 之后：revision >= cache.revision，收敛远端仍存在的 Session
  const cleared = convergeMutationCache(cache, 3, new Set(["s1", "s2"]));
  assert.deepEqual(cleared.sort(), ["s1", "s2"]);
  assert.equal(cache.revisionBySession.size, 0);
  assert.equal(cache.recordBySession.size, 0);
});

test("convergeMutationCache：请求早于 mutation 时不清理（保留完整 record 保护）", () => {
  const cache = createTitleMutationCache();
  cache.revision = 5;
  cache.revisionBySession.set("s1", 5);
  cache.recordBySession.set("s1", { id: "s1" });

  const cleared = convergeMutationCache(cache, 4, new Set(["s1"]));
  assert.deepEqual(cleared, []);
  assert.equal(cache.revisionBySession.has("s1"), true);
  assert.equal(cache.recordBySession.has("s1"), true);
});

test("convergeMutationCache：远端已删除的 Session 不误清（不复活语义）", () => {
  const cache = createTitleMutationCache();
  cache.revision = 2;
  cache.revisionBySession.set("s1", 2);
  cache.recordBySession.set("s1", { id: "s1" });
  cache.revisionBySession.set("gone", 2);
  cache.recordBySession.set("gone", { id: "gone" });

  const cleared = convergeMutationCache(cache, 2, new Set(["s1"]));
  assert.deepEqual(cleared, ["s1"]);
  // 已删除 Session 的缓存保留在 map 中（列表不含它，也不会复活）
  assert.equal(cache.revisionBySession.has("gone"), true);
});

test("convergeMutationCache：部分命中时只清理远端存在的 Session", () => {
  const cache = createTitleMutationCache();
  cache.revision = 2;
  cache.revisionBySession.set("s1", 2);
  cache.recordBySession.set("s1", { id: "s1" });
  cache.revisionBySession.set("s2", 2);
  cache.recordBySession.set("s2", { id: "s2" });

  const cleared = convergeMutationCache(cache, 2, new Set(["s1"]));
  assert.deepEqual(cleared, ["s1"]);
  assert.equal(cache.revisionBySession.has("s1"), false);
  assert.equal(cache.revisionBySession.has("s2"), true);
});
