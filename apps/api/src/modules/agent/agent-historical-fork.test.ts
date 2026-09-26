import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { HttpError } from "../../app/errors.js";
import { SqliteRunLifecyclePersistence } from "./lifecycle/sqlite-run-lifecycle-persistence.js";
import { initSchema } from "../../infra/db/schema.js";
import {
  appendMessage, commitCompactionMessageForTest, createMessageRunRecord,
  createMessageSession, findMessageClientRequestDedup, forkHistoricalMessageSession, forkMessageSession,
  getMessageSession, HistoricalForkSessionConflictError, HistoricalForkSourceError,
  revertBeforeUserMessage, setManualMessageSessionTitle, validateHistoricalForkSource,
} from "./agent-message.store.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  initSchema(db);
  for (const id of ["ws-a", "ws-b"]) {
    db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values (?,?,?,?,1,1)")
      .run(id, id, id, `/workspace/${id}`);
  }
  createMessageSession(db, { id: "source", workspaceId: "ws-a", kind: "primary", title: "Source", createdAt: 1 });
  createMessageSession(db, { id: "other", workspaceId: "ws-a", kind: "primary", title: "Other", createdAt: 1 });
  createMessageSession(db, { id: "foreign", workspaceId: "ws-b", kind: "primary", title: "Foreign", createdAt: 1 });
  return db;
}
function append(db: Database.Database, sessionId: string, id: string, type: "user" | "assistant" = "user", workspaceId = "ws-a", text = id) {
  const source = getMessageSession(db, workspaceId, sessionId)!;
  appendMessage(db, { id, workspaceId, sessionId, expectedHeadMessageId: source.headMessageId,
    expectedRevision: source.revision, type, status: "completed", createdAt: source.revision + 2,
    parts: [{ id: `part-${id}`, position: 0, type: "text", text }] });
}
const source = (sourceSessionId: string, targetMessageId: string, workspaceId = "ws-a") =>
  ({ workspaceId, sourceSessionId, targetMessageId });
const fork = (db: Database.Database, id: string, sourceSessionId: string, targetMessageId: string, workspaceId = "ws-a") =>
  forkHistoricalMessageSession(db, { ...source(sourceSessionId, targetMessageId, workspaceId), id,
    title: "Scheduled Fork", createdAt: 10 });
function rejectsSource(fn: () => unknown, code: HistoricalForkSourceError["code"]) {
  assert.throws(fn, (error: unknown) => error instanceof HistoricalForkSourceError && error.code === code);
}

test("internal historical fork accepts old origin after source continues/Reverts/is running; public fork stays fenced", () => {
  const db = fixture();
  append(db, "source", "m1", "user", "ws-a", "hello\n\u0000world😀");
  append(db, "source", "m2", "assistant");
  const s = validateHistoricalForkSource(db, source("source", "m1"));
  assert.deepEqual({ title: s.title, messageSummary: s.messageSummary },
    { title: "Source", messageSummary: "hello world😀" });
  const current = getMessageSession(db, "ws-a", "source")!;
  revertBeforeUserMessage(db, { workspaceId: "ws-a", sessionId: "source", targetMessageId: "m1",
    expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision, updatedAt: 4 });
  append(db, "source", "new-branch");
  createMessageRunRecord(db, { runId: "active", workspaceId: "ws-a", sessionId: "source", triggerMessageId: null,
    agentId: "default", providerId: "provider", modelId: "model", status: "running", createdAt: 5 });
  db.prepare("update session_run_state set status='running',active_run_id='active' where session_id='source'").run();
  assert.throws(() => forkMessageSession(db, { id: "public", workspaceId: "ws-a", sourceSessionId: "source",
    expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision,
    targetMessageId: "m2", title: "Public", kind: "primary", createdAt: 6 }));
  const child = fork(db, "child", "source", "m2");
  assert.equal(child.headMessageId, "m2");
  assert.equal(child.contextRootMessageId, null);
  assert.equal(child.forkedFromMessageId, "m2");
  assert.equal(fork(db, "child", "source", "m2").id, "child");
  assert.throws(() => fork(db, "child", "source", "m1"), HistoricalForkSessionConflictError);
  append(db, "child", "advanced");
  assert.throws(() => fork(db, "child", "source", "m2"), HistoricalForkSessionConflictError);
  createMessageSession(db, { id: "collision", workspaceId: "ws-a", title: "Scheduled Fork",
    kind: "primary", createdAt: 10, forkedFromSessionId: "source", forkedFromMessageId: "m2" });
  assert.throws(() => fork(db, "collision", "source", "m2"), HistoricalForkSessionConflictError);
  assert.equal(getMessageSession(db, "ws-a", "source")!.headMessageId, "new-branch");
});

test("origin membership, inherited immutable ancestry, same-workspace siblings and cross-workspace are distinct", () => {
  const db = fixture();
  append(db, "source", "m1"); append(db, "source", "m2");
  fork(db, "child", "source", "m2");
  append(db, "source", "later");
  append(db, "child", "own");
  append(db, "other", "sibling"); append(db, "foreign", "foreign-m", "user", "ws-b");
  assert.equal(fork(db, "grandchild", "child", "m1").headMessageId, "m1");
  assert.equal(fork(db, "ownchild", "child", "own").headMessageId, "own");
  rejectsSource(() => validateHistoricalForkSource(db, source("child", "later")), "SOURCE_UNAVAILABLE");
  rejectsSource(() => validateHistoricalForkSource(db, source("source", "sibling")), "SOURCE_UNAVAILABLE");
  rejectsSource(() => validateHistoricalForkSource(db, source("source", "foreign-m")), "SOURCE_UNAVAILABLE");
  rejectsSource(() => validateHistoricalForkSource(db, source("foreign", "m1")), "SOURCE_UNAVAILABLE");
});

test("validation hides tool/reasoning content and disallows nonterminal target and assistant tool execution", () => {
  const db = fixture();
  const text = "😀".repeat(550);
  append(db, "source", "long", "user", "ws-a", text);
  const summary = validateHistoricalForkSource(db, source("source", "long")).messageSummary;
  assert.equal([...summary].length, 500);
  assert.equal(summary, "😀".repeat(500));
  const head = getMessageSession(db, "ws-a", "source")!;
  appendMessage(db, { id: "assistant-tool", workspaceId: "ws-a", sessionId: "source",
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, type: "assistant",
    status: "completed", createdAt: 7,
    parts: [{ id: "tool-call", position: 0, type: "tool_call", toolName: "bash", input: { secret: "not exposed" } }] });
  db.prepare(`insert into agent_tool_execution
    (id, call_part_id, origin_session_id, status, result_truncated, updated_revision, created_at, updated_at)
    values ('pending-tool','tool-call','source','queued',0,1,7,7)`).run();
  rejectsSource(() => validateHistoricalForkSource(db, source("source", "assistant-tool")), "SOURCE_MESSAGE_INVALID");
  db.prepare("update agent_message set status='streaming' where id='long'").run();
  rejectsSource(() => validateHistoricalForkSource(db, source("source", "long")), "SOURCE_MESSAGE_INVALID");
});

test("historical fork chooses target-time compaction root and rejects corrupt ancestors", () => {
  const db = fixture();
  append(db, "source", "before");
  const prior = getMessageSession(db, "ws-a", "source")!;
  commitCompactionMessageForTest(db, { id: "summary", workspaceId: "ws-a", sessionId: "source",
    expectedHeadMessageId: prior.headMessageId, expectedRevision: prior.revision,
    textPartId: "summary-part", text: "summary", createdAt: 6 });
  append(db, "source", "after");
  assert.equal(fork(db, "pre", "source", "before").contextRootMessageId, null);
  assert.equal(fork(db, "post", "source", "after").contextRootMessageId, "summary");
  db.prepare("update agent_session set context_root_message_id=null where id='post'").run();
  assert.throws(() => fork(db, "post", "source", "after"), HistoricalForkSessionConflictError);
  db.prepare("update agent_session set context_root_message_id='summary',revision=revision+1 where id='post'").run();
  assert.throws(() => fork(db, "post", "source", "after"), HistoricalForkSessionConflictError);
  db.prepare("update agent_message_part set text='' where id='summary-part'").run();
  rejectsSource(() => validateHistoricalForkSource(db, source("source", "after")), "SOURCE_MESSAGE_INVALID");
  rejectsSource(() => fork(db, "bad-summary-part", "source", "after"), "SOURCE_MESSAGE_INVALID");
  assert.equal(getMessageSession(db, "ws-a", "bad-summary-part"), null);
  db.prepare("update agent_message_part set text='summary' where id='summary-part'").run();
  db.prepare("update agent_message set status='failed' where id='summary'").run();
  rejectsSource(() => fork(db, "bad-root", "source", "after"), "SOURCE_MESSAGE_INVALID");
  db.prepare("update agent_message set status='completed' where id='summary'").run();
  db.pragma("foreign_keys=OFF");
  db.prepare("update agent_message set previous_message_id='missing' where id='after'").run();
  db.pragma("foreign_keys=ON");
  rejectsSource(() => fork(db, "broken", "source", "after"), "SOURCE_MESSAGE_INVALID");
  assert.equal(getMessageSession(db, "ws-a", "broken"), null);
});

test("activation checks expected Fork head/root/revision atomically after a competing message", () => {
  const db = fixture();
  append(db, "source", "anchor");
  const child = fork(db, "race-child", "source", "anchor");
  const expected = { title: "Scheduled Fork", headMessageId: "anchor", contextRootMessageId: child.contextRootMessageId,
    revision: child.revision, sourceSessionId: "source", sourceMessageId: "anchor" };
  append(db, "race-child", "rival");
  const persistence = new SqliteRunLifecyclePersistence(db);
  const activation = (runId: string) => persistence.activateUserRun({ workspaceId: "ws-a",
    sessionId: "race-child", clientRequestId: "scheduled-execution:test", text: "scheduled prompt",
    images: [], runId, agentId: "default", providerId: "test", modelId: "model",
    uiLocale: null, createdAt: 30, expectedHistoricalFork: expected });
  assert.throws(() => activation("new-run"), (error: unknown) =>
    error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.equal(getMessageSession(db, "ws-a", "race-child")?.headMessageId, "rival");
  assert.equal(db.prepare("select 1 from agent_run where run_id='new-run'").get(), undefined);
  assert.equal(findMessageClientRequestDedup(db, { workspaceId: "ws-a", sessionId: "race-child",
    clientRequestId: "scheduled-execution:test" }), null);
  db.prepare("update agent_session set head_message_id='anchor',revision=0,context_root_message_id='anchor' where id='race-child'").run();
  assert.throws(() => activation("root-run"), (error: unknown) =>
    error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
});

test("activation rejects title edits without revision changes for both expected-ID Session paths", () => {
  const db = fixture();
  append(db, "source", "anchor");
  const forked = fork(db, "title-fork", "source", "anchor");
  const originalRevision = forked.revision;
  setManualMessageSessionTitle(db, { workspaceId: "ws-a", sessionId: "title-fork", title: "Changed" });
  assert.equal(getMessageSession(db, "ws-a", "title-fork")?.revision, originalRevision);

  const persistence = new SqliteRunLifecyclePersistence(db);
  const activate = (sessionId: string, runId: string, expectedHistoricalFork?: {
    title: string; headMessageId: string; contextRootMessageId: string | null;
    revision: number; sourceSessionId: string; sourceMessageId: string;
  }, expectedSessionTitle?: string) => persistence.activateUserRun({
    workspaceId: "ws-a", sessionId, clientRequestId: `scheduled-execution:${runId}`,
    text: "scheduled prompt", images: [], runId, agentId: "default", providerId: "test",
    modelId: "model", uiLocale: null, createdAt: 30, expectedHistoricalFork, expectedSessionTitle,
  });
  assert.throws(() => activate("title-fork", "fork-title-run", {
    title: "Scheduled Fork", headMessageId: "anchor", contextRootMessageId: forked.contextRootMessageId,
    revision: forked.revision, sourceSessionId: "source", sourceMessageId: "anchor",
  }), (error: unknown) => error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.equal(getMessageSession(db, "ws-a", "title-fork")?.headMessageId, "anchor");
  assert.equal(db.prepare("select 1 from agent_run where run_id='fork-title-run'").get(), undefined);

  createMessageSession(db, { id: "title-new", workspaceId: "ws-a", kind: "primary",
    title: "Scheduled New", createdAt: 1 });
  setManualMessageSessionTitle(db, { workspaceId: "ws-a", sessionId: "title-new", title: "Changed" });
  assert.equal(getMessageSession(db, "ws-a", "title-new")?.revision, 0);
  assert.throws(() => activate("title-new", "new-title-run", undefined, "Scheduled New"),
    (error: unknown) => error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.equal(getMessageSession(db, "ws-a", "title-new")?.headMessageId, null);
  assert.equal(db.prepare("select 1 from agent_run where run_id='new-title-run'").get(), undefined);
});

test("new_session activation rejects a competing send between expected-ID creation and Run activation", () => {
  const db = fixture();
  const id = "scheduled-new-race";
  createMessageSession(db, { id, workspaceId: "ws-a", kind: "primary", title: "Scheduled New", createdAt: 1 });
  append(db, id, "rival-send");
  const start = (runId: string) => new SqliteRunLifecyclePersistence(db).activateUserRun({
    workspaceId: "ws-a", sessionId: id, clientRequestId: "scheduled-execution:new-race",
    text: "scheduled prompt", images: [], runId, agentId: "default", providerId: "test",
    modelId: "model", uiLocale: null, createdAt: 30, expectedSessionTitle: "Scheduled New",
  });
  assert.throws(() => start("blocked-run"), (error: unknown) =>
    error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.equal(getMessageSession(db, "ws-a", id)?.headMessageId, "rival-send");
  assert.equal(db.prepare("select 1 from agent_run where run_id='blocked-run'").get(), undefined);
  assert.equal(findMessageClientRequestDedup(db, { workspaceId: "ws-a", sessionId: id,
    clientRequestId: "scheduled-execution:new-race" }), null);

  // Even a Revert to an empty head is not the pristine revision-0 Session.
  db.prepare("update agent_session set head_message_id=null where id=?").run(id);
  assert.throws(() => start("reverted-run"), (error: unknown) =>
    error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.equal(db.prepare("select 1 from agent_run where run_id='reverted-run'").get(), undefined);

  db.prepare("update agent_session set revision=0,context_root_message_id='rival-send' where id=?").run(id);
  assert.throws(() => start("wrong-root-run"), (error: unknown) =>
    error instanceof HttpError && error.code === "SESSION_ID_CONFLICT");
  assert.equal(db.prepare("select 1 from agent_run where run_id='wrong-root-run'").get(), undefined);
});
