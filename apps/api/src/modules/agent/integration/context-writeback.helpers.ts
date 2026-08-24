import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { TestContext } from "node:test";
import {
  createRunRecord,
  getRunRecord,
  getRunState as getRunStateRow,
  updateRunRecordStatus,
  updateRunState
} from "../agent.store.js";
import { createAgentIntegrationFixture, type AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";

/** P3 fixture owner. Each caller supplies TestContext for explicit, idempotent teardown. */
export async function createP3Fixture(t: TestContext, options?: { agentWorkerConcurrency?: number }) {
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
  return res.json() as { messageItemId: number; runId: string; deduplicated: boolean };
}

/**
 * Creates a context item through the internal route while explicitly preserving
 * the legacy temporary run/run-state setup and restoration behavior.
 */
export async function createContextItemInternal(params: {
  fixture: AgentIntegrationFixture;
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
  const fixture = params.fixture;
  const existingRun = params.runId ? getRunRecord(fixture.db, params.runId) : null;
  const previousState = params.runId ? getRunStateRow(fixture.db, params.workspaceId, params.sessionId) : null;
  const temporaryRun = Boolean(params.runId && !existingRun);
  if (params.runId) {
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
    headers: { "x-awb-agent-internal-token": params.internalToken },
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
  if (params.runId && previousState) {
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

export async function updateContextItemInternal(params: {
  fixture: Pick<AgentIntegrationFixture, "app" | "internalToken">;
  app: FastifyInstance;
  internalToken: string;
  itemId: number;
  status?: "streaming" | "queued" | "running" | "completed" | "failed" | "cancelled";
  output?: Record<string, unknown>;
}) {
  const res = await params.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${params.itemId}`,
    headers: { "x-awb-agent-internal-token": params.internalToken },
    payload: {
      ...(Object.prototype.hasOwnProperty.call(params, "status") ? { status: params.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "output") ? { output: params.output } : {})
    }
  });
  assert.equal(res.statusCode, 200, `update internal context-item failed: ${res.body}`);
  return res.json() as { item: { id: number } };
}

export async function updateRunStateInternal(params: {
  fixture: Pick<AgentIntegrationFixture, "app" | "internalToken">;
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  status: "idle" | "running";
  activeRunId: string | null;
  activeAssistantItemId: number | null;
  lastResponseTotalTokens?: number | null;
  runNoticeText?: string | null;
  updatedAt?: number;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": params.internalToken },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId: params.activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      ...(Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens") ? { lastResponseTotalTokens: params.lastResponseTotalTokens } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "runNoticeText") ? { runNoticeText: params.runNoticeText } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "updatedAt") ? { updatedAt: params.updatedAt } : {})
    }
  });
  assert.equal(res.statusCode, 200, `update internal run-state failed: ${res.body}`);
}
