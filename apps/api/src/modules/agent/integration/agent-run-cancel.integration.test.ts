import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  appendContextItem,
  createAgentSession,
  createRunRecord,
  getContextItemById,
  getRunRecord,
  moveSessionHead,
  updateRunState
} from "../agent.store.js";
import { newSortableId } from "../../../utils/ids.js";
import { AgentRuntime } from "../agent.runtime.js";
import {
  createContextItemInternal,
  createP3Fixture,
  createSession,
  updateRunStateInternal
} from "./context-writeback.helpers.js";

async function getContextItems(app: import("fastify").FastifyInstance, sessionId: string) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items` });
  assert.equal(res.statusCode, 200, `get context-items failed: ${res.body}`);
  return res.json() as { headItemId: number | null; items: Array<{ id: number; kind: string; status: string; output: Record<string, unknown> }> };
}

async function getContextItem(app: import("fastify").FastifyInstance, sessionId: string, itemId: number) {
  const res = await app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/context-items/${itemId}` });
  assert.equal(res.statusCode, 200, `get context-item failed: ${res.body}`);
  return res.json() as { id: number; status: string; output: Record<string, unknown> };
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

test("agent cancel 仅终止执行并保留消息,活跃项标记为 cancelled", async (t: TestContext) => {
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
      text: "start"
    }
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel",
    step: 1,
    prevId: userItem.item.id,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "working..."
    }
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "bash",
      args: {
        command: "sleep 10"
      }
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

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel run failed: ${cancelRes.body}`);
  const cancelBody = cancelRes.json() as { ok: boolean; session: { id: string; headItemId: number | null } };
  assert.equal(cancelBody.session.id, session.id);
  assert.equal(cancelBody.session.headItemId, toolItem.item.id);

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);
  assert.equal(runState.lastTerminalStatus, "cancelled");

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, toolItem.item.id);
  assert.equal(context.items.length, 3);
  const latestAssistant = context.items.find((item) => item.id === assistantItem.item.id);
  const latestTool = context.items.find((item) => item.id === toolItem.item.id);
  assert.equal(latestAssistant?.status, "cancelled");
  assert.equal(latestTool?.status, "cancelled");
});
test("agent cancel 会将 subtask 工具项明确改写为 cancelled 并保留 subtask_session_id + existing 提示", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const subtaskSessionId = "sess_subtask_cancelled_1";

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

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel_subtask",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "starting subtask..."
    }
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_cancel_subtask",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_cancel_subtask_1",
      args: {
        description: "研究问题",
        prompt: "请直接完成这个子任务",
        agentId: "default",
        session: { mode: "fork" }
      },
      text: `tool: subtask\nstatus: running\nsubtask_session_id: ${subtaskSessionId}\n\nSubtask started.`,
      result: {
        subtaskSessionId
      }
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

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: {
      workspaceId: fixture.workspaceId
    }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel subtask run failed: ${cancelRes.body}`);

  const cancelledItem = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(cancelledItem.status, "cancelled");
  assert.equal(cancelledItem.output.type, "tool");

  const text = String((cancelledItem.output as { text?: string }).text || "");
  assert.equal(text.includes("tool: subtask"), true);
  assert.equal(text.includes("status: cancelled"), true);
  assert.equal(text.includes(`subtask_session_id: ${subtaskSessionId}`), true);
  assert.equal(text.includes('mode: "existing"'), true);
  assert.equal(text.includes(`sessionId: "${subtaskSessionId}"`), true);
});
test("run-complete(cancelled) 会收敛该 run 下的非终态 context items", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const createdAt = Date.now();

  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt
  });

  const assistantItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_run_complete_cancelled",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: {
      type: "assistant_text",
      text: "partial streaming..."
    }
  });

  const toolItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn_run_complete_cancelled",
    step: 1,
    prevId: assistantItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_run_complete_cancelled_subtask",
      args: { description: "研究问题", prompt: "...", agentId: "default", session: { mode: "new" } },
      text: "tool: subtask\nstatus: running\nsubtask_session_id: sess_sub_x\n\nSubtask started.",
      result: { subtaskSessionId: "sess_sub_x" }
    }
  });

  // Mark run-state as running, so completeRunFromWorker should settle it to idle.
  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: assistantItem.item.id
  });

  const completeRes = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/run-complete",
    headers: {
      "x-awb-agent-internal-token": fixture.internalToken
    },
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      status: "cancelled",
      updatedAt: createdAt + 123
    }
  });
  assert.equal(completeRes.statusCode, 200, `run-complete cancelled failed: ${completeRes.body}`);

  const runRecord = getRunRecord(fixture.db, runId);
  assert.equal(runRecord?.status, "cancelled");

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);

  const assistantAfter = await getContextItem(fixture.app, session.id, assistantItem.item.id);
  assert.equal(assistantAfter.status, "cancelled");

  const toolAfter = await getContextItem(fixture.app, session.id, toolItem.item.id);
  assert.equal(toolAfter.status, "cancelled");
  assert.equal(toolAfter.output.type, "tool");
  const toolText = String((toolAfter.output as { text?: string }).text || "");
  assert.equal(toolText.includes("tool: subtask"), true);
  assert.equal(toolText.includes("status: cancelled"), true);
});
test("agent cancel 会收敛隐藏链上的未终态 items 与关联 run", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();

  const baseRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: baseRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt
  });

  const user1 = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: baseRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "第一问" }
  });
  const assistant1 = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: baseRunId,
    turnId: "turn_cancel_hidden_1",
    step: 1,
    prevId: user1.item.id,
    kind: "assistant",
    status: "completed",
    output: { type: "assistant_text", text: "第一答" }
  });
  const user2 = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: baseRunId,
    turnId: null,
    step: null,
    prevId: assistant1.item.id,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "第二问" }
  });

  const hiddenRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: hiddenRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: user2.item.id,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: createdAt + 1
  });

  const hiddenAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: hiddenRunId,
    turnId: "turn_cancel_hidden_2",
    step: 1,
    prevId: user2.item.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "hidden working" },
    createdAt: createdAt + 2
  });
  const hiddenTool = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: hiddenRunId,
    turnId: "turn_cancel_hidden_2",
    step: 1,
    prevId: hiddenAssistant.id,
    kind: "tool",
    status: "running",
    output: { type: "tool", toolName: "bash", args: { command: "sleep 10" } } as any,
    createdAt: createdAt + 3
  });
  moveSessionHead(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    expectedHeadItemId: hiddenTool.id,
    nextHeadItemId: user2.item.id,
    updatedAt: createdAt + 4
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel hidden run failed: ${cancelRes.body}`);

  const runState = await getRunState(fixture.app, session.id);
  assert.equal(runState.status, "idle");
  assert.equal(runState.activeRunId, null);
  assert.equal(runState.lastTerminalStatus, "cancelled");

  const hiddenAssistantAfter = getContextItemById(fixture.db, hiddenAssistant.id);
  const hiddenToolAfter = getContextItemById(fixture.db, hiddenTool.id);
  assert.equal(hiddenAssistantAfter?.status, "cancelled");
  assert.equal(hiddenToolAfter?.status, "cancelled");

  const hiddenRunAfter = getRunRecord(fixture.db, hiddenRunId);
  assert.equal(hiddenRunAfter?.status, "cancelled");

  const context = await getContextItems(fixture.app, session.id);
  assert.equal(context.headItemId, user2.item.id);
  assert.equal(context.items.map((item) => item.id).includes(hiddenAssistant.id), false);
  assert.equal(context.items.map((item) => item.id).includes(hiddenTool.id), false);
});
test("agent cancel 不应把仅因脏 non-terminal item 命中的 terminal run 改写为 cancelled", async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const session = await createSession(fixture.app, fixture.workspaceId);
  const createdAt = Date.now();

  const terminalRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: terminalRunId,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    triggerItemId: 1,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "completed",
    createdAt
  });

  const user = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: terminalRunId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "可见消息" }
  });

  const dirtyAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: terminalRunId,
    turnId: "turn_cancel_terminal_run_dirty",
    step: 1,
    prevId: user.item.id,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "dirty hidden assistant" },
    createdAt: createdAt + 1
  });
  moveSessionHead(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    expectedHeadItemId: dirtyAssistant.id,
    nextHeadItemId: user.item.id,
    updatedAt: createdAt + 2
  });

  const cancelRes = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/cancel`,
    payload: { workspaceId: fixture.workspaceId }
  });
  assert.equal(cancelRes.statusCode, 200, `cancel terminal run dirty item failed: ${cancelRes.body}`);

  const dirtyAssistantAfter = getContextItemById(fixture.db, dirtyAssistant.id);
  assert.equal(dirtyAssistantAfter?.status, "cancelled");

  const terminalRunAfter = getRunRecord(fixture.db, terminalRunId);
  assert.equal(terminalRunAfter?.status, "completed");
});
test("agent cancel 会基于当前 active run 的 subtask 结果精确级联取消活动 child，且不误取消历史 fork child", { concurrency: false }, async (t: TestContext) => {
  const fixture = await createP3Fixture(t, { agentWorkerConcurrency: 0 });
  const now = Date.now();

  const parent = await createSession(fixture.app, fixture.workspaceId);
  const parentRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: parentRunId,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now
  });

  const parentAssistant = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    runId: parentRunId,
    turnId: "turn_parent_cancel_cascade",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "starting child" }
  });

  const staleForkChildId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: staleForkChildId,
    workspaceId: fixture.workspaceId,
    title: "stale-child",
    kind: "subtask",
    createdAt: now + 1,
    forkedFromSessionId: parent.id,
    forkedFromItemId: parentAssistant.item.id
  });
  const staleForkRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: staleForkRunId,
    workspaceId: fixture.workspaceId,
    sessionId: staleForkChildId,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now + 1
  });
  const staleForkAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: staleForkChildId,
    runId: staleForkRunId,
    turnId: "turn_stale_child",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "stale child still running" },
    createdAt: now + 1
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: staleForkChildId,
    status: "running",
    activeRunId: staleForkRunId,
    activeAssistantItemId: staleForkAssistant.id,
    runNoticeText: "",
    updatedAt: now + 1,
    appliedItemId: staleForkAssistant.id
  });

  const activeChildId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: activeChildId,
    workspaceId: fixture.workspaceId,
    title: "active-existing-child",
    kind: "subtask",
    createdAt: now + 2,
    forkedFromSessionId: newSortableId("sess"),
    forkedFromItemId: null
  });
  const activeChildRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: activeChildRunId,
    workspaceId: fixture.workspaceId,
    sessionId: activeChildId,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now + 2
  });
  const activeChildAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: activeChildId,
    runId: activeChildRunId,
    turnId: "turn_active_child",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "active child running" },
    createdAt: now + 2
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: activeChildId,
    status: "running",
    activeRunId: activeChildRunId,
    activeAssistantItemId: activeChildAssistant.id,
    runNoticeText: "",
    updatedAt: now + 2,
    appliedItemId: activeChildAssistant.id
  });

  const reusedCompletedChildId = newSortableId("sess");
  createAgentSession(fixture.db, {
    id: reusedCompletedChildId,
    workspaceId: fixture.workspaceId,
    title: "reused-completed-child",
    kind: "subtask",
    createdAt: now + 3,
    forkedFromSessionId: newSortableId("sess"),
    forkedFromItemId: null
  });
  const reusedCompletedChildRunId = newSortableId("run");
  createRunRecord(fixture.db, {
    runId: reusedCompletedChildRunId,
    workspaceId: fixture.workspaceId,
    sessionId: reusedCompletedChildId,
    triggerItemId: 1,
    agentId: "agent-default",
    providerId: "openai",
    modelId: "gpt-4.1",
    status: "running",
    createdAt: now + 3
  });
  const reusedCompletedChildAssistant = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: reusedCompletedChildId,
    runId: reusedCompletedChildRunId,
    turnId: "turn_reused_completed_child",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "reused child still running elsewhere" },
    createdAt: now + 3
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: reusedCompletedChildId,
    status: "running",
    activeRunId: reusedCompletedChildRunId,
    activeAssistantItemId: reusedCompletedChildAssistant.id,
    runNoticeText: "",
    updatedAt: now + 3,
    appliedItemId: reusedCompletedChildAssistant.id
  });

  const completedSubtaskItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    runId: parentRunId,
    turnId: "turn_parent_cancel_cascade_completed",
    step: 0,
    prevId: parentAssistant.item.id,
    kind: "tool",
    status: "completed",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_parent_cancel_cascade_completed",
      args: { description: "old child", prompt: "finished", session: { mode: "existing", sessionId: reusedCompletedChildId } },
      text: `tool: subtask\nstatus: completed\nsubtask_session_id: ${reusedCompletedChildId}\n\nCompleted.`,
      result: { subtaskSessionId: reusedCompletedChildId }
    }
  });

  const activeSubtaskItem = await createContextItemInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    runId: parentRunId,
    turnId: "turn_parent_cancel_cascade",
    step: 1,
    prevId: completedSubtaskItem.item.id,
    kind: "tool",
    status: "running",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_parent_cancel_cascade_1",
      args: { description: "reuse child", prompt: "continue child", session: { mode: "existing", sessionId: activeChildId } },
      text: `tool: subtask\nstatus: running\nsubtask_session_id: ${activeChildId}\n\nSubtask started.`,
      result: { subtaskSessionId: activeChildId }
    }
  });
  fixture.db.prepare(
    "update agent_run set parent_run_id = ?, parent_tool_item_id = ? where run_id = ?"
  ).run(parentRunId, activeSubtaskItem.item.id, activeChildRunId);

  await updateRunStateInternal({ fixture,
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: parent.id,
    status: "running",
    activeRunId: parentRunId,
    activeAssistantItemId: parentAssistant.item.id
  });

  // 窄测试观察 seam：本地 AgentRuntime 没有可替换的 runtime 注入点，
  // 仅在这个不可并发测试内观察 cancelSession，并在 finally 中恢复原型。
  const runtimeCancelSessionIds: string[] = [];
  const originalCancelSession = AgentRuntime.prototype.cancelSession;
  AgentRuntime.prototype.cancelSession = function observedCancelSession(sessionId: string) {
    runtimeCancelSessionIds.push(sessionId);
    return originalCancelSession.call(this, sessionId);
  };

  const cancelRes = await (async () => {
    try {
      return await fixture.app.inject({
        method: "POST",
        url: `/api/agent/sessions/${parent.id}/cancel`,
        payload: { workspaceId: fixture.workspaceId }
      });
    } finally {
      AgentRuntime.prototype.cancelSession = originalCancelSession;
    }
  })();
  assert.equal(cancelRes.statusCode, 200, `cancel cascade failed: ${cancelRes.body}`);
  assert.deepEqual(runtimeCancelSessionIds, [parent.id, activeChildId]);
  assert.equal(runtimeCancelSessionIds.filter((sessionId) => sessionId === parent.id).length, 1);
  assert.equal(runtimeCancelSessionIds.filter((sessionId) => sessionId === activeChildId).length, 1);
  assert.equal(runtimeCancelSessionIds.includes(staleForkChildId), false);
  assert.equal(runtimeCancelSessionIds.includes(reusedCompletedChildId), false);

  const parentState = await getRunState(fixture.app, parent.id);
  assert.equal(parentState.status, "idle");
  assert.equal(parentState.lastTerminalStatus, "cancelled");

  const activeChildState = await getRunState(fixture.app, activeChildId);
  assert.equal(activeChildState.status, "idle");
  assert.equal(activeChildState.lastTerminalStatus, "cancelled");

  const activeChildRun = getRunRecord(fixture.db, activeChildRunId);
  assert.equal(activeChildRun?.status, "cancelled");
  const activeChildAssistantAfter = getContextItemById(fixture.db, activeChildAssistant.id);
  assert.equal(activeChildAssistantAfter?.status, "cancelled");

  const staleForkState = await getRunState(fixture.app, staleForkChildId);
  assert.equal(staleForkState.status, "running");
  assert.equal(staleForkState.activeRunId, staleForkRunId);
  const staleForkRun = getRunRecord(fixture.db, staleForkRunId);
  assert.equal(staleForkRun?.status, "running");
  const staleForkAssistantAfter = getContextItemById(fixture.db, staleForkAssistant.id);
  assert.equal(staleForkAssistantAfter?.status, "streaming");

  const reusedCompletedChildState = await getRunState(fixture.app, reusedCompletedChildId);
  assert.equal(reusedCompletedChildState.status, "running");
  assert.equal(reusedCompletedChildState.activeRunId, reusedCompletedChildRunId);
  const reusedCompletedChildRun = getRunRecord(fixture.db, reusedCompletedChildRunId);
  assert.equal(reusedCompletedChildRun?.status, "running");
  const reusedCompletedChildAssistantAfter = getContextItemById(fixture.db, reusedCompletedChildAssistant.id);
  assert.equal(reusedCompletedChildAssistantAfter?.status, "streaming");
});
