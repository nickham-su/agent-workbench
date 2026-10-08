import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceLifecycleCoordinator } from "./workspace-lifecycle-coordinator.js";
import { workspaceDeletingFence } from "../../modules/agent/lifecycle/workspace-deleting-fence.js";
import { HttpError } from "../../app/errors.js";

function resetFence(...workspaceIds: string[]) {
  for (const workspaceId of workspaceIds) workspaceDeletingFence.end(workspaceId);
}

test("lifecycle gate 使删除 admission 与已通过旧检查的 mutation 串行", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const workspaceId = "ws_lifecycle_race";
  resetFence(workspaceId);
  let releaseAdmission!: () => void;
  const admissionEntered = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let releaseDelete!: () => void;
  const deleteMayBegin = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const sideEffects: string[] = [];

  const oldCheckAlreadyPassed = coordinator.withAdmission(workspaceId, async () => {
    await admissionEntered;
    sideEffects.push("old-check-finished");
  });
  const deleting = coordinator.withAdmission(workspaceId, async () => {
    await deleteMayBegin;
    workspaceDeletingFence.restore(workspaceId);
    sideEffects.push("intent-written");
  });
  const mutation = coordinator.withMutation(workspaceId, async () => {
    sideEffects.push("MUST_NOT_RUN");
  });

  releaseAdmission();
  await oldCheckAlreadyPassed;
  releaseDelete();
  await deleting;
  await assert.rejects(mutation, (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING");
  assert.deepEqual(sideEffects, ["old-check-finished", "intent-written"]);
  resetFence(workspaceId);
});

test("restored tombstone 拒绝同 Workspace mutation，但不阻塞其他 Workspace", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const deletingWorkspace = "ws_restored";
  const otherWorkspace = "ws_other";
  resetFence(deletingWorkspace, otherWorkspace);
  workspaceDeletingFence.restore(deletingWorkspace);
  const effects: string[] = [];
  await assert.rejects(
    () => coordinator.withMutation(deletingWorkspace, async () => { effects.push("deleted-workspace"); }),
    (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING",
  );
  await coordinator.withMutation(otherWorkspace, async () => { effects.push("other-workspace"); });
  assert.deepEqual(effects, ["other-workspace"]);
  resetFence(deletingWorkspace, otherWorkspace);
});

test("同一异步链的同 Workspace 重入不会绕过首次 fence 检查", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const workspaceId = "ws_reentrant";
  resetFence(workspaceId);
  const effects: string[] = [];
  await coordinator.withMutation(workspaceId, async () => {
    await coordinator.withMutation(workspaceId, async () => { effects.push("nested"); });
  });
  assert.deepEqual(effects, ["nested"]);

  workspaceDeletingFence.restore(workspaceId);
  await assert.rejects(
    () => coordinator.withMutation(workspaceId, async () => {
      effects.push("MUST_NOT_RUN");
      await coordinator.withMutation(workspaceId, async () => { effects.push("MUST_NOT_RUN_NESTED"); });
    }),
    (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING",
  );
  assert.deepEqual(effects, ["nested"]);
  resetFence(workspaceId);
});

test("同链对另一 Workspace 不重入，仍独立执行其 admission", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const first = "ws_first";
  const second = "ws_second";
  resetFence(first, second);
  workspaceDeletingFence.restore(second);
  await assert.rejects(
    () => coordinator.withMutation(first, async () => coordinator.withMutation(second, async () => undefined)),
    (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING",
  );
  resetFence(first, second);
});

test("已入场 mutation 完成前 delete intent 不能越过；intent 后新 mutation 被拒绝", async () => {
  const coordinator = new WorkspaceLifecycleCoordinator();
  const workspaceId = "ws_upload_delete_race";
  resetFence(workspaceId);
  let releaseUpload!: () => void;
  const uploadEntered = new Promise<void>((resolve) => { releaseUpload = resolve; });
  let releaseWrite!: () => void;
  const allowUploadWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const events: string[] = [];

  const upload = coordinator.withMutation(workspaceId, async () => {
    events.push("upload-admitted");
    releaseUpload();
    await allowUploadWrite;
    events.push("upload-written");
  });
  await uploadEntered;
  const deleting = coordinator.withAdmission(workspaceId, async () => {
    workspaceDeletingFence.restore(workspaceId);
    events.push("intent-written");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["upload-admitted"]);
  releaseWrite();
  await upload;
  await deleting;
  await assert.rejects(() => coordinator.withMutation(workspaceId, async () => { events.push("MUST_NOT_WRITE"); }), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_DELETING");
  assert.deepEqual(events, ["upload-admitted", "upload-written", "intent-written"]);
  resetFence(workspaceId);
});
