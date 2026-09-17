import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntimePort } from "../agent.runtime-port.js";
import { AgentStartupCoordinator } from "./agent-startup-coordinator.js";

function createCoordinator(params?: {
  cleanupError?: boolean;
  attachmentCleanupError?: boolean;
}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const coordinator = new AgentStartupCoordinator({
    cleanupOrphans: async () => {
      calls.push("cleanup");
      if (params?.cleanupError) throw new Error("cleanup failed");
    },
    cleanupAttachmentTemps: async () => {
      calls.push("attachments");
      if (params?.attachmentCleanupError) throw new Error("attachment cleanup failed");
    },
    recoverRuns: async () => { calls.push("recover"); },
    logger: { warn: (_bindings, message) => warnings.push(message) }
  });
  return { coordinator, calls, warnings };
}

test("AgentStartupCoordinator keeps pre-listen cleanup independent from recovery", async () => {
  const { coordinator, calls } = createCoordinator();
  await coordinator.runPreListen();
  assert.deepEqual(calls, ["cleanup", "attachments"]);
});

test("AgentStartupCoordinator always registers fenced recovery after listen", async () => {
  const { coordinator, calls, warnings } = createCoordinator({
    cleanupError: true,
    attachmentCleanupError: true
  });
  await coordinator.runPreListen();
  assert.deepEqual(calls, ["cleanup", "attachments"]);
  assert.deepEqual(warnings, ["subtask orphan startup scan failed", "agent attachment temp startup cleanup failed"]);

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
  assert.deepEqual(calls, ["cleanup", "attachments", "recover"]);
});

test("AgentStartupCoordinator 在扫描期间收到新 Worker generation ready 时串行补跑一次", async () => {
  let entered = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runtimeOne = { enqueueRun() {}, cancelSession() {} } as AgentRuntimePort;
  const runtimeTwo = { enqueueRun() {}, cancelSession() {} } as AgentRuntimePort;
  const recoveredRuntimes: AgentRuntimePort[] = [];
  const coordinator = new AgentStartupCoordinator({
    cleanupOrphans: () => undefined,
    cleanupAttachmentTemps: () => undefined,
    recoverRuns: async ({ runtime }) => {
      recoveredRuntimes.push(runtime);
      entered += 1;
      if (entered === 1) await firstBlocked;
    },
    logger: { warn: () => undefined },
  });

  const first = coordinator.recoverWhenRuntimeReady(runtimeOne, 1);
  await Promise.resolve();
  const duplicate = coordinator.recoverWhenRuntimeReady(runtimeOne, 1);
  const replacement = coordinator.recoverWhenRuntimeReady(runtimeTwo, 2);
  await Promise.resolve();
  assert.equal(entered, 1, "同 generation 合并，替换 generation 不并发扫描");
  releaseFirst();
  await Promise.all([first, duplicate, replacement]);
  assert.equal(entered, 2);
  assert.deepEqual(recoveredRuntimes, [runtimeOne, runtimeTwo]);
});

test("AgentStartupCoordinator 旧 generation 扫描失败后仍补跑已 ready 的新 generation", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstFailure = new Error("generation one scan failed");
  const runtimeOne = { enqueueRun() {}, cancelSession() {} } as AgentRuntimePort;
  const runtimeTwo = { enqueueRun() {}, cancelSession() {} } as AgentRuntimePort;
  const recoveredRuntimes: AgentRuntimePort[] = [];
  const warnings: string[] = [];
  const coordinator = new AgentStartupCoordinator({
    cleanupOrphans: () => undefined,
    cleanupAttachmentTemps: () => undefined,
    recoverRuns: async ({ runtime }) => {
      recoveredRuntimes.push(runtime);
      if (runtime === runtimeOne) {
        await firstBlocked;
        throw firstFailure;
      }
    },
    logger: { warn: (_bindings, message) => warnings.push(message) },
  });

  const first = coordinator.recoverWhenRuntimeReady(runtimeOne, 1);
  await Promise.resolve();
  const replacement = coordinator.recoverWhenRuntimeReady(runtimeTwo, 2);
  releaseFirst();

  await Promise.all([first, replacement]);
  assert.deepEqual(recoveredRuntimes, [runtimeOne, runtimeTwo]);
  assert.deepEqual(warnings, ["agent run recovery scan failed; continuing with newer Worker generation"]);
});
