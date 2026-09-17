import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { recoverAfterAgentRuntimeReady } from "./agent-runtime-ready.js";

const runtime = { enqueueRun: () => undefined, cancelSession: () => undefined };

test("runtime ready 先续作删除，再恢复其他 Run，删除失败不杀健康 Worker", async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  await recoverAfterAgentRuntimeReady({
    runtime,
    generation: 7,
    resumeWorkspaceDeletions: async () => {
      calls.push("resume-deletion");
      throw new Error("deletion remains pending");
    },
    recoverRuns: async ({ generation }) => {
      calls.push(`recover-runs:${generation}`);
    },
    reconcileTerminals: async () => {
      calls.push("reconcile-terminals");
    },
    logger: { warn: (_bindings: Record<string, unknown>, message: string) => {
      warnings.push(message);
    } } as Pick<FastifyBaseLogger, "warn">,
  });
  assert.deepEqual(calls, ["resume-deletion", "recover-runs:7", "reconcile-terminals"]);
  assert.deepEqual(warnings, ["workspace deletion startup resume failed"]);
});

test("runtime ready 保留意外 Run recovery 失败，使 Worker manager 应用退避", async () => {
  const calls: string[] = [];
  await assert.rejects(
    recoverAfterAgentRuntimeReady({
      runtime,
      generation: 1,
      resumeWorkspaceDeletions: async () => { calls.push("resume-deletion"); },
      recoverRuns: async () => {
        calls.push("recover-runs");
        throw new Error("database unavailable");
      },
      reconcileTerminals: async () => { calls.push("reconcile-terminals"); },
      logger: { warn: () => undefined },
    }),
    /database unavailable/,
  );
  assert.deepEqual(calls, ["resume-deletion", "recover-runs"]);
});

test("runtime ready 终端恢复失败不会阻断健康 Worker", async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  await recoverAfterAgentRuntimeReady({
    runtime,
    generation: 2,
    resumeWorkspaceDeletions: async () => { calls.push("resume-deletion"); },
    recoverRuns: async () => { calls.push("recover-runs"); },
    reconcileTerminals: async () => {
      calls.push("reconcile-terminals");
      throw new Error("tmux unavailable");
    },
    logger: { warn: (_bindings: Record<string, unknown>, message: string) => {
      warnings.push(message);
    } } as Pick<FastifyBaseLogger, "warn">,
  });
  assert.deepEqual(calls, ["resume-deletion", "recover-runs", "reconcile-terminals"]);
  assert.deepEqual(warnings, ["terminal startup reconciliation failed"]);
});
