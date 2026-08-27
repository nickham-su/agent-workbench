import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { appendContextItem, createRunRecord, getAgentSession, updateRunState } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { createSession, createContextItemInternal, updateRunStateInternal } from "./context-writeback.helpers.js";
import assert from "node:assert/strict";





























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

test("internal runs/:runId/final-text 返回最终 assistant 文本", async (t: TestContext) => {
  const fixture = await createP4Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: newSortableId("turn"),
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "final answer from integration test" }
  });
  assert.ok(assistantItem.item.id > 0);
  const runComplete = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      status: "completed"
    }
  });
  assert.equal(runComplete.statusCode, 200, `run complete failed: ${runComplete.body}`);

  const finalText = await fixture.app.inject({
    method: "GET",
    url: `/api/internal/agent/runs/${encodeURIComponent(runId)}/final-text`,
    headers: { "x-awb-agent-internal-token": fixture.internalToken }
  });
  assert.equal(finalText.statusCode, 200, `final-text query failed: ${finalText.body}`);
  const finalBody = finalText.json() as { found: boolean; text: string };
  assert.equal(finalBody.found, true);
  assert.equal(finalBody.text, "final answer from integration test");
});

test("run-state 支持 runNoticeText 更新与 idle 自动清空", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "Request failed, retrying in 2s (1/3): timeout"
  });

  const runningState = await getRunState(fixture.app, session.id);
  assert.equal(runningState.status, "running");
  assert.equal(runningState.runNoticeText, "Request failed, retrying in 2s (1/3): timeout");

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
  });

  const idleState = await getRunState(fixture.app, session.id);
  assert.equal(idleState.status, "idle");
  assert.equal(idleState.runNoticeText, "");
  assert.equal(idleState.lastTerminalStatus, null);
});

test("run-state 返回最近一次终态 run 结果", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;
  const createdAt = Date.now();
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "completed",
    createdAt
  });
  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: createdAt
  });

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.lastTerminalStatus, "completed");
});

test("run-state 不应把旧 terminal run 误认为当前这次 idle 的终态", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;
  const createdAt = Date.now();
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "completed",
    createdAt
  });

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: createdAt + 1000
  });

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.lastTerminalStatus, null);
});

test("internal sessions/status-summary 返回 run 摘要（elapsed/contextWindowTokens/ratio）", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;

  const runId = newSortableId("run");
  const createdAt = Date.now() - 1500;
  const updatedAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 64000,
    runNoticeText: "",
    updatedAt,
    appliedItemId: 0
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      sessionId: session.id,
      // Compatibility: use `agentId` as documented.
      agentId: "default"
    }
  });
  assert.equal(res.statusCode, 200, `status-summary failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.session?.id, session.id);
  assert.equal(body.session?.workspaceId, fixture.workspaceId);
  assert.equal(body.agent?.id, "default");
  assert.equal(body.agent?.name, "default");
  assert.equal(body.runState?.status, "running");
  assert.equal(body.runState?.activeRunId, runId);
  assert.equal(body.runState?.lastResponseTotalTokens, 64000);
  // Compatibility: runState.terminalStatus alias
  assert.equal(body.runState?.contextWindowTokens, 128000);
  assert.ok(Math.abs((body.runState?.contextTokenRatio ?? 0) - 0.5) < 1e-9);
  assert.equal(body.runState?.terminalStatus, body.runState?.lastTerminalStatus);
  assert.equal(body.startedAt, createdAt);
  assert.equal(body.contextWindowTokens, 128000);
  assert.equal(body.contextWindowTokens, body.runState?.contextWindowTokens);
  assert.ok(Math.abs(body.contextTokenRatio - 0.5) < 1e-9);
  assert.equal(body.contextTokenRatio, body.runState?.contextTokenRatio);
  assert.ok(typeof body.elapsedMs === "number" && body.elapsedMs >= 0);

  {
    // Precedence: selectedAgentId wins when both are provided.
    const resPreferSelected = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/sessions/status-summary",
      headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
      payload: { sessionId: session.id, agentId: "missing", selectedAgentId: "default" }
    });
    assert.equal(resPreferSelected.statusCode, 200);
    const prefer = resPreferSelected.json() as any;
    assert.equal(prefer.agent?.id, "default");
  }

  // updatedAt should be stable across calls (generatedAt changes)
  const updatedAt1 = body.updatedAt;
  const generatedAt1 = body.generatedAt;
  await sleep(10);
  const res2 = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: session.id, agentId: "default" }
  });
  assert.equal(res2.statusCode, 200);
  const body2 = res2.json() as any;
  assert.equal(body2.updatedAt, updatedAt1);
  assert.ok(typeof body2.generatedAt === "number" && body2.generatedAt >= generatedAt1);

  const resNoAgent = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      sessionId: session.id
    }
  });
  assert.equal(resNoAgent.statusCode, 200, `status-summary(no agent) failed: ${resNoAgent.body}`);
  const bodyNoAgent = resNoAgent.json() as any;
  assert.equal(bodyNoAgent.agent, null);
  assert.equal(bodyNoAgent.contextWindowTokens, bodyNoAgent.runState?.contextWindowTokens ?? null);
  assert.equal(bodyNoAgent.contextTokenRatio, bodyNoAgent.runState?.contextTokenRatio ?? null);
});

test("internal channels/allowlist/check 命中 allowlist 时返回 allowed=true 与 role", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken,
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(res.statusCode, 200, `allowlist check failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.allowed, true);
  assert.equal(body.role, "user");
  assert.equal(body.reason, undefined);
});

test("internal channels/allowlist/check 未命中 allowlist 时返回 allowed=false 与 reason", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken,
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_unknown"
    }
  });
  assert.equal(res.statusCode, 200, `allowlist check failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.allowed, false);
  assert.equal(body.role, undefined);
  assert.equal(body.reason, "sender is not allowed");
});

test("internal channels/allowlist/check 缺失或错误 internal token 返回 401", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const noTokenRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(noTokenRes.statusCode, 401);

  const badTokenRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": "bad-token",
      "x-awb-plugin-id": "feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(badTokenRes.statusCode, 401);
});

test("internal channels/allowlist/check plugin caller mismatch 返回 401", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/channels/allowlist/check",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken,
      "x-awb-plugin-id": "not-feishu"
    },
    payload: {
      pluginId: "feishu",
      senderId: "u_allowed"
    }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "PLUGIN_CALLER_MISMATCH");
});

test("internal sessions/status-summary 需要 internal token 且 sessionId 必须存在", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const noTokenRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    payload: { sessionId: "sess_missing" }
  });
  assert.equal(noTokenRes.statusCode, 401);

  const notFoundRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: "sess_missing" }
  });
  assert.equal(notFoundRes.statusCode, 404);
  assert.equal(notFoundRes.json().code, "SESSION_NOT_FOUND");

  const agentNotFoundRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: "sess_missing", selectedAgentId: "agent_missing" }
  });
  // sessionId missing still dominates; ensure agent not found is covered in another test
  assert.equal(agentNotFoundRes.statusCode, 404);
});

test("internal sessions/status-summary sessionId 为空白时返回 400 + SESSION_ID_REQUIRED", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: "   " }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "SESSION_ID_REQUIRED");
});

test("internal sessions/status-summary agent 不存在时返回 400 + AGENT_NOT_FOUND", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getAgentSession(fixture.db, created.id)!;
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/status-summary",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: session.id, agentId: "agent_missing" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "AGENT_NOT_FOUND");
});

test("internal agents/list 传入非法 surface 返回 400", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/agents/list",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { workspaceId: fixture.workspaceId, surface: "subtask" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(String((res.json() as { message?: string }).message || "").toLowerCase().includes("surface"), true);
});

test("internal sessions/context-items-tail 返回尾部上下文项", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const user1 = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_tail_1",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "hello 1" }
  });
  const assistant2 = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_tail_1",
    step: 2,
    prevId: user1.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "hello 2" }
  });
  const tool3 = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_tail_1",
    step: 3,
    prevId: assistant2.item.id,
    kind: "tool",
    status: "completed",
    output: { type: "tool", toolName: "todolist", result: { goal: "x", todos: [] } }
  });

  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "feishu", sessionId: session.id, tailLimit: 2 }
  });
  assert.equal(res.statusCode, 200, `context-items-tail failed: ${res.body}`);
  const body = res.json() as any;
  assert.equal(body.sessionId, session.id);
  assert.equal(Array.isArray(body.items), true);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0]?.id, assistant2.item.id);
  assert.equal(body.items[1]?.id, tool3.item.id);
});

test("internal sessions/context-items-tail 序列化 subtask child run 摘要", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const now = Date.now();
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: 0,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", status: "running", createdAt: now
  });
  const parentTool = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId: session.id, runId: parentRunId, turnId: null, step: null, prevId: null,
    kind: "tool", status: "completed", output: { type: "tool", toolName: "subtask" }, createdAt: now + 1
  });
  const childRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: childRunId, workspaceId: fixture.workspaceId, sessionId: session.id, triggerItemId: parentTool.id,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", parentRunId, parentToolItemId: parentTool.id,
    status: "completed", createdAt: now + 2
  });
  fixture.db.prepare("update agent_run set updated_at = ? where run_id = ?").run(now + 5, childRunId);

  const res = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "feishu", sessionId: session.id, tailLimit: 10 }
  });
  assert.equal(res.statusCode, 200, res.body);
  const projected = (res.json() as { items: Array<{ id: number; subtaskRun?: unknown }> }).items.find((item) => item.id === parentTool.id);
  assert.deepEqual(projected?.subtaskRun, { runId: childRunId, status: "completed", startedAt: now + 2, endedAt: now + 5, durationMs: 3 });
});

test("internal sessions/context-items-tail sessionId 为空白时返回 400 + SESSION_ID_REQUIRED", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "feishu", sessionId: "   ", tailLimit: 1 }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "SESSION_ID_REQUIRED");
});

test("internal sessions/context-items-tail 缺少 x-awb-plugin-id 时返回 400 + PLUGIN_ID_REQUIRED", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { pluginId: "feishu", sessionId: session.id, tailLimit: 1 }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "PLUGIN_ID_REQUIRED");
});

test("internal sessions/context-items-tail 缺少 body.pluginId 时返回 400 + PLUGIN_ID_REQUIRED", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { sessionId: session.id, tailLimit: 1 }
  });

  assert.equal(res.statusCode, 400);
  assert.ok(typeof res.json().message === "string" && res.json().message.length > 0);
});

test("internal sessions/context-items-tail header/body pluginId 不一致时返回 401 + PLUGIN_ID_MISMATCH", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/context-items-tail",
    headers: { "x-awb-agent-internal-token": fixture.internalToken, "x-awb-plugin-id": "feishu" },
    payload: { pluginId: "slack", sessionId: session.id, tailLimit: 1 }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "PLUGIN_ID_MISMATCH");
});
