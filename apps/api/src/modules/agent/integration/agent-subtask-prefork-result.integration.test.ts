import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { test, type TestContext } from "node:test";
import { setSettingJson } from "../../settings/settings.store.js";
import { getRunRecord } from "../agent-message.store.js";
import {
  appendMessage,
  getMessageSession,
  getMessageSessionHead,
  getToolExecution,
  getVisibleMessageChain,
  updateToolExecution
} from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";
import {
  createMessageRunForTest,
  createMessageToolAnchor,
  createP2Fixture,
  createSession,
  createSubtaskSessionForTest,
  startToolExecutionForTest,
  startSubtaskForAnchor
} from "./subtask.helpers.js";

type Fixture = Awaited<ReturnType<typeof createP2Fixture>>;
type ParentAnchor = {
  sessionId: string;
  runId: string;
  toolExecutionId: string;
  assistantMessageId: string;
};

async function getPromptContextInternal(params: {
  app: FastifyInstance;
  internalToken: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}) {
  const res = await params.app.inject({
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    headers: { "x-awb-agent-internal-token": params.internalToken },
    payload: {
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      runId: params.runId
    }
  });
  assert.equal(res.statusCode, 200, `get prompt-context failed: ${res.body}`);
  return res.json() as {
    system: string;
    tools: Array<{ name: string }>;
    uiLocale: "zh-CN" | "en-US" | null;
    messages: Array<{ role: string; content: unknown }>;
    pendingTools: Array<{
      toolExecutionId: string;
      callPartId: string;
      assistantMessageId: string;
      status: string;
      toolName: string;
    }>;
  };
}

async function configureAgentDefaults(app: FastifyInstance, contextWindowTokens = 128_000) {
  const providersRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{
        id: "ppchat",
        name: "ppchat",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
        models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens }]
      }]
    }
  });
  assert.equal(providersRes.statusCode, 200, `configure providers failed: ${providersRes.body}`);
  const agentsRes = await app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "You are a helpful coding assistant.",
        tools: ["bash", "read", "write", "subtask"],
        mcpServers: [],
        defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agentsRes.statusCode, 200, `configure agents failed: ${agentsRes.body}`);
}

async function createParentAnchor(fixture: Fixture, options?: {
  text?: string;
  sessionMode?: "new" | "existing" | "fork";
  subtaskDepth?: number | null;
  completeAnchor?: boolean;
}) : Promise<ParentAnchor> {
  const parent = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunForTest({
    fixture,
    sessionId: parent.id,
    subtaskDepth: options?.subtaskDepth ?? 0,
    text: options?.text ?? "parent history"
  });
  const tool = createMessageToolAnchor({
    fixture,
    sessionId: parent.id,
    runId: run.runId,
    toolName: "subtask",
    input: {
      description: "研究问题",
      prompt: "请直接完成这个子任务",
      agentId: "default",
      session: { mode: options?.sessionMode ?? "fork" }
    }
  });
  if (options?.completeAnchor !== false) {
    startToolExecutionForTest({ fixture, sessionId: parent.id, runId: run.runId, toolExecutionId: tool.toolExecutionId });
  }
  return {
    sessionId: parent.id,
    runId: run.runId,
    toolExecutionId: tool.toolExecutionId,
    assistantMessageId: tool.assistantMessageId
  };
}

function appendTextMessage(params: {
  fixture: Fixture;
  sessionId: string;
  runId: string | null;
  type: "assistant" | "system";
  status?: "completed" | "failed" | "cancelled";
  text: string;
}) {
  const head = getMessageSessionHead(params.fixture.db, {
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId
  });
  assert.ok(head, "test session must exist");
  const id = newSortableId("msg");
  appendMessage(params.fixture.db, {
    id,
    workspaceId: params.fixture.workspaceId,
    sessionId: params.sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: params.type,
    status: params.status ?? "completed",
    originRunId: params.runId,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: params.text }],
    createdAt: Date.now()
  });
  return id;
}

async function getSubtaskResult(fixture: Fixture, sessionId: string, runId: string) {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/result",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId, runId }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { resultText: string };
}

test("agent subtask fork 在复制历史与子任务 prompt 之间插入 system 提示", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createParentAnchor(fixture, { text: "请调用 subtask 把任务交给另一个 agent。" });
  appendTextMessage({ fixture, sessionId: anchor.sessionId, runId: anchor.runId, type: "assistant", text: "我会调用工具处理这个任务。" });

  const response = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.sessionId,
    parentRunId: anchor.runId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "研究问题",
    prompt: "请直接完成这个子任务",
    session: { mode: "fork" }
  });
  assert.equal(response.statusCode, 200, response.body);
  const started = response.json() as { sessionId: string; runId: string; agentName: string };
  assert.equal(started.agentName, "default");

  const messages = getVisibleMessageChain(fixture.db, { workspaceId: fixture.workspaceId, sessionId: started.sessionId });
  assert.equal(messages.some((message) => message.type === "assistant" && message.id === anchor.assistantMessageId), false);
  assert.equal(messages[0]?.type, "user");
  assert.equal(messages[0]?.parts[0]?.type, "text");
  assert.equal(messages[0]?.parts[0]?.text, "请调用 subtask 把任务交给另一个 agent。");
  const guardIndex = messages.findIndex((message) => message.type === "system" && message.parts.some((part) => part.type === "text" && part.text.includes("All historical content before this system message")));
  const promptIndex = messages.findIndex((message) => message.type === "user" && message.parts.some((part) => part.type === "text" && part.text === "请直接完成这个子任务"));
  assert.ok(guardIndex >= 0);
  assert.equal(promptIndex, guardIndex + 1);

  const promptContext = await getPromptContextInternal({
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: started.sessionId,
    runId: started.runId
  });
  assert.equal(promptContext.uiLocale, null);
  assert.equal(promptContext.messages.some((message) => message.role === "system" && typeof message.content === "string" && message.content.includes("All historical content before this system message")), true);
  assert.equal(promptContext.tools.some((tool) => tool.name === "subtask"), false);
});

test("subtask start with preforkSummaryText should inject summary->guard->prompt without copying parent history", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createParentAnchor(fixture, { text: "this is parent history that must not be copied" });

  const response = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.sessionId,
    parentRunId: anchor.runId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "prefork",
    prompt: "please do prefork task",
    session: { mode: "fork" },
    preforkSummaryText: "prefork summary",
  });
  assert.equal(response.statusCode, 200, response.body);
  const started = response.json() as { sessionId: string; runId: string };
  const messages = getVisibleMessageChain(fixture.db, { workspaceId: fixture.workspaceId, sessionId: started.sessionId });
  assert.deepEqual(messages.map((message) => message.type), ["system", "system", "user"]);
  assert.equal(messages[0]?.parts[0]?.type, "text");
  assert.equal(messages[0]?.parts[0]?.text, "prefork summary");
  assert.equal(messages[1]?.parts[0]?.type, "text");
  assert.ok(messages[1]?.parts[0]?.type === "text" && messages[1].parts[0].text.includes("All historical content before this system message"));
  assert.equal(messages[2]?.parts[0]?.type, "text");
  assert.equal(messages[2]?.parts[0]?.text, "please do prefork task");
  assert.equal(messages.some((message) => message.parts.some((part) => part.type === "text" && part.text.includes("this is parent history"))), false);
});

test("subtask start should reject preforkSummaryText when mode=new/existing", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const anchor = await createParentAnchor(fixture);
  const existing = createSubtaskSessionForTest(fixture, { title: "existing" });
  for (const session of [{ mode: "new" as const }, { mode: "existing" as const, sessionId: existing.id }]) {
    const response = await startSubtaskForAnchor({
      fixture,
      parentSessionId: anchor.sessionId,
      parentRunId: anchor.runId,
      parentToolExecutionId: anchor.toolExecutionId,
      description: "prefork",
      prompt: "please do prefork task",
      session,
      preforkSummaryText: "prefork summary"
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal((response.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_NOT_ALLOWED");
  }
});

test("subtask start should reject too long preforkSummaryText", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const anchor = await createParentAnchor(fixture);
  const response = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.sessionId,
    parentRunId: anchor.runId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "prefork",
    prompt: "please do prefork task",
    session: { mode: "fork" },
    preforkSummaryText: "x".repeat(20_001)
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((response.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_SUMMARY_TOO_LONG");
});

test("subtask start should allow description length 50 and silently truncate >50", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const maxDescription = "d".repeat(50);
  const acceptedAnchor = await createParentAnchor(fixture);
  const accepted = await startSubtaskForAnchor({
    fixture,
    parentSessionId: acceptedAnchor.sessionId,
    parentRunId: acceptedAnchor.runId,
    parentToolExecutionId: acceptedAnchor.toolExecutionId,
    description: maxDescription,
    prompt: "please do subtask with max allowed description length",
    session: { mode: "fork" }
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptedSession = getMessageSession(fixture.db, fixture.workspaceId, (accepted.json() as { sessionId: string }).sessionId);
  assert.ok(acceptedSession?.title.startsWith(maxDescription));

  const longAnchor = await createParentAnchor(fixture);
  const longDescription = "x".repeat(70);
  const truncated = await startSubtaskForAnchor({
    fixture,
    parentSessionId: longAnchor.sessionId,
    parentRunId: longAnchor.runId,
    parentToolExecutionId: longAnchor.toolExecutionId,
    description: longDescription,
    prompt: "please do subtask with long description",
    session: { mode: "fork" }
  });
  assert.equal(truncated.statusCode, 200, truncated.body);
  const truncatedSession = getMessageSession(fixture.db, fixture.workspaceId, (truncated.json() as { sessionId: string }).sessionId);
  assert.ok(truncatedSession?.title.startsWith(longDescription.slice(0, 50)));
  assert.equal(truncatedSession?.title.includes(longDescription), false);
});

test("subtask start should reject mismatched preforkMeta", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createParentAnchor(fixture);
  const response = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.sessionId,
    parentRunId: anchor.runId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "prefork",
    prompt: "please do prefork task",
    session: { mode: "fork" },
    preforkSummaryText: "prefork summary",
    preforkMeta: { thresholdPct: 95, parentLastResponseTotalTokens: 199_999, childContextWindowTokens: 128_000 }
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((response.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_META_MISMATCH");
});

test("subtask prefork-plan should use default threshold and return correct shouldPrefork", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createParentAnchor(fixture);
  const request = (thresholdPct?: number) => fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: anchor.sessionId,
      parentRunId: anchor.runId,
      parentToolExecutionId: anchor.toolExecutionId,
      agentId: "default",
      ...(thresholdPct === undefined ? {} : { thresholdPct })
    }
  });
  const before = await request();
  assert.equal(before.statusCode, 200, before.body);
  assert.deepEqual(before.json(), {
    shouldPrefork: false,
    thresholdPct: 95,
    parentLastResponseTotalTokens: null,
    childContextWindowTokens: 128_000,
    thresholdTokens: 121_600
  });
});

test("subtask prefork-plan should reject invalid thresholdPct", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const anchor = await createParentAnchor(fixture);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: anchor.sessionId,
      parentRunId: anchor.runId,
      parentToolExecutionId: anchor.toolExecutionId,
      agentId: "default",
      thresholdPct: 49
    }
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((response.json() as { code?: string }).code, "AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID");
});

test("agent subtask fork 对父 run 非法 locale 做归一化回退，避免继续传播非法值", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  await configureAgentDefaults(fixture.app);
  const anchor = await createParentAnchor(fixture);
  const response = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.sessionId,
    parentRunId: anchor.runId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "研究问题",
    prompt: "请直接完成这个子任务",
    session: { mode: "fork" }
  });
  assert.equal(response.statusCode, 200, response.body);
  const started = response.json() as { sessionId: string; runId: string };
  const promptContext = await getPromptContextInternal({ app: fixture.app, internalToken: fixture.internalToken, workspaceId: fixture.workspaceId, sessionId: started.sessionId, runId: started.runId });
  assert.equal(promptContext.uiLocale, null);
  assert.equal(promptContext.messages.some((message) => message.role === "system" && typeof message.content === "string" && message.content.includes("You are working in a subtask session derived from a main session.")), true);
});

test("subtask 失败时 getSubtaskRunResultFromWorker 仍返回 partial text", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const session = createSubtaskSessionForTest(fixture, { title: "it-subtask-result" });
  const run = createMessageRunForTest({ fixture, sessionId: session.id, status: "failed" });
  appendTextMessage({ fixture, sessionId: session.id, runId: run.runId, type: "assistant", status: "failed", text: "partial result from subtask" });
  assert.deepEqual(await getSubtaskResult(fixture, session.id, run.runId), { resultText: "partial result from subtask" });
});

test("subtask result follows assistant, then system, then empty fallback and status exposes all terminal states", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const createRun = (status: "running" | "completed" | "failed" | "cancelled", suffix: string, initialSystemText?: string) => {
    const session = createSubtaskSessionForTest(fixture, { title: `result-${suffix}` });
    if (initialSystemText !== undefined) appendTextMessage({ fixture, sessionId: session.id, runId: null, type: "system", text: initialSystemText });
    const run = createMessageRunForTest({ fixture, sessionId: session.id, status });
    return { session, runId: run.runId };
  };
  for (const status of ["running", "completed", "failed", "cancelled"] as const) {
    const current = createRun(status, status);
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/subtask/status",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId, sessionId: current.session.id, runId: current.runId }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status });
  }

  const assistantPreferred = createRun("completed", "assistant-preferred");
  appendTextMessage({ fixture, sessionId: assistantPreferred.session.id, runId: assistantPreferred.runId, type: "assistant", text: "assistant result" });
  appendTextMessage({ fixture, sessionId: assistantPreferred.session.id, runId: assistantPreferred.runId, type: "system", text: "system fallback" });
  assert.deepEqual(await getSubtaskResult(fixture, assistantPreferred.session.id, assistantPreferred.runId), { resultText: "assistant result" });

  const systemOnly = createRun("completed", "system-only", "latest system");
  assert.deepEqual(await getSubtaskResult(fixture, systemOnly.session.id, systemOnly.runId), { resultText: "latest system" });

  const allBlankSystem = createRun("completed", "blank-system", "  ");
  assert.deepEqual(await getSubtaskResult(fixture, allBlankSystem.session.id, allBlankSystem.runId), { resultText: "" });

  const blankAssistantWithSystem = createRun("completed", "blank-assistant-system", "system after blank assistant");
  appendTextMessage({ fixture, sessionId: blankAssistantWithSystem.session.id, runId: blankAssistantWithSystem.runId, type: "assistant", text: "  " });
  assert.deepEqual(await getSubtaskResult(fixture, blankAssistantWithSystem.session.id, blankAssistantWithSystem.runId), { resultText: "system after blank assistant" });

  const empty = createRun("running", "empty");
  assert.deepEqual(await getSubtaskResult(fixture, empty.session.id, empty.runId), { resultText: "" });
});

test("failed tool item 可保留 subtask partial result 且 error 不混入 partial 文本", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const anchor = await createParentAnchor(fixture, { completeAnchor: false });
  const startedAt = Date.now();
  assert.equal(updateToolExecution(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: anchor.sessionId,
    runId: anchor.runId,
    executionId: anchor.toolExecutionId,
    status: "running",
    startedAt,
    updatedAt: startedAt
  }), "updated");
  assert.equal(updateToolExecution(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: anchor.sessionId,
    runId: anchor.runId,
    executionId: anchor.toolExecutionId,
    status: "failed",
    structuredResult: { subtaskSessionId: "sess_subtask_failed", resultText: "partial result from subtask" },
    error: "subtask failed",
    completedAt: startedAt + 1,
    updatedAt: startedAt + 1
  }), "updated");
  const execution = getToolExecution(fixture.db, anchor.toolExecutionId);
  assert.equal(execution?.status, "failed");
  assert.equal(execution?.error, "subtask failed");
  assert.equal(execution?.resultPreview?.includes("partial result from subtask") ?? false, false);
  assert.deepEqual(execution?.structuredResult, { subtaskSessionId: "sess_subtask_failed", resultText: "partial result from subtask" });
});

test("subtask prefork-plan 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  setSettingJson(fixture.db, "workspace_agent_enablement_v1", {
    workspaces: { [fixture.workspaceId]: { mode: "subset", enabledAgentIds: [], updatedAt: Date.now() } }
  }, Date.now());
  const anchor = await createParentAnchor(fixture);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/prefork-plan",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, parentSessionId: anchor.sessionId, parentRunId: anchor.runId, parentToolExecutionId: anchor.toolExecutionId, agentId: "default" }
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((response.json() as { code?: string }).code, "AGENT_DISABLED_IN_WORKSPACE");
});

test("subtask start 在 workspace 全不选时返回 AGENT_DISABLED_IN_WORKSPACE", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  setSettingJson(fixture.db, "workspace_agent_enablement_v1", {
    workspaces: { [fixture.workspaceId]: { mode: "subset", enabledAgentIds: [], updatedAt: Date.now() } }
  }, Date.now());
  const anchor = await createParentAnchor(fixture);
  const response = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.sessionId,
    parentRunId: anchor.runId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "do task",
    prompt: "do task",
    session: { mode: "fork" }
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal((response.json() as { code?: string }).code, "AGENT_DISABLED_IN_WORKSPACE");
});
