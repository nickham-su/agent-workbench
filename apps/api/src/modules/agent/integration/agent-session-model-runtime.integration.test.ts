import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { appendContextItem, getRunRecord, updateRunRecordStatus, updateRunState } from "../agent.store.js";
import { createAgentService } from "../agent.composition.js";
import {
  createAgentIntegrationFixture,
  createPrimarySession,
  sendAgentMessage,
  type AgentIntegrationFixture
} from "../testkit/agent-integration-testkit.js";
import { createSubtaskAnchor, startSubtaskForAnchor } from "./subtask.helpers.js";

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

function runtime() {
  return { enqueueRun() {}, cancelSession() {} };
}

function settleRun(fixture: AgentIntegrationFixture, sessionId: string, runId: string) {
  const now = Date.now();
  updateRunRecordStatus(fixture.db, { runId, status: "completed", updatedAt: now });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    runNoticeText: "",
    updatedAt: now,
    appliedItemId: 0
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
    payload: { fromSessionId: source.id, fromItemId: sourceMessage.messageItemId, mode: "visible_only", title: "forked" }
  });
  assert.equal(fork.statusCode, 201, fork.body);
  const forked = fork.json() as { id: string };
  const forkedMessage = await sendAgentMessage(fixture, {
    sessionId: forked.id,
    text: "fork must use agent default",
    clientRequestId: "fork-run"
  });
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, forkedMessage.runId)),
    { agentId: "default", providerId: "ppchat", modelId: "gpt-5.2" }
  );
});

test("subtask 新 Run 不继承父 primary session 的模型覆盖", async (t) => {
  const fixture = await createFixture(t);
  const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
  await setOverride(fixture, anchor.parentSession.id);

  const started = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolItemId: anchor.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(started.statusCode, 200, started.body);
  const body = started.json() as { sessionId: string; runId: string; reused: boolean };
  assert.equal(body.reused, false);
  assert.deepEqual(
    pickModel(getRunRecord(fixture.db, body.runId)),
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
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "context to compact" },
    createdAt: Date.now()
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
  assert.equal(item.id > 0, true);
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

function pickModel(run: ReturnType<typeof getRunRecord>) {
  assert.ok(run, "run should have been persisted");
  return { agentId: run.agentId, providerId: run.providerId, modelId: run.modelId };
}
