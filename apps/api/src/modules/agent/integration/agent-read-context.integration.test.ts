import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { test, type TestContext } from "node:test";
import { createAgentComposition } from "../agent.composition.js";
import type { AppContext } from "../../../app/context.js";
import { agentArchiveSessionDir } from "../../../infra/fs/paths.js";
import {
  appendContextItem,
  createRunRecord,
  getAgentSession,
  getRunRecord,
  getRunState as getRunStateRow,
  getSessionTranscriptItems,
  updateRunState
} from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import {
  createContextItemInternal,
  createP3Fixture,
  createSession,
  sendMessage,
  updateContextItemInternal
} from "./context-writeback.helpers.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDirectAgentComposition(fixture: AgentIntegrationFixture) {
  const ctx: AppContext = {
    db: fixture.db,
    repoRoot: fixture.repoRoot,
    dataDir: fixture.dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    serveWeb: false,
    webDistDir: null,
    credentialMasterKey: Buffer.alloc(32, 7),
    credentialMasterKeySource: "generated",
    credentialMasterKeyId: "testkey",
    credentialMasterKeyCreatedAt: Date.now(),
    authToken: null,
    authCookieSecure: false,
    agentWorkerEnabled: false,
    agentWorkerHost: "127.0.0.1",
    agentWorkerPort: 0,
    agentWorkerSocketPath: path.join(fixture.dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: 0,
    agentInternalToken: fixture.internalToken,
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(fixture.dataDir, "agent-plugin-host.sock")
  };
  return createAgentComposition(ctx, fixture.app.log);
}

async function getRunState(app: FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/run-state` });
  assert.equal(res.statusCode, 200, `get run-state failed: ${res.body}`);
  return res.json() as { status: "idle" | "running" };
}

async function waitRunIdle(app: FastifyInstance, sessionId: string, timeoutMs = 6_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await getRunState(app, sessionId)).status === "idle") return;
    await sleep(80);
  }
  throw new Error(`wait run idle timeout, sessionId=${sessionId}`);
}

async function getMessagesContextInternal(params: {
  app: FastifyInstance; internalToken: string; workspaceId: string; sessionId: string;
  appendMessage?: { role: "system" | "user"; content: string };
}) {
  const res = await params.app.inject({
    method: "POST", url: "/api/internal/agent/messages-context",
    headers: { "x-awb-agent-internal-token": params.internalToken },
    payload: { workspaceId: params.workspaceId, sessionId: params.sessionId, ...(params.appendMessage ? { appendMessage: params.appendMessage } : {}) }
  });
  assert.equal(res.statusCode, 200, `get messages-context failed: ${res.body}`);
  return res.json() as { headItemId: number | null; system: string; messages: Array<{ role: string; content: unknown }> };
}

async function getContextItems(app: FastifyInstance, sessionId: string, afterId?: number) {
  const url = afterId ? `/api/agent/sessions/${sessionId}/context-items?afterId=${afterId}` : `/api/agent/sessions/${sessionId}/context-items`;
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, `get context-items failed: ${res.body}`);
  return res.json() as { headItemId: number | null; items: Array<{ id: number; kind: string; status: string; output: Record<string, any>; prevId: number | null; archiveAt: number | null; boundaryReason: string | null }> };
}

async function getContextItem(app: FastifyInstance, sessionId: string, itemId: number) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items/${itemId}` });
  assert.equal(res.statusCode, 200, `get context-item failed: ${res.body}`);
  return res.json() as { id: number; status: string; output: Record<string, unknown> };
}

async function getPromptContextInternal(params: { app: FastifyInstance; internalToken: string; workspaceId: string; sessionId: string; runId: string }) {
  const res = await params.app.inject({
    method: "POST", url: "/api/internal/agent/prompt-context",
    headers: { "x-awb-agent-internal-token": params.internalToken },
    payload: { workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as { system: string; messages: Array<{ role: string; content: unknown }> };
}

test("prompt-context reuses one run static promise and clears it when the run reaches a terminal status", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
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
    status: "running",
    createdAt: Date.now()
  });
  const composition = createDirectAgentComposition(fixture);
  const { service } = composition;
  const { runPromptStaticCache } = composition.testOnly;
  const request = { workspaceId: fixture.workspaceId, sessionId: session.id, runId };

  await service.getPromptContextForRun(request);
  const first = runPromptStaticCache.get(runId);
  assert.ok(first, "first prompt-context call should populate the static cache");
  const firstPromise = first.promise;
  const firstExpiresAt = first.expiresAt;

  await service.getPromptContextForRun(request);
  const second = runPromptStaticCache.get(runId);
  assert.ok(second, "second prompt-context call should retain the static cache");
  assert.equal(second.promise, firstPromise, "same run should reuse the static prompt promise while it is fresh");
  assert.ok(second.expiresAt >= firstExpiresAt, "same run cache access should preserve the current access-based expiry behavior");

  service.completeRunFromWorker({
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    status: "completed"
  });
  assert.equal(runPromptStaticCache.has(runId), false, "terminal run completion should clear the static prompt cache");

  await service.getPromptContextForRun(request);
  const afterTerminal = runPromptStaticCache.get(runId);
  assert.ok(afterTerminal, "current service still permits prompt retrieval for a terminal run");
  assert.notEqual(afterTerminal.promise, firstPromise, "terminal cache clear should force a new static promise on the next retrieval");
});
test("agent 消息去重与上下文项追加", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const clientRequestId = newSortableId("req");

  const first = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello integration",
    clientRequestId
  });
  const second = await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "hello integration",
    clientRequestId
  });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.messageItemId, first.messageItemId);
  assert.equal(second.runId, first.runId);

  await waitRunIdle(fixture.app, session.id);
  const context = await getContextItems(fixture.app, session.id);
  const userItems = context.items.filter((item) => item.kind === "user");
  assert.equal(userItems.length, 1);
  assert.ok(String(userItems[0]?.output?.text || "").includes("hello integration"));
});
test("read-side execution-profile 与 prompt-context 不修改已有 run、session 或 context", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
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
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "read-only baseline" }
  });

  const beforeSession = getAgentSession(fixture.db, session.id);
  const beforeRun = getRunRecord(fixture.db, runId);
  const beforeRunState = getRunStateRow(fixture.db, fixture.workspaceId, session.id);
  const beforeItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id);

  const profile = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId }
  });
  assert.equal(profile.statusCode, 200, `get execution-profile failed: ${profile.body}`);
  const prompt = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId }
  });
  assert.equal(prompt.statusCode, 200, `get prompt-context failed: ${prompt.body}`);

  assert.deepEqual(getAgentSession(fixture.db, session.id), beforeSession);
  assert.deepEqual(getRunRecord(fixture.db, runId), beforeRun);
  assert.deepEqual(getRunStateRow(fixture.db, fixture.workspaceId, session.id), beforeRunState);
  assert.deepEqual(getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id), beforeItems);
});
test("agent messages-context 返回完整 messages 且支持 appendMessage", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
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
    uiLocale: "zh-CN",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const user = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "hello" }
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: user.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "world" }
  });

  const beforeItems = getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id);
  const beforeRunState = getRunStateRow(fixture.db, fixture.workspaceId, session.id);

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    appendMessage: { role: "user", content: "append" }
  });
  assert.equal(typeof ctx.headItemId, "number");
  assert.ok(ctx.messages.length >= 3);
  assert.equal(ctx.messages.at(-1)?.role, "user");
  assert.equal(ctx.messages.at(-1)?.content, "append");
  assert.ok(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"));
  assert.deepEqual(getSessionTranscriptItems(fixture.db, fixture.workspaceId, session.id), beforeItems);
  assert.deepEqual(getRunStateRow(fixture.db, fixture.workspaceId, session.id), beforeRunState);
});
test("agent messages-context system 根据 active run 的 uiLocale 返回英文语言约束", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
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
    uiLocale: "en-US",
    status: "running",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });

  assert.ok(ctx.system.includes("Language requirement: use English consistently for this run."));
  assert.equal(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"), false);
});
test("agent messages-context 在 activeRun 缺失时回退到当前 session 最近 run 的 uiLocale", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now() - 10_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "completed",
    createdAt: Date.now()
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id
  });

  assert.ok(ctx.system.includes("Language requirement: use English consistently for this run."));
});
test("agent messages-context 在当前 session 无可用 locale 时回退到全局最近 run 的 uiLocale", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const targetSession = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "completed",
    createdAt: Date.now() - 20_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "completed",
    createdAt: Date.now() - 10_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "zh-CN",
    status: "completed",
    createdAt: Date.now()
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id
  });

  assert.ok(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"));
});
test("agent messages-context 回退到全局最近 run 时会忽略非法 uiLocale 脏值", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const targetSession = await createSession(fixture.app, fixture.workspaceId);
  const otherSession = await createSession(fixture.app, fixture.workspaceId);

  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: null,
    status: "completed",
    createdAt: Date.now() - 30_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "en-US",
    status: "completed",
    createdAt: Date.now() - 20_000
  });
  createRunRecord(fixture.db, {
    runId: newSortableId("run"),
    workspaceId: fixture.workspaceId,
    sessionId: otherSession.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    uiLocale: "fr-FR" as any,
    status: "completed",
    createdAt: Date.now() - 10_000
  });

  const ctx = await getMessagesContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: targetSession.id
  });

  assert.ok(ctx.system.includes("Language requirement: use English consistently for this run."));
  assert.equal(ctx.system.includes("语言要求：本轮对话请统一使用简体中文。"), false);
});
test("agent context-items 支持 afterId 增量查询", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "first",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const full = await getContextItems(fixture.app, session.id);
  const lastId = full.items.at(-1)?.id ?? 0;

  await sendMessage(fixture.app, {
    sessionId: session.id,
    workspaceId: fixture.workspaceId,
    text: "second",
    clientRequestId: newSortableId("req")
  });
  await waitRunIdle(fixture.app, session.id);

  const delta = await getContextItems(fixture.app, session.id, lastId);
  assert.ok(delta.items.length > 0);
  assert.ok(
    delta.items.every((item) => item.id > lastId),
    `unexpected delta items; lastId=${String(lastId)} ids=${delta.items.map((i) => i.id).join(",")}`
  );
});
test("agent context-items 支持 assistant reasoning 字段的创建与读取", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "hello"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_1",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "结论正文",
      reasoning: {
        text: "先分析上下文,再给结论"
      }
    }
  });

  const full = await getContextItems(fixture.app, session.id);
  const assistant = full.items.find((item) => item.id === assistantItem.item.id);
  assert.ok(assistant);
  assert.equal(assistant?.kind, "assistant");
  assert.equal(assistant?.output.type, "assistant_text");
  assert.equal(assistant?.output.text, "结论正文");
  assert.deepEqual((assistant?.output as any).reasoning, { text: "先分析上下文,再给结论" });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.deepEqual((single.output as any).reasoning, { text: "先分析上下文,再给结论" });
});
test("agent context-items 支持 assistant reasoning 字段的更新", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_update",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "初始正文"
    }
  });

  await updateContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    itemId: assistantItem.item.id,
    status: "completed",
    output: {
      type: "assistant_text",
      text: "最终正文",
      reasoning: { text: "补充后的思考内容" }
    }
  });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.equal(single.output.text, "最终正文");
  assert.deepEqual((single.output as any).reasoning, { text: "补充后的思考内容" });
  assert.equal((single.output as any).error, undefined);
});
test("assistant reasoning 不应进入 prompt-context", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 0,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "继续" }
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_reasoning_prompt",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "正式回答", reasoning: { text: "隐藏思考" } }
  });

  const prompt = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(JSON.stringify(prompt.messages).includes("正式回答"));
  assert.equal(JSON.stringify(prompt.messages).includes("隐藏思考"), false);
});
test("assistant reasoning 不应进入 archive line", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "用户消息" }
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_reasoning_archive",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "正式回答", reasoning: { text: "不应归档的思考" } }
  });

  const clearRes = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/clear`, payload: { workspaceId: fixture.workspaceId, reason: "切换新任务" } });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);

  const archiveFilePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  const archiveText = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveText.includes("正式回答"));
  assert.equal(archiveText.includes("不应归档的思考"), false);
});
test("assistant failed item 会通过 output.error 返回错误且正文不混入 [run]", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_failed_assistant",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "failed",
    output: {
      type: "assistant_text",
      text: "半截回答",
      error: "model idle timeout after 30000ms"
    }
  });

  const single = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(single.output.type, "assistant_text");
  assert.equal(single.output.text, "半截回答");
  assert.equal((single.output as any).error, "model idle timeout after 30000ms");
  assert.equal(single.output.text.includes("[run]"), false);
});
test("prompt-context 仅注入最近一次且无 tool item 的 failed assistant", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 0,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt
  });

  const userItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "继续" }
  });
  const failedAssistant = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_failed_prompt",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "failed",
    output: { type: "assistant_text", text: "半截输出", error: "provider error" }
  });

  const prompt = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: session.id, runId });
  assert.ok(prompt.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("半截输出")));
  assert.equal(prompt.messages.some((m) => JSON.stringify(m.content).includes("provider error")), false);
  assert.equal(prompt.messages.some((m) => JSON.stringify(m.content).includes("[run]")), false);
  assert.ok(failedAssistant.item.id > 0);
});
test("非 system item 写入 boundaryReason 会被忽略", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const appended = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    boundaryReason: "should-not-be-stored",
    output: {
      type: "user_text",
      text: "hello"
    },
    createdAt: Date.now()
  });

  assert.equal(appended.boundaryReason, null);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items[0]?.kind, "user");
  assert.equal(context.items[0]?.boundaryReason, null);
});
