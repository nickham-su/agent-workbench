import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AgentApiPromptContextResponseSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { createMessageRunRecord } from "./agent-message.store.js";
import {
  appendMessage,
  appendStreamingAssistant,
  commitCompactionMessage,
  completeAssistantWithExecutions,
  createMessageSession,
  flushStreamingParts,
  getMessageSessionHead,
  startMessageRun
} from "./agent-message.store.js";
import { newSortableId } from "../../utils/ids.js";
import {
  createAgentTestFixture,
  createTestWorkspace,
  injectJson,
  type AgentTestFixture
} from "./testkit/agent-testkit.js";

const fixtures: AgentTestFixture[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Read-side API fixture cleanup failed");
});

async function configureReadSideDefaults(fixture: AgentTestFixture) {
  assert.ok(fixture.app);
  const providers = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{
        id: "ppchat",
        name: "ppchat",
        npm: "@ai-sdk/openai",
        options: { baseURL: "https://code.ppchat.vip/v1", apiKey: "sk-test" },
        models: [{ id: "gpt-5.2", name: "gpt-5.2", contextWindowTokens: 128000 }]
      }]
    }
  });
  assert.equal(providers.statusCode, 200, providers.body);
  const agents = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/agents",
    payload: {
      agents: [{
        id: "default",
        name: "default",
        summary: "",
        prompt: "You are a helpful coding assistant.",
        tools: ["bash", "read", "write"],
        pluginTools: [],
        mcpServers: [],
        defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
        scope: "both",
        order: 0
      }]
    }
  });
  assert.equal(agents.statusCode, 200, agents.body);
}

async function createReadSideFixture() {
  const fixture = await createAgentTestFixture({ withApp: true, agentWorkerConcurrency: 0 });
  fixtures.push(fixture);
  const workspace = await createTestWorkspace(fixture, { title: "read-side API test workspace" });
  await configureReadSideDefaults(fixture);
  return { fixture, workspace };
}

function createRun(fixture: AgentTestFixture, workspaceId: string) {
  const sessionId = newSortableId("sess");
  const runId = newSortableId("run");
  const createdAt = Date.now();
  createMessageSession(fixture.db, {
    id: sessionId,
    workspaceId,
    title: "read-side API test session",
    kind: "primary",
    createdAt
  });
  const head = getMessageSessionHead(fixture.db, { workspaceId, sessionId });
  assert.ok(head);
  const triggerMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: triggerMessageId,
    workspaceId,
    sessionId,
    expectedHeadMessageId: head.headMessageId,
    expectedRevision: head.revision,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "read-side trigger" }],
    createdAt
  });
  createMessageRunRecord(fixture.db, {
    runId,
    workspaceId,
    sessionId,
    triggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt
  });
  startMessageRun(fixture.db, { workspaceId, sessionId, runId, updatedAt: createdAt });
  return { sessionId, runId };
}

function createCompletedToolExecution(fixture: AgentTestFixture, input: { workspaceId: string; sessionId: string; runId: string; result: unknown }) {
  const now = Date.now();
  const assistantId = newSortableId("msg");
  const callPartId = newSortableId("part");
  const executionId = newSortableId("exec");
  assert.equal(appendStreamingAssistant(fixture.db, {
    id: assistantId, workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId,
    expectedHeadMessageId: getMessageSessionHead(fixture.db, { workspaceId: input.workspaceId, sessionId: input.sessionId })?.headMessageId ?? null,
    expectedRevision: getMessageSessionHead(fixture.db, { workspaceId: input.workspaceId, sessionId: input.sessionId })?.revision ?? 0,
    createdAt: now,
  }).id, assistantId);
  assert.equal(flushStreamingParts(fixture.db, {
    workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId, messageId: assistantId, updatedAt: now + 1,
    parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "todolist", input: { goal: "test" } }],
  }), "updated");
  assert.equal(completeAssistantWithExecutions(fixture.db, {
    workspaceId: input.workspaceId, sessionId: input.sessionId, runId: input.runId, messageId: assistantId, updatedAt: now + 2,
    executions: [{ id: executionId, callPartId, originSessionId: input.sessionId, originRunId: input.runId, status: "queued" }],
  }), "updated");
  fixture.db.prepare(`update agent_tool_execution set status='completed', result_preview=?, result_truncated=1, result_artifact_path=?, structured_result_json=?, updated_revision=(select revision from agent_session where id=?), updated_at=? where id=?`)
    .run("brief result", "tool-results/private.json", JSON.stringify(input.result), input.sessionId, now + 3, executionId);
  return { assistantId, executionId };
}

test("ToolExecution detail 仅暴露当前 Session 可见链，timeline 保持轻量", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const { executionId } = createCompletedToolExecution(fixture, { workspaceId: workspace.id, sessionId, runId, result: { goal: "detail", todos: [{ content: "x", status: "completed" }] } });

  const timeline = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/timeline?workspaceId=${workspace.id}` });
  assert.equal(timeline.statusCode, 200, timeline.body);
  const timelineExecution = (timeline.json() as any).toolExecutions.find((item: any) => item.id === executionId);
  assert.equal(timelineExecution.resultPreview, "brief result");
  assert.equal(Object.hasOwn(timelineExecution, "structuredResult"), false);
  assert.equal(Object.hasOwn(timelineExecution, "resultArtifactPath"), false);

  const detail = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/tool-executions/${executionId}?workspaceId=${workspace.id}` });
  assert.equal(detail.statusCode, 200, detail.body);
  const detailBody = detail.json() as any;
  assert.deepEqual(detailBody.structuredResult, { goal: "detail", todos: [{ content: "x", status: "completed" }] });
  assert.equal(detailBody.resultArtifactPath, "tool-results/private.json");

  const other = createRun(fixture, workspace.id);
  const hidden = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${other.sessionId}/tool-executions/${executionId}?workspaceId=${workspace.id}` });
  assert.equal(hidden.statusCode, 404, hidden.body);
  assert.equal((hidden.json() as any).code, "TOOL_EXECUTION_NOT_FOUND");
});

test("read-side internal routes preserve token, body validation, and missing-resource responses", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const endpoints = [
    {
      path: "/api/internal/agent/execution-profile",
      validBody: { workspaceId: workspace.id, sessionId, runId },
      invalidBody: { workspaceId: "", sessionId: "", runId: "" },
      missingBody: { workspaceId: workspace.id, sessionId, runId: "missing-run" }
    },
    {
      path: "/api/internal/agent/prompt-context",
      validBody: { workspaceId: workspace.id, sessionId, runId },
      invalidBody: { workspaceId: "", sessionId: "", runId: "" },
      missingBody: { workspaceId: workspace.id, sessionId, runId: "missing-run" }
    },
    {
      path: "/api/internal/agent/messages-context",
      validBody: { workspaceId: workspace.id, sessionId },
      invalidBody: { workspaceId: "", sessionId: "" },
      missingBody: { workspaceId: workspace.id, sessionId: "missing-session" }
    }
  ];

  for (const endpoint of endpoints) {
    const invalidToken = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: "invalid-token",
      payload: endpoint.invalidBody
    });
    assert.equal(invalidToken.statusCode, 401, `${endpoint.path} should retain current invalid-token behavior`);

    const invalidBody = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: endpoint.invalidBody
    });
    assert.equal(invalidBody.statusCode, 400, `${endpoint.path} should retain current invalid-body behavior`);

    const missing = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: endpoint.missingBody
    });
    assert.equal(missing.statusCode, 404, `${endpoint.path} should retain current missing-resource behavior`);

    const workspaceMismatch = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: { ...endpoint.validBody, workspaceId: "workspace-mismatch" }
    });
    assert.equal(workspaceMismatch.statusCode, 400, `${endpoint.path} should retain workspace-mismatch behavior`);
    assert.deepEqual(workspaceMismatch.json(), { message: "workspaceId mismatch" });

    const success = await injectJson(fixture.app, {
      method: "POST",
      url: endpoint.path,
      internalToken: fixture.internalToken,
      payload: endpoint.validBody
    });
    assert.equal(success.statusCode, 200, `${endpoint.path} should retain current successful response`);
  }

  const messagesWithoutRunId = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/messages-context",
    internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId }
  });
  assert.equal(messagesWithoutRunId.statusCode, 200, messagesWithoutRunId.body);

  const profile = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    internalToken: fixture.internalToken,
    payload: endpoints[0]?.validBody
  });
  assert.equal(profile.statusCode, 200, profile.body);
  const profileBody = profile.json() as any;
  assert.equal(profileBody.resolved.runId, runId);
  for (const key of ["agentId", "providerId", "modelId"]) assert.equal(typeof profileBody.resolved[key], "string");
  assert.equal(typeof profileBody.agent?.id, "string");
  assert.equal(typeof profileBody.provider?.id, "string");
  assert.equal(typeof profileBody.provider?.name, "string");
  assert.equal(typeof profileBody.provider?.npm, "string");
  assert.equal(typeof profileBody.provider?.options, "object");
  assert.equal(typeof profileBody.model?.id, "string");
  assert.equal(typeof profileBody.model?.name, "string");
  assert.equal(typeof profileBody.model?.contextWindowTokens, "number");
  assert.equal(typeof profileBody.runtime?.modelIdleTimeoutMs, "number");
  assert.equal(typeof profileBody.runtime?.modelTotalTimeoutMs, "number");
  assert.equal(typeof profileBody.runtime?.modelRequestMaxRetries, "number");
  assert.equal(typeof profileBody.runtime?.modelRequestRetryBackoffMaxMs, "number");
  assert.equal(typeof profileBody.runtime?.autoCompactThresholdPct, "number");
  assert.ok(profileBody.vision === null || typeof profileBody.vision === "object");
  assert.ok(profileBody.compaction === null || typeof profileBody.compaction === "object");

  const prompt = await injectJson(fixture.app, {
    method: "POST",
    url: "/api/internal/agent/prompt-context",
    internalToken: fixture.internalToken,
    payload: endpoints[1]?.validBody
  });
  assert.equal(prompt.statusCode, 200, prompt.body);
  const promptBody = prompt.json() as any;
  assert.ok(promptBody.headMessageId === null || typeof promptBody.headMessageId === "string");
  assert.equal(typeof promptBody.sessionRevision, "number");
  assert.equal(typeof promptBody.system, "string");
  assert.equal(Array.isArray(promptBody.messages), true);
  assert.equal(Array.isArray(promptBody.tools), true);
  assert.equal(Array.isArray(promptBody.pendingTools), true);
  assert.ok(promptBody.lastResponseTotalTokens === null || typeof promptBody.lastResponseTotalTokens === "number");
  assert.ok(promptBody.uiLocale === null || promptBody.uiLocale === "zh-CN" || promptBody.uiLocale === "en-US");
  assert.equal(Array.isArray(promptBody.externalSkillRoots), true);
  for (const tool of promptBody.tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.inputSchema, "object");
  }
  for (const pending of promptBody.pendingTools) {
    assert.equal(typeof pending.toolExecutionId, "string");
    assert.equal(typeof pending.callPartId, "string");
    assert.equal(typeof pending.assistantMessageId, "string");
    assert.ok(pending.status === "queued" || pending.status === "running");
    assert.equal(typeof pending.toolName, "string");
    assert.equal(typeof pending.args, "object");
  }
  for (const root of promptBody.externalSkillRoots) {
    assert.ok(root.sourceType === "workspace" || root.sourceType === "repo");
    assert.equal(typeof root.rootDir, "string");
    assert.equal(typeof root.rootPath, "string");
  }
});

test("prompt-context returns queued/running tools with a transcript boundary, then emits complete envelopes after terminal state", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const createdAt = Date.now();
  const head = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(head);
  const assistantId = newSortableId("msg");
  const callPartId = newSortableId("part");
  const executionId = newSortableId("exec");
  const { appendStreamingAssistant, flushStreamingParts, completeAssistantWithExecutions, updateToolExecution } = await import("./agent-message.store.js");
  appendStreamingAssistant(fixture.db, { id: assistantId, workspaceId: workspace.id, sessionId, runId, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, createdAt });
  flushStreamingParts(fixture.db, { workspaceId: workspace.id, sessionId, runId, messageId: assistantId, updatedAt: createdAt + 1, parts: [{ id: callPartId, position: 0, type: "tool_call", toolName: "bash", input: { command: "pwd" }, providerToolCallId: "provider-call" }] });
  completeAssistantWithExecutions(fixture.db, { workspaceId: workspace.id, sessionId, runId, messageId: assistantId, updatedAt: createdAt + 2, executions: [{ id: executionId, callPartId, originSessionId: sessionId, originRunId: runId, status: "queued" }] });
  const request = { workspaceId: workspace.id, sessionId, runId };
  const queued = await injectJson(fixture.app, { method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken, payload: request });
  assert.equal(queued.statusCode, 200, queued.body);
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, queued.json()), true);
  const queuedBody = queued.json() as { messages: Array<{ role: string }>; pendingTools: Array<{ toolExecutionId: string; callPartId: string; assistantMessageId: string; status: string }> };
  assert.deepEqual(queuedBody.pendingTools, [{ toolExecutionId: executionId, callPartId, assistantMessageId: assistantId, status: "queued", toolName: "bash", toolCallId: "provider-call", args: { command: "pwd" } }]);
  assert.equal(queuedBody.messages.some((message) => message.role === "assistant" || message.role === "tool"), false);
  updateToolExecution(fixture.db, { workspaceId: workspace.id, sessionId, runId, executionId, status: "running", updatedAt: createdAt + 3 });
  const running = await injectJson(fixture.app, { method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken, payload: request });
  assert.equal(running.statusCode, 200, running.body);
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, running.json()), true);
  assert.equal((running.json() as { pendingTools: Array<{ status: string }> }).pendingTools[0]?.status, "running");
  updateToolExecution(fixture.db, { workspaceId: workspace.id, sessionId, runId, executionId, status: "completed", resultPreview: "workspace path", updatedAt: createdAt + 4 });
  const completed = await injectJson(fixture.app, { method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken, payload: request });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(Value.Check(AgentApiPromptContextResponseSchema, completed.json()), true);
  const completedBody = completed.json() as { pendingTools: unknown[]; messages: Array<{ role: string; content: unknown }> };
  assert.deepEqual(completedBody.pendingTools, []);
  assert.deepEqual(completedBody.messages.slice(-2), [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "provider-call", toolName: "bash", input: { command: "pwd" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "provider-call", toolName: "bash", output: { type: "text", value: "workspace path" } }] }
  ]);
});

test("timeline、messages-context 与 archive 不暴露私有 replay，受保护 PromptContext 可读取", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const head = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(head);
  const assistantId = newSortableId("msg");
  const secret = "opaque-private-replay-sentinel";
  appendStreamingAssistant(fixture.db, {
    id: assistantId, workspaceId: workspace.id, sessionId, runId,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, createdAt: Date.now(),
  });
  flushStreamingParts(fixture.db, {
    workspaceId: workspace.id, sessionId, runId, messageId: assistantId, updatedAt: Date.now() + 1,
    parts: [{
      id: newSortableId("part"), position: 0, type: "reasoning", text: "visible summary",
      providerReplay: {
        version: 1,
        provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "ppchat", model: "gpt-5.2" },
        item: { type: "reasoning", itemId: "rs_private", encryptedContent: secret },
      },
    }, { id: newSortableId("part"), position: 1, type: "text", text: "public answer" }],
  });
  completeAssistantWithExecutions(fixture.db, { workspaceId: workspace.id, sessionId, runId, messageId: assistantId, executions: [], updatedAt: Date.now() + 2 });

  const timeline = await fixture.app.inject({ method: "GET", url: `/api/agent/sessions/${sessionId}/timeline?workspaceId=${workspace.id}` });
  assert.equal(timeline.statusCode, 200, timeline.body);
  assert.doesNotMatch(timeline.body, new RegExp(secret));
  assert.doesNotMatch(timeline.body, /providerReplay|provider_replay_json/);

  const prompt = await injectJson(fixture.app, {
    method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId, runId },
  });
  assert.equal(prompt.statusCode, 200, prompt.body);
  const promptBody = prompt.json() as { providerReplay?: Array<{ parts: Array<{ providerReplay: { item: { encryptedContent?: string } } }> }> };
  assert.equal(promptBody.providerReplay?.[0]?.parts[0]?.providerReplay.item.encryptedContent, secret, prompt.body);
  assert.doesNotMatch(prompt.body, /provider_replay_json/);

  const messages = await injectJson(fixture.app, {
    method: "POST", url: "/api/internal/agent/messages-context", internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId },
  });
  assert.equal(messages.statusCode, 200, messages.body);
  assert.doesNotMatch(messages.body, new RegExp(secret));
  assert.doesNotMatch(messages.body, /providerReplay|provider_replay_json/);

  const archiveRows = fixture.db.prepare("select text from agent_archived_text_fts").all();
  assert.doesNotMatch(JSON.stringify(archiveRows), new RegExp(secret));
});

test("replay-only completed Assistant 仅在受保护 PromptContext 保留原始 ordinal", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const initial = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(initial);
  appendMessage(fixture.db, {
    id: "replay-only-user", workspaceId: workspace.id, sessionId,
    expectedHeadMessageId: initial.headMessageId, expectedRevision: initial.revision,
    type: "user", status: "completed",
    parts: [{ id: "replay-only-user-text", position: 0, type: "text", text: "before" }],
    createdAt: 1,
  });
  const afterUser = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(afterUser);
  const secret = "replay-only-private-cipher";
  appendMessage(fixture.db, {
    id: "replay-only-assistant", workspaceId: workspace.id, sessionId,
    expectedHeadMessageId: afterUser.headMessageId, expectedRevision: afterUser.revision,
    type: "assistant", status: "completed", originRunId: runId,
    parts: [{
      id: "replay-only-reasoning", position: 0, type: "reasoning", text: "",
      providerReplay: {
        version: 1,
        provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "ppchat", model: "gpt-5.2" },
        item: { type: "reasoning", itemId: "replay-only-item", encryptedContent: secret },
      },
    }],
    createdAt: 2,
  });
  const afterAssistant = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(afterAssistant);
  appendMessage(fixture.db, {
    id: "replay-only-next-user", workspaceId: workspace.id, sessionId,
    expectedHeadMessageId: afterAssistant.headMessageId, expectedRevision: afterAssistant.revision,
    type: "user", status: "completed",
    parts: [{ id: "replay-only-next-text", position: 0, type: "text", text: "after" }],
    createdAt: 3,
  });

  const prompt = await injectJson(fixture.app, {
    method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId, runId },
  });
  assert.equal(prompt.statusCode, 200, prompt.body);
  const promptBody = prompt.json() as {
    messages: Array<{ role: string; content: unknown }>;
    providerReplay?: Array<{ assistantOrdinal: number; parts: Array<{ providerReplay: { item: { encryptedContent?: string } } }> }>;
  };
  assert.deepEqual(promptBody.messages, [
    { role: "user", content: "read-side trigger" },
    { role: "user", content: "before" },
    { role: "assistant", content: [] },
    { role: "user", content: "after" },
  ]);
  assert.equal(promptBody.providerReplay?.[0]?.assistantOrdinal, 2);
  assert.equal(promptBody.providerReplay?.[0]?.parts[0]?.providerReplay.item.encryptedContent, secret);

  const messages = await injectJson(fixture.app, {
    method: "POST", url: "/api/internal/agent/messages-context", internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId },
  });
  assert.equal(messages.statusCode, 200, messages.body);
  assert.deepEqual((messages.json() as { messages: unknown[] }).messages, [
    { role: "user", content: "read-side trigger" },
    { role: "user", content: "before" },
    { role: "user", content: "after" },
  ]);
  assert.doesNotMatch(messages.body, new RegExp(secret));
});

test("PromptContext 私有 replay 服从当前 contextRoot..head completed 有效链", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const appendReplayAssistant = (status: "completed" | "failed", encryptedContent: string) => {
    const head = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
    assert.ok(head);
    const messageId = newSortableId("msg");
    appendStreamingAssistant(fixture.db, { id: messageId, workspaceId: workspace.id, sessionId, runId, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, createdAt: Date.now() });
    flushStreamingParts(fixture.db, {
      workspaceId: workspace.id, sessionId, runId, messageId, updatedAt: Date.now() + 1,
      parts: [{
        id: newSortableId("part"), position: 0, type: "reasoning", text: "summary",
        providerReplay: {
          version: 1,
          provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "ppchat", model: "gpt-5.2" },
          item: { type: "reasoning", itemId: `rs_${encryptedContent}`, encryptedContent },
        },
      }, { id: newSortableId("part"), position: 1, type: "text", text: "answer" }],
    });
    if (status === "completed") {
      completeAssistantWithExecutions(fixture.db, { workspaceId: workspace.id, sessionId, runId, messageId, executions: [], updatedAt: Date.now() + 2 });
    } else {
      fixture.db.prepare("update agent_message set status='failed' where id=?").run(messageId);
    }
    return messageId;
  };
  appendReplayAssistant("completed", "valid-cipher");
  appendReplayAssistant("failed", "failed-cipher");
  const response = await injectJson(fixture.app, {
    method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId, runId },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /valid-cipher/);
  assert.doesNotMatch(response.body, /failed-cipher/);
});

test("compaction 替换旧上下文后不额外回放被摘要替换的 reasoning", async () => {
  const { fixture, workspace } = await createReadSideFixture();
  assert.ok(fixture.app);
  const { sessionId, runId } = createRun(fixture, workspace.id);
  const beforeAssistant = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(beforeAssistant);
  const assistantId = newSortableId("msg");
  const oldCipher = "compacted-reasoning-must-not-replay";
  const now = Date.now();
  appendStreamingAssistant(fixture.db, {
    id: assistantId,
    workspaceId: workspace.id,
    sessionId,
    runId,
    expectedHeadMessageId: beforeAssistant.headMessageId,
    expectedRevision: beforeAssistant.revision,
    createdAt: now,
  });
  flushStreamingParts(fixture.db, {
    workspaceId: workspace.id,
    sessionId,
    runId,
    messageId: assistantId,
    updatedAt: now + 1,
    parts: [{
      id: newSortableId("part"),
      position: 0,
      type: "reasoning",
      text: "old visible summary",
      providerReplay: {
        version: 1,
        provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "ppchat", model: "gpt-5.2" },
        item: { type: "reasoning", itemId: "rs-compacted", encryptedContent: oldCipher },
      },
    }, {
      id: newSortableId("part"), position: 1, type: "text", text: "old answer",
    }],
  });
  completeAssistantWithExecutions(fixture.db, {
    workspaceId: workspace.id, sessionId, runId, messageId: assistantId, executions: [], updatedAt: now + 2,
  });
  const beforeCompaction = getMessageSessionHead(fixture.db, { workspaceId: workspace.id, sessionId });
  assert.ok(beforeCompaction);
  const compactedId = newSortableId("msg");
  commitCompactionMessage(fixture.db, {
    id: compactedId,
    workspaceId: workspace.id,
    sessionId,
    expectedHeadMessageId: beforeCompaction.headMessageId,
    expectedRevision: beforeCompaction.revision,
    textPartId: newSortableId("part"),
    text: "summary replaces older messages",
    createdAt: now + 3,
  });

  const response = await injectJson(fixture.app, {
    method: "POST", url: "/api/internal/agent/prompt-context", internalToken: fixture.internalToken,
    payload: { workspaceId: workspace.id, sessionId, runId },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.doesNotMatch(response.body, /old visible summary|old answer|compacted-reasoning-must-not-replay/);
  const prompt = response.json() as { messages: Array<{ role: string; content: unknown }>; providerReplay?: unknown[] };
  assert.deepEqual(prompt.messages, [{ role: "system", content: "summary replaces older messages" }]);
  assert.deepEqual(prompt.providerReplay, []);
});
