import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test, type TestContext } from "node:test";
import { createAgentComposition } from "../agent.composition.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import type { AgentApiSubtaskStartRequest, AgentApiSubtaskStartResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import { newSortableId } from "../../../utils/ids.js";
import { createTestWorkspace } from "../testkit/agent-testkit.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";
import {
  appendMessage, createMessageSession, getMessageSession, getMessageRunState,
  getRunRecord, getVisibleMessageChain, moveMessageHead, commitCompactionMessageForTest,
} from "../agent-message.store.js";
import {
  createP2Fixture, createSession, createMessageRunForTest,
  createMessageToolAnchor, startToolExecutionForTest,
} from "./subtask.helpers.js";

type Caller = Awaited<ReturnType<typeof caller>>;

async function caller(fixture: AgentIntegrationFixture, source?: string | ((id: string) => string)) {
  const parent = await createSession(fixture.app, fixture.workspaceId);
  const run = createMessageRunForTest({ fixture, sessionId: parent.id, subtaskDepth: 0, text: "caller history" });
  const sourceSessionId = typeof source === "function" ? source(parent.id) : source;
  const session = { mode: "fork" as const, ...(sourceSessionId !== undefined ? { sourceSessionId } : {}) };
  const anchor = createMessageToolAnchor({ fixture, sessionId: parent.id, runId: run.runId,
    toolName: "subtask", input: { description: "summary", prompt: "summarize stable history", agentId: "default", session } });
  startToolExecutionForTest({ fixture, sessionId: parent.id, runId: run.runId, toolExecutionId: anchor.toolExecutionId });
  return { parent, run, ...anchor, session };
}

function source(fixture: AgentIntegrationFixture, kind: "primary" | "subtask" = "primary", empty = false) {
  const id = newSortableId("sess");
  createMessageSession(fixture.db, { id, workspaceId: fixture.workspaceId, title: "source", kind, createdAt: Date.now() });
  if (!empty) text(fixture, id, "stable source history");
  return getMessageSession(fixture.db, fixture.workspaceId, id)!;
}

function text(fixture: AgentIntegrationFixture, sessionId: string, value: string) {
  const session = getMessageSession(fixture.db, fixture.workspaceId, sessionId)!;
  return appendMessage(fixture.db, { id: newSortableId("msg"), workspaceId: fixture.workspaceId, sessionId,
    expectedHeadMessageId: session.headMessageId, expectedRevision: session.revision,
    type: "user", status: "completed", parts: [{ id: newSortableId("part"), position: 0, type: "text", text: value }],
    createdAt: Date.now() });
}

function request(fixture: AgentIntegrationFixture, anchor: Caller, overrides: Partial<AgentApiSubtaskStartRequest> = {}): AgentApiSubtaskStartRequest {
  return { workspaceId: fixture.workspaceId, parentSessionId: anchor.parent.id,
    parentRunId: anchor.run.runId, parentToolExecutionId: anchor.toolExecutionId,
    description: "summary", prompt: "summarize stable history", agentId: "default", session: anchor.session, ...overrides };
}

async function start(fixture: AgentIntegrationFixture, anchor: Caller, overrides: Partial<AgentApiSubtaskStartRequest> = {}) {
  return fixture.app.inject({ method: "POST", url: "/api/internal/agent/subtask/start",
    headers: { "x-awb-agent-internal-token": fixture.internalToken }, payload: request(fixture, anchor, overrides) });
}

function childCount(fixture: AgentIntegrationFixture, anchor: Caller) {
  return (fixture.db.prepare("select count(*) as count from agent_run where parent_run_id = ? and parent_tool_execution_id = ?")
    .get(anchor.run.runId, anchor.toolExecutionId) as { count: number }).count;
}

function shellCount(fixture: AgentIntegrationFixture, sourceSessionId: string) {
  return (fixture.db.prepare("select count(*) as count from agent_session where kind = 'subtask' and forked_from_session_id = ?")
    .get(sourceSessionId) as { count: number }).count;
}

function assertError(response: Awaited<ReturnType<typeof start>>, status: number, code: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().code, code);
}

function directComposition(t: TestContext, fixture: AgentIntegrationFixture, db = fixture.db) {
  const composition = createAgentComposition({ ...fixture.ctx, db }, fixture.app.log);
  t.after(() => composition.dispose());
  return composition;
}

for (const kind of ["primary", "subtask"] as const) {
  for (const active of [false, true]) {
    test(`explicit fork: ${active ? "running" : "idle"} ${kind} source has independent lineage and single-field response`, async (t) => {
      const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
      const origin = source(fixture, kind);
      if (active) {
        const sourceRun = createMessageRunForTest({ fixture, sessionId: origin.id, subtaskDepth: 7, text: "active source history" });
        fixture.db.prepare("update agent_run set agent_id = 'source-agent', model_id = 'source-model' where run_id = ?").run(sourceRun.runId);
      }
      fixture.db.prepare("insert into agent_session_agent_model_override (session_id, agent_id, provider_id, model_id, updated_at) values (?, 'default', 'source-provider', 'source-model', 1)").run(origin.id);
      const before = getMessageSession(fixture.db, fixture.workspaceId, origin.id)!;
      const beforeState = getMessageRunState(fixture.db, fixture.workspaceId, origin.id);
      const anchor = await caller(fixture, origin.id);
      const response = await start(fixture, anchor);
      assert.equal(response.statusCode, 200, response.body);
      const child = response.json<AgentApiSubtaskStartResponse>();
      assert.deepEqual(Object.keys(child).sort(), ["agentName", "reused", "runId", "sessionId", "sourceSessionId", "workspacePath"]);
      assert.equal(child.sourceSessionId, origin.id);
      assert.equal(child.reused, false);
      const session = getMessageSession(fixture.db, fixture.workspaceId, child.sessionId)!;
      assert.equal(session.kind, "subtask");
      assert.equal(session.forkedFromSessionId, origin.id);
      assert.equal(session.forkedFromMessageId, before.headMessageId);
      assert.equal(session.contextRootMessageId, before.contextRootMessageId);
      const run = getRunRecord(fixture.db, child.runId)!;
      assert.equal(run.parentRunId, anchor.run.runId);
      assert.equal(run.parentToolExecutionId, anchor.toolExecutionId);
      assert.equal(run.subtaskDepth, 1);
      assert.equal(run.agentId, "default");
      assert.equal(run.modelId, "gpt-5.2");
      assert.equal((fixture.db.prepare("select count(*) as count from agent_session_agent_model_override where session_id = ?")
        .get(child.sessionId) as { count: number }).count, 0);
      assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, child.sessionId)?.lastResponseTotalTokens, null);
      assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, origin.id), before);
      assert.deepEqual(getMessageRunState(fixture.db, fixture.workspaceId, origin.id), beforeState);
      assert.equal(childCount(fixture, anchor), 1);
    });
  }
}

test("explicit source=caller excludes the entire pending tool Assistant and is distinguished from implicit fork", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const anchor = await caller(fixture, (id) => id);
  const response = await start(fixture, anchor);
  assert.equal(response.statusCode, 200, response.body);
  const child = response.json<AgentApiSubtaskStartResponse>();
  assert.equal(child.sourceSessionId, anchor.parent.id);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, child.sessionId)?.forkedFromMessageId, anchor.run.triggerMessageId);
  assert.equal(getVisibleMessageChain(fixture.db, { workspaceId: fixture.workspaceId, sessionId: child.sessionId }).some((item) => item.id === anchor.assistantMessageId), false);
  const retry = await start(fixture, anchor);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), { ...child, reused: true });
  const implicit = await caller(fixture);
  const old = await start(fixture, implicit);
  assert.equal(old.statusCode, 200, old.body);
  assert.equal(Object.hasOwn(old.json(), "sourceSessionId"), false);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, old.json().sessionId)?.forkedFromSessionId, implicit.parent.id);
});

test("explicit retry never recaptures a source after forward, rollback, or source deletion", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const origin = source(fixture);
  const anchor = await caller(fixture, origin.id);
  const response = await start(fixture, anchor);
  assert.equal(response.statusCode, 200, response.body);
  const child = response.json<AgentApiSubtaskStartResponse>();
  const saved = getMessageSession(fixture.db, fixture.workspaceId, child.sessionId)!;
  text(fixture, origin.id, "source advanced");
  const advanced = await start(fixture, anchor);
  assert.equal(advanced.statusCode, 200, advanced.body);
  assert.deepEqual(advanced.json(), { ...child, reused: true });
  const current = getMessageSession(fixture.db, fixture.workspaceId, origin.id)!;
  moveMessageHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId: origin.id,
    expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision,
    nextHeadMessageId: origin.headMessageId!, updatedAt: Date.now() });
  const rolledBack = await start(fixture, anchor);
  assert.equal(rolledBack.statusCode, 200, rolledBack.body);
  assert.deepEqual(rolledBack.json(), { ...child, reused: true });
  // A Session's fork source is a logical ID, not a live-query prerequisite.
  fixture.db.prepare("delete from agent_session where id = ?").run(origin.id);
  const unavailable = await start(fixture, anchor);
  assert.equal(unavailable.statusCode, 200, unavailable.body);
  assert.deepEqual(unavailable.json(), { ...child, reused: true });
  assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, child.sessionId), saved);
  assert.equal(childCount(fixture, anchor), 1);
});

test("each new parent tool captures the source's current rolled-back branch", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const origin = source(fixture);
  const future = text(fixture, origin.id, "future source history");
  const first = await caller(fixture, origin.id);
  const initial = await start(fixture, first);
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, initial.json().sessionId)?.forkedFromMessageId, future.id);
  const current = getMessageSession(fixture.db, fixture.workspaceId, origin.id)!;
  moveMessageHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId: origin.id,
    expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision,
    nextHeadMessageId: origin.headMessageId!, updatedAt: Date.now() });
  const second = await caller(fixture, origin.id);
  const next = await start(fixture, second);
  assert.equal(next.statusCode, 200, next.body);
  assert.notEqual(next.json().sessionId, initial.json().sessionId);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, next.json().sessionId)?.forkedFromMessageId, origin.headMessageId);
});

for (const change of ["implicit-to-explicit", "explicit-to-implicit", "different-source", "old-worker-prefork"] as const) {
  test(`source input binding rejects ${change} before materialization or caller prefork`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture);
    const anchor = await caller(fixture, change === "implicit-to-explicit" ? undefined : origin.id);
    const overrides: Partial<AgentApiSubtaskStartRequest> = {
      session: change === "implicit-to-explicit" ? { mode: "fork", sourceSessionId: origin.id }
        : change === "different-source" ? { mode: "fork", sourceSessionId: "unavailable-source" } : { mode: "fork" },
    };
    if (change === "old-worker-prefork") {
      overrides.preforkSummaryText = "caller summary";
      overrides.preforkMeta = { thresholdPct: 95, parentLastResponseTotalTokens: 1, childContextWindowTokens: 1 };
    }
    assertError(await start(fixture, anchor, overrides), 409, "AGENT_SUBTASK_FORK_SOURCE_MISMATCH");
    assert.equal(childCount(fixture, anchor), 0);
    assert.equal(shellCount(fixture, origin.id), 0);
  });
}

test("trimmed source input and transport match; retries reject changed input semantics or Child source relations", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const origin = source(fixture);
  const anchor = await caller(fixture, ` ${origin.id} `);
  const response = await start(fixture, anchor, { session: { mode: "fork", sourceSessionId: origin.id } });
  assert.equal(response.statusCode, 200, response.body);
  const child = response.json<AgentApiSubtaskStartResponse>();
  assert.equal(child.sourceSessionId, origin.id);
  assertError(await start(fixture, anchor, { session: { mode: "fork" } }), 409, "AGENT_SUBTASK_FORK_SOURCE_MISMATCH");
  assertError(await start(fixture, anchor, { session: { mode: "fork", sourceSessionId: "different-source" } }), 409, "AGENT_SUBTASK_FORK_SOURCE_MISMATCH");
  fixture.db.prepare("update agent_session set forked_from_session_id = ? where id = ?").run(anchor.parent.id, child.sessionId);
  assertError(await start(fixture, anchor), 409, "AGENT_SUBTASK_FORK_SOURCE_MISMATCH");
  assert.equal(childCount(fixture, anchor), 1);
  assert.ok(getMessageSession(fixture.db, fixture.workspaceId, child.sessionId));
  fixture.db.prepare("update agent_message_part set tool_input_json = '{' where id = ?").run(anchor.callPartId);
  assertError(await start(fixture, anchor), 400, "AGENT_SUBTASK_ANCHOR_INVALID");
  assert.equal(childCount(fixture, anchor), 1);
});

for (const input of [null, "", "{", "null", "[]", "1", '"input"',
  '{"session":{"mode":"fork","sourceSessionId":null}}',
  '{"session":{"mode":"fork","sourceSessionId":9}}',
  '{"session":{"mode":"fork","sourceSessionId":" "}}',
  '{"session":{"mode":"new","sourceSessionId":"source"}}',
  '{"session":{"mode":"invalid","sourceSessionId":"source"}}']) {
  test(`corrupt persisted tool input returns ANCHOR_INVALID (${String(input)})`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture);
    const anchor = await caller(fixture, origin.id);
    // Simulate legacy/corrupt disk state; normal writes cannot omit a ToolCall input.
    if (input === null) fixture.db.pragma("ignore_check_constraints = ON");
    fixture.db.prepare("update agent_message_part set tool_input_json = ? where id = ?").run(input, anchor.callPartId);
    if (input === null) fixture.db.pragma("ignore_check_constraints = OFF");
    assertError(await start(fixture, anchor), 400, "AGENT_SUBTASK_ANCHOR_INVALID");
    assert.equal(childCount(fixture, anchor), 0);
    assert.equal(shellCount(fixture, origin.id), 0);
  });
}

for (const scenario of ["missing", "foreign", "empty", "bad-root"] as const) {
  test(`explicit source ${scenario} maps to fixed safe error without fallback or leaked shell`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture, "primary", scenario === "empty");
    let sourceId = origin.id;
    if (scenario === "missing") sourceId = "missing-source";
    if (scenario === "foreign") {
      const other = await createTestWorkspace(fixture, { title: "other" });
      fixture.db.prepare("update agent_session set workspace_id = ? where id = ?").run(other.id, origin.id);
    }
    if (scenario === "bad-root") {
      fixture.db.prepare("update agent_session set context_root_message_id = ? where id = ?").run(origin.headMessageId, origin.id);
      fixture.db.prepare("update agent_message set status = 'failed' where id = ?").run(origin.headMessageId);
    }
    const anchor = await caller(fixture, sourceId);
    const response = await start(fixture, anchor);
    const unavailable = scenario === "missing" || scenario === "foreign";
    assertError(response, unavailable ? 404 : 409, unavailable ? "AGENT_SUBTASK_FORK_SOURCE_UNAVAILABLE"
      : scenario === "empty" ? "AGENT_SUBTASK_FORK_SOURCE_NO_STABLE_CONTEXT" : "AGENT_SUBTASK_FORK_SOURCE_CONTEXT_INVALID");
    assert.equal(response.json().message, unavailable ? "fork source is unavailable"
      : scenario === "empty" ? "fork source has no stable context" : "fork source context is invalid");
    assert.equal(childCount(fixture, anchor), 0);
    assert.equal(shellCount(fixture, sourceId), 0);
  });
}

for (const failure of ["profile", "prompt", "parent"] as const) {
  test(`explicit source!=caller pre-activation ${failure} failure safely compensates only the empty child`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture);
    const anchor = await caller(fixture, origin.id);
    const before = getMessageSession(fixture.db, fixture.workspaceId, origin.id)!;
    const beforeMessages = getVisibleMessageChain(fixture.db, { workspaceId: fixture.workspaceId, sessionId: origin.id });
    if (failure === "parent") {
      fixture.db.exec(`create trigger cancel_explicit_parent_after_materialization after insert on agent_session
        when new.kind = 'subtask' and new.forked_from_session_id = '${origin.id}' begin
        update agent_run set status = 'cancelled', execution_phase = 'terminal', intended_terminal_status = null,
          intended_terminal_code = null, intended_terminal_detail = null, terminal_result_code = 'run_cancelled',
          terminal_result_detail = null where run_id = '${anchor.run.runId}';
        update session_run_state set status = 'idle', active_run_id = null where session_id = '${anchor.parent.id}'; end;`);
    }
    const response = await start(fixture, anchor, failure === "profile" ? { agentId: "nonexistent-agent" }
      : failure === "prompt" ? { prompt: "   " } : {});
    assert.notEqual(response.statusCode, 200, response.body);
    if (failure === "prompt") assertError(response, 400, "AGENT_SUBTASK_PROMPT_REQUIRED");
    if (failure === "parent") assertError(response, 409, "AGENT_SUBTASK_PARENT_NOT_ACTIVE");
    assert.equal(shellCount(fixture, origin.id), 0);
    assert.equal(childCount(fixture, anchor), 0);
    assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, origin.id), before);
    assert.deepEqual(getVisibleMessageChain(fixture.db, { workspaceId: fixture.workspaceId, sessionId: origin.id }), beforeMessages);
  });
}

test("two real SQLite connections racing the same parent produce one Child and no loser shell", async (t) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const origin = source(fixture);
  const anchor = await caller(fixture, origin.id);
  const secondDb = new Database(fixture.db.name);
  secondDb.pragma("foreign_keys = ON");
  secondDb.pragma("busy_timeout = 50");
  t.after(() => secondDb.close());
  const first = directComposition(t, fixture).service;
  const second = directComposition(t, fixture, secondDb).service;
  const transportedRequest = {
    ...request(fixture, anchor),
    session: { mode: "fork" as const, sourceSessionId: ` ${origin.id} ` },
  };
  // Each synchronous materializer finishes before its await yields. Both
  // Sessions exist before either activation; SQLite's unique Child wins.
  const firstStart = first.startSubtaskRunFromWorker(transportedRequest);
  assert.equal(shellCount(fixture, origin.id), 1);
  const later = text(fixture, origin.id, "source advanced between competing materializations");
  const secondStart = second.startSubtaskRunFromWorker(transportedRequest);
  assert.equal(shellCount(fixture, origin.id), 2);
  assert.equal(childCount(fixture, anchor), 0);
  const captured = fixture.db.prepare("select forked_from_message_id as anchor from agent_session where forked_from_session_id = ?")
    .all(origin.id) as Array<{ anchor: string }>;
  assert.deepEqual(captured.map((item) => item.anchor).sort(), [origin.headMessageId, later.id].sort());
  const results = await Promise.all([firstStart, secondStart]);
  assert.deepEqual(results.map((item) => item.reused).sort(), [false, true]);
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal(results[0].runId, results[1].runId);
  assert.equal(results[0].sourceSessionId, origin.id);
  assert.equal(results[1].sourceSessionId, origin.id);
  assert.equal(childCount(fixture, anchor), 1);
  assert.equal(shellCount(fixture, origin.id), 1);
  assert.equal(getMessageSession(fixture.db, fixture.workspaceId, results[0].sessionId)?.forkedFromMessageId, origin.headMessageId);
  const retry = await start(fixture, anchor);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().sessionId, results[0].sessionId);
});

for (const cancelTarget of ["caller", "source", "self-source"] as const) {
  test(`cancellation follows execution parent rather than history source (${cancelTarget})`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture);
    const sourceRun = createMessageRunForTest({ fixture, sessionId: origin.id, subtaskDepth: 0 });
    const anchor = await caller(fixture, cancelTarget === "self-source" ? (id) => id : origin.id);
    const response = await start(fixture, anchor);
    assert.equal(response.statusCode, 200, response.body);
    const child = response.json<AgentApiSubtaskStartResponse>();
    const target = cancelTarget === "source" ? origin.id : anchor.parent.id;
    const cancelled = await fixture.app.inject({ method: "POST", url: `/api/agent/sessions/${target}/cancel`,
      payload: { workspaceId: fixture.workspaceId } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    if (cancelTarget === "source") {
      assert.equal(getRunRecord(fixture.db, sourceRun.runId)?.status, "cancelled");
      assert.equal(getRunRecord(fixture.db, child.runId)?.status, "running");
      assert.equal(getRunRecord(fixture.db, anchor.run.runId)?.status, "running");
    } else {
      assert.equal(getRunRecord(fixture.db, child.runId)?.status, "cancelled");
      assert.equal(getMessageRunState(fixture.db, fixture.workspaceId, child.sessionId)?.status, "idle");
      assert.equal(getRunRecord(fixture.db, sourceRun.runId)?.status, "running");
    }
    assert.ok(getMessageSession(fixture.db, fixture.workspaceId, child.sessionId));
  });
}


for (const timing of ["before", "after-materialization"] as const) {
  test(`explicit Fork respects the Workspace deleting fence (${timing})`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture);
    const anchor = await caller(fixture, origin.id);
    const service = directComposition(t, fixture).service;
    const before = getMessageSession(fixture.db, fixture.workspaceId, origin.id);
    let pending: ReturnType<typeof service.startSubtaskRunFromWorker>;
    if (timing === "after-materialization") {
      pending = service.startSubtaskRunFromWorker(request(fixture, anchor));
      assert.equal(shellCount(fixture, origin.id), 1);
      workspaceDeletingFence.begin(fixture.workspaceId);
    } else {
      workspaceDeletingFence.begin(fixture.workspaceId);
      pending = service.startSubtaskRunFromWorker(request(fixture, anchor));
    }
    try {
      await assert.rejects(() => pending, (error: unknown) => error instanceof Error
        && "code" in error && error.code === "WORKSPACE_DELETING");
    } finally {
      workspaceDeletingFence.end(fixture.workspaceId);
    }
    assert.equal(shellCount(fixture, origin.id), 0);
    assert.equal(childCount(fixture, anchor), 0);
    assert.deepEqual(getMessageSession(fixture.db, fixture.workspaceId, origin.id), before);
  });
}

for (const depth of [null, 100]) {
  test(`explicit source does not bypass the parent depth guard (${depth})`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture);
    const anchor = await caller(fixture, origin.id);
    fixture.db.prepare("update agent_run set subtask_depth = ? where run_id = ?").run(depth, anchor.run.runId);
    assertError(await start(fixture, anchor), 409, depth === null ? "AGENT_SUBTASK_DEPTH_UNKNOWN" : "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED");
    assert.equal(shellCount(fixture, origin.id), 0);
    assert.equal(childCount(fixture, anchor), 0);
  });
}


for (const root of ["system", "compaction"] as const) {
  test(`explicit start inherits a legal internal ${root} boundary and source context`, async (t) => {
    const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
    const origin = source(fixture, "primary", root === "system");
    const id = newSortableId("msg");
    if (root === "system") {
      appendMessage(fixture.db, { id, workspaceId: fixture.workspaceId, sessionId: origin.id,
        expectedHeadMessageId: null, expectedRevision: 0, type: "system", status: "completed",
        parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "source system history" }], createdAt: Date.now() });
    } else {
      commitCompactionMessageForTest(fixture.db, { id, workspaceId: fixture.workspaceId, sessionId: origin.id,
        expectedHeadMessageId: origin.headMessageId, expectedRevision: origin.revision,
        textPartId: newSortableId("part"), text: "source compaction summary", retainedFromMessageId: null, createdAt: Date.now() });
    }
    const anchor = await caller(fixture, origin.id);
    const response = await start(fixture, anchor);
    assert.equal(response.statusCode, 200, response.body);
    const child = response.json<AgentApiSubtaskStartResponse>();
    const session = getMessageSession(fixture.db, fixture.workspaceId, child.sessionId)!;
    assert.equal(session.forkedFromMessageId, id);
    assert.equal(session.contextRootMessageId, id);
    const context = await fixture.app.inject({ method: "POST", url: "/api/internal/agent/prompt-context",
      headers: { "x-awb-agent-internal-token": fixture.internalToken },
      payload: { workspaceId: fixture.workspaceId, sessionId: child.sessionId, runId: child.runId } });
    assert.equal(context.statusCode, 200, context.body);
    const inherited = JSON.stringify(context.json());
    assert.equal(inherited.includes(root === "system" ? "source system history" : "source compaction summary"), true);
    assert.equal(inherited.includes("caller history"), false);
  });
}
