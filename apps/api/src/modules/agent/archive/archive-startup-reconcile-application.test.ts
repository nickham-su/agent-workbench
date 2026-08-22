import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchiveStartupReconcileApplication } from "./archive-startup-reconcile-application.js";

test("ArchiveStartupReconcileApplication isolates one session failure and continues", async () => {
  const calls: string[] = [];
  const app = new ArchiveStartupReconcileApplication({
    listSessions: () => [{ workspaceId: "w", sessionId: "first" }, { workspaceId: "w", sessionId: "second" }],
    reconcilePendingBestEffort: async ({ sessionId }) => { calls.push(sessionId); if (sessionId === "first") throw new Error("failed"); return false; },
    logger: { warn: () => calls.push("warn") }
  });
  await app.reconcileAllPendingBestEffort();
  assert.deepEqual(calls, ["first", "warn", "second"]);
});
