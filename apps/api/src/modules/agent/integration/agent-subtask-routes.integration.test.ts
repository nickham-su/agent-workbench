import { createAgentComposition } from "../agent.composition.js";
import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ensureDir } from "../../../infra/fs/fs.js";
import { workspaceRoot } from "../../../infra/fs/paths.js";
import { insertWorkspace } from "../../workspaces/workspace.store.js";
import {
  createMessageRunRecord,
  getMessageSessionById,
  getRunRecord,
} from "../agent-message.store.js";
import {
  appendMessage,
  createMessageSession,
  getMessageSessionHead,
  startMessageRun
} from "../agent-message.store.js";
import type { AppContext } from "../../../app/context.js";
import type { AgentService } from "../agent.service.js";
import type { AgentApiSubtaskStartRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { newSortableId } from "../../../utils/ids.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import {
  createMessageToolAnchor,
  createP2Fixture,
  createSession,
  createSubtaskAnchor,
  createSubtaskSessionForTest,
  startSubtaskForAnchor
} from "./subtask.helpers.js";


function createDirectAgentComposition(fixture: AgentIntegrationFixture) {
  const ctx: AppContext = {
    db: fixture.db,
    repoRoot: fixture.repoRoot,
    dataDir: fixture.dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    serveWeb: false,
    webDistDir: null,
      preview: { enabled: false, runtime: null },
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
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(fixture.dataDir, "agent-plugin-host.sock")
  };
  return createAgentComposition(ctx, fixture.app.log);
}

function createDirectAgentService(fixture: AgentIntegrationFixture) {
  return createDirectAgentComposition(fixture).service;
}

async function assertDirectSubtaskStartError(params: {
  service: AgentService;
  request: AgentApiSubtaskStartRequest;
  statusCode: number;
  code: string;
}) {
  await assert.rejects(
    () => params.service.startSubtaskRunFromWorker(params.request),
    (error: unknown) => {
      const typed = error as { statusCode?: number; code?: string };
      assert.equal(typed.statusCode, params.statusCode);
      assert.equal(typed.code, params.code);
      return true;
    }
  );
}

test("subtask start reports anchor validation codes at the Route", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });

  const otherRunId = newSortableId("run");
  createMessageRunRecord(fixture.db, {
    runId: otherRunId,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    triggerMessageId: anchor.userMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    subtaskDepth: 0,
    status: "running",
    createdAt: Date.now()
  });
  const anchorRunMismatch = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: otherRunId,
    parentToolExecutionId: anchor.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(anchorRunMismatch.statusCode, 400, anchorRunMismatch.body);
  assert.equal(anchorRunMismatch.json().code, "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH");

  const nonSubtaskTool = createMessageToolAnchor({
    fixture,
    sessionId: anchor.parentSession.id,
    runId: anchor.parentRunId,
    toolName: "bash",
    input: { command: "true" }
  });
  const invalidAnchor = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolExecutionId: nonSubtaskTool.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(invalidAnchor.statusCode, 400, invalidAnchor.body);
  assert.equal(invalidAnchor.json().code, "AGENT_SUBTASK_ANCHOR_INVALID");
});

test("subtask start stable validation codes are precise at Service boundaries", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
  const service = createDirectAgentService(fixture);
  const baseRequest = {
    workspaceId: fixture.workspaceId,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolExecutionId: anchor.toolExecutionId,
    description: "child",
    prompt: "complete child",
    agentId: "default",
    session: { mode: "new" as const }
  };

  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, description: " " },
    statusCode: 400,
    code: "AGENT_SUBTASK_DESCRIPTION_REQUIRED"
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, agentId: " " },
    statusCode: 400,
    code: "AGENT_SUBTASK_AGENT_REQUIRED"
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "fork" }, preforkMeta: { thresholdPct: 95, parentLastResponseTotalTokens: 1, childContextWindowTokens: 128000 } },
    statusCode: 400,
    code: "AGENT_SUBTASK_PREFORK_META_INVALID"
  });
  const existingSessionMissingIdRequest = {
    ...baseRequest,
    session: { mode: "existing" }
  } as unknown as AgentApiSubtaskStartRequest;
  await assertDirectSubtaskStartError({
    service,
    request: existingSessionMissingIdRequest,
    statusCode: 400,
    code: "AGENT_SUBTASK_EXISTING_SESSION_REQUIRED"
  });
  const invalidSessionModeRequest = {
    ...baseRequest,
    session: { mode: "invalid" }
  } as unknown as AgentApiSubtaskStartRequest;
  await assertDirectSubtaskStartError({
    service,
    request: invalidSessionModeRequest,
    statusCode: 400,
    code: "AGENT_SUBTASK_SESSION_MODE_INVALID"
  });
  // The Service intentionally creates a new/fork session before this validation;
  // keep this case in the shared fixture to preserve the documented non-atomic behavior.
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, prompt: " " },
    statusCode: 400,
    code: "AGENT_SUBTASK_PROMPT_REQUIRED"
  });

  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: "missing-subtask-session" } },
    statusCode: 404,
    code: "AGENT_SUBTASK_SESSION_NOT_FOUND"
  });

  const foreignWorkspaceId = newSortableId("ws");
  const foreignWorkspaceDirName = newSortableId("workspace");
  const foreignWorkspacePath = workspaceRoot(fixture.dataDir, foreignWorkspaceDirName);
  await ensureDir(foreignWorkspacePath);
  insertWorkspace(fixture.db, {
    id: foreignWorkspaceId,
    dirName: foreignWorkspaceDirName,
    title: "foreign-workspace",
    path: foreignWorkspacePath,
    terminalCredentialId: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const foreignSessionId = newSortableId("sess");
  createMessageSession(fixture.db, {
    id: foreignSessionId,
    workspaceId: foreignWorkspaceId,
    title: "foreign-subtask",
    kind: "subtask",
    createdAt: Date.now()
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: foreignSessionId } },
    statusCode: 400,
    code: "AGENT_SUBTASK_WORKSPACE_MISMATCH"
  });

  const primarySession = await createSession(fixture.app, fixture.workspaceId);
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: primarySession.id } },
    statusCode: 400,
    code: "AGENT_SUBTASK_KIND_MISMATCH"
  });

  const runningSessionId = newSortableId("sess");
  const runningAt = Date.now();
  createMessageSession(fixture.db, {
    id: runningSessionId,
    workspaceId: fixture.workspaceId,
    title: "running-subtask",
    kind: "subtask",
    createdAt: runningAt
  });
  const runningTriggerMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: runningTriggerMessageId,
    workspaceId: fixture.workspaceId,
    sessionId: runningSessionId,
    expectedHeadMessageId: null,
    expectedRevision: 0,
    type: "user",
    status: "completed",
    originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "running child" }],
    createdAt: runningAt
  });
  createMessageRunRecord(fixture.db, {
    runId: "run-running-subtask",
    workspaceId: fixture.workspaceId,
    sessionId: runningSessionId,
    triggerMessageId: runningTriggerMessageId,
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
    status: "running",
    createdAt: runningAt
  });
  startMessageRun(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: runningSessionId,
    runId: "run-running-subtask",
    updatedAt: runningAt
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: runningSessionId } },
    statusCode: 409,
    code: "AGENT_SUBTASK_SESSION_RUNNING"
  });

  const invalidBoundaryAnchor = createMessageToolAnchor({
    fixture,
    sessionId: anchor.parentSession.id,
    runId: anchor.parentRunId,
    toolName: "subtask",
    input: { description: "child", prompt: "complete child", agentId: "default", session: { mode: "fork" } }
  });
  fixture.db.prepare("update agent_message set type = 'user' where id = ?").run(invalidBoundaryAnchor.assistantMessageId);
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, parentToolExecutionId: invalidBoundaryAnchor.toolExecutionId, session: { mode: "fork" } },
    statusCode: 400,
    code: "AGENT_SUBTASK_FORK_BOUNDARY_INVALID"
  });
});

test("subtask start 按 depth 执行限制、mode 和轻量幂等", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const runtimeRes = await fixture.app.inject({
    method: "PUT",
    url: "/api/settings/agent/runtime",
    payload: { maxSubtaskDepth: 2 }
  });
  assert.equal(runtimeRes.statusCode, 200, runtimeRes.body);

  for (const mode of ["new", "fork"] as const) {
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: mode });
    const res = await startSubtaskForAnchor({
      fixture,
      parentSessionId: parent.parentSession.id,
      parentRunId: parent.parentRunId,
      parentToolExecutionId: parent.toolExecutionId,
      session: { mode }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { sessionId: string; runId: string; reused: boolean };
    assert.equal(body.reused, false);
    const child = getRunRecord(fixture.db, body.runId);
    assert.equal(child?.subtaskDepth, 1);
    assert.equal(child?.parentRunId, parent.parentRunId);
    assert.equal(child?.parentToolExecutionId, parent.toolExecutionId);
    const session = getMessageSessionById(fixture.db, body.sessionId);
    assert.equal(session?.kind, "subtask");
    assert.equal(session?.forkedFromSessionId, parent.parentSession.id);
    assert.equal(session?.forkedFromMessageId, mode === "fork" ? parent.userMessageId : null);
  }

  const existingSession = createSubtaskSessionForTest(fixture, {
    title: "existing",
    forkedFromSessionId: "original-parent",
    forkedFromMessageId: null
  });
  const existingParent = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "existing" });
  const existingRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolExecutionId: existingParent.toolExecutionId,
    session: { mode: "existing", sessionId: existingSession.id }
  });
  assert.equal(existingRes.statusCode, 200, existingRes.body);
  assert.equal((existingRes.json() as { agentName: string }).agentName, "default");
  const existingRun = getRunRecord(fixture.db, (existingRes.json() as { runId: string }).runId);
  assert.equal(existingRun?.subtaskDepth, 2);
  assert.equal(existingRun?.parentRunId, existingParent.parentRunId);
  assert.equal(existingRun?.parentToolExecutionId, existingParent.toolExecutionId);
  const existingSessionAfter = getMessageSessionById(fixture.db, existingSession.id);
  assert.equal(existingSessionAfter?.forkedFromSessionId, "original-parent");
  assert.equal(existingSessionAfter?.forkedFromMessageId, null);

  const duplicate = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolExecutionId: existingParent.toolExecutionId,
    session: { mode: "existing", sessionId: existingSession.id }
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal((duplicate.json() as { agentName: string }).agentName, "default");
  assert.equal((duplicate.json() as { reused: boolean }).reused, true);
  assert.equal((duplicate.json() as { runId: string }).runId, (existingRes.json() as { runId: string }).runId);

  const differentExistingSession = createSubtaskSessionForTest(fixture, { title: "different-existing" });
  const mismatch = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolExecutionId: existingParent.toolExecutionId,
    session: { mode: "existing", sessionId: differentExistingSession.id }
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().code, "AGENT_SUBTASK_EXISTING_SESSION_MISMATCH");
  assert.equal(
    mismatch.json().message,
    "existing subtask session does not match the previously created child run"
  );
});

test("subtask start 首次已提交但客户端未确认时，重试复用同一个已激活 child", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "new" });
  const request = {
    fixture,
    parentSessionId: parent.parentSession.id,
    parentRunId: parent.parentRunId,
    parentToolExecutionId: parent.toolExecutionId,
    session: { mode: "new" as const }
  };

  // The first route call completes server-side; deliberately discard its response
  // to model a client-side response loss after persistence/activation.
  const first = await startSubtaskForAnchor(request);
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json() as { sessionId: string; runId: string; reused: boolean };
  assert.equal(firstBody.reused, false);
  const initialSeeds = fixture.db.prepare("select id from agent_message where origin_session_id = ? order by depth").all(firstBody.sessionId) as Array<{ id: string }>;
  const initialChildCount = fixture.db.prepare(
    "select count(*) as count from agent_run where workspace_id = ? and parent_run_id = ? and parent_tool_execution_id = ?"
  ).get(fixture.workspaceId, parent.parentRunId, parent.toolExecutionId) as { count: number };
  assert.equal(initialChildCount.count, 1);
  assert.ok(initialSeeds.length > 0, "first call must activate and seed the child before its response is lost");

  const retry = await startSubtaskForAnchor(request);
  assert.equal(retry.statusCode, 200, retry.body);
  const retryBody = retry.json() as { sessionId: string; runId: string; reused: boolean };
  assert.equal(retryBody.reused, true);
  assert.equal(retryBody.sessionId, firstBody.sessionId);
  assert.equal(retryBody.runId, firstBody.runId);
  assert.equal(
    (fixture.db.prepare(
      "select count(*) as count from agent_run where workspace_id = ? and parent_run_id = ? and parent_tool_execution_id = ?"
    ).get(fixture.workspaceId, parent.parentRunId, parent.toolExecutionId) as { count: number }).count,
    1
  );
  const seedsAfterRetry = fixture.db.prepare("select id from agent_message where origin_session_id = ? order by depth").all(firstBody.sessionId) as Array<{ id: string }>;
  assert.deepEqual(seedsAfterRetry, initialSeeds, "retry must not seed or execute the child a second time");
});

test("subtask fork 无 boundary 时保留双空 metadata 并写入 guard→prompt", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
  fixture.db.prepare("update agent_message set previous_message_id = null where id = ?").run(parent.assistantMessageId);

  const res = await startSubtaskForAnchor({
    fixture,
    parentSessionId: parent.parentSession.id,
    parentRunId: parent.parentRunId,
    parentToolExecutionId: parent.toolExecutionId,
    session: { mode: "fork" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const started = res.json() as { sessionId: string; runId: string };
  const session = getMessageSessionById(fixture.db, started.sessionId);
  assert.equal(session?.kind, "subtask");
  assert.equal(session?.forkedFromSessionId, null);
  assert.equal(session?.forkedFromMessageId, null);

  const items = fixture.db.prepare(`
    select message.id, message.type as kind, part.text
    from agent_message message
    left join agent_message_part part on part.message_id = message.id and part.type = 'text'
    where message.origin_session_id = ?
    order by message.depth, part.position
  `).all(started.sessionId) as Array<{ id: string; kind: string; text: string | null }>;
  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, "system");
  assert.notEqual(String(items[0]?.text || "").trim(), "");
  assert.equal(items[1]?.kind, "user");
  assert.equal(items[1]?.text, "complete child");
});

test("subtask start 对 unknown 和超限 parent depth 返回明确错误", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const unknown = await createSubtaskAnchor({ fixture, parentDepth: null, sessionMode: "new" });
  const unknownRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: unknown.parentSession.id,
    parentRunId: unknown.parentRunId,
    parentToolExecutionId: unknown.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(unknownRes.statusCode, 409);
  assert.equal(unknownRes.json().code, "AGENT_SUBTASK_DEPTH_UNKNOWN");

  const maxRes = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 1 } });
  assert.equal(maxRes.statusCode, 200, maxRes.body);
  const exceeded = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
  const exceededRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: exceeded.parentSession.id,
    parentRunId: exceeded.parentRunId,
    parentToolExecutionId: exceeded.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(exceededRes.statusCode, 409);
  assert.equal(exceededRes.json().code, "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
});

test("已有 child 可在配置下调后复用，而新的同层调用按最新上限拒绝", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 2 } });
  const existing = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
  const started = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existing.parentSession.id,
    parentRunId: existing.parentRunId,
    parentToolExecutionId: existing.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(started.statusCode, 200, started.body);
  const original = started.json() as { runId: string; reused: boolean };
  assert.equal(original.reused, false);

  const lowered = await fixture.app.inject({ method: "PUT", url: "/api/settings/agent/runtime", payload: { maxSubtaskDepth: 1 } });
  assert.equal(lowered.statusCode, 200, lowered.body);
  const retried = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existing.parentSession.id,
    parentRunId: existing.parentRunId,
    parentToolExecutionId: existing.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal((retried.json() as { runId: string; reused: boolean }).runId, original.runId);
  assert.equal((retried.json() as { reused: boolean }).reused, true);

  const nextTool = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "new" });
  const rejected = await startSubtaskForAnchor({
    fixture,
    parentSessionId: nextTool.parentSession.id,
    parentRunId: nextTool.parentRunId,
    parentToolExecutionId: nextTool.toolExecutionId,
    session: { mode: "new" }
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
});

test("subtask start preserves session union boundaries at the Route", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
  const initial = await startSubtaskForAnchor({ fixture, parentSessionId: anchor.parentSession.id, parentRunId: anchor.parentRunId, parentToolExecutionId: anchor.toolExecutionId, session: { mode: "fork" } });
  assert.equal(initial.statusCode, 200, initial.body);

  const forbiddenSessionId = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolExecutionId: anchor.toolExecutionId,
    session: { mode: "fork", sessionId: "SHOULD_REJECT" }
  });
  assert.equal(forbiddenSessionId.statusCode, 400);
  assert.equal((forbiddenSessionId.json() as { code?: string }).code, "AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED");

  const missingExistingSessionId = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: {
      workspaceId: fixture.workspaceId,
      parentSessionId: anchor.parentSession.id,
      parentRunId: anchor.parentRunId,
      parentToolExecutionId: anchor.toolExecutionId,
      description: "child",
      prompt: "complete child",
      agentId: "default",
      session: { mode: "existing" }
    }
  });
  assert.equal(missingExistingSessionId.statusCode, 400);
  assert.equal(String(missingExistingSessionId.body).includes("AGENT_SUBTASK_EXISTING_SESSION_REQUIRED"), false);
});
