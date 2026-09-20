import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createMessageRunRecord, getRunRecord } from "../agent-message.store.js";
import {
  appendMessage,
  appendStreamingAssistant,
  completeAssistantWithExecutions,
  convergeRunTerminal,
  createMessageSession,
  getMessage,
  getMessageRunState,
  getMessageSession,
  persistRunTerminalIntent,
  startMessageRun,
  updateToolExecution
} from "../agent-message.store.js";
import { createAgentService } from "../agent.composition.js";
import {
  createAgentIntegrationFixture,
  createPrimarySession,
  sendAgentMessage,
  type AgentIntegrationFixture
} from "../testkit/agent-integration-testkit.js";

async function createFixture(t: TestContext) {
  const fixture = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0 });
  t.after(async () => fixture.dispose());

  const providers = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [
        {
          id: "ppchat",
          name: "Default Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.test/default", apiKey: "sk-default" },
          models: [{ id: "gpt-5.2", name: "Default Model", contextWindowTokens: 128000 }]
        },
        {
          id: "session-provider",
          name: "Session Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.test/session", apiKey: "sk-session" },
          models: [{ id: "session-model", name: "Session Model", contextWindowTokens: 128000 }]
        },
        {
          id: "compaction-provider",
          name: "Compaction Provider",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://example.test/compaction", apiKey: "sk-compaction" },
          models: [{ id: "compaction-model", name: "Compaction Model", contextWindowTokens: 128000 }]
        }
      ]
    }
  });
  assert.equal(providers.statusCode, 200, providers.body);
  return fixture;
}

async function setOverride(fixture: AgentIntegrationFixture, sessionId: string, providerId = "session-provider", modelId = "session-model") {
  const response = await fixture.app.inject({
    method: "PUT",
    url: `/api/agent/sessions/${sessionId}/agents/default/model-override`,
    payload: { workspaceId: fixture.workspaceId, providerId, modelId }
  });
  assert.equal(response.statusCode, 200, response.body);
}

function pickModel(run: ReturnType<typeof getRunRecord>) {
  if (!run) return null;
  return { agentId: run.agentId, providerId: run.providerId, modelId: run.modelId };
}

function runtime() {
  return { enqueueRun() {}, cancelSession() {} };
}

function settleRun(fixture: AgentIntegrationFixture, sessionId: string, runId: string) {
  const now = Date.now();
  persistRunTerminalIntent(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId, runId, status: "completed",
    code: "run_completed", detail: null, updatedAt: now,
  });
  convergeRunTerminal(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId, runId, updatedAt: now,
  });
}

test("普通消息的新 Run 以完整 session override pair 写入快照，且覆盖仅影响对应 session", async (t) => {
  const fixture = await createFixture(t);
  const overridden = await createPrimarySession(fixture);
  const inherited = await createPrimarySession(fixture);
  await setOverride(fixture, overridden.id);

  const overriddenMessage = await sendAgentMessage(fixture, {
    sessionId: overridden.id,
    text: "use session model",
    clientRequestId: "session-override-run"
  });
  const inheritedMessage = await sendAgentMessage(fixture, {
    sessionId: inherited.id,
    text: "use agent default",
    clientRequestId: "agent-default-run"
  });

  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, overriddenMessage.runId)),
    { agentId: "default", providerId: "session-provider", modelId: "session-model" }
  );
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, inheritedMessage.runId)),
    { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" }
  );
});

test("DELETE override 后下一条普通消息的新 Run 使用当前全局 default", async (t) => {
  const fixture = await createFixture(t);
  const session = await createPrimarySession(fixture);
  await setOverride(fixture, session.id);
  const deleted = await fixture.app.inject({
    method: "DELETE",
    url: `/api/agent/sessions/${session.id}/agents/default/model-override?workspaceId=${fixture.workspaceId}`
  });
  assert.equal(deleted.statusCode, 200, deleted.body);

  const message = await sendAgentMessage(fixture, {
    sessionId: session.id,
    text: "use default after reset",
    clientRequestId: "default-after-reset"
  });
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, message.runId)),
    { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" }
  );
});

test("失效 override 会拒绝普通消息，且不会写入半成品 Run", async (t) => {
  const fixture = await createFixture(t);
  const session = await createPrimarySession(fixture);
  await setOverride(fixture, session.id);
  const before = fixture.db.prepare("select count(*) as count from agent_run where session_id = ?").get(session.id) as { count: number };

  const providers = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/providers",
    payload: {
      default: { providerId: "ppchat", modelId: "gpt-5.2" },
      providers: [{
        id: "ppchat", name: "Default Provider", npm: "@ai-sdk/openai",
        options: { baseURL: "https://example.test/default", apiKey: "sk-default" },
        models: [{ id: "gpt-5.2", name: "Default Model", contextWindowTokens: 128000 }]
      }]
    }
  });
  assert.equal(providers.statusCode, 200, providers.body);
  const rejected = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/messages`,
    payload: { workspaceId: fixture.workspaceId, text: "must not fall back", clientRequestId: "invalid-override" }
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal((rejected.json() as any).code, "AGENT_PROVIDER_NOT_FOUND");
  const after = fixture.db.prepare("select count(*) as count from agent_run where session_id = ?").get(session.id) as { count: number };
  assert.equal(after.count, before.count);
});

test("已创建 Run 的 execution profile 保持 run snapshot，fork 不继承来源 session override", async (t) => {
  const fixture = await createFixture(t);
  const source = await createPrimarySession(fixture);
  await setOverride(fixture, source.id);
  const sourceMessage = await sendAgentMessage(fixture, {
    sessionId: source.id,
    text: "source session override",
    clientRequestId: "source-run"
  });
  settleRun(fixture, source.id, sourceMessage.runId);

  await setOverride(fixture, source.id, "ppchat", "gpt-5.2");
  const profile = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: source.id, runId: sourceMessage.runId }
  });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().resolved.providerId, "session-provider");
  assert.equal(profile.json().resolved.modelId, "session-model");

  const fork = await fixture.app.inject({
    method: "POST",
    url: "/api/agent/sessions/fork",
    payload: { fromSessionId: source.id, fromMessageId: sourceMessage.messageId, title: "forked" }
  });
  assert.equal(fork.statusCode, 201, fork.body);
  const forked = fork.json() as { id: string };
  const countsBefore = {
    messages: Number((fixture.db.prepare("select count(*) as count from agent_message").get() as { count: number }).count),
    parts: Number((fixture.db.prepare("select count(*) as count from agent_message_part").get() as { count: number }).count),
    executions: Number((fixture.db.prepare("select count(*) as count from agent_tool_execution").get() as { count: number }).count)
  };
  const forkedMessage = await sendAgentMessage(fixture, {
    sessionId: forked.id,
    text: "fork must use agent default",
    clientRequestId: "fork-run"
  });
  assert.deepEqual({
    messages: Number((fixture.db.prepare("select count(*) as count from agent_message where id <> ?").get(forkedMessage.messageId) as { count: number }).count),
    parts: Number((fixture.db.prepare("select count(*) as count from agent_message_part where message_id <> ?").get(forkedMessage.messageId) as { count: number }).count),
    executions: Number((fixture.db.prepare("select count(*) as count from agent_tool_execution").get() as { count: number }).count)
  }, countsBefore);
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, forkedMessage.runId)),
    { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" }
  );
});

test("subtask 新 Run 不继承父 primary session 的模型覆盖", async (t) => {
  const fixture = await createFixture(t);
  const parent = await createPrimarySession(fixture);
  await setOverride(fixture, parent.id);
  const now = Date.now();
  const parentTrigger = appendMessage(fixture.db, {
    id: "parent-trigger", workspaceId: fixture.workspaceId, sessionId: parent.id,
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", originRunId: null,
    parts: [{ id: "parent-trigger-text", position: 0, type: "text", text: "delegate" }], createdAt: now
  });
  createMessageRunRecord(fixture.db, {
    runId: "parent-run", workspaceId: fixture.workspaceId, sessionId: parent.id, triggerMessageId: parentTrigger.id,
    agentId: "default", providerId: "session-provider", modelId: "session-model", status: "running", createdAt: now
  });
  startMessageRun(fixture.db, { workspaceId: fixture.workspaceId, sessionId: parent.id, runId: "parent-run", updatedAt: now });
  const parentMessage = appendMessage(fixture.db, {
    id: "assistant-parent", workspaceId: fixture.workspaceId, sessionId: parent.id,
    expectedHeadMessageId: parentTrigger.id, expectedRevision: 1, type: "assistant", status: "streaming",
    originRunId: "parent-run", parts: [{ id: "call-parent", position: 0, type: "tool_call", toolName: "subtask", input: {} }], createdAt: now
  });
  completeAssistantWithExecutions(fixture.db, {
    workspaceId: fixture.workspaceId, sessionId: parent.id, runId: "parent-run",
    messageId: parentMessage.id, updatedAt: now + 1,
    executions: [{ id: "execution-parent", callPartId: "call-parent", originSessionId: parent.id, originRunId: "parent-run", status: "queued" }]
  });
  fixture.db.prepare("update agent_tool_execution set status='completed', completed_at=?, updated_at=? where id='execution-parent'").run(now + 2, now + 2);
  const childSessionId = "subtask-session";
  createMessageSession(fixture.db, { id: childSessionId, workspaceId: fixture.workspaceId, title: "subtask", kind: "subtask", createdAt: now + 3, forkedFromSessionId: parent.id, forkedFromMessageId: parentMessage.id });
  const childMessage = appendMessage(fixture.db, {
    id: "subtask-prompt", workspaceId: fixture.workspaceId, sessionId: childSessionId,
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", originRunId: null,
    parts: [{ id: "subtask-prompt-text", position: 0, type: "text", text: "work" }], createdAt: now + 3
  });
  createMessageRunRecord(fixture.db, {
    runId: "subtask-run", workspaceId: fixture.workspaceId, sessionId: childSessionId, triggerMessageId: childMessage.id,
    agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", parentRunId: null, parentToolExecutionId: "execution-parent", status: "running", createdAt: now + 4
  });
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, "subtask-run")),
    { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" }
  );
});

test("手动压缩的新 Run 使用 session override 作为主模型，不改变独立 compaction 配置语义", async (t) => {
  const fixture = await createFixture(t);
  const session = await createPrimarySession(fixture);
  await setOverride(fixture, session.id);
  const runtimeSettings = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { compactionModel: { providerId: "compaction-provider", modelId: "compaction-model" } }
  });
  assert.equal(runtimeSettings.statusCode, 200, runtimeSettings.body);
  const message = appendMessage(fixture.db, {
    id: "compaction-context", workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", originRunId: null,
    parts: [{ id: "compaction-context-text", position: 0, type: "text", text: "context to compact" }], createdAt: Date.now()
  });

  // Manual compaction only schedules when the worker capability is enabled.
  // The fake runtime keeps this test focused on the persisted new-Run snapshot.
  fixture.ctx.agentWorkerEnabled = true;
  const result = await createAgentService(fixture.ctx, fixture.app.log).compactSession({
    sessionId: session.id,
    body: { workspaceId: fixture.workspaceId, clientRequestId: "compact-override" },
    runtime: runtime()
  });
  assert.equal(result.scheduled, true);
  assert.equal(message.id, "compaction-context");
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, result.runId)),
    { agentId: "default", providerId: "session-provider", modelId: "session-model" }
  );

  const profile = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/execution-profile",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId: result.runId }
  });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().model.id, "session-model");
  assert.equal(profile.json().compaction.source, "runtime_compaction");
  assert.equal(profile.json().compaction.provider.id, "compaction-provider");
  assert.equal(profile.json().compaction.model.id, "compaction-model");
});
