import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AgentApiEndpoints, GitToolResultSchema, type GitToolResult } from "@agent-workbench/shared/internal-contracts/agent-api";
import { createAgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import { createSession, createMessageRunForTest, createMessageToolAnchor } from "./subtask.helpers.js";
import { getToolExecution } from "../agent-message.store.js";
import { ModelContextResolver } from "../read-side/model-context-resolver.js";
import { RuntimeTranscriptProjector } from "../read-side/runtime-transcript-projector.js";

const workerRuntime = new URL("../../../../../agent-worker/src/runtime/runner.ts", import.meta.url);
const { buildToolSuccessTextForTest } = await import(workerRuntime.href);
const base = {
  repo: "fixture-repo", ok: true, exitCode: 0, signal: null, timedOut: false, cancelled: false,
  outputLimitExceeded: false, processStopConfirmed: true, failureCode: null, leaseDisposition: "released",
  stdout: "fixture stdout", stderr: "fixture warning", outputRedacted: true, durationMs: 3, warnings: [],
} as const;

for (const [name, result] of [
  ["success", base],
  ["nonzero", { ...base, ok: false, exitCode: 128 }],
  ["parent-zero-unconfirmed", { ...base, ok: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED", leaseDisposition: "retained" }],
  ["cleanup-warning", { ...base, leaseDisposition: "release_unconfirmed", warnings: ["LEASE_CLEANUP_FAILED"] }],
] as const) {
  test(`Git API preserves structured result and history semantics: ${name}`, async (t) => {
    const fixture = await createAgentIntegrationFixture({ repoRoot: path.resolve("../../.tmp-tests/0032-stage3/api"), agentWorkerConcurrency: 0 });
    t.after(() => fixture.dispose());
    const session = await createSession(fixture.app, fixture.workspaceId);
    const run = createMessageRunForTest({ fixture, sessionId: session.id });
    const input = { repo: "fixture-repo", args: ["status", "fixture-model-visible-argv"], timeout: 7 };
    const anchor = createMessageToolAnchor({ fixture, sessionId: session.id, runId: run.runId, toolName: "git", input });
    const owner = { workspaceId: fixture.workspaceId, sessionId: session.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId };
    const update = async (payload: Record<string, unknown>) => fixture.app.inject({
      method: AgentApiEndpoints.updateToolExecution.method, url: AgentApiEndpoints.updateToolExecution.path,
      headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { ...owner, ...payload, updatedAt: Date.now() },
    });
    assert.equal((await update({ status: "running", startedAt: Date.now() })).statusCode, 200);
    assert(Value.Check(GitToolResultSchema, result));
    const preview = buildToolSuccessTextForTest({ toolName: "git", args: input, result, completedAt: 0 });
    const response = await update({ status: "completed", structuredResult: result, resultPreview: preview, completedAt: Date.now() });
    assert.equal(response.statusCode, 200, response.body);
    const execution = getToolExecution(fixture.db, anchor.toolExecutionId)!;
    assert.equal(execution.status, "completed");
    assert.deepEqual(execution.structuredResult, result);
    assert(!JSON.stringify(execution.structuredResult).includes("fixture-model-visible-argv"));
    const resolved = new ModelContextResolver(fixture.db).resolve({ workspaceId: fixture.workspaceId, sessionId: session.id });
    const transcript = new RuntimeTranscriptProjector().project({ workspaceId: fixture.workspaceId, triggerMessageId: null, messages: resolved.messages, executions: resolved.executions });
    const history = JSON.stringify(transcript);
    assert(history.includes("fixture-model-visible-argv"), "normal tool-call args must remain intact");
    assert(history.includes(`ok: ${result.ok}`));
    if (!result.ok) assert(!JSON.stringify(transcript.filter(message => message.role === "tool")).includes("ok: true"));
    if (name === "parent-zero-unconfirmed") { assert(history.includes("exit_code: 0")); assert(history.includes("lease_disposition: retained")); }
    if (name === "cleanup-warning") assert(history.includes("Do not repeat Git"));
  });
}

test("Git API rejects extra metadata and contradictory result without changing running execution", async (t) => {
  const fixture = await createAgentIntegrationFixture({ repoRoot: path.resolve("../../.tmp-tests/0032-stage3/api"), agentWorkerConcurrency: 0 });
  t.after(() => fixture.dispose());
  const session = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunForTest({ fixture, sessionId: session.id });
  const anchor = createMessageToolAnchor({ fixture, sessionId: session.id, runId: run.runId, toolName: "git", input: { repo: "fixture-repo", args: ["status"] } });
  const owner = { workspaceId: fixture.workspaceId, sessionId: session.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId };
  const update = async (payload: Record<string, unknown>) => fixture.app.inject({ method: AgentApiEndpoints.updateToolExecution.method, url: AgentApiEndpoints.updateToolExecution.path,
    headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { ...owner, ...payload, updatedAt: Date.now() } });
  assert.equal((await update({ status: "running", startedAt: Date.now() })).statusCode, 200);
  for (const result of [{ ...base, env: { PRIVATE: "fixture" } }, { ...base, args: ["status"] }, { ...base, leasePath: "/fixture-lease" }, { ...base, ok: true, processStopConfirmed: false }]) {
    assert(!Value.Check(GitToolResultSchema, result));
    const response = await update({ status: "completed", structuredResult: result, completedAt: Date.now() });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(getToolExecution(fixture.db, anchor.toolExecutionId)!.status, "running");
  }
  // Compile-time contract check is independent of the runtime adversarial inputs.
  const success: GitToolResult = { ...base, warnings: [] }; assert(success.ok);
});
