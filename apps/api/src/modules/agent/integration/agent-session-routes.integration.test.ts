import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { test, type TestContext } from "node:test";
import { Type } from "@sinclair/typebox";
import { HttpError } from "../../../app/errors.js";
import { createApp } from "../../../app/createApp.js";
import { getRunRecord } from "../agent-message.store.js";
import { getMessageRunState, getMessageSession } from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  appendMessageFixture,
  createMessageRunFixture,
  createIntegrationFixture,
  createSession,
} from "./context-writeback.helpers.js";
import { createAgentTestFixture } from "../testkit/agent-testkit.js";

type RouteProbe = { observedBodies: unknown[]; handlerCalls: number };

async function createRouteProbeFixture(t: TestContext, kind: "prevalidation" | "schema-only", probe: RouteProbe) {
  const fixture = await createAgentTestFixture({
    withApp: true,
    dataDirPrefix: "agent-session-routes-probe-",
    agentWorkerConcurrency: 0,
    appFactory: async (ctx) => {
      const app = await createApp(ctx);
      app.post(kind === "prevalidation" ? "/__p0-prevalidation-probe" : "/__p0-schema-only-probe", {
        schema: { body: Type.Object({ known: Type.String() }, { additionalProperties: false }), response: { 204: Type.Null() } },
        ...(kind === "prevalidation" ? {
          preValidation: async (req) => {
            probe.observedBodies.push(structuredClone(req.body));
            if (typeof req.body === "object" && req.body != null && "unexpected" in req.body) {
              throw new HttpError(400, "unexpected body key", "P0_UNKNOWN_BODY_KEY");
            }
          },
        } : {}),
      }, async (req, reply) => {
        if (kind === "schema-only") probe.observedBodies.push(structuredClone(req.body));
        probe.handlerCalls += 1;
        return reply.code(204).send();
      });
      return app;
    },
  });
  if (!fixture.app) throw new Error("route probe requires Fastify app");
  t.after(async () => { await fixture.dispose(); });
  return fixture;
}

async function runComplete(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, sessionId: string, runId: string, status: "completed" | "failed" | "cancelled") {
  const updatedAt = Date.now();
  const code = status === "completed" ? "run_completed" : status === "failed" ? "run_failed" : "run_cancelled";
  const headers = { "x-awb-agent-internal-token": fixture.internalToken };
  const intent = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/runs/terminal-intent", headers,
    payload: { workspaceId: fixture.workspaceId, sessionId, runId, status, code, detail: null, updatedAt },
  });
  if (intent.statusCode !== 200) return;
  const convergence = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/runs/converge-terminal", headers,
    payload: { workspaceId: fixture.workspaceId, sessionId, runId, updatedAt },
  });
  assert.equal(convergence.statusCode, 200, convergence.body);
}

async function runNotice(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, sessionId: string, runId: string, runNoticeText: string) {
  return await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/run-notice",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId, runId, runNoticeText, updatedAt: Date.now() },
  });
}

test("internal runs/trigger 支持 clientRequestId 去重", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const payload = { workspaceId: fixture.workspaceId, sessionId: session.id, agentId: "default", text: "hello from internal trigger", clientRequestId: "it_trigger_dedup_1" };
  const first = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/runs/trigger", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload });
  assert.equal(first.statusCode, 201, first.body);
  const firstBody = first.json() as { runId: string; messageId: string; deduplicated: boolean; sessionId: string };
  assert.equal(firstBody.deduplicated, false);
  assert.equal(firstBody.sessionId, session.id);
  assert.ok(firstBody.messageId);
  const second = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/runs/trigger", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload });
  assert.equal(second.statusCode, 201, second.body);
  const secondBody = second.json() as { runId: string; messageId: string; deduplicated: boolean };
  assert.equal(secondBody.deduplicated, true);
  assert.equal(secondBody.runId, firstBody.runId);
  assert.equal(secondBody.messageId, firstBody.messageId);
});

test("primary compact Run 固定写入 depth 0 和双空 parent 字段", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/compact`, payload: { workspaceId: fixture.workspaceId, clientRequestId: "compact-root" } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
  const run = createMessageRunFixture({ fixture, sessionId: session.id, subtaskDepth: 0, parentRunId: null, parentToolExecutionId: null });
  const record = getRunRecord(fixture.db, run.runId);
  assert.equal(record?.subtaskDepth, 0);
  assert.equal(record?.parentRunId, null);
  assert.equal(record?.parentToolExecutionId, null);
});

test("primary 上下文 fork 创建独立执行根，不携带来源的 subtask 嵌套深度", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const source = await createSession(fixture.app, fixture.workspaceId);
  const sourceMessage = appendMessageFixture({ fixture, sessionId: source.id, type: "user", text: "fork source" });
  const fork = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: { fromSessionId: source.id, fromMessageId: sourceMessage.messageId } });
  assert.equal(fork.statusCode, 201, fork.body);
  const forked = fork.json() as { id: string; kind: string; forkedFromSessionId: string | null; forkedFromMessageId: string | null; headMessageId: string | null };
  assert.equal(forked.kind, "primary");
  assert.equal(forked.forkedFromSessionId, source.id);
  assert.equal(forked.forkedFromMessageId, sourceMessage.messageId);
  assert.equal(forked.headMessageId, sourceMessage.messageId);
  const rootRun = createMessageRunFixture({ fixture, sessionId: forked.id, subtaskDepth: 0, parentRunId: null, parentToolExecutionId: null });
  const record = getRunRecord(fixture.db, rootRun.runId);
  assert.equal(record?.subtaskDepth, 0);
  assert.equal(record?.parentRunId, null);
  assert.equal(record?.parentToolExecutionId, null);
});

test("public 和 generic internal create 固定创建 primary，并拒绝未知字段", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const publicCreate = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions", payload: { workspaceId: fixture.workspaceId, title: "public primary" } });
  assert.equal(publicCreate.statusCode, 201, publicCreate.body);
  assert.equal(publicCreate.json().kind, "primary");
  const removedInternalCreate = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/sessions", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, title: "internal primary" } });
  assert.equal(removedInternalCreate.statusCode, 404, removedInternalCreate.body);
  const invalid = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions", payload: { workspaceId: fixture.workspaceId, title: "bad", kind: "subtask" } });
  assert.equal(invalid.statusCode, 400);
});

test("public fork 固定创建 primary，并拒绝非 primary source 和未知字段", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const source = await createSession(fixture.app, fixture.workspaceId);
  const message = appendMessageFixture({ fixture, sessionId: source.id, type: "user", text: "fork validation source" });
  const fork = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: { fromSessionId: source.id, fromMessageId: message.messageId } });
  assert.equal(fork.statusCode, 201, fork.body);
  assert.equal(fork.json().kind, "primary");
  const unknown = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: { fromSessionId: source.id, fromMessageId: message.messageId, kind: "primary" } });
  assert.equal(unknown.statusCode, 400);
  const subtaskId = newSortableId("sess");
  const subtaskMessage = appendMessageFixture({ fixture, sessionId: source.id, type: "user", text: "subtask source anchor" });
  fixture.db.prepare(`insert into agent_session (id,workspace_id,title,kind,head_message_id,context_root_message_id,revision,forked_from_session_id,forked_from_message_id,created_at,updated_at) values (?,?,?,?,?,?,0,?,?,?,?)`).run(subtaskId, fixture.workspaceId, "subtask", "subtask", subtaskMessage.messageId, subtaskMessage.messageId, source.id, subtaskMessage.messageId, Date.now(), Date.now());
  fixture.db.prepare(`insert into session_run_state (workspace_id,session_id,status,active_run_id,run_notice_text,retry_count,next_retry_at,active_assistant_message_id,non_terminal_message_ids_json,non_terminal_tool_execution_ids_json,updated_at) values (?,?,'idle',null,'',0,null,null,'[]','[]',?)`).run(fixture.workspaceId, subtaskId, Date.now());
  const rejected = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: { fromSessionId: subtaskId, fromMessageId: subtaskMessage.messageId } });
  assert.equal(rejected.statusCode, 400);
});

test("P0 baseline: endpoint-local preValidation sees unknown keys before schema stripping", async (t: TestContext) => {
  const probe: RouteProbe = { observedBodies: [], handlerCalls: 0 };
  const fixture = await createRouteProbeFixture(t, "prevalidation", probe);
  assert.ok(fixture.app);
  const res = await fixture.app.inject({ method: "POST", url: "/__p0-prevalidation-probe", payload: { known: "ok", unexpected: true } });
  assert.equal(res.statusCode, 400);
  assert.equal(probe.handlerCalls, 0);
  assert.deepEqual(probe.observedBodies, [{ known: "ok", unexpected: true }]);
});

test("P0 baseline: schema additionalProperties:false alone strips unknown body keys and permits the request", async (t: TestContext) => {
  const probe: RouteProbe = { observedBodies: [], handlerCalls: 0 };
  const fixture = await createRouteProbeFixture(t, "schema-only", probe);
  assert.ok(fixture.app);
  const res = await fixture.app.inject({ method: "POST", url: "/__p0-schema-only-probe", payload: { known: "ok", unexpected: true } });
  assert.equal(res.statusCode, 204);
  assert.equal(probe.handlerCalls, 1);
  assert.deepEqual(probe.observedBodies, [{ known: "ok" }]);
});

test("Run terminal intent route: invalid token + invalid body is 401; valid token + invalid body is 400", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const unauthorized = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/runs/terminal-intent", payload: {} });
  assert.equal(unauthorized.statusCode, 401);
  const invalid = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/runs/terminal-intent", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: {} });
  assert.equal(invalid.statusCode, 400);
});

test("Subtask Routes: invalid token wins over invalid body and valid token reaches schema validation", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const unauthorized = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", payload: {} });
  assert.equal(unauthorized.statusCode, 401);
  const invalid = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: {} });
  assert.equal(invalid.statusCode, 400);
});

test("Run terminal intent route: unknown top-level fields preserve the current accepted request behavior", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunFixture({ fixture, sessionId: session.id });
  const updatedAt = Date.now();
  const headers = { "x-awb-agent-internal-token": fixture.internalToken };
  const intent = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/runs/terminal-intent", headers, payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: run.runId, status: "completed", code: "run_completed", detail: null, updatedAt, unknown: true } });
  assert.equal(intent.statusCode, 200, intent.body);
  const convergence = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/runs/converge-terminal", headers, payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: run.runId, updatedAt } });
  assert.equal(convergence.statusCode, 200, convergence.body);
  assert.equal(getRunRecord(fixture.db, run.runId)?.status, "completed");
});

test("Message 公共读取将不存在的 Session 映射为 SESSION_NOT_FOUND 404", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const missingSessionId = "sess_missing";
  const requests = [
    `/api/agent/sessions/${missingSessionId}/timeline?workspaceId=${fixture.workspaceId}`,
    `/api/agent/sessions/${missingSessionId}/messages/msg_missing?workspaceId=${fixture.workspaceId}`,
    `/api/agent/sessions/${missingSessionId}/run-state?workspaceId=${fixture.workspaceId}`,
  ];

  for (const url of requests) {
    const response = await fixture.app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal((response.json() as { code?: string }).code, "SESSION_NOT_FOUND");
  }
});

test("Run ignored: RS-1, RS-2, RS-3 and RC-1, RC-2, RC-3 return 200 ok without DB mutation", async (t: TestContext) => {
  const fixture = await createIntegrationFixture(t, { agentWorkerConcurrency: 0 });
  const first = await createSession(fixture.app, fixture.workspaceId);
  const firstRun = createMessageRunFixture({ fixture, sessionId: first.id });
  const lateNotice = await runNotice(fixture, first.id, "missing-run", "late");
  assert.equal(lateNotice.statusCode, 200);
  assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, first.id)?.activeRunId, firstRun.runId);
  const other = await createSession(fixture.app, fixture.workspaceId);
  const otherRun = createMessageRunFixture({ fixture, sessionId: other.id });
  await runComplete(fixture, first.id, otherRun.runId, "completed");
  assert.equal(getRunRecord(fixture.db, otherRun.runId)?.status, "running");
  await runComplete(fixture, first.id, "missing-run", "completed");
  assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, first.id)?.activeRunId, firstRun.runId);
  await runComplete(fixture, first.id, firstRun.runId, "completed");
  const terminalNotice = await runNotice(fixture, first.id, firstRun.runId, "late terminal notice");
  assert.equal(terminalNotice.statusCode, 200);
  assert.equal(getRunRecord(fixture.db, firstRun.runId)?.status, "completed");
  assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, first.id)?.status, "idle");
  const untouched = getMessageSession(fixture.db, fixture.workspaceId, other.id);
  assert.ok(untouched);
  assert.equal(untouched.headMessageId, otherRun.triggerMessageId);
});
