import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentApiCompactionSourceRequestSchema,
  AgentApiCompactionSourceResponseSchema,
} from "../src/internal-contracts/agent-api-read.js";

test("Compaction source RPC only accepts its fixed request and strict provider-neutral response", () => {
  const request = { workspaceId: "workspace", sessionId: "session", runId: "run" };
  assert.equal(Value.Check(AgentApiCompactionSourceRequestSchema, request), true);
  assert.equal(Value.Check(AgentApiCompactionSourceRequestSchema, { ...request, triggerMessageId: "client-controlled" }), false);
  assert.equal(Value.Check(AgentApiCompactionSourceRequestSchema, { workspaceId: "workspace", sessionId: "session" }), false);

  const response = {
    ...request,
    runKind: "manual_compaction" as const,
    triggerMessageId: null,
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    subtaskDepth: null,
    headMessageId: "head",
    contextRootMessageId: null,
    sessionRevision: 3,
    uiLocale: null,
    oneShotSystem: "",
    pendingBoundary: null,
    blocks: [],
  };
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, response), true);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...response, wireMessages: [] }), false);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...response, uiLocale: "zh-CN" }), false);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...response, sessionRevision: -1 }), false);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, {
    ...response,
    pendingBoundary: { reason: "pending_tool_execution", assistantMessageId: "assistant", toolExecutionIds: ["execution"] },
  }), true);

  const strictBlock = {
    sourceMessageId: "message",
    physical: { previousMessageId: null, depth: 0, originSessionId: null, originRunId: null, updatedRevision: 1 },
    message: {
      id: "message", workspaceId: "workspace", previousMessageId: null, replacesMessageId: null,
      depth: 0, type: "user", status: "completed", originSessionId: "session", originRunId: "run",
      updatedRevision: 1, createdAt: 1, updatedAt: 1, parts: [],
    },
    toolExecutions: [{ id: "execution", callPartId: "call", status: "completed", resultPreview: null, error: null, startedAt: 1, completedAt: 2 }],
    attachments: [], providerReplay: [],
  };
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, { ...response, blocks: [strictBlock] }), true);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, {
    ...response, blocks: [{ ...strictBlock, toolExecutions: [{ ...strictBlock.toolExecutions[0], structuredResult: { secret: "never" } }] }],
  }), false);
  assert.equal(Value.Check(AgentApiCompactionSourceResponseSchema, {
    ...response, blocks: [{ ...strictBlock, toolExecutions: [{ ...strictBlock.toolExecutions[0], resultArtifactPath: "/private" }] }],
  }), false);
});
