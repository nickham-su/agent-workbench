import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionProfileResolver } from "./execution-profile-resolver.js";

test("ExecutionProfileResolver preserves run identity and resolves the primary surface", () => {
  const calls: Array<Record<string, unknown>> = [];
  const runtime = { modelIdleTimeoutMs: 60_000 };
  const resolver = new ExecutionProfileResolver({
    resolveProfile(input) {
      calls.push(input);
      return {
        agent: { id: "resolved-agent", name: "Agent" },
        provider: { id: "resolved-provider", name: "Provider" },
        model: { id: "resolved-model", name: "Model" },
        vision: { source: "runtime_vision" as const },
        compaction: null
      };
    },
    getRuntime: () => runtime
  });

  const result = resolver.getExecutionProfileForRun({
    workspaceId: "workspace",
    sessionId: "session",
    session: { kind: "primary" },
    run: { runId: "run", agentId: "run-agent", providerId: "run-provider", modelId: "run-model" }
  });

  assert.deepEqual(calls, [{
    surface: "user",
    workspaceId: "workspace",
    agentId: "run-agent",
    providerId: "run-provider",
    modelId: "run-model"
  }]);
  assert.deepEqual(result, {
    resolved: {
      runId: "run",
      sessionId: "session",
      workspaceId: "workspace",
      agentId: "resolved-agent",
      providerId: "resolved-provider",
      modelId: "resolved-model"
    },
    agent: { id: "resolved-agent", name: "Agent" },
    provider: { id: "resolved-provider", name: "Provider" },
    model: { id: "resolved-model", name: "Model" },
    vision: { source: "runtime_vision" },
    compaction: null,
    runtime
  });
});

test("ExecutionProfileResolver resolves the subtask surface without querying ownership", () => {
  let surface: "user" | "subtask" | null = null;
  const resolver = new ExecutionProfileResolver({
    resolveProfile(input) {
      surface = input.surface;
      return {
        agent: { id: input.agentId },
        provider: { id: input.providerId },
        model: { id: input.modelId },
        vision: null,
        compaction: null
      };
    },
    getRuntime: () => ({})
  });

  const result = resolver.getExecutionProfileForRun({
    workspaceId: "workspace",
    sessionId: "session",
    session: { kind: "subtask" },
    run: { runId: "run", agentId: "agent", providerId: "provider", modelId: "model" }
  });

  assert.equal(surface, "subtask");
  assert.deepEqual(result.resolved, {
    runId: "run",
    sessionId: "session",
    workspaceId: "workspace",
    agentId: "agent",
    providerId: "provider",
    modelId: "model"
  });
});
