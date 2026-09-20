import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { AgentApiEndpoints } from "@agent-workbench/shared/internal-contracts/agent-api";
import { registerAgentWorkerRoutes } from "./agent-worker.routes.js";
import type { AgentWorkerRouteDependencies } from "./agent-route-types.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function sourceResponse() {
  return {
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run",
    runKind: "manual_compaction" as const,
    triggerMessageId: "trigger",
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    subtaskDepth: null,
    headMessageId: "head",
    contextRootMessageId: null,
    sessionRevision: 7,
    uiLocale: null,
    oneShotSystem: "",
    pendingBoundary: null,
    blocks: [],
  };
}

test("compaction source route requires its internal token and validates strict request/response DTOs", async () => {
  const app = Fastify();
  apps.push(app);
  const calls: unknown[] = [];
  const dependencies = {
    internalToken: "internal-token",
    service: {
      getCompactionSourceFromWorker(input: unknown) {
        calls.push(input);
        return sourceResponse();
      },
    },
  } as unknown as AgentWorkerRouteDependencies;
  await registerAgentWorkerRoutes(app, dependencies);
  await app.ready();

  const missingToken = await app.inject({
    method: AgentApiEndpoints.getCompactionSource.method,
    url: AgentApiEndpoints.getCompactionSource.path,
    payload: { workspaceId: "workspace", sessionId: "session", runId: "run" },
  });
  assert.equal(missingToken.statusCode, 401);

  const invalidBody = await app.inject({
    method: AgentApiEndpoints.getCompactionSource.method,
    url: AgentApiEndpoints.getCompactionSource.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: { workspaceId: "workspace", sessionId: "session", runId: "run", uiLocale: "zh-CN" },
  });
  assert.equal(invalidBody.statusCode, 400);

  const response = await app.inject({
    method: AgentApiEndpoints.getCompactionSource.method,
    url: AgentApiEndpoints.getCompactionSource.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: { workspaceId: "workspace", sessionId: "session", runId: "run" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), sourceResponse());
  assert.deepEqual(calls, [{ workspaceId: "workspace", sessionId: "session", runId: "run" }]);
});

test("compaction source route serializes away generic ToolExecution fields", async () => {
  const app = Fastify();
  apps.push(app);
  const dependencies = {
    internalToken: "internal-token",
    service: {
      getCompactionSourceFromWorker() {
        return {
          ...sourceResponse(),
          blocks: [{
            sourceMessageId: "message",
            physical: { previousMessageId: null, depth: 0, originSessionId: null, originRunId: null, updatedRevision: 1 },
            message: {
              id: "message", workspaceId: "workspace", previousMessageId: null, replacesMessageId: null,
              depth: 0, type: "user", status: "completed", originSessionId: "session", originRunId: "run",
              updatedRevision: 1, createdAt: 1, updatedAt: 1, parts: [],
            },
            toolExecutions: [{
              id: "execution", callPartId: "call", status: "completed", resultPreview: null, error: null,
              startedAt: 1, completedAt: 2, structuredResult: { forbidden: true },
            }],
            attachments: [], providerReplay: [],
          }],
        };
      },
    },
  } as unknown as AgentWorkerRouteDependencies;
  await registerAgentWorkerRoutes(app, dependencies);
  await app.ready();

  const response = await app.inject({
    method: AgentApiEndpoints.getCompactionSource.method,
    url: AgentApiEndpoints.getCompactionSource.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: { workspaceId: "workspace", sessionId: "session", runId: "run" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { blocks: Array<{ toolExecutions: Array<Record<string, unknown>> }> };
  assert.equal(body.blocks[0]?.toolExecutions[0]?.structuredResult, undefined);
  assert.equal(body.blocks[0]?.toolExecutions[0]?.resultArtifactPath, undefined);
});

test("atomic compaction route requires its token, validates its strict DTO, and forwards the manual terminal intent", async () => {
  const app = Fastify();
  apps.push(app);
  const calls: unknown[] = [];
  const dependencies = {
    internalToken: "internal-token",
    service: {
      commitCompactionWithTerminalIntentFromWorker(input: unknown) {
        calls.push(input);
        return { result: "updated" as const, summaryMessageId: "summary" };
      },
    },
  } as unknown as AgentWorkerRouteDependencies;
  await registerAgentWorkerRoutes(app, dependencies);
  await app.ready();

  const request = {
    workspaceId: "workspace",
    sessionId: "session",
    runId: "run",
    messageId: "message",
    textPartId: "part",
    expectedHeadMessageId: "head",
    expectedRevision: 7,
    retainedFromMessageId: "retained",
    summaryText: "summary",
    intent: { status: "completed", code: "compaction_completed", detail: null },
    createdAt: 123,
  };

  const missingToken = await app.inject({
    method: AgentApiEndpoints.commitCompactionWithTerminalIntent.method,
    url: AgentApiEndpoints.commitCompactionWithTerminalIntent.path,
    payload: request,
  });
  assert.equal(missingToken.statusCode, 401);

  const unknownField = await app.inject({
    method: AgentApiEndpoints.commitCompactionWithTerminalIntent.method,
    url: AgentApiEndpoints.commitCompactionWithTerminalIntent.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: { ...request, unexpected: true },
  });
  assert.equal(unknownField.statusCode, 400);

  const invalidIntent = await app.inject({
    method: AgentApiEndpoints.commitCompactionWithTerminalIntent.method,
    url: AgentApiEndpoints.commitCompactionWithTerminalIntent.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: { ...request, intent: { status: "failed", code: "run_failed", detail: null } },
  });
  assert.equal(invalidIntent.statusCode, 400);

  const response = await app.inject({
    method: AgentApiEndpoints.commitCompactionWithTerminalIntent.method,
    url: AgentApiEndpoints.commitCompactionWithTerminalIntent.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: request,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { result: "updated", summaryMessageId: "summary" });
  assert.deepEqual(calls, [request]);
});

test("compaction confirmation route is token-protected and uses a strict identity-only DTO", async () => {
  const app = Fastify();
  apps.push(app);
  const calls: unknown[] = [];
  const dependencies = {
    internalToken: "internal-token",
    service: {
      confirmCompactionCommitFromWorker(input: unknown) {
        calls.push(input);
        return { outcome: "committed" as const };
      },
    },
  } as unknown as AgentWorkerRouteDependencies;
  await registerAgentWorkerRoutes(app, dependencies);
  await app.ready();
  const request = { workspaceId: "workspace", sessionId: "session", runId: "run", messageId: "summary" };
  const denied = await app.inject({ method: AgentApiEndpoints.confirmCompactionCommit.method, url: AgentApiEndpoints.confirmCompactionCommit.path, payload: request });
  assert.equal(denied.statusCode, 401);
  const invalid = await app.inject({
    method: AgentApiEndpoints.confirmCompactionCommit.method,
    url: AgentApiEndpoints.confirmCompactionCommit.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: { ...request, summaryText: "must not be accepted" },
  });
  assert.equal(invalid.statusCode, 400);
  const response = await app.inject({
    method: AgentApiEndpoints.confirmCompactionCommit.method,
    url: AgentApiEndpoints.confirmCompactionCommit.path,
    headers: { "x-awb-agent-internal-token": "internal-token" },
    payload: request,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { outcome: "committed" });
  assert.deepEqual(calls, [request]);
});
