import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import type { AgentSessionVisibility } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendMessage, appendStreamingAssistant, completeAssistantWithExecutions, createMessageRunRecord,
  createMessageSession, flushStreamingParts, forkHistoricalMessageSession, getMessageRunState,
  getMessageSession, HistoricalForkSessionConflictError, startMessageRun, updateToolExecution,
} from "../agent-message.store.js";
import { SqliteRunLifecyclePersistence } from "../lifecycle/sqlite-run-lifecycle-persistence.js";
import { SessionInteractionApplication } from "./session-interaction-application.js";
import { SqliteSessionInteractionStore } from "./sqlite-session-interaction-store.js";

const workspaceId = "ws";

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  initSchema(db);
  t.after(() => db.close());
  for (const id of [workspaceId, "foreign"]) {
    db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values (?,?,?,?,1,1)")
      .run(id, id, id, `/workspace/${id}`);
  }
  let sequence = 0;
  const store = new SqliteSessionInteractionStore({
    db, workspaceExists: (id) => Boolean(db.prepare("select 1 from workspaces where id=?").get(id)),
    getControlRunState: (id) => getMessageRunState(db, workspaceId, id)!,
  });
  const application = new SessionInteractionApplication({
    store,
    profileReader: { resolveUser: () => ({ agentId: "agent", providerId: "provider", modelId: "model" }) },
    lifecycleStarter: { startUserRun: async () => { throw new Error("not used in creation tests"); } },
    clock: { nowMs: () => 100 }, ids: { newSessionId: () => `child-${++sequence}` },
    logger: { warn: () => undefined }, normalizeUiLocale: () => null,
    isConflict: () => false, toConflictHttpError: (error) => error as Error,
  });
  return { db, application };
}

function create(db: Database.Database, id: string, visibility: AgentSessionVisibility = "listed", kind: "primary" | "subtask" = "primary", ws = workspaceId) {
  createMessageSession(db, { id, workspaceId: ws, title: id, kind, visibility, createdAt: 1 });
  return getMessageSession(db, ws, id)!;
}

function text(db: Database.Database, id: string, messageId = `${id}-user`) {
  const session = getMessageSession(db, workspaceId, id)!;
  appendMessage(db, { id: messageId, workspaceId, sessionId: id, expectedHeadMessageId: session.headMessageId,
    expectedRevision: session.revision, type: "user", status: "completed", createdAt: 2,
    parts: [{ id: `${messageId}-text`, position: 0, type: "text", text: "history" }] });
}

function parent(db: Database.Database, visibility: AgentSessionVisibility) {
  create(db, "parent", visibility);
  text(db, "parent");
  createMessageRunRecord(db, { runId: "parent-run", workspaceId, sessionId: "parent", triggerMessageId: "parent-user",
    agentId: "agent", providerId: "provider", modelId: "model", subtaskDepth: 0, status: "running", createdAt: 3 });
  startMessageRun(db, { workspaceId, sessionId: "parent", runId: "parent-run", updatedAt: 3 });
  appendStreamingAssistant(db, { id: "parent-assistant", workspaceId, sessionId: "parent", runId: "parent-run",
    expectedHeadMessageId: "parent-user", expectedRevision: 1, createdAt: 4 });
  flushStreamingParts(db, { workspaceId, sessionId: "parent", runId: "parent-run", messageId: "parent-assistant",
    parts: [{ id: "parent-call", position: 0, type: "tool_call", toolName: "subtask", input: { session: { mode: "fork" } } }], updatedAt: 5 });
  completeAssistantWithExecutions(db, { workspaceId, sessionId: "parent", runId: "parent-run", messageId: "parent-assistant",
    executions: [{ id: "parent-execution", callPartId: "parent-call", originSessionId: "parent", originRunId: "parent-run", status: "queued" }], updatedAt: 6 });
  updateToolExecution(db, { workspaceId, sessionId: "parent", runId: "parent-run", executionId: "parent-execution", status: "running", updatedAt: 7 });
  return { sessionId: "parent", runId: "parent-run", toolExecutionId: "parent-execution" };
}

function snapshot(db: Database.Database) {
  return ["agent_session", "session_run_state", "workspace_session_tab_state", "agent_message", "agent_message_part", "agent_run", "agent_client_request", "agent_tool_execution"]
    .map((table) => db.prepare(`select * from ${table} order by rowid`).all());
}

function tab(db: Database.Database, id: string) {
  return db.prepare("select visible,updated_at as updatedAt from workspace_session_tab_state where session_id=?").get(id) as { visible: number; updatedAt: number };
}

for (const parentVisibility of ["listed", "unlisted"] as const) {
  for (const sourceVisibility of ["listed", "unlisted"] as const) {
    for (const visibility of [undefined, "listed", "unlisted"] as const) {
      test(`creation policy matrix: parent=${parentVisibility}, source=${sourceVisibility}, intent=${visibility}`, (t) => {
        const { db } = fixture(t);
        const executionParent = parent(db, parentVisibility);
        create(db, "source", sourceVisibility);
        const expected = [parentVisibility, sourceVisibility, visibility].includes("unlisted") ? "unlisted" : "listed";
        createMessageSession(db, { id: "derived", workspaceId, title: "derived", kind: "primary", createdAt: 10,
          executionParent, contentSourceSessionId: "source", visibility });
        assert.equal(getMessageSession(db, workspaceId, "derived")!.visibility, expected);
        assert.equal(tab(db, "derived").visible, expected === "listed" ? 1 : 0);
      });
    }
  }
}

for (const visibility of ["listed", "unlisted"] as const) {
  for (const path of ["new", "resolved", "stable", "summary", "no-boundary"] as const) {
    test(`subtask materialization ${path} inherits ${visibility} parent even without content ancestry`, async (t) => {
      const { db, application } = fixture(t);
      parent(db, visibility);
      create(db, "source");
      text(db, "source");
      const { session } = await application.resolveSubtaskSessionForStart({
        workspaceId, parentSessionId: "parent", parentRunId: "parent-run", parentToolExecutionId: "parent-execution",
        subtaskTitleBase: "child",
        session: path === "new" ? { mode: "new" } : path === "stable" ? { mode: "fork", sourceSessionId: "source" } : { mode: "fork" },
        forkBoundaryMessageId: path === "no-boundary" ? null : "parent-user", shouldUsePreforkSummary: path === "summary",
      });
      assert.equal(session.visibility, visibility);
      assert.equal(tab(db, session.id).visible, 0);
      if (path === "no-boundary") assert.equal(session.forkedFromSessionId, null);
      if (path === "summary" || path === "new") assert.equal(session.forkedFromMessageId, null);
      if (path === "stable") assert.equal(session.forkedFromSessionId, "source");
    });
  }
}

test("listed execution parent with an unlisted stable content source derives unlisted", async (t) => {
  const { db, application } = fixture(t);
  parent(db, "listed"); create(db, "source", "unlisted"); text(db, "source");
  const result = await application.resolveSubtaskSessionForStart({ workspaceId, parentSessionId: "parent", parentRunId: "parent-run",
    parentToolExecutionId: "parent-execution", session: { mode: "fork", sourceSessionId: "source" },
    subtaskTitleBase: "stable", forkBoundaryMessageId: null, shouldUsePreforkSummary: false });
  assert.equal(result.session.visibility, "unlisted");
});

for (const sourceVisibility of ["listed", "unlisted"] as const) {
  for (const visibility of [undefined, "listed", "unlisted"] as const) {
    test(`public and historical Fork use authoritative ${sourceVisibility} source for ${visibility} intent`, async (t) => {
      const { db, application } = fixture(t);
      create(db, "source", sourceVisibility); text(db, "source");
      const sourceBefore = getMessageSession(db, workspaceId, "source");
      const expected = sourceVisibility === "unlisted" || visibility === "unlisted" ? "unlisted" : "listed";
      const publicFork = await application.forkPrimarySession({ fromSessionId: "source", fromMessageId: "source-user", visibility });
      assert.equal(publicFork.visibility, expected);
      assert.equal(tab(db, publicFork.id).visible, expected === "listed" ? 1 : 0);
      const historical = application.forkPrimarySessionFromHistoricalAnchorWithExpectedId({ workspaceId, sessionId: "historical", sourceSessionId: "source",
        targetMessageId: "source-user", title: "Historical", visibility });
      assert.equal(historical.visibility, expected);
      db.prepare("update workspace_session_tab_state set visible=1,updated_at=42 where session_id=?").run(historical.id);
      assert.equal(application.forkPrimarySessionFromHistoricalAnchorWithExpectedId({ workspaceId, sessionId: "historical", sourceSessionId: "source",
        targetMessageId: "source-user", title: "Historical", visibility }).id, historical.id);
      assert.deepEqual(tab(db, historical.id), { visible: 1, updatedAt: 42 });
      assert.deepEqual(getMessageSession(db, workspaceId, "source"), sourceBefore);
    });
  }
}

test("a stale/forged caller projection cannot make an unlisted source's Fork listed", async (t) => {
  const { db } = fixture(t);
  const source = create(db, "source", "unlisted"); text(db, "source");
  const store = new SqliteSessionInteractionStore({ db, workspaceExists: () => true, getControlRunState: () => { throw new Error("unused"); } });
  const fork = await store.cloneSession({ id: "child", createdAt: 10, fromSession: { ...source, visibility: "listed" }, fromMessageId: "source-user",
    targetKind: "primary", boundaryPolicy: "public-user-assistant", visibility: "listed" });
  assert.equal(fork.visibility, "unlisted");
});

test("invalid execution binding or missing/cross-workspace content source creates no partial state", (t) => {
  const { db } = fixture(t);
  const executionParent = parent(db, "unlisted");
  create(db, "foreign-source", "unlisted", "primary", "foreign");
  for (const policy of [
    { executionParent: { ...executionParent, runId: "missing-run" } },
    { executionParent: { ...executionParent, toolExecutionId: "missing-execution" } },
    { executionParent: { ...executionParent, sessionId: "foreign-source" } },
    { executionParent, contentSourceSessionId: "missing-source" },
    { executionParent, contentSourceSessionId: "foreign-source" },
  ]) {
    const before = snapshot(db);
    assert.throws(() => createMessageSession(db, { id: "invalid", workspaceId, kind: "subtask", title: "invalid", createdAt: 10, ...policy }), HttpError);
    assert.deepEqual(snapshot(db), before);
  }
});

test("preallocated primary identity includes visibility, but never current Tab visible", (t) => {
  const { db, application } = fixture(t);
  const input = { workspaceId, sessionId: "preallocated", title: "Expected", visibility: "unlisted" as const };
  assert.equal(application.createPrimarySessionWithExpectedId(input).visibility, "unlisted");
  db.prepare("update workspace_session_tab_state set visible=1,updated_at=42 where session_id=?").run(input.sessionId);
  assert.equal(application.createPrimarySessionWithExpectedId(input).id, input.sessionId);
  assert.deepEqual(tab(db, input.sessionId), { visible: 1, updatedAt: 42 });
  const before = snapshot(db);
  assert.throws(() => application.createPrimarySessionWithExpectedId({ ...input, visibility: "listed" }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === "SESSION_ID_CONFLICT");
  assert.deepEqual(snapshot(db), before);
});

test("historical expected identity rejects opposite visibility without changing the target or Tab", (t) => {
  const { db } = fixture(t);
  create(db, "source"); text(db, "source");
  const input = { workspaceId, id: "preallocated", sourceSessionId: "source", targetMessageId: "source-user", title: "Fork", createdAt: 10 };
  forkHistoricalMessageSession(db, { ...input, visibility: "listed" });
  const before = snapshot(db);
  assert.throws(() => forkHistoricalMessageSession(db, { ...input, visibility: "unlisted" }), HistoricalForkSessionConflictError);
  assert.deepEqual(snapshot(db), before);
});

for (const parentVisibility of ["listed", "unlisted"] as const) {
  for (const targetVisibility of ["listed", "unlisted"] as const) {
    test(`reuse and activation: ${parentVisibility} parent to ${targetVisibility} child`, async (t) => {
      const { db, application } = fixture(t);
      parent(db, parentVisibility);
      create(db, "target", targetVisibility, "subtask");
      db.prepare("update workspace_session_tab_state set visible=1,updated_at=42 where session_id='target'").run();
      const command = { workspaceId, parentSessionId: "parent", parentRunId: "parent-run", parentToolExecutionId: "parent-execution",
        session: { mode: "existing" as const, sessionId: "target" }, subtaskTitleBase: "reuse", forkBoundaryMessageId: null, shouldUsePreforkSummary: false };
      const activation = { workspaceId, sessionId: "target", runId: "child-run", parentRunId: "parent-run", parentToolExecutionId: "parent-execution",
        subtaskDepth: 1, agentId: "agent", providerId: "provider", modelId: "model", uiLocale: null, createdAt: 20, systemTexts: ["guard"], prompt: "work" };
      const persistence = new SqliteRunLifecyclePersistence(db);
      if (parentVisibility === "unlisted" && targetVisibility === "listed") {
        const before = snapshot(db);
        const mismatch = (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === "SUBTASK_SESSION_VISIBILITY_MISMATCH";
        await assert.rejects(() => application.resolveSubtaskSessionForStart(command), mismatch);
        assert.deepEqual(snapshot(db), before);
        assert.throws(() => persistence.activate(activation), mismatch);
        assert.deepEqual(snapshot(db), before);
      } else {
        assert.equal((await application.resolveSubtaskSessionForStart(command)).createdSessionId, null);
        assert.equal(persistence.activate(activation).kind, "activated");
        assert.equal(getMessageSession(db, workspaceId, "target")!.visibility, targetVisibility);
        assert.deepEqual(tab(db, "target"), { visible: 1, updatedAt: 42 });
      }
    });
  }
}

test("subtask activation preserves the existing busy-session fence precedence with no writes", (t) => {
  const { db } = fixture(t);
  parent(db, "listed"); create(db, "busy", "listed", "subtask");
  createMessageRunRecord(db, { runId: "busy-run", workspaceId, sessionId: "busy", triggerMessageId: null,
    agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 10 });
  startMessageRun(db, { workspaceId, sessionId: "busy", runId: "busy-run", updatedAt: 10 });
  updateToolExecution(db, { workspaceId, sessionId: "parent", runId: "parent-run", executionId: "parent-execution", status: "completed", updatedAt: 11 });
  const before = snapshot(db);
  assert.deepEqual(new SqliteRunLifecyclePersistence(db).activate({ workspaceId, sessionId: "busy", runId: "new-run",
    parentRunId: "parent-run", parentToolExecutionId: "parent-execution", subtaskDepth: 1, agentId: "agent", providerId: "provider", modelId: "model",
    uiLocale: null, createdAt: 20, systemTexts: [], prompt: "work" }), { kind: "session-running" });
  assert.deepEqual(snapshot(db), before);
});
