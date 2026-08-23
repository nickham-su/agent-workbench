import { createAgentComposition } from "../agent.composition.js";
import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ensureDir } from "../../../infra/fs/fs.js";
import { workspaceRoot } from "../../../infra/fs/paths.js";
import { insertWorkspace } from "../../workspaces/workspace.store.js";
import {
  createAgentSession,
  createRunRecord,
  getAgentSession,
  getRunRecord,
  getSessionTranscriptItems,
  updateRunState
} from "../agent.store.js";
import type { AppContext } from "../../../app/context.js";
import type { AgentService } from "../agent.service.js";
import type { AgentApiSubtaskStartRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { newSortableId } from "../../../utils/ids.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import {
  createContextItemInternal,
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
  createRunRecord(fixture.db, {
    runId: otherRunId,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    triggerItemId: anchor.toolItem.item.id,
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
    parentToolItemId: anchor.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(anchorRunMismatch.statusCode, 400, anchorRunMismatch.body);
  assert.equal(anchorRunMismatch.json().code, "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH");

  const nonSubtaskTool = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    runId: anchor.parentRunId,
    turnId: "turn_subtask_depth",
    step: 2,
    prevId: anchor.toolItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "bash",
      toolCallId: "call_not_subtask",
      args: { command: "true" },
      result: null
    }
  });
  const invalidAnchor = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolItemId: nonSubtaskTool.item.id,
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
    parentToolItemId: anchor.toolItem.item.id,
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
  createAgentSession(fixture.db, {
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
  createAgentSession(fixture.db, {
    id: runningSessionId,
    workspaceId: fixture.workspaceId,
    title: "running-subtask",
    kind: "subtask",
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: runningSessionId,
    status: "running",
    activeRunId: "run-running-subtask",
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, session: { mode: "existing", sessionId: runningSessionId } },
    statusCode: 409,
    code: "AGENT_SUBTASK_SESSION_RUNNING"
  });

  const invalidBoundaryAnchor = await createContextItemInternal(fixture, {
    app: fixture.app,
    internalToken: fixture.internalToken,
    workspaceId: fixture.workspaceId,
    sessionId: anchor.parentSession.id,
    runId: anchor.parentRunId,
    turnId: "turn_invalid_boundary",
    step: 3,
    prevId: anchor.toolItem.item.id,
    kind: "tool",
    status: "queued",
    output: {
      type: "tool",
      toolName: "subtask",
      toolCallId: "call_invalid_boundary",
      args: { description: "child", prompt: "complete child", agentId: "default", session: { mode: "fork" } },
      result: null
    }
  });
  fixture.db.prepare("update agent_context_item set prev_id = ? where id = ?").run(999999999, invalidBoundaryAnchor.item.id);
  await assertDirectSubtaskStartError({
    service,
    request: { ...baseRequest, parentToolItemId: invalidBoundaryAnchor.item.id, session: { mode: "fork" } },
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
      parentToolItemId: parent.toolItem.item.id,
      session: { mode }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { sessionId: string; runId: string; reused: boolean };
    assert.equal(body.reused, false);
    const child = getRunRecord(fixture.db, body.runId);
    assert.equal(child?.subtaskDepth, 1);
    assert.equal(child?.parentRunId, parent.parentRunId);
    assert.equal(child?.parentToolItemId, parent.toolItem.item.id);
    const session = getAgentSession(fixture.db, body.sessionId);
    assert.equal(session?.kind, "subtask");
    assert.equal(session?.forkedFromSessionId, mode === "new" ? parent.parentSession.id : null);
    assert.equal(session?.forkedFromItemId, mode === "new" ? parent.toolItem.item.id : null);
  }

  const existingSession = createSubtaskSessionForTest(fixture, {
    title: "existing",
    forkedFromSessionId: "original-parent",
    forkedFromItemId: 7
  });
  const existingParent = await createSubtaskAnchor({ fixture, parentDepth: 1, sessionMode: "existing" });
  const existingRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolItemId: existingParent.toolItem.item.id,
    session: { mode: "existing", sessionId: existingSession.id }
  });
  assert.equal(existingRes.statusCode, 200, existingRes.body);
  assert.equal((existingRes.json() as { agentName: string }).agentName, "default");
  const existingRun = getRunRecord(fixture.db, (existingRes.json() as { runId: string }).runId);
  assert.equal(existingRun?.subtaskDepth, 2);
  assert.equal(existingRun?.parentRunId, existingParent.parentRunId);
  assert.equal(existingRun?.parentToolItemId, existingParent.toolItem.item.id);
  const existingSessionAfter = getAgentSession(fixture.db, existingSession.id);
  assert.equal(existingSessionAfter?.forkedFromSessionId, "original-parent");
  assert.equal(existingSessionAfter?.forkedFromItemId, 7);

  const duplicate = await startSubtaskForAnchor({
    fixture,
    parentSessionId: existingParent.parentSession.id,
    parentRunId: existingParent.parentRunId,
    parentToolItemId: existingParent.toolItem.item.id,
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
    parentToolItemId: existingParent.toolItem.item.id,
    session: { mode: "existing", sessionId: differentExistingSession.id }
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().code, "AGENT_SUBTASK_EXISTING_SESSION_MISMATCH");
  assert.equal(
    mismatch.json().message,
    "existing subtask session does not match the previously created child run"
  );
});

test("subtask fork 无 boundary 时保留双空 metadata 并写入 guard→prompt", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const parent = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
  fixture.db.prepare("update agent_context_item set prev_id = null where id = ?").run(parent.toolItem.item.id);

  const res = await startSubtaskForAnchor({
    fixture,
    parentSessionId: parent.parentSession.id,
    parentRunId: parent.parentRunId,
    parentToolItemId: parent.toolItem.item.id,
    session: { mode: "fork" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const started = res.json() as { sessionId: string; runId: string };
  const session = getAgentSession(fixture.db, started.sessionId);
  assert.equal(session?.kind, "subtask");
  assert.equal(session?.forkedFromSessionId, null);
  assert.equal(session?.forkedFromItemId, null);

  const items = getSessionTranscriptItems(fixture.db, fixture.workspaceId, started.sessionId);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.kind, "system");
  assert.equal(String((items[0]?.output as { text?: string }).text || "").includes("All history before this system message was copied"), true);
  assert.equal(items[0]?.runId, null);
  assert.equal(items[1]?.kind, "user");
  assert.equal(items[1]?.runId, started.runId);
});

test("subtask start 对 unknown 和超限 parent depth 返回明确错误", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const unknown = await createSubtaskAnchor({ fixture, parentDepth: null, sessionMode: "new" });
  const unknownRes = await startSubtaskForAnchor({
    fixture,
    parentSessionId: unknown.parentSession.id,
    parentRunId: unknown.parentRunId,
    parentToolItemId: unknown.toolItem.item.id,
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
    parentToolItemId: exceeded.toolItem.item.id,
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
    parentToolItemId: existing.toolItem.item.id,
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
    parentToolItemId: existing.toolItem.item.id,
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
    parentToolItemId: nextTool.toolItem.item.id,
    session: { mode: "new" }
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
});

test("subtask start preserves session union boundaries at the Route", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const anchor = await createSubtaskAnchor({ fixture, parentDepth: 0, sessionMode: "fork" });
  const initial = await startSubtaskForAnchor({ fixture, parentSessionId: anchor.parentSession.id, parentRunId: anchor.parentRunId, parentToolItemId: anchor.toolItem.item.id, session: { mode: "fork" } });
  assert.equal(initial.statusCode, 200, initial.body);

  const forbiddenSessionId = await startSubtaskForAnchor({
    fixture,
    parentSessionId: anchor.parentSession.id,
    parentRunId: anchor.parentRunId,
    parentToolItemId: anchor.toolItem.item.id,
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
      parentToolItemId: anchor.toolItem.item.id,
      description: "child",
      prompt: "complete child",
      agentId: "default",
      session: { mode: "existing" }
    }
  });
  assert.equal(missingExistingSessionId.statusCode, 400);
  assert.equal(String(missingExistingSessionId.body).includes("AGENT_SUBTASK_EXISTING_SESSION_REQUIRED"), false);
});
