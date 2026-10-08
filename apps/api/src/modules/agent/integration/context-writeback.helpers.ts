import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { TestContext } from "node:test";
import { newSortableId } from "../../../utils/ids.js";
import { createMessageRunRecord } from "../agent-message.store.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  flushStreamingParts,
  getMessageSessionHead,
  startMessageRun,
  updateMessageRunNotice,
  updateToolExecution,
  type AgentMessagePartInput,
  type AgentToolExecutionInput
} from "../agent-message.store.js";
import { createAgentIntegrationFixture, type AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";

/** 创建 HTTP 集成测试 fixture；调用方传入 TestContext 以确保显式、幂等地清理。 */
export async function createIntegrationFixture(t: TestContext, options?: { agentWorkerConcurrency?: number; authToken?: string | null }) {
  const fixture = await createAgentIntegrationFixture(options);
  t.after(async () => {
    await fixture.dispose();
  });
  return fixture;
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

function sessionHead(fixture: AgentIntegrationFixture, sessionId: string) {
  const head = getMessageSessionHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId });
  assert.ok(head, "message fixture session must exist");
  return head;
}

/** Creates a real user/system Message and immutable Parts on the current session head. */
export function appendMessageFixture(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  type: "user" | "system";
  text: string;
  createdAt?: number;
  messageId?: string;
}) {
  const createdAt = params.createdAt ?? Date.now();
  const head = sessionHead(params.fixture, params.sessionId);
  const messageId = params.messageId ?? newSortableId("msg");
  const partId = newSortableId("part");
  appendMessage(params.fixture.db, {
    id: messageId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: params.type,
    status: "completed",
    originRunId: null,
    parts: [{ id: partId, position: 0, type: "text", text: params.text }],
    createdAt
  });
  return { messageId, partId, createdAt };
}

/** Creates a real Run after creating its user trigger Message, then activates session run state. */
export function createMessageRunFixture(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId?: string;
  triggerText?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  subtaskDepth?: number | null;
  parentRunId?: string | null;
  parentToolExecutionId?: string | null;
  createdAt?: number;
}) {
  const createdAt = params.createdAt ?? Date.now();
  const trigger = appendMessageFixture({
    fixture: params.fixture,
    sessionId: params.sessionId,
    type: "user",
    text: params.triggerText ?? "fixture trigger",
    createdAt
  });
  const runId = params.runId ?? newSortableId("run");
  createMessageRunRecord(params.fixture.db, {
    runId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    triggerMessageId: trigger.messageId,
    agentId: params.agentId ?? "default",
    providerId: params.providerId ?? "ppchat",
    modelId: params.modelId ?? "gpt-5.2",
    subtaskDepth: params.subtaskDepth ?? null,
    parentRunId: params.parentRunId ?? null,
    parentToolExecutionId: params.parentToolExecutionId ?? null,
    status: "running",
    createdAt
  });
  startMessageRun(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId,
    updatedAt: createdAt
  });
  return { runId, triggerMessageId: trigger.messageId, triggerPartId: trigger.partId, createdAt };
}

/** Creates a streaming assistant Message, its Parts, and queued ToolExecutions in the canonical order. */
export function createAssistantFixture(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId: string;
  parts?: AgentMessagePartInput[];
  executions?: AgentToolExecutionInput[];
  createdAt?: number;
  messageId?: string;
}) {
  const createdAt = params.createdAt ?? Date.now();
  const head = sessionHead(params.fixture, params.sessionId);
  const messageId = params.messageId ?? newSortableId("msg");
  const assistant = appendStreamingAssistant(params.fixture.db, {
    id: messageId,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    runId: params.runId,
    createdAt
  });
  const parts = params.parts ?? [];
  if (parts.length > 0) {
    assert.equal(flushStreamingParts(params.fixture.db, {
      workspaceId: params.fixture.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      messageId: assistant.id,
      parts,
      updatedAt: createdAt + 1
    }), "updated");
  }
  if (params.executions) {
    assert.equal(completeAssistantWithExecutions(params.fixture.db, {
      workspaceId: params.fixture.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      messageId: assistant.id,
      executions: params.executions,
      updatedAt: createdAt + 2
    }), "updated");
  }
  return { assistantMessageId: assistant.id, parts, executions: params.executions ?? [], createdAt };
}

/** Advances a real ToolExecution through the required queued → running → terminal transition. */
export function completeToolExecutionFixture(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId: string;
  toolExecutionId: string;
  status?: "completed" | "failed" | "cancelled" | "unknown";
  resultPreview?: string | null;
  structuredResult?: unknown;
  error?: string | null;
  createdAt?: number;
}) {
  const createdAt = params.createdAt ?? Date.now();
  assert.equal(updateToolExecution(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    executionId: params.toolExecutionId,
    status: "running",
    startedAt: createdAt,
    updatedAt: createdAt
  }), "updated");
  assert.equal(updateToolExecution(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    executionId: params.toolExecutionId,
    status: params.status ?? "completed",
    resultPreview: params.resultPreview ?? null,
    structuredResult: params.structuredResult ?? null,
    error: params.error ?? null,
    completedAt: createdAt + 1,
    updatedAt: createdAt + 1
  }), "updated");
}

export function setRunNoticeFixture(params: {
  fixture: AgentIntegrationFixture;
  sessionId: string;
  runId: string;
  runNoticeText: string;
  updatedAt?: number;
}) {
  return updateMessageRunNotice(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    runId: params.runId,
    runNoticeText: params.runNoticeText,
    updatedAt: params.updatedAt ?? Date.now()
  });
}
