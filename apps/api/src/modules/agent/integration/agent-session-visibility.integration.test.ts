import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createAgentComposition } from "../agent.composition.js";
import { HttpError } from "../../../app/errors.js";
import type { AgentApiSubtaskStartRequest, AgentApiSubtaskStartResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { AgentSessionVisibility } from "@agent-workbench/shared";
import { createMessageSession, createMessageRunRecord, appendMessage, getMessageSession, getMessageRunState } from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import { createP2Fixture, createMessageRunForTest, createMessageToolAnchor, startToolExecutionForTest } from "./subtask.helpers.js";

function session(fixture: AgentIntegrationFixture, visibility: AgentSessionVisibility, kind: "primary" | "subtask" = "primary", withText = true) {
  const id = newSortableId("sess");
  createMessageSession(fixture.db, { id, workspaceId: fixture.workspaceId, title: "visibility fixture", kind, visibility, createdAt: Date.now() });
  if (withText) {
    const messageId = newSortableId("msg");
    appendMessage(fixture.db, { id: messageId, workspaceId: fixture.workspaceId, sessionId: id, expectedHeadMessageId: null, expectedRevision: 0,
      type: "user", status: "completed", createdAt: Date.now(), parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "history" }] });
  }
  return getMessageSession(fixture.db, fixture.workspaceId, id)!;
}

function caller(fixture: AgentIntegrationFixture, visibility: AgentSessionVisibility, target: AgentApiSubtaskStartRequest["session"]) {
  const parent = session(fixture, visibility);
  const run = createMessageRunForTest({ fixture, sessionId: parent.id, subtaskDepth: 0 });
  const anchor = createMessageToolAnchor({ fixture, sessionId: parent.id, runId: run.runId, toolName: "subtask",
    input: { description: "child", prompt: "work", agentId: "default", session: target } });
  startToolExecutionForTest({ fixture, sessionId: parent.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId });
  const request: AgentApiSubtaskStartRequest = { workspaceId: fixture.workspaceId, parentSessionId: parent.id, parentRunId: run.runId,
    parentToolExecutionId: anchor.toolExecutionId, description: "child", prompt: "work", agentId: "default", session: target };
  return { parent, run, anchor, request };
}

function start(fixture: AgentIntegrationFixture, payload: AgentApiSubtaskStartRequest) {
  return fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start", headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload });
}

function snapshot(fixture: AgentIntegrationFixture) {
  return ["agent_session", "session_run_state", "workspace_session_tab_state", "agent_message", "agent_message_part", "agent_run", "agent_client_request", "agent_tool_execution"]
    .map((table) => fixture.db.prepare(`select * from ${table} order by rowid`).all());
}

test("HTTP Fork accepts visibility intent, inherits hidden sources, rejects invalid values and does not promote on open", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  for (const sourceVisibility of ["listed", "unlisted"] as const) {
    const source = session(fixture, sourceVisibility);
    for (const visibility of [undefined, "listed", "unlisted"] as const) {
      const response = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork",
        payload: { fromSessionId: source.id, fromMessageId: source.headMessageId, ...(visibility === undefined ? {} : { visibility }) } });
      assert.equal(response.statusCode, 201, response.body);
      const expected = sourceVisibility === "unlisted" || visibility === "unlisted" ? "unlisted" : "listed";
      assert.equal(response.json().visibility, expected);
      const opened = await fixture.app.inject({ method: "PUT", url: `/api/workspaces/${fixture.workspaceId}/agent-tab-state/${response.json().id}`, payload: { visible: true } });
      assert.equal(opened.statusCode, 200, opened.body);
      assert.equal(getMessageSession(fixture.db, fixture.workspaceId, response.json().id)!.visibility, expected);
    }
    for (const visibility of [null, "invalid", 1]) {
      const before = snapshot(fixture);
      const response = await fixture.app.inject({ method: "POST", url: "/api/agent/sessions/fork",
        payload: { fromSessionId: source.id, fromMessageId: source.headMessageId, visibility } });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(snapshot(fixture), before);
    }
  }
});

for (const mode of ["new", "fork", "stable", "summary"] as const) {
  test(`HTTP ${mode} subtask inherits actual unlisted execution parent`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const source = session(fixture, "listed");
    const target = mode === "new" ? { mode: "new" as const } : mode === "stable" ? { mode: "fork" as const, sourceSessionId: source.id } : { mode: "fork" as const };
    const call = caller(fixture, "unlisted", target);
    const response = await start(fixture, { ...call.request, ...(mode === "summary" ? { preforkSummaryText: "summary" } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<AgentApiSubtaskStartResponse>();
    const child = getMessageSession(fixture.db, fixture.workspaceId, result.sessionId)!;
    assert.equal(child.visibility, "unlisted");
    assert.equal(child.kind, "subtask");
    const tab = fixture.db.prepare("select visible from workspace_session_tab_state where session_id=?").get(child.id) as { visible: number };
    assert.equal(tab.visible, 0);
    assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, child.id)!.activeRunId, result.runId);
  });
}

for (const parentVisibility of ["listed", "unlisted"] as const) {
  for (const targetVisibility of ["listed", "unlisted"] as const) {
    test(`HTTP existing reuse ${parentVisibility} parent -> ${targetVisibility} target has exact zero-write rejection`, async (t) => {
      const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
      const target = session(fixture, targetVisibility, "subtask", false);
      const call = caller(fixture, parentVisibility, { mode: "existing", sessionId: target.id });
      fixture.db.prepare("update workspace_session_tab_state set visible=1,updated_at=42 where session_id=?").run(target.id);
      const before = snapshot(fixture);
      const response = await start(fixture, call.request);
      if (parentVisibility === "unlisted" && targetVisibility === "listed") {
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().code, "SUBTASK_SESSION_VISIBILITY_MISMATCH");
        assert.deepEqual(snapshot(fixture), before);
      } else {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().sessionId, target.id);
        assert.equal(getMessageSession(fixture.db, fixture.workspaceId, target.id)!.visibility, targetVisibility);
      }
      assert.deepEqual(fixture.db.prepare("select visible,updated_at as updatedAt from workspace_session_tab_state where session_id=?").get(target.id), { visible: 1, updatedAt: 42 });
    });
  }
}

test("HTTP already accepted listed child cannot bypass unlisted parent's policy", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const target = session(fixture, "listed", "subtask");
  const call = caller(fixture, "unlisted", { mode: "existing", sessionId: target.id });
  createMessageRunRecord(fixture.db, { runId: newSortableId("run"), workspaceId: fixture.workspaceId, sessionId: target.id,
    triggerMessageId: target.headMessageId, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", subtaskDepth: 1,
    parentRunId: call.run.runId, parentToolExecutionId: call.anchor.toolExecutionId, status: "completed", createdAt: Date.now() });
  const before = snapshot(fixture);
  const response = await start(fixture, call.request);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "SUBTASK_SESSION_VISIBILITY_MISMATCH");
  assert.deepEqual(snapshot(fixture), before);
});

test("two real SQLite connections produce one unlisted child Run and no loser Tab shell", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const call = caller(fixture, "unlisted", { mode: "new" });
  const beforeParent = getMessageSession(fixture.db, fixture.workspaceId, call.parent.id);
  const secondDb = new Database(fixture.db.name);
  secondDb.pragma("foreign_keys=ON");
  secondDb.pragma("busy_timeout=50");
  const firstComposition = createAgentComposition(fixture.ctx, fixture.app.log);
  const secondComposition = createAgentComposition({ ...fixture.ctx, db: secondDb }, fixture.app.log);
  t.after(() => { firstComposition.dispose(); secondComposition.dispose(); secondDb.close(); });
  // Both synchronous materializations finish before either continuation can activate.
  const firstStart = firstComposition.service.startSubtaskRunFromWorker(call.request);
  const secondStart = secondComposition.service.startSubtaskRunFromWorker(call.request);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_session where kind='subtask'").get() as { count: number }).count, 2);
  const [first, second] = await Promise.all([firstStart, secondStart]);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  assert.equal(first.runId, second.runId);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, first.sessionId)!.visibility, "unlisted");
  assert.deepEqual(fixture.db.prepare("select id from agent_session where kind='subtask'").all(), [{ id: first.sessionId }]);
  assert.equal((fixture.db.prepare("select count(*) as count from agent_run where parent_run_id=?").get(call.run.runId) as { count: number }).count, 1);
  assert.equal((fixture.db.prepare("select count(*) as count from workspace_session_tab_state tab left join agent_session session on session.id=tab.session_id where session.id is null").get() as { count: number }).count, 0);
  assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, call.parent.id), beforeParent);
});

test("a real SQLite activation loser rejects a listed winner and rolls back its messages before compensating only its hidden shell", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const call = caller(fixture, "unlisted", { mode: "new" });
  const composition = createAgentComposition(fixture.ctx, fixture.app.log);
  t.after(() => composition.dispose());
  const initial = snapshot(fixture);
  const pending = composition.service.startSubtaskRunFromWorker(call.request);
  const shells = fixture.db.prepare("select id,visibility from agent_session where kind='subtask'").all() as Array<{ id: string; visibility: string }>;
  assert.equal(shells.length, 1);
  assert.equal(shells[0]!.visibility, "unlisted");
  const winner = session(fixture, "listed", "subtask", false);
  const winnerRun = newSortableId("run");
  createMessageRunRecord(fixture.db, { runId: winnerRun, workspaceId: fixture.workspaceId, sessionId: winner.id,
    triggerMessageId: null, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2", subtaskDepth: 1,
    parentRunId: call.run.runId, parentToolExecutionId: call.anchor.toolExecutionId, status: "completed", createdAt: Date.now() });
  fixture.db.prepare("update workspace_session_tab_state set visible=1,updated_at=42 where session_id=?").run(winner.id);
  const winnerState = getMessageRunState(fixture.db, fixture.workspaceId, winner.id);
  const expectedRuns = fixture.db.prepare("select * from agent_run order by rowid").all();
  await assert.rejects(() => pending, (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === "SUBTASK_SESSION_VISIBILITY_MISMATCH");
  const final = snapshot(fixture);
  // No failed activation Message/part/dedup/tool mutation survives the unique conflict.
  for (const index of [3, 4, 6, 7]) assert.deepEqual(final[index], initial[index]);
  assert.deepEqual(fixture.db.prepare("select * from agent_run order by rowid").all(), expectedRuns);
  assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, winner.id), winner);
  assert.deepEqual(getMessageRunState(fixture.db, fixture.workspaceId, winner.id), winnerState);
  assert.deepEqual(fixture.db.prepare("select visible,updated_at as updatedAt from workspace_session_tab_state where session_id=?").get(winner.id), { visible: 1, updatedAt: 42 });
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, shells[0]!.id), null);
  assert.equal(fixture.db.prepare("select 1 from workspace_session_tab_state where session_id=?").get(shells[0]!.id), undefined);
  assert.deepEqual(fixture.db.prepare("select id from agent_session where kind='subtask'").all(), [{ id: winner.id }]);
});
