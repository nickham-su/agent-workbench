import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntimePort } from "../agent.runtime-port.js";
import { AgentStartupCoordinator } from "./agent-startup-coordinator.js";

function createCoordinator(params: {
  recoveryMode: "fail" | "recover";
  cleanupError?: boolean;
  archiveError?: boolean;
}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const coordinator = new AgentStartupCoordinator({
    cleanupOrphans: async () => {
      calls.push("cleanup");
      if (params.cleanupError) throw new Error("cleanup failed");
    },
    reconcileArchive: async () => {
      calls.push("archive");
      if (params.archiveError) throw new Error("archive failed");
    },
    failRuns: async () => { calls.push("fail"); },
    recoverRuns: async () => { calls.push("recover"); },
    logger: { warn: (_bindings, message) => warnings.push(message) },
    recoveryMode: params.recoveryMode
  });
  return { coordinator, calls, warnings };
}

test("AgentStartupCoordinator keeps cleanup, archive and fail ordered before listen", async () => {
  const { coordinator, calls } = createCoordinator({ recoveryMode: "fail" });
  await coordinator.runPreListen();
  assert.deepEqual(calls, ["cleanup", "archive", "fail"]);
});

test("AgentStartupCoordinator isolates cleanup/archive failure and registers recover only on listen", async () => {
  const { coordinator, calls, warnings } = createCoordinator({
    recoveryMode: "recover",
    cleanupError: true,
    archiveError: true
  });
  await coordinator.runPreListen();
  assert.deepEqual(calls, ["cleanup", "archive"]);
  assert.deepEqual(warnings, ["subtask orphan startup scan failed", "archive pending startup reconcile failed"]);

  let onListen: (() => Promise<void>) | undefined;
  const app = {
    addHook(name: string, handler: () => Promise<void>) {
      assert.equal(name, "onListen");
      onListen = handler;
    }
  };
  coordinator.registerRecoverOnListen(app as never, { enqueueRun() {}, cancelSession() {} } as AgentRuntimePort);
  assert.ok(onListen);
  await onListen();
  assert.deepEqual(calls, ["cleanup", "archive", "recover"]);
});
