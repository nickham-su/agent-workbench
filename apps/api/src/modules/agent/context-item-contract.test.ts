import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app/createApp.js";
import { openDb, type Db } from "../../infra/db/db.js";
import { ensureDir, rmrf } from "../../infra/fs/fs.js";
import { agentArchivePendingSidecarPath, agentArchiveSessionDir, workspaceRoot } from "../../infra/fs/paths.js";
import { newSortableId } from "../../utils/ids.js";
import { insertWorkspace } from "../workspaces/workspace.store.js";
import { ArchiveStorage } from "./archive/archive-storage.js";
import {
  AgentConflictError,
  appendContextItem,
  appendContextItemWithRunFence,
  appendSystemSummaryAndArchiveItems,
  createAgentSession,
  createRunRecord,
  getContextItemById,
  getRunRecord,
  getRunState,
  getSessionHead,
  updateRunRecordStatus,
  updateRunState
} from "./agent.store.js";

type Fixture = {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  workspaceId: string;
  internalToken: string;
  contextHandlerBodies: unknown[];
  compactHandlerBodies: unknown[];
};

const fixtures = new Set<Fixture>();

afterEach(async () => {
  await Promise.all([...fixtures].map(async (fixture) => {
    fixtures.delete(fixture);
    await fixture.app.close();
    await rmrf(fixture.dataDir);
  }));
});

async function createFixture(options?: {
  agentTestFaults?: {
    archiveRollback?: { appendBeforeRollback?: string } | null;
    archiveSidecar?: { failWrite?: boolean; failRename?: boolean } | null;
  };
}): Promise<Fixture> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, "context-contract-"));
  const db = await openDb(dataDir);
  const internalToken = "test-internal-token";
  const contextHandlerBodies: unknown[] = [];
  const compactHandlerBodies: unknown[] = [];
  const app = await createApp({
    db,
    repoRoot,
    dataDir,
    fileMaxBytes: 1024 * 1024,
    version: "test",
    logLevel: "error",
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
    agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
    agentWorkerConcurrency: 0,
    agentInternalToken: internalToken,
    agentWorkerResponseValidation: "strict",
    agentApiOrigin: "http://127.0.0.1:0",
    agentStartupRecoveryMode: "recover",
    agentPluginHostEnabled: false,
    agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"),
    agentPluginServicesEnabled: false,
    agentTestFaults: options?.agentTestFaults
  });
  app.addHook("preHandler", async (request) => {
    const requestPath = request.url.split("?", 1)[0];
    if (
      requestPath === "/api/internal/agent/context-items" ||
      /^\/api\/internal\/agent\/context-items\/\d+$/.test(requestPath)
    ) {
      contextHandlerBodies.push(request.body);
    } else if (requestPath === "/api/internal/agent/context/compact") {
      compactHandlerBodies.push(request.body);
    }
  });
  const workspaceId = newSortableId("ws");
  const dirName = newSortableId("workspace");
  await ensureDir(workspaceRoot(dataDir, dirName));
  insertWorkspace(db, {
    id: workspaceId,
    dirName,
    title: "context-contract-workspace",
    path: workspaceRoot(dataDir, dirName),
    terminalCredentialId: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  await app.ready();
  const fixture = { app, db, dataDir, workspaceId, internalToken, contextHandlerBodies, compactHandlerBodies };
  fixtures.add(fixture);
  return fixture;
}

function createSession(fixture: Fixture) {
  const id = newSortableId("sess");
  return createAgentSession(fixture.db, {
    id,
    workspaceId: fixture.workspaceId,
    title: "context-contract-session",
    kind: "primary",
    forkedFromSessionId: null,
    forkedFromItemId: null,
    createdAt: Date.now()
  }) ?? { id };
}

function headers(fixture: Fixture) {
  return { "x-awb-agent-internal-token": fixture.internalToken };
}

function createRun(fixture: Fixture, sessionId: string, runId: string) {
  createRunRecord(fixture.db, {
    runId,
    workspaceId: fixture.workspaceId,
    sessionId,
    triggerItemId: 1,
    agentId: "default",
    providerId: "provider",
    modelId: "model",
    status: "running",
    createdAt: Date.now()
  });
}

async function compact(fixture: Fixture, input: Record<string, unknown>) {
  return fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context/compact",
    headers: headers(fixture),
    payload: input
  });
}

function assertCompleteContextRecord(item: Record<string, unknown>) {
  for (const key of [
    "id", "workspaceId", "sessionId", "runId", "turnId", "step", "prevId", "kind", "status",
    "archiveAt", "boundaryReason", "output", "createdAt", "updatedAt"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(item, key), `missing context record field: ${key}`);
  }
}

test("Context create/update return complete records and accept shared output variants", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const outputs = [
    { kind: "user", status: "completed", output: { type: "user_text", text: "hello" } },
    { kind: "assistant", status: "streaming", output: { type: "assistant_text", text: "draft", reasoning: { text: "reason" }, error: "" } },
    { kind: "tool", status: "queued", output: { type: "tool", toolName: "bash", args: { command: "pwd" }, result: null } },
    { kind: "tool", status: "queued", output: { type: "tool", toolName: "mcp_demo_server", args: ["array"], result: "text" } },
    { kind: "tool", status: "queued", output: { type: "tool", toolName: "plugin_demo-plugin_run", args: null, result: { ok: true } } },
    { kind: "system", status: "completed", output: { type: "system_text", text: "system" } }
  ] as const;
  let prevId: number | null = null;
  let streamingAssistantId: number | null = null;
  for (const entry of outputs) {
    const response: { statusCode: number; body: string; json: () => unknown } = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/context-items",
      headers: headers(fixture),
      payload: {
        workspaceId: fixture.workspaceId,
        sessionId: session.id,
        runId: null,
        turnId: null,
        step: null,
        prevId,
        ...entry,
        ignoredTopLevelField: "accepted"
      }
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { ok: boolean; item: Record<string, unknown> };
    assert.equal(body.ok, true);
    assertCompleteContextRecord(body.item);
    assert.equal((body.item.output as { type: string }).type, entry.output.type);
    prevId = body.item.id as number;
    if (entry.kind === "assistant") streamingAssistantId = prevId;
  }

  assert.ok(streamingAssistantId);
  const update = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${streamingAssistantId}`,
    headers: headers(fixture),
    payload: {
      status: "completed",
      output: {
        type: "assistant_text",
        text: "final",
        reasoning: { text: "final reason" },
        ignoredOutputField: "not persisted"
      },
      ignoredTopLevelField: "accepted"
    }
  });
  assert.equal(update.statusCode, 200, update.body);
  const updatedBody = update.json() as { ok: boolean; item: Record<string, unknown> };
  assert.equal(updatedBody.ok, true);
  assertCompleteContextRecord(updatedBody.item);
  assert.deepEqual(updatedBody.item.output, { type: "assistant_text", text: "final", reasoning: { text: "final reason" } });
  assert.equal(
    fixture.contextHandlerBodies.every((body) => (body as { ignoredTopLevelField?: unknown }).ignoredTopLevelField === "accepted"),
    true,
    "preHandler should receive schema-valid Context request bodies with unknown top-level fields intact"
  );
});

test("Context compact returns the shared success shape and clears active run token usage", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 12_345,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "old context" },
    createdAt: Date.now()
  });
  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "summary",
    ignoredTopLevelField: "preserved before handler"
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { compacted: boolean; summaryItemId: number | null; archivedCount: number; ok?: unknown };
  assert.equal(body.compacted, true);
  assert.equal(typeof body.summaryItemId, "number");
  assert.equal(body.archivedCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "ok"), false);
  assert.equal(fixture.compactHandlerBodies.length, 1);
  assert.equal((fixture.compactHandlerBodies[0] as Record<string, unknown>).ignoredTopLevelField, "preserved before handler");
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt == null, false);
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), body.summaryItemId);
  assert.equal(getRunState(fixture.db, fixture.workspaceId, session.id).lastResponseTotalTokens, null);
  assert.equal(getRunState(fixture.db, fixture.workspaceId, session.id).activeRunId, runId);
});

test("Context compact token cleanup failure happens after archive and summary commit without archive rollback", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    lastResponseTotalTokens: 12_345,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn",
    step: 1,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "post-commit compact token failure" },
    createdAt: Date.now()
  });
  fixture.db.exec(`
    create trigger fail_compaction_token_cleanup
    before update on agent_session_run_state
    when new.last_response_total_tokens is null
    begin
      select raise(abort, 'injected token cleanup failure');
    end;
  `);

  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "summary survives token cleanup failure"
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt == null, false);
  const headItemId = getSessionHead(fixture.db, fixture.workspaceId, session.id);
  assert.ok(headItemId != null);
  assert.equal(getContextItemById(fixture.db, headItemId!)?.boundaryReason, "compaction");
  assert.equal(getRunState(fixture.db, fixture.workspaceId, session.id).lastResponseTotalTokens, 12_345);
  const archivePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  assert.ok((await fs.readFile(archivePath, "utf-8")).includes("post-commit compact token failure"));
  assert.equal(await fs.stat(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id)).then(() => true, () => false), false);
});

test("Clear idle write failure rolls back the archive append after summary and marker commit", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "post-commit clear idle failure" },
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: item.id
  });
  fixture.db.exec(`
    create trigger fail_clear_idle_write
    before update on agent_session_run_state
    when new.status = 'idle' and new.active_run_id is null
    begin
      select raise(abort, 'injected clear idle write failure');
    end;
  `);

  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: { workspaceId: fixture.workspaceId, reason: "P0 characterization" }
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt == null, false);
  const headItemId = getSessionHead(fixture.db, fixture.workspaceId, session.id);
  assert.ok(headItemId != null);
  assert.equal(getContextItemById(fixture.db, headItemId!)?.boundaryReason, "clear");
  const archivePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  assert.equal(await fs.readFile(archivePath, "utf-8"), "");
  assert.equal(await fs.stat(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id)).then(() => true, () => false), false);
});

test("Clear idle write failure writes a sidecar when rollback skips an externally extended archive", async () => {
  const fixture = await createFixture({
    agentTestFaults: { archiveRollback: { appendBeforeRollback: "external append\n" } }
  });
  const session = createSession(fixture);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "clear idle rollback skip" },
    createdAt: Date.now()
  });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: item.id
  });
  fixture.db.exec(`
    create trigger fail_clear_idle_write_with_external_append
    before update on agent_session_run_state
    when new.status = 'idle' and new.active_run_id is null
    begin
      select raise(abort, 'injected clear idle write failure');
    end;
  `);

  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/agent/sessions/${session.id}/clear`,
    payload: { workspaceId: fixture.workspaceId, reason: "P0 rollback skipped characterization" }
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt == null, false);
  const headItemId = getSessionHead(fixture.db, fixture.workspaceId, session.id);
  assert.ok(headItemId != null);
  assert.equal(getContextItemById(fixture.db, headItemId!)?.boundaryReason, "clear");
  const archivePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  const archiveText = await fs.readFile(archivePath, "utf-8");
  assert.ok(archiveText.includes("clear idle rollback skip"));
  assert.ok(archiveText.includes("external append"));
  const sidecar = JSON.parse(await fs.readFile(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id), "utf-8"));
  assert.equal(sidecar.operation, "clear");
  assert.equal(sidecar.snapshots.length, 1);
});

test("Context compact returns 200 compacted:false for empty and non-terminal visible context", async () => {
  const emptyFixture = await createFixture();
  const emptySession = createSession(emptyFixture);
  const emptyRunId = newSortableId("run");
  createRun(emptyFixture, emptySession.id, emptyRunId);
  const empty = await compact(emptyFixture, {
    workspaceId: emptyFixture.workspaceId,
    sessionId: emptySession.id,
    runId: emptyRunId,
    expectedHeadItemId: null,
    summaryText: "empty summary"
  });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), { compacted: false, summaryItemId: null, archivedCount: 0 });

  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "turn",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "still streaming" },
    createdAt: Date.now()
  });
  const nonTerminal = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "not yet"
  });
  assert.equal(nonTerminal.statusCode, 200, nonTerminal.body);
  assert.deepEqual(nonTerminal.json(), { compacted: false, summaryItemId: null, archivedCount: 0 });
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), item.id);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt, null);
});

test("Context compact keeps the Service precondition 409 body without a conflict code", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "context" },
    createdAt: Date.now()
  });
  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: null,
    summaryText: "summary"
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), { message: "session head conflict" });
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), item.id);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt, null);
});

test("Context compact preserves token priority over body schema validation", async () => {
  const fixture = await createFixture();
  const invalidBody = {
    workspaceId: fixture.workspaceId,
    sessionId: "",
    runId: "run",
    expectedHeadItemId: null,
    summaryText: ""
  };
  const invalidToken = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context/compact",
    headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
    payload: invalidBody
  });
  assert.equal(invalidToken.statusCode, 401, invalidToken.body);

  const validToken = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context/compact",
    headers: headers(fixture),
    payload: invalidBody
  });
  assert.equal(validToken.statusCode, 400, validToken.body);
});

test("Context create/update reject invalid output before response serialization and preserve token priority", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const createPayload = {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "tool",
    status: "queued",
    output: { type: "tool", toolName: "invalid tool name" }
  };
  const invalidCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: headers(fixture),
    payload: createPayload
  });
  assert.equal(invalidCreate.statusCode, 400);
  const invalidTokenCreate = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
    payload: createPayload
  });
  assert.equal(invalidTokenCreate.statusCode, 401);

  const valid = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: headers(fixture),
    payload: { ...createPayload, output: { type: "user_text", text: "valid" }, kind: "user", status: "streaming" }
  });
  const itemId = (valid.json() as { item: { id: number } }).item.id;
  const invalidUpdate = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${itemId}`,
    headers: headers(fixture),
    payload: { output: { type: "assistant_text" } }
  });
  assert.equal(invalidUpdate.statusCode, 400);
  const invalidTokenUpdate = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${itemId}`,
    headers: { "x-awb-agent-internal-token": "BAD_TOKEN" },
    payload: { output: { type: "assistant_text" } }
  });
  assert.equal(invalidTokenUpdate.statusCode, 401);
  const invalidToolUpdate = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${itemId}`,
    headers: headers(fixture),
    payload: { output: { type: "tool", toolName: "invalid tool name" } }
  });
  assert.equal(invalidToolUpdate.statusCode, 400);
});

test("Context create preserves head conflict and terminal update returns the unchanged stored item", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const createPayload = {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "first" }
  };
  const first = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: headers(fixture),
    payload: createPayload
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstItem = (first.json() as { item: { id: number } }).item;

  const conflict = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: headers(fixture),
    payload: { ...createPayload, output: { type: "user_text", text: "late" } }
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.match(String((conflict.json() as { code?: unknown }).code), /^conflict_head:/);

  const before = getContextItemById(fixture.db, firstItem.id);
  assert.ok(before);
  const terminalUpdate = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${firstItem.id}`,
    headers: headers(fixture),
    payload: {
      status: "failed",
      output: { type: "user_text", text: "must not persist" },
      updatedAt: Date.now() + 1_000
    }
  });
  assert.equal(terminalUpdate.statusCode, 200, terminalUpdate.body);
  const returned = (terminalUpdate.json() as { ok: boolean; item: Record<string, unknown> }).item;
  assertCompleteContextRecord(returned);
  assert.deepEqual(returned, before);
  assert.deepEqual(getContextItemById(fixture.db, firstItem.id), before);
});

test("Context create rejects a missing run without appending or returning ignored", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const beforeHead = getSessionHead(fixture.db, fixture.workspaceId, session.id);
  const beforeCount = Number(
    (fixture.db.prepare("select count(*) as count from agent_context_item where session_id = ?").get(session.id) as { count: number }).count
  );

  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: headers(fixture),
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: newSortableId("missing-run"),
      turnId: "missing-run-turn",
      step: 1,
      prevId: beforeHead,
      kind: "assistant",
      status: "streaming",
      output: { type: "assistant_text", text: "must not persist" }
    }
  });

  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(response.json(), { message: "run not found" });
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), beforeHead);
  assert.equal(
    (fixture.db.prepare("select count(*) as count from agent_context_item where session_id = ?").get(session.id) as { count: number }).count,
    beforeCount
  );
  assert.doesNotMatch(response.body, /ignored/);
});

test("Context create late fences terminal runs without changing context, title, or run state", async () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const fixture = await createFixture();
    const session = createSession(fixture);
    const runId = newSortableId("run");
    createRun(fixture, session.id, runId);
    updateRunRecordStatus(fixture.db, { runId, status, updatedAt: Date.now() });
    const beforeHead = getSessionHead(fixture.db, fixture.workspaceId, session.id);
    const beforeSession = fixture.db.prepare("select title from agent_session where id = ?").get(session.id) as { title: string };
    const beforeRun = getRunRecord(fixture.db, runId);

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/internal/agent/context-items",
      headers: headers(fixture),
      payload: {
        workspaceId: fixture.workspaceId,
        sessionId: session.id,
        runId,
        turnId: "late-turn",
        step: 1,
        prevId: beforeHead,
        kind: "tool",
        status: "completed",
        output: { type: "tool", toolName: "todolist", result: { goal: "must not become title" } }
      }
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, item: null, ignored: true });
    assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), beforeHead);
    assert.equal(getContextItemById(fixture.db, (beforeHead ?? 0) + 1), null);
    assert.equal((fixture.db.prepare("select title from agent_session where id = ?").get(session.id) as { title: string }).title, beforeSession.title);
    assert.deepEqual(getRunRecord(fixture.db, runId), beforeRun);
  }
});

for (const sidecarFault of [
  { name: "tmp 写入失败", fault: { failWrite: true } },
  { name: "rename 失败", fault: { failRename: true } }
]) test(`archive pending sidecar ${sidecarFault.name}不掩盖主流程错误`, async () => {
  const fixture = await createFixture({
    agentTestFaults: {
      archiveRollback: { appendBeforeRollback: "external mutation\n" },
      archiveSidecar: sidecarFault.fault
    }
  });
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "sidecar write failure" },
    createdAt: Date.now()
  });
  fixture.db.exec(`
    create trigger fail_compaction_for_sidecar_write
    before insert on agent_context_item
    when new.kind = 'system' and new.boundary_reason = 'compaction'
    begin
      select raise(abort, 'injected Store failure');
    end;
  `);
  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "must preserve original failure"
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(await fs.stat(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id)).then(() => true, () => false), false);
  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  const archiveEntries = await fs.readdir(archiveDir);
  assert.equal(archiveEntries.some((name) => name.startsWith(".pending-reconcile.json.") && name.endsWith(".tmp")), false);
  const archivePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  assert.ok((await fs.readFile(archivePath, "utf-8")).includes("sidecar write failure"));
});

test("同 session 的下一次 Worker compact 会先 reconcile pending archive", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "compact after reconcile" },
    createdAt: Date.now()
  });
  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  const archivePath = path.join(archiveDir, "00000001.log");
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(archivePath, "before\nafter\n", "utf-8");
  const beforeSize = Buffer.byteLength("before\n", "utf-8");
  await fs.writeFile(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id), JSON.stringify({
    version: 1,
    operation: "compaction",
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    createdAt: Date.now(),
    snapshots: [{
      fileKey: path.join("agent", "archive", fixture.workspaceId, session.id, "00000001.log"),
      beforeSize,
      expectedSize: Buffer.byteLength("before\nafter\n", "utf-8")
    }]
  }), "utf-8");

  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "compact after reconcile"
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await fs.stat(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id)).then(() => true, () => false), false);
  assert.ok((await fs.stat(archivePath)).size > beforeSize, "compaction should continue after reconciliation");
});

test("Context create late fences a run after activeRunId switches at the Store boundary", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  const nextRunId = newSortableId("run");
  createRun(fixture, session.id, runId);
  createRun(fixture, session.id, nextRunId);
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: nextRunId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });

  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/internal/agent/context-items",
    headers: headers(fixture),
    payload: {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId,
      turnId: "switched-turn",
      step: 1,
      prevId: null,
      kind: "assistant",
      status: "streaming",
      output: { type: "assistant_text", text: "late" }
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, item: null, ignored: true });
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), null);
  assert.deepEqual(getRunState(fixture.db, fixture.workspaceId, session.id).activeRunId, nextRunId);
});

test("Store append fence is authoritative within its transaction", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  const result = appendContextItemWithRunFence(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "late" },
    createdAt: Date.now()
  });
  assert.deepEqual(result, { kind: "ignored" });
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), null);
});

test("Context update late fences terminal and switched runs without changing the stored item", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  const nextRunId = newSortableId("run");
  createRun(fixture, session.id, runId);
  createRun(fixture, session.id, nextRunId);
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: runId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: "update-turn",
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "before" },
    createdAt: Date.now()
  });
  const before = getContextItemById(fixture.db, item.id);
  assert.ok(before);

  updateRunRecordStatus(fixture.db, { runId, status: "cancelled", updatedAt: Date.now() });
  const terminal = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${item.id}`,
    headers: headers(fixture),
    payload: { status: "completed", output: { type: "assistant_text", text: "must not persist" } }
  });
  assert.equal(terminal.statusCode, 200, terminal.body);
  assert.deepEqual((terminal.json() as { item: unknown }).item, before);
  assert.deepEqual(getContextItemById(fixture.db, item.id), before);

  updateRunRecordStatus(fixture.db, { runId, status: "running", updatedAt: Date.now() });
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    status: "running",
    activeRunId: nextRunId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  const switched = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${item.id}`,
    headers: headers(fixture),
    payload: { status: "completed", output: { type: "assistant_text", text: "must not persist either" } }
  });
  assert.equal(switched.statusCode, 200, switched.body);
  assert.deepEqual((switched.json() as { item: unknown }).item, before);
  assert.deepEqual(getContextItemById(fixture.db, item.id), before);
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), item.id);
});

test("Context update rejects an item whose run ownership is inconsistent", async () => {
  const fixture = await createFixture();
  const firstSession = createSession(fixture);
  const secondSession = createSession(fixture);
  const firstRunId = newSortableId("run");
  const secondRunId = newSortableId("run");
  createRun(fixture, firstSession.id, firstRunId);
  createRun(fixture, secondSession.id, secondRunId);
  updateRunState(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: firstSession.id,
    status: "running",
    activeRunId: firstRunId,
    activeAssistantItemId: null,
    updatedAt: Date.now(),
    appliedItemId: 0
  });
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: firstSession.id,
    runId: firstRunId,
    turnId: null,
    step: 1,
    prevId: null,
    kind: "assistant",
    status: "streaming",
    output: { type: "assistant_text", text: "before" },
    createdAt: Date.now()
  });
  fixture.db.prepare("update agent_context_item set run_id = ? where id = ?").run(secondRunId, item.id);

  const response = await fixture.app.inject({
    method: "PATCH",
    url: `/api/internal/agent/context-items/${item.id}`,
    headers: headers(fixture),
    payload: { status: "completed", output: { type: "assistant_text", text: "must not persist" } }
  });
  assert.equal(response.statusCode, 404, response.body);
  assert.match(response.body, /ownership mismatch/);
});

test("Store compact CAS rejects a stale head without committing DB changes", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "context" },
    createdAt: Date.now()
  });
  const before = getContextItemById(fixture.db, item.id);
  assert.ok(before);
  assert.throws(
    () => appendSystemSummaryAndArchiveItems(fixture.db, {
      workspaceId: fixture.workspaceId,
      sessionId: session.id,
      runId: null,
      expectedHeadItemId: null,
      summaryText: "stale summary",
      boundaryReason: "compaction",
      summaryCreatedAt: Date.now(),
      archiveItemIds: [item.id],
      archiveAt: Date.now()
    }),
    AgentConflictError
  );
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), item.id);
  assert.deepEqual(getContextItemById(fixture.db, item.id), before);
});

test("Context compact rolls back appended archive lines when the Store transaction fails", async () => {
  const fixture = await createFixture();
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "archive then fail" },
    createdAt: Date.now()
  });
  const before = getContextItemById(fixture.db, item.id);
  assert.ok(before);

  fixture.db.exec(`
    create trigger fail_compaction_summary_insert
    before insert on agent_context_item
    when new.kind = 'system' and new.boundary_reason = 'compaction'
    begin
      select raise(abort, 'injected compaction Store failure');
    end;
  `);

  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "summary should not persist"
  });
  assert.equal(response.statusCode, 500, response.body);

  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), item.id);
  assert.deepEqual(getContextItemById(fixture.db, item.id), before);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt, null);
  const summaryCount = fixture.db
    .prepare(
      "select count(*) as count from agent_context_item where session_id = ? and boundary_reason = 'compaction'"
    )
    .get(session.id) as { count: number };
  assert.equal(summaryCount.count, 0);
  const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
  const archivePath = path.join(archiveDir, "00000001.log");
  await assert.doesNotReject(async () => {
    assert.equal(await fs.readFile(archivePath, "utf-8"), "");
  });
});

test("Context compact 为 skipped archive rollback 写入最小 pending sidecar", async () => {
  const fixture = await createFixture({
    agentTestFaults: { archiveRollback: { appendBeforeRollback: "P0 archive mutation\n" } }
  });
  const session = createSession(fixture);
  const runId = newSortableId("run");
  createRun(fixture, session.id, runId);
  const item = appendContextItem(fixture.db, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "archive rollback skip baseline" },
    createdAt: Date.now()
  });
  fixture.db.exec(`
    create trigger fail_compaction_summary_insert_for_skipped_rollback
    before insert on agent_context_item
    when new.kind = 'system' and new.boundary_reason = 'compaction'
    begin
      select raise(abort, 'injected compaction Store failure');
    end;
  `);

  const response = await compact(fixture, {
    workspaceId: fixture.workspaceId,
    sessionId: session.id,
    runId,
    expectedHeadItemId: item.id,
    summaryText: "summary should fail after archive append"
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(getSessionHead(fixture.db, fixture.workspaceId, session.id), item.id);
  assert.equal(getContextItemById(fixture.db, item.id)?.archiveAt, null);

  const archivePath = path.join(agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id), "00000001.log");
  const archiveContent = await fs.readFile(archivePath, "utf-8");
  assert.ok(archiveContent.includes("archive rollback skip baseline"));
  assert.ok(archiveContent.includes("P0 archive mutation"));
  const sidecar = JSON.parse(await fs.readFile(agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id), "utf-8"));
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.operation, "compaction");
  assert.equal(sidecar.workspaceId, fixture.workspaceId);
  assert.equal(sidecar.sessionId, session.id);
  assert.equal(sidecar.runId, runId);
  assert.equal(sidecar.snapshots.length, 1);
  assert.equal(typeof sidecar.snapshots[0].fileKey, "string");
  assert.equal(sidecar.snapshots[0].fileKey.includes(fixture.dataDir), false);
  assert.equal(JSON.stringify(sidecar).includes("archive rollback skip baseline"), false);
});

test("archive pending reconcile 仅自动处理尺寸匹配的单文件 sidecar", async () => {
  for (const mode of ["match", "mismatch", "missing", "invalid", "foreign-session", "multiple"] as const) {
    const fixture = await createFixture();
    try {
      const session = createSession(fixture);
      const archiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, session.id);
      await fs.mkdir(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, "00000001.log");
      await fs.writeFile(archivePath, "before\nafter\n", "utf-8");
      const beforeSize = Buffer.byteLength("before\n", "utf-8");
      const expectedSize = Buffer.byteLength("before\nafter\n", "utf-8");
      const secondArchivePath = path.join(archiveDir, "00000002.log");
      if (mode === "multiple") {
        await fs.writeFile(secondArchivePath, "before\nafter\n", "utf-8");
      }
      let fileKey = path.join("agent", "archive", fixture.workspaceId, session.id, "00000001.log");
      let foreignArchivePath: string | null = null;
      if (mode === "foreign-session") {
        const otherSession = createSession(fixture);
        const otherArchiveDir = agentArchiveSessionDir(fixture.dataDir, fixture.workspaceId, otherSession.id);
        foreignArchivePath = path.join(otherArchiveDir, "00000001.log");
        await fs.mkdir(otherArchiveDir, { recursive: true });
        await fs.writeFile(foreignArchivePath, "before\nafter\n", "utf-8");
        fileKey = path.join("agent", "archive", fixture.workspaceId, otherSession.id, "00000001.log");
      }
      const sidecarPath = agentArchivePendingSidecarPath(fixture.dataDir, fixture.workspaceId, session.id);
      if (mode === "invalid") {
        await fs.writeFile(sidecarPath, "{invalid json", "utf-8");
      } else {
        await fs.writeFile(sidecarPath, JSON.stringify({
          version: 1,
          operation: "compaction",
          workspaceId: fixture.workspaceId,
          sessionId: session.id,
          createdAt: Date.now(),
          snapshots: [
            { fileKey, beforeSize, expectedSize },
            ...(mode === "multiple"
              ? [{ fileKey: path.join("agent", "archive", fixture.workspaceId, session.id, "00000002.log"), beforeSize, expectedSize }]
              : [])
          ]
        }), "utf-8");
      }
      if (mode === "mismatch") await fs.appendFile(archivePath, "changed\n", "utf-8");
      if (mode === "missing") await fs.rm(archivePath);

      const warnings: string[] = [];
      const logger = Object.assign(Object.create(fixture.app.log), {
        warn: (...args: unknown[]) => warnings.push(String(args.at(-1) ?? ""))
      }) as FastifyInstance["log"];
      const archiveStorage = new ArchiveStorage({ dataDir: fixture.dataDir, logger });
      const reconciled = await archiveStorage.reconcilePendingBestEffort({ workspaceId: fixture.workspaceId, sessionId: session.id });
      const shouldReconcile = mode === "match";
      assert.equal(reconciled, shouldReconcile, mode);
      assert.equal(await fs.stat(sidecarPath).then(() => true, () => false), !shouldReconcile, mode);
      if (mode === "match") assert.equal((await fs.stat(archivePath)).size, beforeSize);
      if (mode === "multiple") {
        assert.equal((await fs.stat(archivePath)).size, expectedSize, mode);
        assert.equal((await fs.stat(secondArchivePath)).size, expectedSize, mode);
        assert.ok(warnings.includes("archive pending sidecar has multiple snapshots; automatic reconcile skipped"), mode);
      }
      if (foreignArchivePath) assert.equal((await fs.stat(foreignArchivePath)).size, expectedSize, mode);
    } finally {
      await fixture.app.close();
      fixture.db.close();
      await rmrf(fixture.dataDir);
      fixtures.delete(fixture);
    }
  }
});
