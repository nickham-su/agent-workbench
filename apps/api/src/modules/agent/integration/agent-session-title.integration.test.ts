import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createMessageRunRecord } from "../agent-message.store.js";
import { appendMessage, getMessageSessionHead, startMessageRun } from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { createAgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import { createMessageToolAnchor, createSession } from "./subtask.helpers.js";

async function completeTodolistForTitle(
  fixture: Awaited<ReturnType<typeof createAgentIntegrationFixture>>,
  sessionId: string,
  goal: string
) {
  const now = Date.now();
  const head = getMessageSessionHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId });
  assert.ok(head, "session must exist");
  const triggerMessageId = newSortableId("msg");
  const runId = newSortableId("run");
  appendMessage(fixture.db, {
    id: triggerMessageId,
    workspaceId: fixture.workspaceId,
    sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "update task list" }],
    createdAt: now
  });
  createMessageRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId,
    triggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: now
  });
  startMessageRun(fixture.db, { workspaceId: fixture.workspaceId, sessionId, runId, updatedAt: now });
  const tool = createMessageToolAnchor({ fixture, sessionId, runId, toolName: "todolist", input: {} });
  const headers = { "x-awb-agent-internal-token": fixture.internalToken };
  const running = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/tool-executions/update",
    headers,
    payload: { workspaceId: fixture.workspaceId, sessionId, runId, toolExecutionId: tool.toolExecutionId, status: "running", startedAt: now + 1, updatedAt: now + 1 }
  });
  assert.equal(running.statusCode, 200, running.body);
  const completed = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/tool-executions/update",
    headers,
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId,
      runId,
      toolExecutionId: tool.toolExecutionId,
      status: "completed",
      structuredResult: { goal, todos: [] },
      completedAt: now + 2,
      updatedAt: now + 2
    }
  });
  assert.equal(completed.statusCode, 200, completed.body);
}

async function putTitle(
  fixture: { app: import("fastify").FastifyInstance },
  sessionId: string,
  payload: Record<string, unknown>
) {
  return fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${sessionId}/title`,
    payload
  });
}

async function cancelSessionAndWaitIdle(fixture: { app: import("fastify").FastifyInstance }, sessionId: string, workspaceId: string) {
  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${sessionId}/cancel`,
    payload: { workspaceId }
  });
  assert.equal(res.statusCode, 200, res.body);
  const deadline = Date.now() + 10000;
  for (;;) {
    const state = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/sessions/${sessionId}/run-state?workspaceId=${workspaceId}`,
    });
    assert.equal(state.statusCode, 200, state.body);
    const body = state.json() as { status: string };
    if (body.status === "idle") {
      // Run 状态回到 idle 后，内部 runtime 的异步收尾（如 cancelled 完成写回）可能仍在进行；
      // 等待其稳定，避免 dispose 关闭数据库后出现 "database connection is not open" 噪声。
      await new Promise((resolve) => setTimeout(resolve, 200));
      return;
    }
    if (Date.now() > deadline) throw new Error(`session ${sessionId} did not return to idle in time`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("PUT /api/agent/sessions/:sessionId/title 设置标题并永久接管，updatedAt 不变", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const before = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const beforeRecord = (before.json() as Array<{ id: string; updatedAt: number }>).find((s) => s.id === session.id);
  assert.ok(beforeRecord);

  const res = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "  我的   标题  " });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { id: string; title: string; updatedAt: number };
  assert.equal(body.title, "我的 标题");
  assert.equal(body.updatedAt, beforeRecord.updatedAt, "手动标题不得推进 updatedAt");

  // 相同标题再次保存：幂等成功
  const again = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "我的 标题" });
  assert.equal(again.statusCode, 200, again.body);
});

test("PUT title 后首条用户消息不再覆盖标题", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });
  const session = await createSession(fixture.app, fixture.workspaceId);
  await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "手动标题" });

  const send = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "这是一条会自动命名的首条消息", clientRequestId: "req-1" }
  });
  assert.equal(send.statusCode, 201, send.body);

  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const record = (list.json() as Array<{ id: string; title: string }>).find((s) => s.id === session.id);
  assert.equal(record?.title, "手动标题");

  // 首条消息会启动后台 Run；显式取消并等待回到 idle 后再 dispose，避免连接关闭后的错误噪声
  await cancelSessionAndWaitIdle(fixture, session.id, fixture.workspaceId);
});

test("manual 状态下 todolist update-to-completed 不覆盖标题，auto 对照组会更新", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });

  // manual 组：先创建 running 的 todolist item，再 update 为 completed + goal
  const manual = await createSession(fixture.app, fixture.workspaceId);
  await putTitle(fixture, manual.id, { workspaceId: fixture.workspaceId, title: "update 锁定" });

  await completeTodolistForTitle(fixture, manual.id, "update 后的目标");

  // auto 对照组：同样先 running 再 update-to-completed
  const control = await createSession(fixture.app, fixture.workspaceId);
  await completeTodolistForTitle(fixture, control.id, "update 自动目标");

  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const records = list.json() as Array<{ id: string; title: string }>;
  assert.equal(records.find((s) => s.id === manual.id)?.title, "update 锁定", "manual 下 update-to-completed 不得覆盖标题");
  assert.equal(records.find((s) => s.id === control.id)?.title, "update 自动目标");
});

test("PUT title 对无 body/null/数组/缺 title 返回 400 而非 500", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });
  const session = await createSession(fixture.app, fixture.workspaceId);

  // 无 body：Fastify 对 PUT JSON 路由无 body 时按 undefined 处理，由 Schema 返回 400
  const noBody = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${session.id}/title`
  });
  assert.equal(noBody.statusCode, 400);

  // null body（显式 JSON null）
  const nullBody = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${session.id}/title`,
    headers: { "content-type": "application/json" },
    payload: "null"
  });
  assert.equal(nullBody.statusCode, 400);

  // 数组 body
  const arrayBody = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${session.id}/title`,
    payload: ["workspaceId", "title"]
  });
  assert.equal(arrayBody.statusCode, 400);

  // 缺少 title
  const missingTitle = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${session.id}/title`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(missingTitle.statusCode, 400);

  // 缺少 workspaceId
  const missingWs = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${session.id}/title`,
    payload: { title: "x" }
  });
  assert.equal(missingWs.statusCode, 400);

  // 均未发生写入
  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const record = (list.json() as Array<{ id: string; title: string }>).find((s) => s.id === session.id);
  assert.equal(record?.title, "it-session");
});

test("PUT title 按 JavaScript string.length 执行原始 1000 上限", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });
  const session = await createSession(fixture.app, fixture.workspaceId);

  // 500 个 emoji：JS length 1000，路由层必须接受（进入应用层；规范化后 1002 > 50，由应用层返回 TOO_LONG）
  const fiveHundredEmoji = "😀".repeat(500);
  const res = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: fiveHundredEmoji });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /AGENT_SESSION_TITLE_TOO_LONG/);

  // 501 个 emoji：JS length 1002 > 1000，路由 preValidation 必须在结构阶段拒绝，不进入应用层
  const fiveHundredOneEmoji = "😀".repeat(501);
  const res2 = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: fiveHundredOneEmoji });
  assert.equal(res2.statusCode, 400);
  assert.doesNotMatch(res2.body, /AGENT_SESSION_TITLE_TOO_LONG/);

  // 1000 个 ASCII：JS length 1000，进入应用层后因 1000 > 50 返回 TOO_LONG
  const thousand = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "x".repeat(1000) });
  assert.equal(thousand.statusCode, 400);
  assert.match(thousand.body, /AGENT_SESSION_TITLE_TOO_LONG/);

  // 未发生任何写入
  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const record = (list.json() as Array<{ id: string; title: string }>).find((s) => s.id === session.id);
  assert.equal(record?.title, "it-session");
});

test("PUT title 返回 404/400/固定错误码", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });
  const session = await createSession(fixture.app, fixture.workspaceId);

  // Session 不存在
  const missing = await putTitle(fixture, "missing-session", { workspaceId: fixture.workspaceId, title: "x" });
  assert.equal(missing.statusCode, 404);

  // Workspace 不匹配
  const mismatch = await putTitle(fixture, session.id, { workspaceId: "ws-other", title: "x" });
  assert.equal(mismatch.statusCode, 400);

  // 结构校验：原始空字符串
  const empty = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "" });
  assert.equal(empty.statusCode, 400);

  // 结构校验：原始长度 1001
  const tooLongRaw = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "x".repeat(1001) });
  assert.equal(tooLongRaw.statusCode, 400);

  // 未知字段
  const unknown = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "x", mode: "manual" });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.body, /AGENT_REQUEST_UNKNOWN_FIELD/);

  // 业务校验：纯空白
  const blank = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "   " });
  assert.equal(blank.statusCode, 400);
  assert.match(blank.body, /AGENT_SESSION_TITLE_EMPTY/);

  // 业务校验：规范化后 51
  const fiftyOne = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "a".repeat(51) });
  assert.equal(fiftyOne.statusCode, 400);
  assert.match(fiftyOne.body, /AGENT_SESSION_TITLE_TOO_LONG/);

  // 业务校验：控制字符
  const control = await putTitle(fixture, session.id, { workspaceId: fixture.workspaceId, title: "a\u0007b" });
  assert.equal(control.statusCode, 400);
  assert.match(control.body, /AGENT_SESSION_TITLE_INVALID_CHARACTERS/);

  // 验证未发生任何写入
  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const record = (list.json() as Array<{ id: string; title: string }>).find((s) => s.id === session.id);
  assert.equal(record?.title, "it-session");
});

test("未手动接管的 Session 仍由首条消息自动命名，manual 后 todolist 不再覆盖", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });

  // 自动命名基线：首条消息截断到 50
  const auto = await createSession(fixture.app, fixture.workspaceId);
  const longText = "自动".repeat(40);
  await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${auto.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: longText, clientRequestId: "req-auto" }
  });
  const autoList = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const autoRecord = (autoList.json() as Array<{ id: string; title: string }>).find((s) => s.id === auto.id);
  assert.ok(autoRecord);
  assert.ok(autoRecord.title.length <= 50);
  assert.match(autoRecord.title, /…$/);

  // manual 后通过 worker 内部写回 completed todolist：标题不变
  const manual = await createSession(fixture.app, fixture.workspaceId);
  await putTitle(fixture, manual.id, { workspaceId: fixture.workspaceId, title: "锁定标题" });

  await completeTodolistForTitle(fixture, manual.id, "新的任务目标标题");

  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const manualRecord = (list.json() as Array<{ id: string; title: string }>).find((s) => s.id === manual.id);
  assert.equal(manualRecord?.title, "锁定标题", "manual 状态下 todolist 不得覆盖标题");

  // 对照：未接管的 Session 上同样的 todolist 会更新标题
  const control = await createSession(fixture.app, fixture.workspaceId);
  await completeTodolistForTitle(fixture, control.id, "自动任务目标");
  const controlList = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const controlRecord = (controlList.json() as Array<{ id: string; title: string }>).find((s) => s.id === control.id);
  assert.equal(controlRecord?.title, "自动任务目标");

  // auto Session 的首条消息启动了后台 Run；显式取消并等待回到 idle 后再 dispose
  await cancelSessionAndWaitIdle(fixture, auto.id, fixture.workspaceId);
});

test("OpenAPI 文档包含标题更新路由且请求/响应 schema 正确", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });
  const document = fixture.app.swagger() as unknown as {
    paths: Record<string, {
      put?: {
        parameters?: Array<{ name: string; in: string; required?: boolean; schema?: { minLength?: number } }>;
        requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, { minLength?: number; maxLength?: number }>; required?: string[] } }> };
        responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>;
      };
    }>;
  };
  const operation = document.paths["/api/agent/sessions/{sessionId}/title"]?.put;
  assert.ok(operation, "PUT /api/agent/sessions/{sessionId}/title must be documented in OpenAPI");

  // params：sessionId 必填且非空
  const sessionIdParam = operation.parameters?.find((param) => param.name === "sessionId" && param.in === "path");
  assert.ok(sessionIdParam, "sessionId path param must be documented");
  assert.equal(sessionIdParam.required, true);
  assert.equal(sessionIdParam.schema?.minLength, 1);

  // requestBody：application/json，workspaceId/title 必填，title 长度 1..1000
  const requestBody = operation.requestBody?.content?.["application/json"]?.schema;
  assert.ok(requestBody, "request body schema must be application/json");
  assert.equal(requestBody.properties?.workspaceId?.minLength, 1);
  assert.equal(requestBody.properties?.title?.minLength, 1);
  assert.equal(requestBody.properties?.title?.maxLength, 1000);
  assert.deepEqual([...(requestBody.required ?? [])].sort(), ["title", "workspaceId"]);

  // responses：200 返回 AgentSessionRecord（含 id/title），400/404 错误契约
  const okSchema = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(okSchema, "200 response schema must be documented");
  assert.ok(okSchema.properties?.id, "200 response must be an AgentSessionRecord with id");
  assert.ok(okSchema.properties?.title, "200 response must be an AgentSessionRecord with title");
  assert.ok(operation.responses?.["400"], "400 error response must be documented");
  assert.ok(operation.responses?.["404"], "404 error response must be documented");
});

test("Fork 不继承手动接管标记：manual 源 Session Fork 后新 Session 可被自动 todolist 更新标题", async (t: TestContext) => {
  const fixture = await createAgentIntegrationFixture();
  t.after(async () => { await fixture.dispose(); });

  // manual 源 Session：先有一条 user 消息作为 Fork 边界
  const source = await createSession(fixture.app, fixture.workspaceId);
  await putTitle(fixture, source.id, { workspaceId: fixture.workspaceId, title: "源手动标题" });
  const send = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${source.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "fork 边界消息", clientRequestId: "fork-boundary" }
  });
  assert.equal(send.statusCode, 201, send.body);
  await cancelSessionAndWaitIdle(fixture, source.id, fixture.workspaceId);

  const list = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const sourceRecord = (list.json() as Array<{ id: string; title: string }>).find((s) => s.id === source.id);
  assert.equal(sourceRecord?.title, "源手动标题");

  // Fork：从边界消息创建新 Session
  const sourceMessage = send.json() as { messageId: string };

  const fork = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: source.id, fromMessageId: sourceMessage.messageId }
  });
  assert.equal(fork.statusCode, 201, fork.body);
  const forked = fork.json() as { id: string; title: string };
  assert.equal(forked.title, "源手动标题 (fork)");

  // Fork 新 Session 的 head 指向共享的 Message boundary；新 todolist Execution
  // 从该 head 继续追加，并通过新的写回端点更新自动标题。
  await completeTodolistForTitle(fixture, forked.id, "Fork 后的自动标题");

  const after = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions?workspaceId=${fixture.workspaceId}` });
  const records = after.json() as Array<{ id: string; title: string }>;
  assert.equal(records.find((s) => s.id === source.id)?.title, "源手动标题", "源 Session 仍保持手动接管");
  assert.equal(
    records.find((s) => s.id === forked.id)?.title,
    "Fork 后的自动标题",
    "Fork 出的新 Session title_manually_set 必须为 0，允许后续自动 todolist 更新标题"
  );
});
