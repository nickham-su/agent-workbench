import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { agentArchiveSessionDir } from "../../../infra/fs/paths.js";
import { createAgentSession, createRunRecord, getAgentSession } from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import {
  createContextItemInternal,
  createP3Fixture,
  createSession,
  updateRunStateInternal
} from "./context-writeback.helpers.js";

function createSubtaskSessionForTest(fixture: AgentIntegrationFixture, params?: { title?: string; forkedFromSessionId?: string | null; forkedFromItemId?: number | null }) {
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

async function getContextItems(app: import("fastify").FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items` });
  assert.equal(res.statusCode, 200, `get context-items failed: ${res.body}`);
  return res.json() as { headItemId: number | null; items: Array<{ id: number; kind: string; status: string; output: Record<string, unknown>; archiveAt: number | null; boundaryReason: string | null }> };
}

async function getRunState(app: import("fastify").FastifyInstance, sessionId: string) {
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

async function getPromptContextInternal(params: { app: import("fastify").FastifyInstance; internalToken: string; workspaceId: string; sessionId: string; runId: string }) {
  const res = await params.app.inject({
    method: "POST", url: "/api/internal/agent/prompt-context",
    headers: { "x-awb-agent-internal-token": params.internalToken },
    payload: { workspaceId: params.workspaceId, sessionId: params.sessionId, runId: params.runId }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as { system: string; tools: Array<{ name: string }>; uiLocale: "zh-CN" | "en-US" | null; messages: Array<{ role: string; content: unknown }> };
}

test("agent compact 在 worker 不可用时仍接受 uiLocale 参数", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const res = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${session.id}/compact`, payload: { workspaceId: fixture.workspaceId, clientRequestId: "req_compact_locale", uiLocale: "zh-CN" } });
  assert.equal(res.statusCode, 503, `compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});
test("agent compact 在 worker 不可用时返回 503", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: newSortableId("req")
    }
  });
  assert.equal(res.statusCode, 503, `compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});
test("internal compact 需要 internal token", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/internal/agent/sessions/${session.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "req_internal_compact_unauthorized"
    }
  });
  assert.equal(res.statusCode, 401, `internal compact should require token: ${res.body}`);
});
test("internal compact 在 worker 不可用时返回 503", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);

  const res = await fixture.app.inject({
    method: "POST",
    url: `/api/internal/agent/sessions/${session.id}/compact`,
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "req_internal_compact_worker_unavailable",
      uiLocale: "zh-CN"
    }
  });
  assert.equal(res.statusCode, 503, `internal compact should fail when worker disabled: ${res.body}`);
  assert.equal(res.json().code, "AGENT_WORKER_UNAVAILABLE");
});
test("agent clear 会归档当前可见上下文并插入 clear 边界 marker", async (t: TestContext) => {
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
      text: "旧任务: 先完成接口改造"
    }
  });
  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "旧任务答复: 可以先做字段迁移。"
    }
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId,
      reason: "切换新任务",
      uiLocale: "zh-CN"
    }
  });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);
  const clearBody = clearRes.json() as { ok: boolean; session: { id: string; headItemId: number | null } };
  assert.equal(clearBody.session.id, session.id);
  assert.ok((clearBody.session.headItemId ?? 0) > assistantItem.item.id);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.items.length, 3);
  assert.equal(context.items[0]?.archiveAt == null, false);
  assert.equal(context.items[1]?.archiveAt == null, false);
  assert.equal(context.items[2]?.kind, "system");
  assert.equal(context.items[2]?.boundaryReason, "clear");
  assert.equal(context.items[2]?.archiveAt, null);
  assert.ok(String(context.items[2]?.output?.text || "").includes("archive_search"));

  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: clearBody.session.headItemId || context.items[2]!.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId
  });
  const oldUserLeak = promptContext.messages.find((item) => String(item.content || "").includes("旧任务: 先完成接口改造"));
  assert.equal(oldUserLeak, undefined);
  const clearSummary = promptContext.messages.find((item) => item.role === "system" && String(item.content || "").includes("已开始新任务"));
  assert.ok(clearSummary);

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  assert.ok(archiveContent.includes("旧任务: 先完成接口改造"));
  assert.ok(archiveContent.includes("旧任务答复: 可以先做字段迁移。"));

  const clearAgainRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearAgainRes.statusCode, 400, `clear should be no-op when only marker visible: ${clearAgainRes.body}`);
  assert.equal(clearAgainRes.json().code, "AGENT_CLEAR_NOT_NEEDED");
});
test("agent clear 在 en-US locale 下生成英文摘要，且缺省 locale 回退英文", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  await createContextItemInternal({ fixture,
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
    output: { type: "user_text", text: "old task" }
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId,
      reason: "switch task",
      uiLocale: "en-US"
    }
  });
  assert.equal(clearRes.statusCode, 200, `clear session failed: ${clearRes.body}`);

  const context = await getContextItems(fixture.app, session.id);
  assert.ok(String(context.items.at(-1)?.output?.text || "").includes("A new task has started (switch task)."));

  const session2 = await createSession(fixture.app, fixture.workspaceId);
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session2.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "another old task" }
  });
  const clearRes2 = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session2.id}/clear`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(clearRes2.statusCode, 200, `clear session without locale failed: ${clearRes2.body}`);
  const context2 = await getContextItems(fixture.app, session2.id);
  assert.ok(String(context2.items.at(-1)?.output?.text || "").includes("A new task has started."));
});
test("subtask 会话的 send、compact、clear 保持只读且不修改状态", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const subtaskSession = createSubtaskSessionForTest(fixture);
  const beforeState = await getRunState(fixture.app, subtaskSession.id);
  const beforeHead = (await getContextItems(fixture.app, subtaskSession.id)).headItemId;

  const sendRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/messages`,
    payload: {
      workspaceId: fixture.workspaceId,
      text: "must remain read-only",
      clientRequestId: "subtask-readonly-send"
    }
  });
  assert.equal(sendRes.statusCode, 400, `send subtask should fail: ${sendRes.body}`);
  assert.equal(sendRes.json().code, "AGENT_SUBTASK_READONLY");

  const compactRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/compact`,
    payload: {
      workspaceId: fixture.workspaceId,
      clientRequestId: "subtask-readonly-compact"
    }
  });
  assert.equal(compactRes.statusCode, 400, `compact subtask should fail: ${compactRes.body}`);
  assert.equal(compactRes.json().code, "AGENT_SUBTASK_READONLY");

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${subtaskSession.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 400, `clear subtask should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_SUBTASK_READONLY");
  assert.equal((await getContextItems(fixture.app, subtaskSession.id)).headItemId, beforeHead);
  assert.deepEqual(await getRunState(fixture.app, subtaskSession.id), beforeState);
  const runCount = fixture.db.prepare("select count(*) as count from agent_run where session_id = ?").get(subtaskSession.id) as { count: number };
  assert.equal(runCount.count, 0);
});
test("delete workspace 会清理 dataDir 下的 agent 归档目录", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const archiveSessionPath = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, "sess_cleanup");
  const archiveWorkspacePath = path.dirname(archiveSessionPath);
  await fs.mkdir(archiveSessionPath, { recursive: true });
  await fs.writeFile(path.join(archiveSessionPath, "00000001.log"), "line\n", "utf-8");

  const deleteRes = await fixture.app.inject({
    method: "DELETE",
    url: `/api/workspaces/${fixture.workspaceId}`
  });
  assert.equal(deleteRes.statusCode, 204, `delete workspace failed: ${deleteRes.body}`);

  const archiveWorkspaceExists = await fs
    .stat(archiveWorkspacePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(archiveWorkspaceExists, false, "workspace archive directory should be removed");
});
test("agent clear 在空会话返回 AGENT_CLEAR_EMPTY", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 400, `clear empty session should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_CLEAR_EMPTY");
});
test("agent clear 在会话运行中返回 AGENT_CLEAR_NOT_IDLE", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);
  await createContextItemInternal({ fixture,
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
      text: "测试 clear 运行中校验"
    }
  });

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: newSortableId("run"),
    activeAssistantItemId: null,
  });

  const clearRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(clearRes.statusCode, 409, `clear running session should fail: ${clearRes.body}`);
  assert.equal(clearRes.json().code, "AGENT_CLEAR_NOT_IDLE");
});
test("agent revert 在会话运行中返回 AGENT_REVERT_NOT_IDLE", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: Date.now()
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
    output: {
      type: "user_text",
      text: "测试运行中禁止回退"
    }
  });
  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_revert_running",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "working..."
    }
  });

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id,
  });

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertRes.statusCode, 409, `revert running session should fail: ${revertRes.body}`);
  assert.equal(revertRes.json().code, "AGENT_REVERT_NOT_IDLE");

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, assistantItem.item.id);
  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "running");
  assert.equal(runState.activeRunId, runId);
});
test("agent revert 在 idle 且存在非终态残留 item 时返回 AGENT_REVERT_HAS_NON_TERMINAL_ITEMS", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
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
      text: "测试 idle 下非终态残留禁止回退"
    }
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_revert_dirty",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "残留中的输出"
    }
  });

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: userItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertRes.statusCode, 409, `revert dirty idle session should fail: ${revertRes.body}`);
  assert.equal(revertRes.json().code, "AGENT_REVERT_HAS_NON_TERMINAL_ITEMS");
});
test("agent revert 在 idle 时可回退到可见 item 并隐藏后续分支", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
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
      text: "问题A"
    }
  });
  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: "turn_revert_success",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: "答复A"
    }
  });
  const trailingUser = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: assistantItem.item.id,
    kind: "user",
    status: "completed",
    output: {
      type: "user_text",
      text: "问题B"
    }
  });

  const revertRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/revert`,
    payload: {
      workspaceId: fixture.workspaceId,
      itemId: assistantItem.item.id,
      reason: "manual_revert"
    }
  });
  assert.equal(revertRes.statusCode, 200, `revert visible item should succeed: ${revertRes.body}`);
  const revertBody = revertRes.json() as { ok: boolean; session: { id: string; headItemId: number | null } };
  assert.equal(revertBody.session.id, session.id);
  assert.equal(revertBody.session.headItemId, assistantItem.item.id);

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, assistantItem.item.id);
  assert.deepEqual(context.items.map((item) => item.id), [userItem.item.id, assistantItem.item.id]);
  assert.equal(context.items.some((item) => item.id === trailingUser.item.id), false);
});
test("agent clear 并发请求会串行执行且不会重复归档", async (t: TestContext) => {
  const fixture = await createP3Fixture(t);
  const session = await createSession(fixture.app, fixture.workspaceId);

  const userText = "并发清空测试-用户消息";
  const assistantText = "并发清空测试-助手消息";
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
      text: userText
    }
  });
  await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "completed",
    output: {
      type: "assistant_text",
      text: assistantText
    }
  });

  const [r1, r2] = await Promise.all([
    fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/clear`,
      payload: { workspaceId: fixture.workspaceId }
    }),
    fixture.app.inject({
      method: "POST",
      url: `/api/agent/sessions/${session.id}/clear`,
      payload: { workspaceId: fixture.workspaceId }
    })
  ]);

  const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 400]);
  const failed = r1.statusCode === 400 ? r1 : r2;
  assert.equal(failed.json().code, "AGENT_CLEAR_NOT_NEEDED");

  const archiveFilePath = path.join(
    agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id),
    "00000001.log"
  );
  const archiveContent = await fs.readFile(archiveFilePath, "utf-8");
  const userHits = archiveContent.split(userText).length - 1;
  const assistantHits = archiveContent.split(assistantText).length - 1;
  assert.equal(userHits, 1);
  assert.equal(assistantHits, 1);
});
