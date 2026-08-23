import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { TestContext } from "node:test";
import {
  createAgentSession,
  createRunRecord,
  getAgentSession,
  getRunRecord,
  getRunState as getRunStateRow,
  updateRunRecordStatus,
  updateRunState
} from "../agent.store.js";
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
  forkedFromItemId?: number | null;
}) {
  const createdAt = Date.now();
  const id = newSortableId("sess");
  createAgentSession(fixture.db, {
    id,
    workspaceId: fixture.workspaceId,
    title: params?.title || "it-subtask-session",
    kind: "subtask",
    createdAt,
    forkedFromSessionId: params?.forkedFromSessionId ?? null,
    forkedFromItemId: params?.forkedFromItemId ?? null
  });
  const session = getAgentSession(fixture.db, id);
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
  return res.json() as { messageItemId: number; runId: string; deduplicated: boolean };
}

export async function createSubtaskAnchor(params: {
  fixture: AgentIntegrationFixture;
  parentDepth: number | null;
  sessionMode: "new" | "existing" | "fork";
  existingSessionId?: string;
}) {
  const parentSession = await createSession(params.fixture.app, params.fixture.workspaceId);
  const parentRunId = newSortableId("run");
  const userItem = await createContextItemInternal(params.fixture, {
    app: params.fixture.app,
    internalToken: params.fixture.internalToken,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "parent task" }
  });
  createRunRecord(params.fixture.db, {
    runId: parentRunId,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    triggerItemId: userItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: params.parentDepth,
    status: "running",
    createdAt: Date.now()
  });
  const toolItem = await createContextItemInternal(params.fixture, {
    app: params.fixture.app,
    internalToken: params.fixture.internalToken,
    workspaceId: params.fixture.workspaceId,
    sessionId: parentSession.id,
    runId: parentRunId,
    turnId: "turn_subtask_depth",
    step: 1,
    prevId: userItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_subtask_depth",
      args: { description: "child", prompt: "complete child", agentId: "default", session: { mode: params.sessionMode } }
    }
  });
  return { parentSession, parentRunId, toolItem };
}

export async function startSubtaskForAnchor(params: {
  fixture: AgentIntegrationFixture;
  parentSessionId: string;
  parentRunId: string;
  parentToolItemId: number;
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
      parentToolItemId: params.parentToolItemId,
      description: params.description ?? "child",
      prompt: params.prompt ?? "complete child",
      agentId: params.agentId ?? "default",
      session: params.session,
      ...(params.preforkSummaryText !== undefined ? { preforkSummaryText: params.preforkSummaryText } : {}),
      ...(params.preforkMeta !== undefined ? { preforkMeta: params.preforkMeta } : {})
    }
  });
}

export async function createContextItemInternal(fixture: AgentIntegrationFixture, params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  step: number | null;
  prevId: number | null;
  kind: "user" | "assistant" | "tool" | "system";
  status: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
  output: Record<string, unknown>;
}) {
  const existingRun = fixture && params.runId ? getRunRecord(fixture.db, params.runId) : null;
  const previousState = fixture && params.runId ? getRunStateRow(fixture.db, params.workspaceId, params.sessionId) : null;
  const temporaryRun = fixture && params.runId && !existingRun;
  if (fixture && params.runId) {
    if (temporaryRun) {
      createRunRecord(fixture.db, {
        runId: params.runId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        triggerItemId: 0,
        agentId: "default",
        providerId: "ppchat",
        modelId: "gpt-5.2",
        status: "running",
        createdAt: Date.now()
      });
    } else if (existingRun) {
      updateRunRecordStatus(fixture.db, { runId: existingRun.runId, status: "running", updatedAt: Date.now() });
    }
    updateRunState(fixture.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: "running",
      activeRunId: params.runId,
      activeAssistantItemId: null,
      updatedAt: Date.now(),
      appliedItemId: previousState?.appliedItemId ?? 0
    });
  }

  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId,
      turnId: params.turnId,
      step: params.step,
      prevId: params.prevId,
      kind: params.kind,
      status: params.status,
      output: params.output
    }
  });
  if (fixture && params.runId && previousState) {
    if (temporaryRun) {
      fixture.db.prepare("delete from agent_run where run_id = ?").run(params.runId);
    } else if (existingRun) {
      updateRunRecordStatus(fixture.db, { runId: existingRun.runId, status: existingRun.status, updatedAt: Date.now() });
    }
    updateRunState(fixture.db, {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: previousState.status,
      activeRunId: previousState.activeRunId,
      activeAssistantItemId: previousState.activeAssistantItemId,
      lastResponseTotalTokens: previousState.lastResponseTotalTokens,
      runNoticeText: previousState.runNoticeText,
      updatedAt: previousState.updatedAt,
      appliedItemId: previousState.appliedItemId
    });
  }
  assert.equal(res.statusCode, 200, `create internal context-item failed: ${res.body}`);
  return res.json() as { item: { id: number } };
}
