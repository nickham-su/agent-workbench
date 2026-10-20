import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ToolRuntimeContext } from "../../runtime";
import type { WorkspaceGitStatusResponse } from "@agent-workbench/shared";
import { createCodeReviewRuntime } from "./runtime";

const status = (...dirty: boolean[]): WorkspaceGitStatusResponse => ({ repos: dirty.map((hasChanges, index) => ({
  repoId: `repo-${index}`, dirName: `repo-${index}`, head: { branch: "main", detached: false, sha: "abc" }, hasChanges
})) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function fixture(t: TestContext, options: { visible?: boolean; detailFailure?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: { time: number; workspaceId: string }[] = [];
  const requests: ReturnType<typeof deferred<WorkspaceGitStatusResponse>>[] = [];
  const dots: boolean[] = [];
  const summaries: WorkspaceGitStatusResponse[] = [];
  const errors: unknown[] = [];
  let detailCalls = 0;
  let time = 0;
  const ctx: ToolRuntimeContext = {
    workspaceId: "workspace", toolId: "codeReview",
    host: { call() {}, setToolDot: (_, dot) => { dots.push(dot); } },
    getCurrentTarget: () => ({ kind: "workspaceRepo", workspaceId: "workspace", dirName: "clean-selected" }),
    getVisible: () => options.visible ?? false,
    api: { getWorkspaceGitStatus: ({ workspaceId }) => {
      calls.push({ time, workspaceId });
      const request = deferred<WorkspaceGitStatusResponse>(); requests.push(request); return request.promise;
    } },
    onWorkspaceGitStatus: (value) => { summaries.push(value); },
    onBackgroundError: (error) => { errors.push(error); },
    refreshView: async () => { detailCalls++; if (options.detailFailure) throw new Error("detail failure"); }
  };
  const runtime = createCodeReviewRuntime(ctx);
  t.after(() => runtime.dispose());
  return {
    runtime, requests, calls, dots, summaries, errors, get detailCalls() { return detailCalls; },
    async tick(ms: number) { time += ms; t.mock.timers.tick(ms); await settle(); },
    async succeed(value = status(false, true)) { requests.at(-1)!.resolve(value); await settle(); },
    async fail() { requests.at(-1)!.reject(new Error("仓库 repo-1 查询失败")); await settle(); }
  };
}

test("首次立即查询整个 Workspace，隐藏且没有面板时仍聚合其他仓库红点", async (t) => {
  const f = fixture(t); f.runtime.start();
  assert.deepEqual(f.calls, [{ time: 0, workspaceId: "workspace" }]);
  await f.succeed();
  assert.deepEqual(f.dots, [true]); assert.equal(f.summaries.length, 1); assert.equal(f.detailCalls, 0);
});

test("空仓库摘要成功清除红点并按相同冷却继续轮询", async (t) => {
  const f = fixture(t); f.runtime.start(); await f.succeed(status());
  assert.deepEqual(f.dots, [false]); assert.deepEqual(f.summaries, [{ repos: [] }]);
  await f.runtime.refresh!();
  await f.tick(4999); assert.equal(f.calls.length, 1);
  await f.tick(1); assert.equal(f.calls.length, 2);
  await f.succeed(status()); assert.deepEqual(f.dots, [false, false]);
});

test("慢请求不重叠，完成后才等待5秒；多次显式触发加入同一请求且无pending补跑", async (t) => {
  const f = fixture(t); f.runtime.start();
  await f.tick(20000); assert.equal(f.calls.length, 1);
  const joined = f.runtime.refresh!(); f.runtime.onRepoChange(null); f.runtime.onVisibilityChange(true);
  await f.succeed(); await joined;
  assert.equal(f.calls.length, 1);
  await f.tick(4999); assert.equal(f.calls.length, 1);
  await f.tick(1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.time, 25000);
});

for (const outcome of ["success", "failure"] as const) {
  test(`${outcome} 后切仓库、显示面板和显式刷新均遵守完整5秒冷却`, async (t) => {
    const f = fixture(t); f.runtime.start();
    if (outcome === "success") await f.succeed(); else await f.fail();
    const trigger = async () => {
      f.runtime.onRepoChange(null);
      f.runtime.onVisibilityChange(false);
      f.runtime.onVisibilityChange(true);
      // 冷却期间必须立即完成，不等待下一次定时查询，也不留下补跑任务。
      await f.runtime.refresh!();
    };
    await trigger();
    assert.equal(f.calls.length, 1);
    assert.equal(f.detailCalls, 1, "重新显示只即时刷新详情");
    await f.tick(4999); await trigger();
    assert.equal(f.calls.length, 1);
    await f.tick(1);
    assert.deepEqual(f.calls.map((call) => call.time), [0, 5000]);
    await f.succeed();
    assert.equal(f.calls.length, 2);
    await f.tick(4999); assert.equal(f.calls.length, 2);
  });
}

test("持续24次失败在第12和24次各提示一次，失败后5秒重试且保持旧摘要和红点", async (t) => {
  const f = fixture(t); f.runtime.start(); await f.succeed();
  for (let i = 1; i <= 24; i++) {
    await f.tick(5000); await f.fail();
    assert.equal(f.errors.length, Math.floor(i / 12));
  }
  assert.deepEqual(f.dots, [true]); assert.equal(f.summaries.length, 1);
  assert.equal((f.errors[0] as Error).message, "仓库 repo-1 查询失败");
});

test("任意摘要成功清零失败计数；详细列表失败不计入摘要失败", async (t) => {
  const f = fixture(t, { visible: true, detailFailure: true }); f.runtime.start();
  for (let i = 0; i < 11; i++) { await f.fail(); await f.tick(5000); }
  await f.succeed(status(false)); assert.equal(f.errors.length, 0);
  for (let i = 0; i < 11; i++) { await f.tick(5000); await f.fail(); }
  assert.equal(f.errors.length, 0);
  await f.tick(5000); await f.fail(); assert.equal(f.errors.length, 1);
  assert.ok(f.detailCalls > 0); assert.deepEqual(f.dots, [false]);
});

test("只在可见时刷新当前仓库细节，操作后的摘要刷新不重复刷新面板", async (t) => {
  const f = fixture(t, { visible: true }); f.runtime.start(); await f.succeed();
  assert.equal(f.detailCalls, 1);
  await f.runtime.refresh!();
  assert.equal(f.calls.length, 1);
  assert.equal(f.detailCalls, 1);
  f.runtime.onVisibilityChange(false); await f.tick(5000); await f.succeed(); assert.equal(f.detailCalls, 1);
  f.runtime.onVisibilityChange(true); await settle(); assert.equal(f.detailCalls, 2);
});

test("dispose 清理计时器，不回写在途结果或发出新查询", async (t) => {
  const f = fixture(t); f.runtime.start(); f.runtime.dispose(); await f.succeed(); await f.tick(5000);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.dots, []); assert.deepEqual(f.summaries, []);
});
