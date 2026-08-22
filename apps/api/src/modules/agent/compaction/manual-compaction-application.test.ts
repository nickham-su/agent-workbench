import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualCompactionApplication } from "./manual-compaction-application.js";
import type { ManualCompactionApplicationDependencies } from "./manual-compaction-ports.js";

function create(overrides: Partial<ManualCompactionApplicationDependencies> = {}) {
  const calls: string[] = [];
  const deps: ManualCompactionApplicationDependencies = {
    reconcilePendingForSessionBestEffort: async () => { calls.push("reconcile"); return false; },
    sessions: { get: () => ({ id: "session", workspaceId: "workspace", kind: "primary", headItemId: 7 } as any), getVisibleItems: () => [{ kind: "user", boundaryReason: null }] },
    isWorkerEnabled: () => true,
    findDedup: () => null,
    getRunState: () => ({ status: "idle" }),
    getControlRunState: () => ({}) as any,
    resolveProfile: () => ({ agentId: "agent", providerId: "provider", modelId: "model" }),
    getWorkspaceRunContext: () => ({ workspacePath: "/workspace", workspaceRepoDirNames: ["repo"] }),
    activate: () => calls.push("activate"),
    failAfterEnqueueFailure: () => calls.push("settle"),
    clock: { nowMs: () => 100 }, ids: { newRunId: () => "run" }, ...overrides
  };
  return { app: new ManualCompactionApplication(deps), calls };
}
const command = (runtime: any) => ({ sessionId: "session", body: { workspaceId: "workspace", clientRequestId: "request" }, runtime });

test("ManualCompactionApplication keeps reconcile, activation, sentinel enqueue order", async () => {
  const { app, calls } = create();
  const result = await app.schedule(command({ enqueueRun: async (input: any) => { calls.push(`enqueue:${input.inputText}`); } }));
  assert.equal(result.scheduled, true);
  assert.deepEqual(calls, ["reconcile", "activate", "enqueue:__awb_compact__"]);
});

test("ManualCompactionApplication preserves dedup without activation or enqueue", async () => {
  const { app, calls } = create({ findDedup: () => ({ runId: "existing" }) });
  const result = await app.schedule(command({ enqueueRun: () => calls.push("enqueue") }));
  assert.equal(result.scheduled, false); assert.equal(result.runId, "existing"); assert.deepEqual(calls, ["reconcile"]);
});

test("ManualCompactionApplication settles through Lifecycle bridge after enqueue failure", async () => {
  const { app, calls } = create();
  await assert.rejects(app.schedule(command({ enqueueRun: () => { calls.push("enqueue"); throw new Error("enqueue failed"); } })), /enqueue failed/);
  assert.deepEqual(calls, ["reconcile", "activate", "enqueue", "settle"]);
});
