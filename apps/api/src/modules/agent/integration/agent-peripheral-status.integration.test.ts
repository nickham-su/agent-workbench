import { test, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { createMessageRunRecord, getMessageSessionById, getRunRecord } from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createMessageSession } from "../agent-message.store.js";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import {
  appendMessageFixture,
  createAssistantFixture,
  createMessageRunFixture,
  completeToolExecutionFixture,
  createSession,
  setRunNoticeFixture
} from "./context-writeback.helpers.js";
import assert from "node:assert/strict";





























function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRunState(app: FastifyInstance, workspaceId: string, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/run-state?workspaceId=${encodeURIComponent(workspaceId)}` });
  assert.equal(res.statusCode, 200, `get run-state failed: ${res.body}`);
  return res.json() as {
    status: "idle" | "running";
    activeRunId: string | null;
    runNoticeText: string;
    lastResponseTotalTokens?: number | null;
    contextTokenRatio?: number | null;
    activeAssistantMessageId: string | null;
    nonTerminalMessageIds: string[];
    nonTerminalToolExecutionIds: string[];
  };
}

async function getMessageTimelineSnapshot(app: FastifyInstance, internalToken: string, workspaceId: string, sessionId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/internal/agent/sessions/message-timeline-snapshot",
    headers: { "x-awb-agent-internal-token": internalToken },
    payload: { workspaceId, sessionId }
  });
  return res;
}

function getFeishuSessionRead(
  app: FastifyInstance,
  input: { path: "last-assistant-text" | "latest-todolist"; workspaceId: string; sessionId: string; token?: string; pluginId?: string }
) {
  return app.inject({
    method: "GET",
    url: `/api/internal/agent/sessions/${encodeURIComponent(input.sessionId)}/${input.path}?workspaceId=${encodeURIComponent(input.workspaceId)}`,
    headers: {
      ...(input.token ? { "x-awb-agent-internal-token": input.token } : {}),
      ...(input.pluginId ? { "x-awb-plugin-id": input.pluginId } : {})
    }
  });
}

test("Feishu 窄化读侧返回当前可见链最后 completed Assistant 文本", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunFixture({ fixture, sessionId: session.id });
  createAssistantFixture({
    fixture,
    sessionId: session.id,
    runId: run.runId,
    parts: [
      { id: newSortableId("part"), position: 0, type: "reasoning", text: "not returned" },
      { id: newSortableId("part"), position: 1, type: "text", text: "last " },
      { id: newSortableId("part"), position: 2, type: "text", text: "assistant" }
    ],
    executions: []
  });

  const result = await getFeishuSessionRead(fixture.app, {
    path: "last-assistant-text",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    token: fixture.internalToken,
    pluginId: "feishu"
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { found: true, text: "last assistant" });
});

test("Feishu 窄化 todolist 读侧返回最新 ToolCall 的权威 execution detail", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunFixture({ fixture, sessionId: session.id });
  const bashPartId = newSortableId("part");
  const todoPartId = newSortableId("part");
  const bashExecutionId = newSortableId("exec");
  const todoExecutionId = newSortableId("exec");
  createAssistantFixture({
    fixture,
    sessionId: session.id,
    runId: run.runId,
    parts: [
      { id: bashPartId, position: 0, type: "tool_call", toolName: "bash", input: {} },
      { id: todoPartId, position: 1, type: "tool_call", toolName: "todolist", input: { goal: "ship" } }
    ],
    executions: [
      { id: bashExecutionId, callPartId: bashPartId, originSessionId: session.id, originRunId: run.runId, status: "queued" },
      { id: todoExecutionId, callPartId: todoPartId, originSessionId: session.id, originRunId: run.runId, status: "queued" }
    ]
  });
  completeToolExecutionFixture({ fixture, sessionId: session.id, runId: run.runId, toolExecutionId: bashExecutionId, resultPreview: "bash result" });
  completeToolExecutionFixture({
    fixture,
    sessionId: session.id,
    runId: run.runId,
    toolExecutionId: todoExecutionId,
    resultPreview: "todo preview",
    structuredResult: { goal: "ship", todos: [{ content: "verify", status: "pending" }] }
  });

  const result = await getFeishuSessionRead(fixture.app, {
    path: "latest-todolist",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    token: fixture.internalToken,
    pluginId: "feishu"
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), {
    isRunning: true,
    execution: {
      resultPreview: "todo preview",
      structuredResult: { goal: "ship", todos: [{ content: "verify", status: "pending" }] }
    }
  });
});

test("Feishu 窄化读侧在无 todolist 时返回空结果，并验证 workspace 与调用方边界", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const valid = { path: "latest-todolist" as const, workspaceId: fixture.workspaceId, sessionId: session.id, token: fixture.internalToken, pluginId: "feishu" };
  const empty = await getFeishuSessionRead(fixture.app, valid);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), { isRunning: false, execution: null });

  assert.equal((await getFeishuSessionRead(fixture.app, { ...valid, token: undefined })).statusCode, 401);
  assert.equal((await getFeishuSessionRead(fixture.app, { ...valid, pluginId: undefined })).statusCode, 401);
  assert.equal((await getFeishuSessionRead(fixture.app, { ...valid, pluginId: "other-plugin" })).statusCode, 401);
  const mismatch = await getFeishuSessionRead(fixture.app, { ...valid, path: "last-assistant-text", workspaceId: "workspace-other" });
  assert.equal(mismatch.statusCode, 404);
  assert.equal(mismatch.json().code, "SESSION_NOT_FOUND");
});

test("internal runs/:runId/final-text 返回最终 assistant 文本", async (t: TestContext) => {
  const fixture = await createP4Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createMessageRunFixture({ fixture, sessionId: session.id, runId });
  const assistant = createAssistantFixture({
    fixture,
    sessionId: session.id,
    runId,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "final answer from integration test" }],
    executions: []
  });
  assert.ok(assistant.assistantMessageId);
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

test("queued/running ToolExecution 阻止 Run completed；terminal 后允许完成及重放", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createMessageRunFixture({ fixture, sessionId: session.id, runId });
  const callPartId = newSortableId("part");
  const toolExecutionId = newSortableId("exec");
  createAssistantFixture({
    fixture,
    sessionId: session.id,
    runId,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "bash", input: {} }],
    executions: [{
      id: toolExecutionId,
      callPartId,
      originSessionId: session.id,
      originRunId: runId,
      status: "queued",
    }],
  });
  const headers = { "x-awb-agent-internal-token": fixture.internalToken };
  const complete = () => fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers,
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId, status: "completed" },
  });

  let response = await complete();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "running");
  assert.equal((await getRunState(fixture.app, fixture.workspaceId, session.id)).status, "running");

  const running = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/tool-executions/update",
    headers,
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      toolExecutionId,
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    },
  });
  assert.equal(running.statusCode, 200, running.body);
  response = await complete();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "running");

  completeToolExecutionFixture({ fixture, sessionId: session.id, runId, toolExecutionId });
  response = await complete();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "completed");
  assert.equal((await getRunState(fixture.app, fixture.workspaceId, session.id)).status, "idle");

  response = await complete();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(getRunRecord(fixture.db, runId)?.status, "completed");
});

test("run-state 支持 runNoticeText 更新与 idle 自动清空", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createMessageRunFixture({ fixture, sessionId: session.id, runId });
  assert.equal(setRunNoticeFixture({
    fixture,
    sessionId: session.id,
    runId,
    runNoticeText: "Request failed, retrying in 2s (1/3): timeout"
  }), "updated");

  const runningState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(runningState.status, "running");
  assert.equal(runningState.runNoticeText, "Request failed, retrying in 2s (1/3): timeout");

  const completed = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId, status: "completed" }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const idleState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(idleState.status, "idle");
  assert.equal(idleState.runNoticeText, "");
  assert.equal(idleState.activeRunId, null);
  assert.equal(idleState.activeAssistantMessageId, null);
});

test("run-state 返回最近一次终态 run 结果", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getMessageSessionById(fixture.db, created.id)!;
  const createdAt = Date.now();
  const runId = newSortableId("run");
  createMessageRunFixture({ fixture, sessionId: session.id, runId, agentId: "agent-default", providerId: "openai", modelId: "gpt-4.1", createdAt });
  const completed = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId, status: "completed" }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const runState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(getRunRecord(fixture.db, runId)?.status, "completed");
});

test("run-state 与 timeline snapshot 按实际 Run 模型投影 Token 比例，解析失败时降级为 null", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createMessageRunFixture({ fixture, sessionId: session.id, runId, createdAt: Date.now() });
  fixture.db.prepare("update session_run_state set last_response_total_tokens = 32000 where workspace_id = ? and session_id = ?")
    .run(fixture.workspaceId, session.id);

  const state = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(state.lastResponseTotalTokens, 32000);
  assert.equal(state.contextTokenRatio, 0.25);

  const snapshotResponse = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, session.id);
  assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
  const snapshot = snapshotResponse.json() as { runState: { contextTokenRatio?: number | null } };
  assert.equal(snapshot.runState.contextTokenRatio, 0.25);

  fixture.db.prepare("update agent_run set provider_id = 'missing-provider', model_id = 'missing-model' where run_id = ?").run(runId);
  const unresolvedState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(unresolvedState.lastResponseTotalTokens, 32000);
  assert.equal(unresolvedState.contextTokenRatio, null);

  const unresolvedSnapshotResponse = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, session.id);
  assert.equal(unresolvedSnapshotResponse.statusCode, 200, unresolvedSnapshotResponse.body);
  const unresolvedSnapshot = unresolvedSnapshotResponse.json() as { runState: { contextTokenRatio?: number | null } };
  assert.equal(unresolvedSnapshot.runState.contextTokenRatio, null);
});

test("run-state 与 timeline snapshot 在 idle 时使用最新 terminal Run，active Run 存在时优先使用 active 模型", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const providersResponse = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{
        id: "ppchat",
        name: "ppchat",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
        models: [
          { id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 },
          { id: "terminal-old", name: "terminal-old", contextWindowTokens: 64000 },
          { id: "terminal-new", name: "terminal-new", contextWindowTokens: 128000 },
          { id: "active-model", name: "active-model", contextWindowTokens: 32000 },
        ],
      }],
    },
  });
  assert.equal(providersResponse.statusCode, 200, providersResponse.body);

  const session = await createSession(fixture.app, fixture.workspaceId);
  const completeRun = async (runId: string, modelId: string, createdAt: number, updatedAt: number) => {
    createMessageRunFixture({ fixture, sessionId: session.id, runId, providerId: "ppchat", modelId, createdAt });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/run-complete",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId, status: "completed" },
    });
    assert.equal(response.statusCode, 200, response.body);
    fixture.db.prepare("update agent_run set updated_at = ? where run_id = ?").run(updatedAt, runId);
  };

  const base = Date.now() - 10_000;
  await completeRun(newSortableId("run"), "terminal-old", base, base + 100);
  await completeRun(newSortableId("run"), "terminal-new", base + 200, base + 400);
  fixture.db.prepare("update session_run_state set last_response_total_tokens = 16000 where workspace_id = ? and session_id = ?")
    .run(fixture.workspaceId, session.id);

  const idleState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(idleState.status, "idle");
  assert.equal(idleState.activeRunId, null);
  assert.equal(idleState.contextTokenRatio, 0.125);
  const idleSnapshotResponse = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, session.id);
  assert.equal(idleSnapshotResponse.statusCode, 200, idleSnapshotResponse.body);
  assert.equal((idleSnapshotResponse.json() as { runState: { contextTokenRatio: number | null } }).runState.contextTokenRatio, 0.125);

  const activeRunId = newSortableId("run");
  createMessageRunFixture({
    fixture,
    sessionId: session.id,
    runId: activeRunId,
    providerId: "ppchat",
    modelId: "active-model",
    createdAt: base + 600,
  });
  const activeState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(activeState.status, "running");
  assert.equal(activeState.activeRunId, activeRunId);
  assert.equal(activeState.contextTokenRatio, 0.5);
  const activeSnapshotResponse = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, session.id);
  assert.equal(activeSnapshotResponse.statusCode, 200, activeSnapshotResponse.body);
  assert.equal((activeSnapshotResponse.json() as { runState: { contextTokenRatio: number | null } }).runState.contextTokenRatio, 0.5);
});

test("run-state 不应把旧 terminal run 误认为当前这次 idle 的终态", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });

  const created = await createSession(fixture.app, fixture.workspaceId);
  const session = getMessageSessionById(fixture.db, created.id)!;
  const createdAt = Date.now();
  const runId = newSortableId("run");
  createMessageRunFixture({ fixture, sessionId: session.id, runId, agentId: "agent-default", providerId: "openai", modelId: "gpt-4.1", createdAt });
  const completed = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId, status: "completed" }
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const runState = await getRunState(fixture.app, fixture.workspaceId, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(getRunRecord(fixture.db, runId)?.status, "completed");
});

test("internal message-timeline-snapshot 返回运行会话、消息与状态摘要", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now() - 1500;
  const run = createMessageRunFixture({ fixture, sessionId: session.id, runId, createdAt });
  const assistant = createAssistantFixture({
    fixture, sessionId: session.id, runId,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "snapshot assistant" }],
    executions: []
  });

  const res = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, session.id);
  assert.equal(res.statusCode, 200, `message-timeline-snapshot failed: ${res.body}`);
  const body = res.json() as {
    session: { id: string; workspaceId: string; headMessageId: string | null };
    messages: Array<{ id: string }>;
    toolExecutions: unknown[];
    runState: { status: string; activeRunId: string | null; activeAssistantMessageId: string | null };
    timelineReset: boolean;
  };
  assert.equal(body.session.id, session.id);
  assert.equal(body.session.workspaceId, fixture.workspaceId);
  assert.equal(body.session.headMessageId, assistant.assistantMessageId);
  assert.deepEqual(body.messages.map((message) => message.id), [run.triggerMessageId, assistant.assistantMessageId]);
  assert.deepEqual(body.toolExecutions, []);
  assert.equal(body.runState.status, "running");
  assert.equal(body.runState.activeRunId, runId);
  assert.equal(body.runState.activeAssistantMessageId, null);
  assert.equal(body.timelineReset, false);
  assert.equal(getRunRecord(fixture.db, runId)?.createdAt, createdAt);
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

test("internal message-timeline-snapshot 需要 internal token 且 session 必须存在", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const noToken = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/sessions/message-timeline-snapshot",
    payload: { workspaceId: fixture.workspaceId, sessionId: "sess_missing" }
  });
  assert.equal(noToken.statusCode, 401);
  const missing = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, "sess_missing");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "SESSION_NOT_FOUND");
});

test("internal message-timeline-snapshot sessionId 为空白时返回请求校验错误", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const res = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/sessions/message-timeline-snapshot",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: "   " }
  });
  assert.equal(res.statusCode, 400);
});

test("internal message-timeline-snapshot 缺少 workspaceId 时返回请求校验错误", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/sessions/message-timeline-snapshot",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { sessionId: session.id }
  });
  assert.equal(res.statusCode, 400);
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

test("internal message-timeline-snapshot 返回当前链上的消息与轻量 ToolExecution", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const user = appendMessageFixture({ fixture, sessionId: session.id, type: "user", text: "hello 1" });
  const run = createMessageRunFixture({ fixture, sessionId: session.id });
  const callPartId = newSortableId("part");
  const toolExecutionId = newSortableId("exec");
  const assistant = createAssistantFixture({
    fixture, sessionId: session.id, runId: run.runId,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "todolist", input: {} }],
    executions: [{ id: toolExecutionId, callPartId, originSessionId: session.id, originRunId: run.runId, status: "queued" }]
  });
  const res = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, session.id);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { session: { id: string }; messages: Array<{ id: string }>; toolExecutions: Array<{ id: string; callPartId: string; status: string; resultPreview: string | null; resultTruncated: boolean; error: string | null; updatedRevision: number; startedAt: number | null; completedAt: number | null }> };
  assert.equal(body.session.id, session.id);
  assert.deepEqual(body.messages.map((message) => message.id), [user.messageId, run.triggerMessageId, assistant.assistantMessageId]);
  assert.deepEqual(body.toolExecutions.map((execution) => ({
    id: execution.id,
    callPartId: execution.callPartId,
    status: execution.status,
    resultPreview: execution.resultPreview,
    resultTruncated: execution.resultTruncated,
    error: execution.error,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt
  })), [{ id: toolExecutionId, callPartId, status: "queued", resultPreview: null, resultTruncated: false, error: null, startedAt: null, completedAt: null }]);
});

test("internal message-timeline-snapshot 以 ToolExecution 锚定 child Run lineage", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const parent = await createSession(fixture.app, fixture.workspaceId);
  const now = Date.now();
  const parentRun = createMessageRunFixture({ fixture, sessionId: parent.id, createdAt: now });
  const callPartId = newSortableId("part");
  const toolExecutionId = newSortableId("exec");
  const assistant = createAssistantFixture({
    fixture, sessionId: parent.id, runId: parentRun.runId,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "subtask", input: {} }],
    executions: [{ id: toolExecutionId, callPartId, originSessionId: parent.id, originRunId: parentRun.runId, status: "queued" }], createdAt: now + 1
  });
  const childSessionId = newSortableId("sess");
  createMessageSession(fixture.db, { id: childSessionId, workspaceId: fixture.workspaceId, title: "child", kind: "subtask", createdAt: now + 2 });
  const childTrigger = appendMessageFixture({ fixture, sessionId: childSessionId, type: "user", text: "child trigger", createdAt: now + 2 });
  const childRunId = newSortableId("run");
  createMessageRunRecord(fixture.db, {
    runId: childRunId, workspaceId: fixture.workspaceId, sessionId: childSessionId,
    triggerMessageId: childTrigger.messageId, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
    parentRunId: parentRun.runId, parentToolExecutionId: toolExecutionId, status: "completed", createdAt: now + 2
  });
  const snapshot = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, parent.id);
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  const body = snapshot.json() as { messages: Array<{ id: string }>; toolExecutions: Array<{ id: string; callPartId: string }> };
  assert.ok(body.messages.some((message) => message.id === assistant.assistantMessageId));
  assert.deepEqual(body.toolExecutions.map((execution) => ({ id: execution.id, callPartId: execution.callPartId })), [{ id: toolExecutionId, callPartId }]);
  const child = getRunRecord(fixture.db, childRunId);
  assert.equal(child?.parentRunId, parentRun.runId);
  assert.equal(child?.parentToolExecutionId, toolExecutionId);
});

test("internal message-timeline-snapshot sessionId 为空白时返回 400", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const res = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, fixture.workspaceId, "   ");
  assert.equal(res.statusCode, 400);
});

test("internal message-timeline-snapshot 缺少 internal token 时返回 401", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/sessions/message-timeline-snapshot", payload: { workspaceId: fixture.workspaceId, sessionId: session.id } });
  assert.equal(res.statusCode, 401);
});

test("internal message-timeline-snapshot 缺少 body.workspaceId 时返回 400", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/sessions/message-timeline-snapshot", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: { sessionId: session.id } });
  assert.equal(res.statusCode, 400);
});

test("internal message-timeline-snapshot 拒绝 workspace 与 session 不匹配", async (t: TestContext) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await getMessageTimelineSnapshot(fixture.app, fixture.internalToken, "ws_other", session.id);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, "SESSION_NOT_FOUND");
});
