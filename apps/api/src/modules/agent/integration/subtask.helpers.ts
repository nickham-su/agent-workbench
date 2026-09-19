import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { TestContext } from "node:test";
import { createMessageRunRecord, getRunRecord } from "../agent-message.store.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  flushStreamingParts,
  createMessageSession,
  getMessageSession,
  getMessageSessionHead,
  startMessageRun,
  updateToolExecution
} from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createAgentIntegrationFixture, type AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";

/** P2-only fixture owner. Every caller passes TestContext for explicit, idempotent cleanup. */
export async function createP2Fixture(t: TestContext, options?: { agentWorkerConcurrency?: number }) {
  const fixture = await createAgentIntegrationFixture(options);
  t.after(async () => {
    await fixture.dispose();
  });
  return fixture;
}

export async function closeP2Fixture(fixture: Pick<AgentIntegrationFixture, "dispose">) {
  await fixture.dispose();
}

export function createSubtaskSessionForTest(fixture: AgentIntegrationFixture, params?: {
  title?: string;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
}) {
  const createdAt = Date.now();
  const id = newSortableId("sess");
  createMessageSession(fixture.db, {
    id,
    workspaceId: fixture.workspaceId,
    title: params?.title || "it-subtask-session",
    kind: "subtask",
    createdAt,
    forkedFromSessionId: params?.forkedFromSessionId ?? null,
    forkedFromMessageId: params?.forkedFromMessageId ?? null
  });
  const session = getMessageSession(fixture.db, fixture.workspaceId, id);
  assert.ok(session, "test subtask session should exist");
  return session;
}

export async function createSession(app: FastifyInstance, workspaceId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId, title: "it-session" }
  });
  assert.equal(res.statusCode, 201, `create session failed: ${res.body}`);
  return res.json() as { id: string };
}

export async function sendMessage(app: FastifyInstance, params: { sessionId: string; workspaceId: string; text: string; clientRequestId: string }) {
  const res = await app.inject({
    method: "POST",
    url: `/api/agent/sessions/${params.sessionId}/messages`,
    payload: {
      workspaceId: params.workspaceId,
      text: params.text,
      clientRequestId: params.clientRequestId
    }
  });
  assert.equal(res.statusCode, 201, `send message failed: ${res.body}`);
  return res.json() as { messageId: string; runId: string; deduplicated: boolean };
}

export function createMessageRunForTest(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  status?: "running" | "completed" | "failed" | "cancelled";
  subtaskDepth?: number | null;
  parentRunId?: string | null;
  parentToolExecutionId?: string | null;
  uiLocale?: "zh-CN" | "en-US" | null;
  text?: string;
}) {
  const createdAt = Date.now();
  const head = getMessageSessionHead(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId
  });
  assert.ok(head, "test session must exist");
  const triggerMessageId = newSortableId("msg");
  const runId = newSortableId("run");
  appendMessage(params.fixture.db, {
    id: triggerMessageId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: params.text ?? "test trigger" }],
    createdAt
  });
  createMessageRunRecord(params.fixture.db, {
    runId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    triggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    uiLocale: params.uiLocale,
    modelId: "gpt-5.2",
    subtaskDepth: params.subtaskDepth,
    parentRunId: params.parentRunId,
    parentToolExecutionId: params.parentToolExecutionId,
    status: params.status ?? "running",
    createdAt
  });
  if ((params.status ?? "running") === "running") {
    startMessageRun(params.fixture.db, {
      workspaceId: params.fixture.workspaceId,
      sessionId: params.sessionId,
      runId,
      updatedAt: createdAt
    });
  }
  return { runId, triggerMessageId, createdAt };
}

export function createMessageToolAnchor(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId: string;
  toolName: string;
  input?: Record<string, unknown>;
}) {
  const createdAt = Date.now();
  const head = getMessageSessionHead(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId
  });
  assert.ok(head, "test session must exist");
  const assistantMessageId = newSortableId("msg");
  const callPartId = newSortableId("part");
  const toolExecutionId = newSortableId("exec");
  const assistant = appendStreamingAssistant(params.fixture.db, {
    id: assistantMessageId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    runId: params.runId,
    createdAt
  });
  // Streaming parts are the immutable ToolCall authority; only then can completion
  // materialize the linked queued ToolExecution.
  const flushed = flushStreamingParts(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    messageId: assistant.id,
    parts: [{
      id: callPartId,
      position: 0,
      type: "tool_call",
      toolName: params.toolName,
      input: params.input ?? {},
      providerToolCallId: null
    }],
    updatedAt: createdAt + 1
  });
  assert.equal(flushed, "updated");
  const completed = completeAssistantWithExecutions(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    messageId: assistant.id,
    executions: [{
      id: toolExecutionId,
      callPartId,
      originSessionId: params.sessionId,
      originRunId: params.runId,
      status: "queued"
    }],
    updatedAt: createdAt + 2
  });
  assert.equal(completed, "updated");
  return { assistantMessageId, callPartId, toolExecutionId };
}

export async function createSubtaskAnchor(params: {
  fixture: AgentIntegrationFixture;
  parentDepth: number | null;
  sessionMode: "new" | "existing" | "fork";
  existingSessionId?: string;
}) {
  const parentSession = await createSession(params.fixture.app, params.fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const createdAt = Date.now();
  const userMessageId = newSortableId("msg");
  const userPartId = newSortableId("part");
  appendMessage(params.fixture.db, {
    id: userMessageId,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    expectedHeadMessageId: null,
    expectedRevision: 0,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: userPartId, position: 0, type: "text", text: "parent task" }],
    createdAt
  });
  createMessageRunRecord(params.fixture.db, {
    runId: parentRunId,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    triggerMessageId: userMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: params.parentDepth,
    status: "running",
    createdAt
  });
  startMessageRun(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    updatedAt: createdAt
  });
  const anchor = createMessageToolAnchor({
    fixture: params.fixture,
    sessionId: parentSession.id,
    runId: parentRunId,
    toolName: "subtask",
    input: {
      description: "child",
      prompt: "complete child",
      agentId: "default",
      session: { mode: params.sessionMode, ...(params.existingSessionId ? { sessionId: params.existingSessionId } : {}) }
    }
  });
  startToolExecutionForTest({
    fixture: params.fixture,
    sessionId: parentSession.id,
    runId: parentRunId,
    toolExecutionId: anchor.toolExecutionId
  });
  return { parentSession, parentRunId, userMessageId, ...anchor };
}

export async function startSubtaskForAnchor(params: {
  fixture: AgentIntegrationFixture;
  parentSessionId: string;
  parentRunId: string;
  parentToolExecutionId: string;
  session: { mode: "new" | "existing" | "fork"; sessionId?: string };
  description?: string;
  prompt?: string;
  agentId?: string;
  preforkSummaryText?: string;
  preforkMeta?: { thresholdPct: number; parentLastResponseTotalTokens: number; childContextWindowTokens: number };
}) {
  return await params.fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": params.fixture.internalToken },
    payload: {
      workspaceId: params.fixture.workspaceId,
      parentSessionId: params.parentSessionId,
      parentRunId: params.parentRunId,
      parentToolExecutionId: params.parentToolExecutionId,
      description: params.description ?? "child",
      prompt: params.prompt ?? "complete child",
      agentId: params.agentId ?? "default",
      session: params.session,
      ...(params.preforkSummaryText !== undefined ? { preforkSummaryText: params.preforkSummaryText } : {}),
      ...(params.preforkMeta !== undefined ? { preforkMeta: params.preforkMeta } : {})
    }
  });
}

export function startToolExecutionForTest(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId: string;
  toolExecutionId: string;
}) {
  const startedAt = Date.now();
  const started = updateToolExecution(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    executionId: params.toolExecutionId,
    status: "running",
    startedAt,
    updatedAt: startedAt
  });
  assert.equal(started, "updated");
}

export function completeToolExecutionForTest(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId: string;
  toolExecutionId: string;
  structuredResult?: unknown;
}) {
  const startedAt = Date.now();
  startToolExecutionForTest(params);
  const result = updateToolExecution(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    executionId: params.toolExecutionId,
    status: "completed",
    structuredResult: params.structuredResult ?? null,
    completedAt: startedAt + 1,
    updatedAt: startedAt + 1
  });
  assert.equal(result, "updated");
}

export function getMessageRunForTest(fixture: AgentIntegrationFixture, runId: string) {
  return getRunRecord(fixture.db, runId);
}
