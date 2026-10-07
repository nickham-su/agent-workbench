import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, type TestContext } from "node:test";
import type { AgentMessageStatus, AgentMessageType, AgentToolExecutionStatus } from "@agent-workbench/shared";
import { initSchema } from "../../infra/db/schema.js";
import {
  AgentMessageDomainError,
  HistoricalForkSourceError,
  StableForkSourceError,
  appendMessage,
  appendStreamingAssistant,
  commitCompactionMessageForTest,
  createMessageRunRecord,
  createMessageSession,
  forkMessageSession,
  forkStableSourceSession,
  flushStreamingParts,
  getMessage,
  getMessageRunState,
  getMessageSession,
  moveMessageHead,
  startMessageRun,
  validateHistoricalForkSource,
} from "./agent-message.store.js";
import { ModelContextResolver } from "./read-side/model-context-resolver.js";
import { RuntimeTranscriptProjector } from "./read-side/runtime-transcript-projector.js";
import { SqliteSessionInteractionStore } from "./session/sqlite-session-interaction-store.js";

function initialize(db: Database.Database, kind: "primary" | "subtask" = "primary") {
  db.pragma("foreign_keys = ON");
  initSchema(db);
  for (const id of ["ws", "other"]) {
    db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values (?,?,?,?,1,1)")
      .run(id, id, id, path.resolve(".tmp-tests", id));
  }
  createMessageSession(db, { id: "source", workspaceId: "ws", title: "source", kind, createdAt: 1 });
}

function fixture(t: TestContext, kind: "primary" | "subtask" = "primary") {
  const db = new Database(":memory:");
  initialize(db, kind);
  t.after(() => db.close());
  return db;
}

function append(db: Database.Database, id: string, options: {
  type?: AgentMessageType; status?: AgentMessageStatus; sessionId?: string;
  tools?: AgentToolExecutionStatus[]; runId?: string;
} = {}) {
  const sessionId = options.sessionId ?? "source";
  const session = getMessageSession(db, "ws", sessionId)!;
  const result = appendMessage(db, {
    id, workspaceId: "ws", sessionId, expectedHeadMessageId: session.headMessageId,
    expectedRevision: session.revision, type: options.type ?? "user", status: options.status ?? "completed",
    originRunId: options.runId,
    parts: [
      { id: `${id}-text`, type: "text", position: 0, text: id },
      ...(options.tools ?? []).map((_, index) => ({
        id: `${id}-call-${index}`, type: "tool_call" as const, position: index + 1,
        toolName: "bash" as const, input: { command: "example" }, providerToolCallId: `call-${id}-${index}`,
      })),
    ],
    createdAt: session.revision + 2,
  });
  for (const [index, status] of (options.tools ?? []).entries()) {
    db.prepare(`insert into agent_tool_execution
      (id,call_part_id,origin_session_id,origin_run_id,status,result_preview,error,updated_revision,created_at,updated_at)
      values (?,?,?,?,?,'result',?,1,1,1)`)
      .run(`${id}-execution-${index}`, `${id}-call-${index}`, sessionId, options.runId ?? null, status,
        status === "failed" ? "tool failed" : null);
  }
  return result;
}

function compact(db: Database.Database, id = "summary", retainedFromMessageId: string | null = null) {
  const session = getMessageSession(db, "ws", "source")!;
  return commitCompactionMessageForTest(db, {
    id, workspaceId: "ws", sessionId: "source", expectedHeadMessageId: session.headMessageId,
    expectedRevision: session.revision, textPartId: `${id}-text`, text: "stable summary",
    retainedFromMessageId, createdAt: session.revision + 2,
  });
}

function fork(db: Database.Database, id = "child", sourceSessionId = "source") {
  return forkStableSourceSession(db, { id, workspaceId: "ws", sourceSessionId, title: id, createdAt: 100 });
}

function context(db: Database.Database, sessionId: string) {
  return new ModelContextResolver(db).resolve({ workspaceId: "ws", sessionId });
}

function expectFailure(db: Database.Database, code: StableForkSourceError["code"], sourceSessionId = "source") {
  const sessions = db.prepare("select * from agent_session order by id").all();
  const states = db.prepare("select * from session_run_state order by session_id").all();
  assert.throws(() => fork(db, "child", sourceSessionId), (error: unknown) =>
    error instanceof StableForkSourceError && error.code === code && error.message === code);
  assert.deepEqual(db.prepare("select * from agent_session order by id").all(), sessions);
  assert.deepEqual(db.prepare("select * from session_run_state order by session_id").all(), states);
}

// Deliberately malformed databases are isolated, in-memory fixtures, never production state.
function corrupt(db: Database.Database, mutate: () => void, triggers: string[] = []) {
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  for (const name of triggers) db.exec(`drop trigger ${name}`);
  mutate();
  db.pragma("ignore_check_constraints = OFF");
  db.pragma("foreign_keys = ON");
}

for (const kind of ["primary", "subtask"] as const) {
  test(`stable Fork accepts a running ${kind}, sharing history without inheriting Run or token state`, (t) => {
    const db = fixture(t, kind);
    append(db, "u");
    append(db, "a", { type: "assistant", tools: ["completed"] });
    createMessageRunRecord(db, {
      runId: "active-source-run", workspaceId: "ws", sessionId: "source", triggerMessageId: "u",
      agentId: "source-agent", providerId: "source-provider", modelId: "source-model", status: "running", createdAt: 5,
    });
    db.prepare(`update session_run_state set status='running',active_run_id='active-source-run',
      last_response_total_tokens=1234,non_terminal_tool_execution_ids_json='["unrelated"]' where session_id='source'`).run();
    db.prepare(`insert into agent_session_agent_model_override (session_id,agent_id,provider_id,model_id,updated_at)
      values ('source','source-agent','source-provider','source-model',1)`).run();
    const originalSession = getMessageSession(db, "ws", "source");
    const originalState = getMessageRunState(db, "ws", "source");
    const count = db.prepare("select count(*) as n from agent_message").get();
    const child = fork(db);
    assert.equal(child.kind, "subtask");
    assert.equal(child.forkedFromSessionId, "source");
    assert.equal(child.forkedFromMessageId, "a");
    assert.equal(child.headMessageId, "a");
    assert.equal(child.contextRootMessageId, "u");
    assert.equal(child.revision, 0);
    const childState = getMessageRunState(db, "ws", "child")!;
    assert.equal(childState.status, "idle");
    assert.equal(childState.activeRunId, null);
    assert.equal(childState.lastResponseTotalTokens, null);
    assert.deepEqual(childState.nonTerminalToolExecutionIds, []);
    assert.deepEqual(childState.nonTerminalMessageIds, []);
    assert.deepEqual(getMessageSession(db, "ws", "source"), originalSession);
    assert.deepEqual(getMessageRunState(db, "ws", "source"), originalState);
    assert.deepEqual(db.prepare("select count(*) as n from agent_message").get(), count);
    assert.equal(db.prepare("select 1 from agent_session_agent_model_override where session_id='child'").get(), undefined);
    assert.equal(db.prepare("select 1 from agent_run where session_id='child'").get(), undefined);
    assert.deepEqual(context(db, "child").messages.map((m) => m.id), ["u", "a"]);
  });
}

test("streaming is a barrier even with completed descendants; source changes never extend the child", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "stream", { type: "assistant", status: "streaming" });
  append(db, "later");
  const source = getMessageSession(db, "ws", "source");
  assert.equal(fork(db).headMessageId, "u");
  assert.deepEqual(context(db, "child").messages.map((m) => m.id), ["u"]);
  assert.deepEqual(getMessageSession(db, "ws", "source"), source);
  db.prepare("update agent_message set status='completed' where id='stream'").run();
  append(db, "newer");
  assert.equal(fork(db, "next-child").headMessageId, "newer");
  assert.equal(getMessageSession(db, "ws", "child")!.headMessageId, "u");
});

test("production streaming Part updates after Fork never enter the inherited stable context", (t) => {
  const db = fixture(t);
  append(db, "u");
  createMessageRunRecord(db, { runId: "run-stream", workspaceId: "ws", sessionId: "source",
    triggerMessageId: "u", agentId: "default", providerId: "provider", modelId: "model",
    status: "running", createdAt: 2 });
  startMessageRun(db, { workspaceId: "ws", sessionId: "source", runId: "run-stream", updatedAt: 2 });
  const source = getMessageSession(db, "ws", "source")!;
  appendStreamingAssistant(db, { id: "stream", workspaceId: "ws", sessionId: "source",
    runId: "run-stream", expectedHeadMessageId: source.headMessageId, expectedRevision: source.revision, createdAt: 3 });
  const update = (text: string, updatedAt: number) => flushStreamingParts(db, {
    workspaceId: "ws", sessionId: "source", runId: "run-stream", messageId: "stream",
    parts: [{ id: "stream-text", position: 0, type: "text", text }], updatedAt,
  });
  assert.equal(update("initial partial", 4), "updated");
  assert.equal(fork(db).headMessageId, "u");
  assert.equal(update("initial partial continued after Fork", 5), "updated");
  assert.equal((getMessage(db, "stream")!.parts[0] as { text: string }).text, "initial partial continued after Fork");
  const inherited = context(db, "child");
  assert.deepEqual(inherited.messages.map((message) => message.id), ["u"]);
  assert.doesNotMatch(JSON.stringify(inherited.messages), /partial/);
  assert.equal(getMessageSession(db, "ws", "child")!.forkedFromMessageId, "u");
  assert.equal(getMessageRunState(db, "ws", "source")!.status, "running");
});

for (const pending of ["queued", "running"] as const) {
  test(`a ${pending} tool excludes its complete Assistant, including the other completed tool`, (t) => {
    const db = fixture(t);
    append(db, "u");
    append(db, "a", { type: "assistant", tools: ["completed", pending] });
    append(db, "later");
    assert.equal(fork(db).headMessageId, "u");
    const inherited = context(db, "child");
    assert.deepEqual(inherited.messages.map((m) => m.id), ["u"]);
    assert.deepEqual(inherited.executions, []);
    assert.equal(getMessage(db, "a")!.parts.length, 3);
  });
}

for (const status of ["completed", "failed", "cancelled", "unknown"] as const) {
  test(`terminal ${status} tools remain ordered and paired, without being re-executed`, (t) => {
    const db = fixture(t);
    append(db, "u");
    append(db, "a", { type: "assistant", tools: [status, "completed"] });
    assert.equal(fork(db).headMessageId, "a");
    const inherited = context(db, "child");
    assert.deepEqual(inherited.executions.map((e) => e.status), [status, "completed"]);
    const projected = new RuntimeTranscriptProjector().project({ workspaceId: "ws", triggerMessageId: null,
      messages: inherited.messages, executions: inherited.executions });
    assert.deepEqual(projected.map((m) => m.role), ["user", "assistant", "tool"]);
    assert.equal(projected[2]!.content.length, 2);
  });
}

test("excluded Message terminals and runtime never become the branch boundary", (t) => {
  const db = fixture(t);
  append(db, "u");
  for (const status of ["failed", "cancelled", "superseded"] as const) append(db, status, { type: "assistant", status });
  append(db, "runtime", { type: "runtime" });
  assert.equal(fork(db).headMessageId, "u");
  assert.deepEqual(context(db, "child").messages.map((m) => m.id), ["u"]);
});

for (const status of ["streaming", "failed", "cancelled", "superseded"] as const) {
  test(`ordinary ${status} root cannot fall back to an older ancestor`, (t) => {
    const db = fixture(t);
    append(db, "old");
    append(db, "root", { type: "assistant", status });
    db.prepare("update agent_session set context_root_message_id='root' where id='source'").run();
    expectFailure(db, status === "streaming" ? "NO_STABLE_CONTEXT" : "CONTEXT_INVALID");
  });
}

test("a completed Assistant root with queued tools has no stable context, not an old root fallback", (t) => {
  const db = fixture(t);
  append(db, "old");
  append(db, "root", { type: "assistant", tools: ["queued"] });
  db.prepare("update agent_session set context_root_message_id='root' where id='source'").run();
  expectFailure(db, "NO_STABLE_CONTEXT");
});

test("System root and head are legal internal boundaries, without widening public or scheduled Fork", (t) => {
  const db = fixture(t);
  append(db, "system", { type: "system" });
  const source = getMessageSession(db, "ws", "source")!;
  const store = new SqliteSessionInteractionStore({
    db, workspaceExists: () => true,
    getControlRunState: (id) => getMessageRunState(db, "ws", id)!,
  });
  const child = store.forkStableSourceSession({ id: "child", workspaceId: "ws", sourceSessionId: "source", title: "child", createdAt: 5 });
  assert.equal(child.headMessageId, "system");
  assert.equal(child.contextRootMessageId, "system");
  const target = { id: "public-child", workspaceId: "ws", sourceSessionId: "source", title: "public", kind: "primary" as const,
    expectedHeadMessageId: source.headMessageId, expectedRevision: source.revision, targetMessageId: "system", createdAt: 10 };
  assert.throws(() => forkMessageSession(db, target), (error: unknown) => error instanceof AgentMessageDomainError && error.code === "FORK_TARGET_INVALID");
  assert.throws(() => validateHistoricalForkSource(db, target), HistoricalForkSourceError);
  assert.throws(() => validateHistoricalForkSource(db, { ...target, sourceSessionId: "child" }), HistoricalForkSourceError);
});

for (const tail of ["none", "streaming", "stable"] as const) {
  test(`compaction root retains its complete window with ${tail} tail`, (t) => {
    const db = fixture(t);
    append(db, "old");
    append(db, "retained");
    append(db, "retained-a", { type: "assistant", tools: ["completed"] });
    compact(db, "summary", "retained");
    if (tail !== "none") append(db, "tail", { type: "assistant", status: tail === "streaming" ? "streaming" : "completed" });
    const child = fork(db);
    assert.equal(child.headMessageId, tail === "stable" ? "tail" : "summary");
    assert.equal(child.contextRootMessageId, "summary");
    assert.deepEqual(context(db, "child").messages.map((m) => m.id),
      ["summary", "retained", "retained-a", ...(tail === "stable" ? ["tail"] : [])]);
    assert.equal(context(db, "child").executions.length, 1);
    assert.equal(child.forkedFromMessageId, child.headMessageId);
    assert.throws(() => forkMessageSession(db, {
      id: "public-child", workspaceId: "ws", sourceSessionId: "source", expectedHeadMessageId: getMessageSession(db, "ws", "source")!.headMessageId,
      expectedRevision: getMessageSession(db, "ws", "source")!.revision, targetMessageId: "summary", title: "public", kind: "primary", createdAt: 12,
    }), AgentMessageDomainError);
  });
}

for (const state of ["streaming", "queued", "running", "failed-with-pending", "runtime-with-pending"] as const) {
  test(`necessary raw retained ${state} is invalid, never filtered or truncated`, (t) => {
    const db = fixture(t);
    append(db, "retained");
    append(db, "retained-a", { type: "assistant", tools: ["completed"] });
    compact(db, "summary", "retained");
    if (state === "streaming") db.prepare("update agent_message set status='streaming' where id='retained-a'").run();
    else {
      db.prepare("update agent_tool_execution set status=? where id='retained-a-execution-0'").run(state === "running" ? "running" : "queued");
      if (state === "failed-with-pending") db.prepare("update agent_message set status='failed' where id='retained-a'").run();
      if (state === "runtime-with-pending") db.prepare("update agent_message set type='runtime' where id='retained-a'").run();
    }
    expectFailure(db, "CONTEXT_INVALID");
  });
}

for (const damage of ["streaming", "empty-summary", "bad-retained", "missing-parts"] as const) {
  test(`compaction ${damage} is context-invalid and creates no child`, (t) => {
    const db = fixture(t);
    append(db, "retained");
    compact(db, "summary", "retained");
    if (damage === "streaming") db.prepare("update agent_message set status='streaming' where id='summary'").run();
    if (damage === "empty-summary") db.prepare("update agent_message_part set text='' where id='summary-text'").run();
    if (damage === "missing-parts") corrupt(db, () => db.prepare("delete from agent_message_part where message_id='summary'").run());
    if (damage === "bad-retained") corrupt(db,
      () => db.prepare("update agent_message set retained_from_message_id='summary' where id='summary'").run(),
      ["agent_message_retained_workspace_update", "agent_message_retained_immutable_update"]);
    expectFailure(db, "CONTEXT_INVALID");
  });
}

test("a forked source may share ancestors owned by another Session; rollback captures only the current branch", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "a", { type: "assistant" });
  fork(db, "forked-source");
  append(db, "source-later");
  append(db, "fork-later", { sessionId: "forked-source" });
  assert.equal(fork(db, "inherited", "forked-source").headMessageId, "fork-later");
  assert.deepEqual(context(db, "inherited").messages.map((m) => m.id), ["u", "a", "fork-later"]);
  const source = getMessageSession(db, "ws", "source")!;
  moveMessageHead(db, { workspaceId: "ws", sessionId: "source", expectedHeadMessageId: source.headMessageId,
    expectedRevision: source.revision, nextHeadMessageId: "u", updatedAt: 100 });
  assert.equal(fork(db, "after-rollback").headMessageId, "u");
  assert.equal(getMessageSession(db, "ws", "inherited")!.headMessageId, "fork-later");
  compact(db, "source-summary");
  assert.equal(getMessageSession(db, "ws", "after-rollback")!.contextRootMessageId, "u");
  append(db, "child-own", { sessionId: "after-rollback" });
  assert.equal(getMessageSession(db, "ws", "source")!.headMessageId, "source-summary");
});

for (const damage of ["missing-head", "missing-ancestor", "cross-workspace", "cycle", "root-off-branch"] as const) {
  test(`physical ${damage} is rejected even before non-retained compaction history`, (t) => {
    const db = fixture(t);
    append(db, "u");
    append(db, "a", { type: "assistant" });
    compact(db);
    corrupt(db, () => {
      if (damage === "missing-head") db.prepare("update agent_session set head_message_id='missing' where id='source'").run();
      if (damage === "missing-ancestor") db.prepare("update agent_message set previous_message_id='missing' where id='a'").run();
      if (damage === "cross-workspace") db.prepare("update agent_message set workspace_id='other' where id='u'").run();
      if (damage === "cycle") db.prepare("update agent_message set previous_message_id='a' where id='u'").run();
      if (damage === "root-off-branch") db.prepare("update agent_session set context_root_message_id='missing' where id='source'").run();
    }, ["agent_message_session_head_workspace_update"]);
    expectFailure(db, "CONTEXT_INVALID");
  });
}

test("physical ancestry over the existing 10,000 traversal guard fails in finite time", (t) => {
  const db = fixture(t);
  db.transaction(() => {
    const insert = db.prepare(`insert into agent_message
      (id,workspace_id,previous_message_id,depth,type,status,origin_session_id,updated_revision,created_at,updated_at)
      values (?,'ws',?,?,'user','completed','source',1,1,1)`);
    for (let index = 0; index <= 10_001; index++) insert.run(`m${index}`, index ? `m${index - 1}` : null, index);
    db.prepare("update agent_session set head_message_id='m10001',context_root_message_id='m0' where id='source'").run();
  })();
  expectFailure(db, "CONTEXT_INVALID");
});

for (const damage of ["missing-execution", "duplicate-execution", "owner", "status", "input", "replay", "parts"] as const) {
  test(`required context ${damage} damage is not mistaken for pending work`, (t) => {
    const db = fixture(t);
    append(db, "u");
    append(db, "a", { type: "assistant", tools: ["completed"] });
    append(db, "tail");
    if (damage === "missing-execution") db.prepare("delete from agent_tool_execution").run();
    if (damage === "duplicate-execution") corrupt(db, () => {
      db.exec(`alter table agent_tool_execution rename to execution_backup;
        create table agent_tool_execution as select * from execution_backup;
        insert into agent_tool_execution select 'duplicate',call_part_id,origin_session_id,origin_run_id,status,
          result_preview,result_truncated,result_artifact_path,structured_result_json,error,updated_revision,
          created_at,updated_at,started_at,completed_at from execution_backup;`);
    });
    if (damage === "owner") db.prepare("update agent_tool_execution set origin_session_id=null").run();
    if (damage === "status") corrupt(db, () => db.prepare("update agent_tool_execution set status='broken'").run());
    if (damage === "input") db.prepare("update agent_message_part set tool_input_json='{' where type='tool_call'").run();
    if (damage === "replay") db.prepare("update agent_message_part set provider_replay_json='{}' where id='a-text'").run();
    if (damage === "parts") corrupt(db, () => db.prepare("update agent_message_part set text=null where id='a-text'").run());
    expectFailure(db, "CONTEXT_INVALID");
  });
}

test("invalid ordinary root Parts take precedence over no-stable pending state", (t) => {
  const db = fixture(t);
  append(db, "root", { type: "assistant", tools: ["queued"] });
  db.prepare("update agent_message_part set tool_input_json='{' where type='tool_call'").run();
  expectFailure(db, "CONTEXT_INVALID");
});

test("legacy Chat replay without endpoint identity retains existing degradation", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "a", { type: "assistant" });
  db.prepare("update agent_message_part set provider_replay_json=? where id='a-text'").run(JSON.stringify({
    version: 1, provider: { npm: "@ai-sdk/deepseek", api: "chat-completions", protocolVersion: 1,
      providerId: "provider", model: "model" },
    item: { type: "text" },
  }));
  assert.equal(fork(db).headMessageId, "a");
  assert.equal(context(db, "child").providerReplayByPartId.size, 0);
});

for (const history of ["empty", "streaming", "excluded", "runtime-root"] as const) {
  test(`${history} source distinguishes absent context from an explicitly invalid root`, (t) => {
    const db = fixture(t);
    if (history === "streaming") append(db, "root", { status: "streaming" });
    if (history === "excluded") {
      append(db, "root", { status: "failed" });
      db.prepare("update agent_session set context_root_message_id=null where id='source'").run();
    }
    if (history === "runtime-root") append(db, "root", { type: "runtime" });
    expectFailure(db, history === "runtime-root" ? "CONTEXT_INVALID" : "NO_STABLE_CONTEXT");
  });
}

test("missing and foreign Workspace sources return identical fixed unavailable diagnostics", (t) => {
  const db = fixture(t);
  createMessageSession(db, { id: "foreign", workspaceId: "other", title: "not exposed", kind: "primary", createdAt: 1 });
  expectFailure(db, "SOURCE_UNAVAILABLE", "missing");
  expectFailure(db, "SOURCE_UNAVAILABLE", "foreign");
});

test("creation conflicts roll back the whole operation, not leaving run-state-only residue", (t) => {
  const db = fixture(t);
  append(db, "u");
  fork(db);
  const sessions = db.prepare("select * from agent_session order by id").all();
  const states = db.prepare("select * from session_run_state order by session_id").all();
  assert.throws(() => fork(db), (error: unknown) => error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY");
  assert.deepEqual(db.prepare("select * from agent_session order by id").all(), sessions);
  assert.deepEqual(db.prepare("select * from session_run_state order by session_id").all(), states);
});

for (const mutation of ["append", "compaction", "rollback", "tool-completion"] as const) {
  test(`WAL two-connection ${mutation} cannot interleave source reads and materialization`, (t) => {
    const root = path.resolve(".tmp-tests");
    fs.mkdirSync(root, { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, "stable-fork-"));
    let rival: Database.Database | undefined;
    let armed = false;
    let attempted = false;
    let competingWrite: () => void = () => undefined;
    const db = new Database(path.join(directory, "db.sqlite"), { verbose: (sql) => {
      if (!armed || attempted || !/from agent_session where id/.test(String(sql))) return;
      attempted = true;
      assert.equal(db.inTransaction, true);
      assert.throws(competingWrite, (error: unknown) => error instanceof Error && "code" in error && error.code === "SQLITE_BUSY");
    } });
    t.after(() => { rival?.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    initialize(db);
    db.pragma("journal_mode = WAL");
    append(db, "u");
    append(db, "a", { type: "assistant", tools: mutation === "tool-completion" ? ["queued"] : [] });
    rival = new Database(path.join(directory, "db.sqlite"));
    rival.pragma("foreign_keys = ON");
    rival.pragma("busy_timeout = 1");
    competingWrite = () => rival!.transaction(() => {
      if (mutation === "append") append(rival!, "concurrent");
      if (mutation === "compaction") compact(rival!, "concurrent-summary");
      if (mutation === "rollback") {
        const source = getMessageSession(rival!, "ws", "source")!;
        moveMessageHead(rival!, { workspaceId: "ws", sessionId: "source", expectedHeadMessageId: source.headMessageId,
          expectedRevision: source.revision, nextHeadMessageId: "u", updatedAt: 200 });
      }
      if (mutation === "tool-completion") rival!.prepare("update agent_tool_execution set status='completed'").run();
    }).immediate();
    const sourceBefore = getMessageSession(db, "ws", "source");
    armed = true;
    const child = fork(db);
    assert.equal(attempted, true, "the rival must try to write at the first source read");
    assert.equal(child.headMessageId, mutation === "tool-completion" ? "u" : "a");
    assert.deepEqual(getMessageSession(db, "ws", "source"), sourceBefore);
    competingWrite();
    const next = fork(db, "next-child");
    assert.equal(next.headMessageId, mutation === "append" ? "concurrent" : mutation === "compaction" ? "concurrent-summary"
      : mutation === "rollback" ? "u" : "a");
    assert.equal(getMessageSession(db, "ws", "child")!.headMessageId, child.headMessageId);
    if (mutation === "compaction") assert.equal(next.contextRootMessageId, "concurrent-summary");
    // Busy is an infrastructure failure, not no-stable/context-invalid.
    rival.exec("BEGIN IMMEDIATE");
    db.pragma("busy_timeout = 1");
    try {
      assert.throws(() => fork(db, "busy-child"), (error: unknown) =>
        !(error instanceof StableForkSourceError) && error instanceof Error && "code" in error && error.code === "SQLITE_BUSY");
    } finally {
      rival.exec("ROLLBACK");
    }
    assert.equal(getMessageSession(db, "ws", "busy-child"), null);
  });
}

test("non-root runtime messages remain excluded, not model streaming barriers", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "runtime", { type: "runtime", status: "streaming" });
  append(db, "tail");
  assert.equal(fork(db).headMessageId, "tail");
  assert.deepEqual(context(db, "child").messages.map((m) => m.id), ["u", "tail"]);
});

test("closed but excluded terminals inside retained history do not enter the new model window", (t) => {
  const db = fixture(t);
  append(db, "retained");
  append(db, "excluded", { type: "assistant", status: "failed", tools: ["failed"] });
  compact(db, "summary", "retained");
  assert.equal(fork(db).headMessageId, "summary");
  assert.deepEqual(context(db, "child").messages.map((m) => m.id), ["summary", "retained"]);
});

for (const damage of ["missing-retained", "foreign-retained", "bad-retained-parts"] as const) {
  test(`${damage} cannot be silently discarded from a required compaction window`, (t) => {
    const db = fixture(t);
    append(db, "retained");
    compact(db, "summary", "retained");
    if (damage === "bad-retained-parts") {
      corrupt(db, () => db.prepare("update agent_message_part set text=null where id='retained-text'").run());
    } else {
      corrupt(db, () => {
        if (damage === "foreign-retained") {
          db.prepare(`insert into agent_message (id,workspace_id,depth,type,status,updated_revision,created_at,updated_at)
            values ('foreign','other',0,'user','completed',0,1,1)`).run();
        }
        db.prepare("update agent_message set retained_from_message_id=? where id='summary'")
          .run(damage === "missing-retained" ? "missing" : "foreign");
      }, ["agent_message_retained_workspace_update", "agent_message_retained_immutable_update"]);
    }
    expectFailure(db, "CONTEXT_INVALID");
  });
}

test("invalid Part types use the context-invalid path rather than a TypeError", (t) => {
  const db = fixture(t);
  append(db, "u");
  corrupt(db, () => db.prepare("update agent_message_part set type='broken' where id='u-text'").run());
  expectFailure(db, "CONTEXT_INVALID");
});

test("required view_image results retain the existing trusted-reference guard", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "a", { type: "assistant", tools: ["completed"] });
  db.prepare("update agent_message_part set tool_name='view_image',tool_input_json=? where type='tool_call'")
    .run(JSON.stringify({ path: "image.png" }));
  db.prepare("update agent_tool_execution set structured_result_json='{}'").run();
  expectFailure(db, "CONTEXT_INVALID");
});

test("stable selection batches large tool histories and preserves Part.position ordering", (t) => {
  const db = fixture(t);
  append(db, "u");
  for (let index = 0; index < 405; index++) append(db, `a${index}`, { type: "assistant", tools: ["completed", "failed"] });
  assert.equal(fork(db).headMessageId, "a404");
  const inherited = context(db, "child");
  assert.equal(inherited.messages.length, 406);
  assert.equal(inherited.executions.length, 810);
  assert.deepEqual(inherited.executions.slice(-2).map((row) => row.callPartId), ["a404-call-0", "a404-call-1"]);
});

test("a missing head with a still-set root is invalid, not an empty-source fallback", (t) => {
  const db = fixture(t);
  append(db, "u");
  db.prepare("update agent_session set head_message_id=null where id='source'").run();
  expectFailure(db, "CONTEXT_INVALID");
});

test("source kind corruption remains unavailable without exposing its metadata", (t) => {
  const db = fixture(t);
  append(db, "u");
  corrupt(db, () => db.prepare("update agent_session set kind='invalid' where id='source'").run());
  expectFailure(db, "SOURCE_UNAVAILABLE");
});

test("duplicate Part positions in corrupt storage do not become an ambiguous tool turn", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "a", { type: "assistant", tools: ["completed"] });
  corrupt(db, () => db.exec(`alter table agent_message_part rename to part_backup;
    create table agent_message_part as select * from part_backup;
    update agent_message_part set position=0 where message_id='a';`));
  expectFailure(db, "CONTEXT_INVALID");
});

test("corrupt execution metadata is rejected by its shared contract", (t) => {
  const db = fixture(t);
  append(db, "u");
  append(db, "a", { type: "assistant", tools: ["completed"] });
  corrupt(db, () => db.prepare("update agent_tool_execution set updated_revision=-1").run());
  expectFailure(db, "CONTEXT_INVALID");
});
