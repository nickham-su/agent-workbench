import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { test, type TestContext } from "node:test";
import { Type } from "@sinclair/typebox";
import { HttpError } from "../../../app/errors.js";
import { createApp } from "../../../app/createApp.js";
import {
  createRunRecord,
  getRunRecord,
  getRunState as getRunStateRow,
  getSessionTranscriptItems
} from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  createContextItemInternal,
  createP2Fixture,
  createSession,
  createSubtaskSessionForTest,
  sendMessage,
} from "./subtask.helpers.js";
import { createAgentTestFixture } from "../testkit/agent-testkit.js";

type P2RouteProbe = { observedBodies: unknown[]; handlerCalls: number };

async function createP2RouteProbeFixture(t: TestContext, kind: "prevalidation" | "schema-only", probe: P2RouteProbe) {
  const fixture = await createAgentTestFixture({
    withApp: true,
    dataDirPrefix: "agent-session-routes-probe-",
    agentWorkerConcurrency: 0,
    appFactory: async (ctx) => {
      const app = await createApp(ctx);
      app.post(
        kind === "prevalidation" ? "/__p0-prevalidation-probe" : "/__p0-schema-only-probe",
        {
          schema: {
            body: Type.Object({ known: Type.String() }, { additionalProperties: false }),
            response: { 204: Type.Null() }
          },
          ...(kind === "prevalidation" ? {
            preValidation: async (req) => {
              probe.observedBodies.push(structuredClone(req.body));
              if (typeof req.body === "object" && req.body != null && "unexpected" in req.body) {
                throw new HttpError(400, "unexpected body key", "P0_UNKNOWN_BODY_KEY");
              }
            }
          } : {})
        },
        async (req, reply) => {
          if (kind === "schema-only") probe.observedBodies.push(structuredClone(req.body));
          probe.handlerCalls += 1;
          return reply.code(204).send();
        }
      );
      return app;
    }
  });
  if (!fixture.app) throw new Error("route probe requires Fastify app");
  const app = fixture.app;
  t.after(async () => {
    await fixture.dispose();
  });
  return { ...fixture, app };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRunState(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/run-state` });
  assert.equal(res.statusCode, 200, `get run-state failed: ${res.body}`);
  return res.json() as {
    status: "idle" | "running";
    activeRunId: string | null;
    runNoticeText: string;
    lastTerminalStatus: "completed" | "failed" | "cancelled" | null;
    contextWindowTokens?: number | null;
    contextTokenRatio?: number | null;
  };
}

async function waitRunIdle(app: FastifyInstance, sessionId: string, timeoutMs = 6_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runState = await getRunState(app, sessionId);
    if (runState.status === "idle") return;
    await sleep(80);
  }
  throw new Error(`wait run idle timeout, sessionId=${sessionId}`);
}

async function updateRunStateInternal(params: {
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
    headers: {
      "x-awb-agent-internal-token": params.internalToken
    },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      status: params.status,
      activeRunId: params.activeRunId,
      activeAssistantItemId: params.activeAssistantItemId,
      ...(Object.prototype.hasOwnProperty.call(params, "lastResponseTotalTokens")
        ? { lastResponseTotalTokens: params.lastResponseTotalTokens }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "runNoticeText") ? { runNoticeText: params.runNoticeText } : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "updatedAt") ? { updatedAt: params.updatedAt } : {})
    }
  });
  assert.equal(res.statusCode, 200, `update internal run-state failed: ${res.body}`);
}

test("internal runs/trigger 支持 clientRequestId 去重", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, );
    const session = await createSession(fixture.app, fixture.workspaceId);

  const payload = {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    agentId: "default",
    text: "hello from internal trigger",
    clientRequestId: "it_trigger_dedup_1"
  };

  const first = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload
  });
  assert.equal(first.statusCode, 201, `internal trigger first failed: ${first.body}`);
  const firstBody = first.json() as { runId: string; deduplicated: boolean; sessionId: string; messageItemId: number };
  assert.equal(firstBody.deduplicated, false);
  assert.equal(firstBody.sessionId, session.id);
  assert.ok(String(firstBody.runId).length > 0);

  const second = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/runs/trigger",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload
  });
  assert.equal(second.statusCode, 201, `internal trigger second failed: ${second.body}`);
  const secondBody = second.json() as { runId: string; deduplicated: boolean; sessionId: string; messageItemId: number };
  assert.equal(secondBody.deduplicated, true);
  assert.equal(secondBody.runId, firstBody.runId);
  assert.equal(secondBody.messageItemId, firstBody.messageItemId);
  const run = getRunRecord(fixture.db, firstBody.runId);
  assert.equal(run?.subtaskDepth, 0);
  assert.equal(run?.parentRunId, null);
  assert.equal(run?.parentToolItemId, null);
});

test("primary compact Run 固定写入 depth 0 和双空 parent 字段", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 1 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const seed = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "context for compaction",
    clientRequestId: "primary-compact-seed"
  });
  await waitRunIdle(fixture.app, session.id);

  // Fixture 已在 worker-disabled 时安装本地回退 runtime；打开 service gate 以覆盖真实 compact Run 写入。
  fixture.ctx.agentWorkerEnabled = true;
  fixture.db.prepare("update agent_run set subtask_depth = ?, parent_run_id = ?, parent_tool_item_id = ? where run_id = ?")
    .run(2, "legacy_parent", null, seed.runId);
  const compactRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "primary-compact-run"
    }
  });
  assert.equal(compactRes.statusCode, 201, compactRes.body);
  const compact = compactRes.json() as { runId: string };
  const run = getRunRecord(fixture.db, compact.runId);
  assert.equal(run?.subtaskDepth, 0);
  assert.equal(run?.parentRunId, null);
  assert.equal(run?.parentToolItemId, null);
});

test("primary 上下文 fork 创建独立执行根，不携带来源的 subtask 嵌套深度", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const source = await createSession(fixture.app, fixture.workspaceId);
  const sourceRunId = newSortableId("run");
  const sourceItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: source.id,
    runId: sourceRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "source" }
  });
  createRunRecord(fixture.db, {
    runId: sourceRunId,
    workspaceId: fixture.workspaceId,
    sessionId: source.id,
    triggerItemId: sourceItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 2,
    status: "completed",
    createdAt: Date.now()
  });
  const forkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only" }
  });
  assert.equal(forkRes.statusCode, 201, forkRes.body);
  const forked = forkRes.json() as { id: string };
  const forkRun = await sendMessage(fixture.app, {
    sessionId: forked.id,
    workspaceId: fixture.workspaceId,
    text: "fork continuation",
    clientRequestId: "fork-depth"
  });
  const firstForkRun = getRunRecord(fixture.db, forkRun.runId);
  assert.equal(firstForkRun?.subtaskDepth, 0);
  assert.equal(firstForkRun?.parentRunId, null);
  assert.equal(firstForkRun?.parentToolItemId, null);

  const sourceItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, source.id);
  const forkedItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, forked.id);
  assert.equal(sourceItems.length, 1);
  assert.equal(sourceItems[0]?.runId, sourceRunId);
  assert.equal(forkedItems.length >= 1, true);
  assert.equal(forkedItems[0]?.kind, "user");
  assert.equal(forkedItems[0]?.runId, null, "copied context must not claim source run ownership");
  assert.equal(forkedItems[0]?.turnId, null);
  assert.equal(forkedItems[0]?.step, null);

  const secondForkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: forked.id, fromItemId: forkedItems[0]?.id, mode: "visible_only" }
  });
  assert.equal(secondForkRes.statusCode, 201, secondForkRes.body);
  const secondFork = secondForkRes.json() as { id: string };
  const secondForkRun = await sendMessage(fixture.app, {
    sessionId: secondFork.id,
    workspaceId: fixture.workspaceId,
    text: "second fork continuation",
    clientRequestId: "fork-depth-second"
  });
  const secondForkLineage = getRunRecord(fixture.db, secondForkRun.runId);
  assert.equal(secondForkLineage?.subtaskDepth, 0);
  assert.equal(secondForkLineage?.parentRunId, null);
  assert.equal(secondForkLineage?.parentToolItemId, null);

  const unknownSource = await createSession(fixture.app, fixture.workspaceId);
  const unknownItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: unknownSource.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "legacy source without run" }
  });
  const unknownForkRes = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: unknownSource.id, fromItemId: unknownItem.item.id, mode: "visible_only" }
  });
  assert.equal(unknownForkRes.statusCode, 201, unknownForkRes.body);
  const unknownFork = unknownForkRes.json() as { id: string };
  const unknownForkRun = await sendMessage(fixture.app, {
    sessionId: unknownFork.id,
    workspaceId: fixture.workspaceId,
    text: "unknown fork continuation",
    clientRequestId: "fork-depth-unknown"
  });
  const unknownLineage = getRunRecord(fixture.db, unknownForkRun.runId);
  assert.equal(unknownLineage?.subtaskDepth, 0);
  assert.equal(unknownLineage?.parentRunId, null);
  assert.equal(unknownLineage?.parentToolItemId, null);

  const nullDepthSource = await createSession(fixture.app, fixture.workspaceId);
  const nullDepthRunId = newSortableId("run");
  const nullDepthItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: nullDepthSource.id,
    runId: nullDepthRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "legacy source with unknown depth" }
  });
  createRunRecord(fixture.db, {
    runId: nullDepthRunId,
    workspaceId: fixture.workspaceId,
    sessionId: nullDepthSource.id,
    triggerItemId: nullDepthItem.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: null,
    parentRunId: null,
    parentToolItemId: null,
    status: "completed",
    createdAt: Date.now()
  });
  const nullDepthForkRes = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: { fromSessionId: nullDepthSource.id, fromItemId: nullDepthItem.item.id, mode: "visible_only" } });
  assert.equal(nullDepthForkRes.statusCode, 201, nullDepthForkRes.body);
  const nullDepthFork = nullDepthForkRes.json() as { id: string };
  const nullDepthForkRun = await sendMessage(fixture.app, { sessionId: nullDepthFork.id, workspaceId: fixture.workspaceId, text: "keep unknown lineage", clientRequestId: "fork-depth-null-source" });
  const nullDepthLineage = getRunRecord(fixture.db, nullDepthForkRun.runId);
  assert.equal(nullDepthLineage?.subtaskDepth, 0);
  assert.equal(nullDepthLineage?.parentRunId, null);
  assert.equal(nullDepthLineage?.parentToolItemId, null);
});

test("public 和 generic internal create 固定创建 primary，并拒绝未知字段", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });

  const publicCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions",
    payload: { workspaceId: fixture.workspaceId, title: "public-primary" }
  });
  assert.equal(publicCreate.statusCode, 201, publicCreate.body);
  assert.equal((publicCreate.json() as { kind: string }).kind, "primary");

  const internalCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/create",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, title: "internal-primary" }
  });
  assert.equal(internalCreate.statusCode, 201, internalCreate.body);
  assert.equal((internalCreate.json() as { kind: string }).kind, "primary");

  const sessionCountBeforeRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
  const rejectedRequests = [
    { name: "public primary kind", url: "/api/agent/sessions", headers: {}, payload: { workspaceId: fixture.workspaceId, kind: "primary" } },
    { name: "public subtask kind", url: "/api/agent/sessions", headers: {}, payload: { workspaceId: fixture.workspaceId, kind: "subtask" } },
    { name: "public arbitrary field", url: "/api/agent/sessions", headers: {}, payload: { workspaceId: fixture.workspaceId, unexpected: true } },
    { name: "internal primary kind", url: "/api/internal/agent/sessions/create", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, kind: "primary" } },
    { name: "internal subtask kind", url: "/api/internal/agent/sessions/create", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, kind: "subtask" } },
    { name: "internal arbitrary field", url: "/api/internal/agent/sessions/create", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { workspaceId: fixture.workspaceId, unexpected: true } }
  ];
  for (const rejected of rejectedRequests) {
    const response = await fixture.app.inject({ method: "POST", url: rejected.url, headers: rejected.headers, payload: rejected.payload });
    assert.equal(response.statusCode, 400, `${rejected.name}: ${response.body}`);
    assert.deepEqual(response.json(), { message: "request body contains unknown field", code: "AGENT_REQUEST_UNKNOWN_FIELD" });
    const sessionCountAfterRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
    assert.equal(sessionCountAfterRejected.count, sessionCountBeforeRejected.count, `${rejected.name} must not create a session`);
  }
});

test("public fork 固定创建 primary，并拒绝非 primary source 和未知字段", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const source = await createSession(fixture.app, fixture.workspaceId);
  const sourceItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: source.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "primary fork source" }
  });
  const accepted = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only" }
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal((accepted.json() as { kind: string }).kind, "primary");

  const sessionCountBeforeRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
  const rejectedRequests = [
    { name: "fork primary kind", payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only", kind: "primary" } },
    { name: "fork subtask kind", payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only", kind: "subtask" } },
    { name: "fork arbitrary field", payload: { fromSessionId: source.id, fromItemId: sourceItem.item.id, mode: "visible_only", unexpected: true } }
  ];
  for (const rejected of rejectedRequests) {
    const response = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork", payload: rejected.payload });
    assert.equal(response.statusCode, 400, `${rejected.name}: ${response.body}`);
    assert.deepEqual(response.json(), { message: "request body contains unknown field", code: "AGENT_REQUEST_UNKNOWN_FIELD" });
    const count = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
    assert.equal(count.count, sessionCountBeforeRejected.count, `${rejected.name} must not create a target session`);
  }

  const subtaskSource = createSubtaskSessionForTest(fixture);
  const subtaskItem = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: subtaskSource.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "subtask fork source" }
  });
  const sourceKindRejected = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: subtaskSource.id, fromItemId: subtaskItem.item.id, mode: "visible_only" }
  });
  assert.equal(sourceKindRejected.statusCode, 400, sourceKindRejected.body);
  assert.deepEqual(sourceKindRejected.json(), { message: "source session must be primary", code: "AGENT_FORK_SOURCE_KIND_INVALID" });
  const countAfterSourceKindRejected = fixture.db.prepare("select count(*) as count from agent_session").get() as { count: number };
  assert.equal(countAfterSourceKindRejected.count, sessionCountBeforeRejected.count + 1, "source-kind rejection must not create a target session");
});

test("P0 baseline: endpoint-local preValidation sees unknown keys before schema stripping", async (t: TestContext) => {
  const probe: P2RouteProbe = { observedBodies: [], handlerCalls: 0 };
  const fixture = await createP2RouteProbeFixture(t, "prevalidation", probe);

  const rejected = await fixture.app.inject({
    method: "POST",
    url: "/__p0-prevalidation-probe",
    payload: { known: "value", unexpected: "value" }
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.deepEqual(rejected.json(), { message: "unexpected body key", code: "P0_UNKNOWN_BODY_KEY" });
  assert.deepEqual(probe.observedBodies, [{ known: "value", unexpected: "value" }]);
  assert.equal(probe.handlerCalls, 0);

  const accepted = await fixture.app.inject({
    method: "POST",
    url: "/__p0-prevalidation-probe",
    payload: { known: "value" }
  });
  assert.equal(accepted.statusCode, 204, accepted.body);
  assert.equal(probe.handlerCalls, 1);
});

test("P0 baseline: schema additionalProperties:false alone strips unknown body keys and permits the request", async (t: TestContext) => {
  const probe: P2RouteProbe = { observedBodies: [], handlerCalls: 0 };
  const fixture = await createP2RouteProbeFixture(t, "schema-only", probe);

  const response = await fixture.app.inject({
    method: "POST",
    url: "/__p0-schema-only-probe",
    payload: { known: "value", unexpected: "value" }
  });

  assert.equal(response.statusCode, 204, response.body);
  assert.equal(probe.handlerCalls, 1);
  assert.deepEqual(probe.observedBodies, [{ known: "value" }]);
});

test("Run Routes: invalid token + invalid body is 401; valid token + invalid body is 400", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runStateBody = {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null
  };

  const validState = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: runStateBody
  });
  assert.equal(validState.statusCode, 200, validState.body);
  assert.deepEqual(validState.json(), { ok: true });

  const invalidBody = { workspaceId: fixture.workspaceId };
  for (const url of [
    "/api/internal/agent/run-state",
    "/api/internal/agent/run-complete"
  ]) {
    const validTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: invalidBody
    });
    assert.equal(validTokenInvalidBody.statusCode, 400, `${url}: ${validTokenInvalidBody.body}`);
    const validErrorBody = validTokenInvalidBody.json() as { message?: unknown; code?: unknown };
    assert.equal(typeof validErrorBody.message, "string", `${url}: ${validTokenInvalidBody.body}`);
    assert.ok(validErrorBody.code === undefined || typeof validErrorBody.code === "string", `${url}: ${validTokenInvalidBody.body}`);

    const invalidTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
      payload: invalidBody
    });
    assert.equal(invalidTokenInvalidBody.statusCode, 401, `${url}: ${invalidTokenInvalidBody.body}`);
    const invalidTokenErrorBody = invalidTokenInvalidBody.json() as { message?: unknown; code?: unknown };
    assert.equal(typeof invalidTokenErrorBody.message, "string", `${url}: ${invalidTokenInvalidBody.body}`);
    assert.ok(invalidTokenErrorBody.code === undefined || typeof invalidTokenErrorBody.code === "string", `${url}: ${invalidTokenInvalidBody.body}`);
  }
});

test("Subtask Routes: invalid token wins over invalid body and valid token reaches schema validation", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const endpoints = [
    "/api/internal/agent/subtask/prefork-plan",
    "/api/internal/agent/subtask/start",
    "/api/internal/agent/subtask/result",
    "/api/internal/agent/subtask/status"
  ];
  for (const url of endpoints) {
    const validTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(validTokenInvalidBody.statusCode, 400, `${url}: ${validTokenInvalidBody.body}`);
    const invalidTokenInvalidBody = await fixture.app.inject({
      method: "POST",
      url,
      headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
      payload: { workspaceId: fixture.workspaceId }
    });
    assert.equal(invalidTokenInvalidBody.statusCode, 401, `${url}: ${invalidTokenInvalidBody.body}`);
  }
});

test("Run Route: unknown top-level fields preserve the current accepted request behavior", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      status: "idle",
      activeRunId: null,
      activeAssistantItemId: null,
      extraField: "preserved"
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true });
});

test("Run ignored: RS-1, RS-2, RS-3 and RC-1, RC-2, RC-3 return 200 ok without DB mutation", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const sessionRs1 = await createSession(fixture.app, fixture.workspaceId);
  await updateRunStateInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: sessionRs1.id,
    status: "running",
    activeRunId: "run-rs1-first",
    activeAssistantItemId: null
  });
  const rs1Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs1.id,
      status: "running",
      activeRunId: "run-rs1-late",
      activeAssistantItemId: null
    }
  });
  assert.equal(rs1Ignored.statusCode, 200);
  assert.deepEqual(rs1Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs1.id).activeRunId, "run-rs1-first");

  const sessionRs2 = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);
  const rs2RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rs2RunId,
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const rs2Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs2.id,
      status: "running",
      activeRunId: rs2RunId,
      activeAssistantItemId: null
    }
  });
  assert.equal(rs2Ignored.statusCode, 200);
  assert.deepEqual(rs2Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs2.id).activeRunId, null);

  const sessionRs3 = await createSession(fixture.app, fixture.workspaceId);
  const rs3RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rs3RunId,
    workspaceId: fixture.workspaceId,
    sessionId: sessionRs3.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt: Date.now()
  });
  const rs3Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-state",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs3.id,
      status: "running",
      activeRunId: rs3RunId,
      activeAssistantItemId: null
    }
  });
  assert.equal(rs3Ignored.statusCode, 200);
  assert.deepEqual(rs3Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs3.id).activeRunId, null);

  const rc1Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs2.id,
      runId: "missing-run",
      status: "completed"
    }
  });
  assert.equal(rc1Ignored.statusCode, 200);
  assert.deepEqual(rc1Ignored.json(), { ok: true });
  assert.equal(getRunStateRow(fixture.db, fixture.workspaceId, sessionRs2.id).activeRunId, null);

  const rc2RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rc2RunId,
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: Date.now()
  });
  const rc2Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs2.id,
      runId: rc2RunId,
      status: "completed"
    }
  });
  assert.equal(rc2Ignored.statusCode, 200);
  assert.deepEqual(rc2Ignored.json(), { ok: true });
  assert.equal(getRunRecord(fixture.db, rc2RunId)?.status, "running");

  const rc3RunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: rc3RunId,
    workspaceId: fixture.workspaceId,
    sessionId: sessionRs3.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt: Date.now()
  });
  const rc3Ignored = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: sessionRs3.id,
      runId: rc3RunId,
      status: "failed"
    }
  });
  assert.equal(rc3Ignored.statusCode, 200);
  assert.deepEqual(rc3Ignored.json(), { ok: true });
  assert.equal(getRunRecord(fixture.db, rc3RunId)?.status, "completed");
});
