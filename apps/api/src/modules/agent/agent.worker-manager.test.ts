import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentWorkerSpawnEnv, completeAgentWorkerReady } from "./agent.worker-manager.js";
import { AgentStartupCoordinator } from "./startup/agent-startup-coordinator.js";

test("normalized AppContext response validation is explicitly propagated to worker spawn env", () => {
  const env = buildAgentWorkerSpawnEnv(
    {
      parentEnv: { AWB_DATA_DIR: "/wrong-data", AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "invalid", OTHER: "keep" },
      dataDir: "/resolved/api-data",
      workerHost: "127.0.0.1",
      workerPort: 4312,
      socketPath: "worker.sock",
      workerConcurrency: 2,
      apiOrigin: "http://api",
      internalToken: "TOKEN",
      responseValidation: "warn",
      pidFilePath: "worker.pid",
      repoRoot: "/repo"
    }
  );

  assert.equal(env.AWB_INTERNAL_RPC_RESPONSE_VALIDATION, "warn");
  assert.equal(env.OTHER, "keep");
  assert.equal(env.AWB_DATA_DIR, "/resolved/api-data");
});

test("Worker onReady 失败时不重置 restart backoff，成功后才重置", async () => {
  let resets = 0;
  await assert.rejects(
    completeAgentWorkerReady({
      generation: 3,
      onReady: async () => { throw new Error("recovery failed"); },
      resetRestartState: () => { resets += 1; },
    }),
    /recovery failed/,
  );
  assert.equal(resets, 0);

  await completeAgentWorkerReady({
    generation: 4,
    onReady: async () => undefined,
    resetRestartState: () => { resets += 1; },
  });
  assert.equal(resets, 1);
});

test("runtime ready recovery is coalesced across initial ready and replacement Worker generation", async () => {
  let entered = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new AgentStartupCoordinator({
    cleanupOrphans: () => undefined,
    cleanupAttachmentTemps: () => undefined,
    recoverRuns: async () => {
      entered += 1;
      await blocked;
    },
    logger: { warn: () => undefined },
  });
  const runtime = { enqueueRun: () => undefined, cancelSession: () => undefined };
  const first = coordinator.recoverWhenRuntimeReady(runtime);
  const second = coordinator.recoverWhenRuntimeReady(runtime);
  await Promise.resolve();
  assert.equal(entered, 1);
  release();
  await Promise.all([first, second]);
  await coordinator.recoverWhenRuntimeReady(runtime);
  assert.equal(entered, 2);
});
