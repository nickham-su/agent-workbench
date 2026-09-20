import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../infra/db/schema.js";
import {
  AgentMessageDomainError,
  AgentRunTerminalInvariantError,
  AgentMessageConflictError,
  appendMessage,
  appendStreamingAssistant,
  commitCompactionMessageForTest,
  commitCompactionMessageWithRunFence,
  completeAssistantWithExecutions,
  completeTerminalAssistantWithIntent,
  convergeRunTerminal,
  commitCompactionWithTerminalIntent,
  createMessageRunRecord,
  createMessageSession,
  discardStreamingAssistant,
  flushStreamingParts,
  getMessage,
  getPersistedRunTerminalIntent,
  hasCommittedCompactionArtifact,
  getMessageRunState,
  getRunRecord,
  getMessageSession,
  getToolExecution,
  isAncestor,
  markRunWorkInProgress,
  moveMessageHead,
  persistRunTerminalIntent,
  forkMessageSession,
  revertBeforeUserMessage,
  replaceStreamingAssistant,
  settleMessageRunIfCurrent,
  updateMessageRunNotice,
  startMessageRun,
  updateToolExecution
} from "./agent-message.store.js";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws-a','ws-a','Workspace A','/workspace/a',1,1)").run();
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws-b','ws-b','Workspace B','/workspace/b',1,1)").run();
  return db;
}
function session(db: Database.Database, id = "s-a", workspaceId = "ws-a") { createMessageSession(db, { id, workspaceId, title: id, kind: "primary", createdAt: 1 }); }
function activate(db: Database.Database, sessionId = "s-a", workspaceId = "ws-a", runId = "run-a") {
  createMessageRunRecord(db, { runId, workspaceId, sessionId, triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id=? and session_id=?").run(runId, workspaceId, sessionId);
}

function primaryProfile(modelId = "model", providerModelId?: string) {
  return {
    provider: { id: "provider", npm: "@ai-sdk/openai" as const },
    model: { id: modelId, ...(providerModelId == null ? {} : { providerModelId }) },
  };
}

function replay(item: { type: "reasoning"; itemId: string; encryptedContent: string; summaryIndex?: number }
  | { type: "text"; itemId: string; phase?: "commentary" | "final_answer" }
  | { type: "function_call"; itemId: string }) {
  return {
    version: 1 as const,
    provider: {
      npm: "@ai-sdk/openai" as const,
      api: "responses" as const,
      providerId: "provider",
      model: "gpt-5",
    },
    item,
  };
}

test("workspace cancel converges every active run before runtime cancellation and preserves other workspaces", () => {
  const db = createDb();
  session(db, "s-a"); session(db, "s-a-2"); session(db, "s-b", "ws-b");
  activate(db, "s-a", "ws-a", "run-a");
  activate(db, "s-a-2", "ws-a", "run-a-2");
  activate(db, "s-b", "ws-b", "run-b");
  appendMessage(db, {
    id: "assistant-a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0,
    type: "assistant", status: "streaming", originRunId: "run-a", createdAt: 2,
    parts: [
      { id: "call-queued", position: 0, type: "tool_call", toolName: "bash", input: {} },
      { id: "call-running", position: 1, type: "tool_call", toolName: "read", input: {} },
    ],
  });
  db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at)
    values ('queued','call-queued','s-a','run-a','queued',0,1,2,2), ('running','call-running','s-a','run-a','running',0,1,2,2)`).run();

  for (const [sessionId, runId] of [["s-a", "run-a"], ["s-a-2", "run-a-2"]] as const) {
    assert.equal(persistRunTerminalIntent(db, {
      workspaceId: "ws-a", sessionId, runId, status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 3,
    }), "updated");
    assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId, runId, updatedAt: 3 }), {
      kind: "transitioned", finalStatus: "cancelled",
    });
  }
  assert.equal(getMessage(db, "assistant-a")?.status, "cancelled");
  assert.equal(getToolExecution(db, "queued")?.status, "cancelled");
  assert.equal(getToolExecution(db, "running")?.status, "unknown");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.status, "idle");
  assert.equal(getMessageRunState(db, "ws-a", "s-a-2")?.status, "idle");
  assert.equal(getMessageRunState(db, "ws-b", "s-b")?.status, "running");
  assert.equal((db.prepare("select status from agent_run where run_id = 'run-a'").get() as { status: string }).status, "cancelled");
  assert.equal((db.prepare("select status from agent_run where run_id = 'run-b'").get() as { status: string }).status, "running");
  db.close();
});

test("compaction confirmation accepts only the current owned artifact and manual atomic intent", () => {
  const db = createDb();
  session(db);
  createMessageRunRecord(db, { runId: "manual-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='manual-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "start", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const message = commitCompactionWithTerminalIntent(db, {
    id: "summary", workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run", expectedHeadMessageId: "start", expectedRevision: 1,
    retainedFromMessageId: null, textPartId: "summary-part", text: "summary", createdAt: 3,
  });
  assert.equal(message.id, "summary");
  const input = { workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run", messageId: "summary" };
  assert.equal(hasCommittedCompactionArtifact(db, input), true);
  assert.equal(hasCommittedCompactionArtifact(db, { ...input, runId: "another-run" }), false);
  appendMessage(db, { id: "next", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "summary", expectedRevision: 2, type: "system", status: "completed", parts: [], createdAt: 4 });
  assert.equal(hasCommittedCompactionArtifact(db, input), false);
  db.close();
});

test("artifact-only compaction rejects a manual Run before writing any state", () => {
  const db = createDb();
  session(db);
  createMessageRunRecord(db, {
    runId: "manual-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null,
    agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1,
  });
  db.prepare("update session_run_state set status='running',active_run_id='manual-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "start", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const before = getMessageSession(db, "ws-a", "s-a")!;

  assert.throws(() => commitCompactionMessageWithRunFence(db, {
    id: "summary", workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run",
    expectedHeadMessageId: "start", expectedRevision: before.revision, retainedFromMessageId: null,
    textPartId: "summary-part", text: "summary", createdAt: 3,
  }), /manual compaction requires an atomic terminal intent/);

  assert.equal(getMessage(db, "summary"), null);
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), before);
  assert.deepEqual(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run" }), null);
  assert.equal(getRunRecord(db, "manual-run")?.executionPhase, "work_pending");
  db.close();
});

test("real SQLite races: cancel fences proactive write, preserves proactive-first artifact, and never overwrites manual completed intent", () => {
  const commit = (db: Database.Database, runId: string, id: string, createdAt: number) =>
    commitCompactionMessageWithRunFence(db, {
      id, workspaceId: "ws-a", sessionId: "s-a", runId, expectedHeadMessageId: "start", expectedRevision: 1,
      retainedFromMessageId: null, textPartId: `${id}-part`, text: "summary", createdAt,
    });

  // Cancel first: the fence rejects a subsequently attempted proactive artifact.
  const cancelFirst = createDb(); session(cancelFirst); activate(cancelFirst);
  appendMessage(cancelFirst, { id: "start", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  assert.equal(persistRunTerminalIntent(cancelFirst, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 3 }), "updated");
  assert.deepEqual(convergeRunTerminal(cancelFirst, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 3 }), { kind: "transitioned", finalStatus: "cancelled" });
  assert.equal(commit(cancelFirst, "run-a", "late-summary", 4), null);
  assert.equal(getMessage(cancelFirst, "late-summary"), null);
  cancelFirst.close();

  // Proactive write first: later cancel wins the Run but leaves the committed artifact intact.
  const commitFirst = createDb(); session(commitFirst); activate(commitFirst);
  appendMessage(commitFirst, { id: "start", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const committed = commit(commitFirst, "run-a", "summary", 3);
  assert.equal(committed?.id, "summary");
  assert.equal(persistRunTerminalIntent(commitFirst, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 4 }), "updated");
  assert.deepEqual(convergeRunTerminal(commitFirst, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 4 }), { kind: "transitioned", finalStatus: "cancelled" });
  assert.equal(getMessage(commitFirst, "summary")?.type, "compaction");
  assert.equal(getRunRecord(commitFirst, "run-a")?.status, "cancelled");
  commitFirst.close();

  // A manual atomic completed intent is immutable: cancellation cannot replace it.
  const manualFirst = createDb(); session(manualFirst);
  createMessageRunRecord(manualFirst, { runId: "manual-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  manualFirst.prepare("update session_run_state set status='running',active_run_id='manual-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(manualFirst, { id: "start", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  commitCompactionWithTerminalIntent(manualFirst, { id: "manual-summary", workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run", expectedHeadMessageId: "start", expectedRevision: 1, retainedFromMessageId: null, textPartId: "manual-summary-part", text: "summary", createdAt: 3 });
  assert.throws(() => persistRunTerminalIntent(manualFirst, { workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run", status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 4 }), /conflicts/);
  assert.deepEqual(getPersistedRunTerminalIntent(manualFirst, { workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run" }), { status: "completed", code: "compaction_completed", detail: null });
  manualFirst.close();
});

test("already_converged 严格校验 terminal tuple、intent 残留、artifact 与 active fence", () => {
  const db = createDb(); session(db); activate(db);
  assert.equal(persistRunTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 2,
  }), "updated");
  assert.deepEqual(convergeRunTerminal(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 2,
  }), { kind: "transitioned", finalStatus: "cancelled" });
  assert.deepEqual(convergeRunTerminal(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 3,
  }), { kind: "already_converged", finalStatus: "cancelled" });

  db.prepare("update agent_run set status='failed', terminal_result_code='run_cancelled' where run_id='run-a'").run();
  assert.throws(() => convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 3 }), AgentRunTerminalInvariantError);
  db.prepare("update agent_run set status='cancelled' where run_id='run-a'").run();

  db.prepare("update session_run_state set status='running', active_run_id='run-a' where workspace_id='ws-a' and session_id='s-a'").run();
  assert.throws(() => convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 3 }), AgentRunTerminalInvariantError);
  db.prepare("update session_run_state set status='idle', active_run_id=null where workspace_id='ws-a' and session_id='s-a'").run();

  db.prepare(`insert into agent_message (id,workspace_id,previous_message_id,replaces_message_id,retained_from_message_id,depth,type,status,origin_session_id,origin_run_id,updated_revision,created_at,updated_at)
    values ('replay-streaming','ws-a',null,null,null,0,'assistant','streaming','s-a','run-a',1,2,2)`).run();
  assert.throws(() => convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 3 }), AgentRunTerminalInvariantError);
  db.close();
});

test("already_converged 允许 ToolExecution 与 Run timestamp 碰撞", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const db = createDb(); session(db); activate(db);
    appendMessage(db, { id: `user-${status}`, workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendStreamingAssistant(db, { id: `assistant-${status}`, workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: `user-${status}`, expectedRevision: 1, createdAt: 3 });
    flushStreamingParts(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: `assistant-${status}`, updatedAt: 4,
      parts: [{ id: `call-${status}`, position: 0, type: "tool_call", toolName: "read", input: {} }],
    });
    assert.equal(completeAssistantWithExecutions(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: `assistant-${status}`, updatedAt: 5,
      executions: [{ id: `execution-${status}`, callPartId: `call-${status}`, originSessionId: "s-a", originRunId: "run-a", status: "queued" }],
    }), "updated");
    if (status === "completed") {
      assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: `execution-${status}`, status: "running", startedAt: 7, updatedAt: 7 }), "updated");
      assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: `execution-${status}`, status, completedAt: 8, updatedAt: 8 }), "updated");
    } else {
      assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: `execution-${status}`, status, completedAt: 8, updatedAt: 8 }), "updated");
    }
    const code = status === "completed" ? "run_completed" : status === "failed" ? "run_failed" : "run_cancelled";
    assert.equal(persistRunTerminalIntent(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status, code, detail: null, updatedAt: 8,
    }), "updated");
    assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 8 }), {
      kind: "transitioned", finalStatus: status,
    });
    assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 9 }), {
      kind: "already_converged", finalStatus: status,
    });
    db.close();
  }
});

test("Compaction skeleton fences idle or stale session state before any write", () => {
  for (const [status, activeRunId] of [["idle", "compaction-run"], ["running", "other-run"]] as const) {
    const db = createDb(); session(db);
    createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
    createMessageRunRecord(db, { runId: "other-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 1 });
    db.prepare("update session_run_state set status=?,active_run_id=? where workspace_id='ws-a' and session_id='s-a'").run(status, activeRunId);
    appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    assert.throws(() => commitCompactionWithTerminalIntent(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "text",
      expectedHeadMessageId: "user", expectedRevision: 1, text: "summary", retainedFromMessageId: null, createdAt: 3,
    }), /not eligible/);
    assert.equal(getMessage(db, "compaction"), null);
    assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null);
    db.close();
  }
});

test("discardStreamingAssistant supersedes replay-only attempt and restores previous head", () => {
  const db = createDb();
  createMessageSession(db, { id: "s-discard", workspaceId: "ws-a", title: "discard", kind: "primary", createdAt: 1 });
  appendMessage(db, { id: "u-discard", workspaceId: "ws-a", sessionId: "s-discard", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "up-discard", position: 0, type: "text", text: "hello" }], createdAt: 2 });
  activate(db, "s-discard", "ws-a", "r-discard");
  appendStreamingAssistant(db, { id: "a-discard", workspaceId: "ws-a", sessionId: "s-discard", expectedHeadMessageId: "u-discard", expectedRevision: 1, runId: "r-discard", createdAt: 4 });
  flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-discard", runId: "r-discard", messageId: "a-discard", updatedAt: 5,
    parts: [{
      id: "rp-discard", position: 0, type: "reasoning", text: "",
      providerReplay: {
        version: 1,
        provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "provider", model: "gpt-5" },
        item: { type: "reasoning", itemId: "rs-discard", encryptedContent: "cipher-discard" },
      },
    }],
  });

  const request = { workspaceId: "ws-a", sessionId: "s-discard", runId: "r-discard", messageId: "a-discard", updatedAt: 6 };
  assert.equal(discardStreamingAssistant(db, request), "updated");
  assert.equal(getMessage(db, "a-discard")?.status, "superseded");
  assert.equal(getMessageSession(db, "ws-a", "s-discard")?.headMessageId, "u-discard");
  const revisionAfterDiscard = getMessageSession(db, "ws-a", "s-discard")?.revision;
  const state = getMessageRunState(db, "ws-a", "s-discard");
  assert.equal(state?.activeAssistantMessageId, null);
  assert.deepEqual(state?.nonTerminalMessageIds, []);
  assert.equal(discardStreamingAssistant(db, request), "updated");
  assert.equal(getMessageSession(db, "ws-a", "s-discard")?.revision, revisionAfterDiscard);
  assert.equal(discardStreamingAssistant(db, { workspaceId: "ws-a", sessionId: "s-discard", runId: "r-discard", messageId: "a-discard", updatedAt: 7 }), "ignored");

  appendMessage(db, {
    id: "u-after-discard", workspaceId: "ws-a", sessionId: "s-discard",
    expectedHeadMessageId: "u-discard", expectedRevision: revisionAfterDiscard!,
    type: "user", status: "completed", parts: [{ id: "up-after-discard", position: 0, type: "text", text: "continued" }], createdAt: 8,
  });
  assert.equal(discardStreamingAssistant(db, request), "ignored");

  db.prepare(`update agent_run set status='failed', execution_phase='terminal',
    intended_terminal_status=null, intended_terminal_code=null, intended_terminal_detail=null,
    terminal_result_code='run_failed', terminal_result_detail=null
    where run_id='r-discard'`).run();
  db.prepare("update session_run_state set status='idle',active_run_id=null where workspace_id='ws-a' and session_id='s-discard'").run();
  assert.equal(discardStreamingAssistant(db, request), "ignored");
  db.close();
});

test("Message append atomically creates ordered parts and moves Session head/revision", () => {
  const db = createDb(); session(db);
  const message = appendMessage(db, { id: "u-1", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "p-1", position: 0, type: "text", text: "hello" }], createdAt: 2 });
  assert.equal(message.depth, 0); assert.equal(message.parts[0]?.type, "text");
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a") && { head: getMessageSession(db, "ws-a", "s-a")!.headMessageId, root: getMessageSession(db, "ws-a", "s-a")!.contextRootMessageId, revision: getMessageSession(db, "ws-a", "s-a")!.revision }, { head: "u-1", root: "u-1", revision: 1 });
  assert.throws(() => appendMessage(db, { id: "stale", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 3 }), AgentMessageConflictError);
  assert.equal(getMessage(db, "stale"), null);
});

test("append rejects cross-workspace parents and rolls back Message/Head together", () => {
  const db = createDb(); session(db, "s-a", "ws-a"); session(db, "s-b", "ws-b");
  appendMessage(db, { id: "a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  assert.throws(
    () => appendMessage(db, { id: "bad", workspaceId: "ws-b", sessionId: "s-b", expectedHeadMessageId: "a", expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 3 }),
    (error) => error instanceof AgentMessageConflictError && error.code === "SESSION_HEAD_CONFLICT"
  );
  assert.equal(getMessage(db, "bad"), null);
  assert.equal(getMessageSession(db, "ws-b", "s-b")!.headMessageId, null);
});

test("run fence allows only active running Run to flush and freeze streaming assistant", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", originRunId: "run-a", parts: [], createdAt: 2 });
  const streaming = appendStreamingAssistant(db, { id: "a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  assert.equal(streaming.status, "streaming");
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", parts: [{ id: "text", position: 0, type: "text", text: "partial" }], updatedAt: 4 }), "updated");
  db.prepare("update session_run_state set active_run_id = null where workspace_id='ws-a' and session_id='s-a'").run();
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", parts: [{ id: "text", position: 0, type: "text", text: "late" }], updatedAt: 5 }), "ignored");
  const part = getMessage(db, "a")!.parts[0];
  assert.equal(part?.type, "text");
  assert.equal(part?.type === "text" ? part.text : null, "partial");
});

test("completed Assistant atomically creates queued executions and terminal rows freeze", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: { command: "pwd" } }], updatedAt: 4 });
  assert.equal(completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", executions: [{ id: "exec", callPartId: "call", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 5 }), "updated");
  assert.equal(getMessage(db, "a")!.status, "completed"); assert.equal(getToolExecution(db, "exec")!.status, "queued");
  assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec", status: "running", startedAt: 6, updatedAt: 6 }), "updated");
  assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec", status: "completed", resultPreview: "ok", completedAt: 7, updatedAt: 7 }), "updated");
  assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec", status: "failed", error: "late", updatedAt: 8 }), "ignored");
  assert.equal(getToolExecution(db, "exec")!.status, "completed");
  assert.equal(completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", executions: [], updatedAt: 8 }), "ignored");
});

test("ToolExecution 状态机允许 queued 的无副作用失败，拒绝 queued 到 unknown", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 4 });
  assert.equal(completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", executions: [{ id: "exec", callPartId: "call", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 5 }), "updated");
  assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec", status: "failed", error: "policy rejected", completedAt: 6, updatedAt: 6 }), "updated");
  assert.equal(getToolExecution(db, "exec")?.status, "failed");

  appendStreamingAssistant(db, { id: "b", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "a", expectedRevision: getMessageSession(db, "ws-a", "s-a")!.revision, runId: "run-a", createdAt: 7 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "b", parts: [{ id: "call-b", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 8 });
  assert.equal(completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "b", executions: [{ id: "exec-b", callPartId: "call-b", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 9 }), "updated");
  assert.throws(() => updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec-b", status: "unknown", completedAt: 10, updatedAt: 10 }), /invalid tool execution transition/);
});

test("complete Assistant 与 ToolExecution terminal 支持精确重放，差异 payload fail closed", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "read", input: { filePath: "a" }, providerToolCallId: "call-1" }], updatedAt: 4 });
  const complete = { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", executions: [{ id: "exec", callPartId: "call", originSessionId: "s-a", originRunId: "run-a", status: "queued" as const }], updatedAt: 5 };
  assert.equal(completeAssistantWithExecutions(db, complete), "updated");
  assert.equal(completeAssistantWithExecutions(db, complete), "updated");
  assert.equal(completeAssistantWithExecutions(db, { ...complete, updatedAt: 6 }), "ignored");
  assert.equal(completeAssistantWithExecutions(db, { ...complete, executions: [{ ...complete.executions[0], id: "other" }] }), "ignored");
  assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec", status: "running", startedAt: 6, updatedAt: 6 }), "updated");
  const terminal = { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "exec", status: "completed" as const, resultPreview: "done", resultTruncated: false, resultArtifactPath: null, structuredResult: { value: 1 }, error: null, startedAt: 6, completedAt: 7, updatedAt: 7 };
  assert.equal(updateToolExecution(db, terminal), "updated");
  assert.equal(updateToolExecution(db, terminal), "updated");
  assert.equal(updateToolExecution(db, { ...terminal, resultPreview: "late" }), "ignored");
});

test("replacement 支持精确重放，metadata 或时间差异 fail closed", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "old", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  const request = { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", oldMessageId: "old", newMessageId: "new", expectedHeadMessageId: "old", expectedRevision: 2, runNoticeText: "retrying", retryCount: 1, nextRetryAt: 100, createdAt: 4 };
  assert.equal(replaceStreamingAssistant(db, request).result, "updated");
  assert.deepEqual(replaceStreamingAssistant(db, request), {
    result: "updated",
    message: (() => {
      const message = getMessage(db, "new")!;
      assert.notEqual(message.type, "compaction");
      return message;
    })()
  });
  assert.equal(replaceStreamingAssistant(db, { ...request, retryCount: 2 }).result, "ignored");
  assert.equal(replaceStreamingAssistant(db, { ...request, createdAt: 5 }).result, "ignored");
});

test("streaming Assistant 创建支持精确 response-loss 重放且不推进 revision", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const request = { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 };
  const first = appendStreamingAssistant(db, request);
  const revision = getMessageSession(db, "ws-a", "s-a")!.revision;
  const replay = appendStreamingAssistant(db, request);
  assert.deepEqual(replay, first);
  assert.equal(getMessageSession(db, "ws-a", "s-a")!.revision, revision);
  assert.throws(() => appendStreamingAssistant(db, { ...request, createdAt: 4 }), /replay does not match/);
});

test("Text/Reasoning flush 重放不推进 revision，position 或非前缀变化 fail closed", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  const part = { id: "text", position: 0, type: "text" as const, text: "hello" };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [part], updatedAt: 4 }), "updated");
  const revision = getMessageSession(db, "ws-a", "s-a")!.revision;
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [part], updatedAt: 5 }), "updated");
  assert.equal(getMessageSession(db, "ws-a", "s-a")!.revision, revision);
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ ...part, text: "hello world" }], updatedAt: 6 }), "updated");
  assert.throws(() => flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ ...part, position: 1, text: "hello world" }], updatedAt: 7 }), /position/);
  assert.throws(() => flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ ...part, text: "different" }], updatedAt: 8 }), /must extend/);
});

test("空 reasoning 可插入私有 replay，metadata-only 更新推进 revision且重放幂等", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  const initial = { id: "reasoning", position: 0, type: "reasoning" as const, text: "" };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [initial], updatedAt: 4 }), "updated");
  const beforeMetadata = getMessageSession(db, "ws-a", "s-a")!.revision;
  const withReplay = { ...initial, providerReplay: replay({ type: "reasoning", itemId: "rs_1", encryptedContent: "cipher-1", summaryIndex: 0 }) };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [withReplay], updatedAt: 5 }), "updated");
  const afterMetadata = getMessageSession(db, "ws-a", "s-a")!.revision;
  assert.equal(afterMetadata, beforeMetadata + 1);
  assert.equal((db.prepare("select provider_replay_json as replay, updated_revision as revision from agent_message_part where id='reasoning'").get() as { replay: string; revision: number }).revision, afterMetadata);

  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [withReplay], updatedAt: 6 }), "updated");
  assert.equal(getMessageSession(db, "ws-a", "s-a")!.revision, afterMetadata);

  const enrichedReplay = { ...initial, providerReplay: replay({ type: "reasoning", itemId: "rs_1", encryptedContent: "cipher-final", summaryIndex: 0 }) };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [enrichedReplay], updatedAt: 7 }), "updated");
  assert.equal(getMessageSession(db, "ws-a", "s-a")!.revision, afterMetadata + 1);
  const stored = db.prepare("select provider_replay_json as replay from agent_message_part where id='reasoning'").get() as { replay: string };
  assert.match(stored.replay, /cipher-final/);
  assert.doesNotMatch(JSON.stringify(getMessage(db, "assistant")), /cipher-final|providerReplay|provider_replay/);

  const withoutIndex = { ...initial, providerReplay: replay({ type: "reasoning", itemId: "rs_2", encryptedContent: "cipher-2" }) };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ ...withoutIndex, id: "reasoning-2", position: 1 }], updatedAt: 8 }), "updated");
  const withIndex = { ...withoutIndex, id: "reasoning-2", position: 1, providerReplay: replay({ type: "reasoning", itemId: "rs_2", encryptedContent: "cipher-2-final", summaryIndex: 1 }) };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [withIndex], updatedAt: 9 }), "updated");
  assert.throws(() => flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", updatedAt: 10,
    parts: [{ ...withIndex, providerReplay: replay({ type: "reasoning", itemId: "rs_2", encryptedContent: "cipher", summaryIndex: 2 }) }],
  }), /summaryIndex is immutable/);
  assert.throws(() => flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", updatedAt: 11,
    parts: [{ ...withIndex, providerReplay: replay({ type: "reasoning", itemId: "rs_2", encryptedContent: "cipher" }) }],
  }), /summaryIndex is immutable/);

  assert.throws(() => flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", updatedAt: 12,
    parts: [{ ...initial, providerReplay: replay({ type: "reasoning", itemId: "rs_other", encryptedContent: "cipher-other" }) }],
  }), /item identity is immutable/);
});

test("text 与 tool_call replay 分别持久化 item metadata，call_id 保持独立", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", updatedAt: 4,
    parts: [
      { id: "text", position: 0, type: "text", text: "hello", providerReplay: replay({ type: "text", itemId: "msg_1", phase: "final_answer" }) },
      { id: "call", position: 1, type: "tool_call", toolName: "bash", input: { command: "pwd" }, providerToolCallId: "call_1", providerReplay: replay({ type: "function_call", itemId: "fc_1" }) },
    ],
  });
  assert.deepEqual(db.prepare("select id,provider_tool_call_id as callId,json_extract(provider_replay_json,'$.item.itemId') as itemId from agent_message_part order by position").all(), [
    { id: "text", callId: null, itemId: "msg_1" },
    { id: "call", callId: "call_1", itemId: "fc_1" },
  ]);
  assert.throws(() => flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", updatedAt: 5,
    parts: [{ id: "text", position: 0, type: "text", text: "hello", providerReplay: replay({ type: "text", itemId: "msg_1", phase: "commentary" }) }],
  }), /phase is immutable/);
  assert.throws(() => flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", updatedAt: 6,
    parts: [{ id: "text", position: 0, type: "text", text: "hello", providerReplay: replay({ type: "text", itemId: "msg_1" }) }],
  }), /phase is immutable/);
});

test("ToolCall part flush retries are idempotent and mismatched replays fail closed", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  const part = { id: "call", position: 0, type: "tool_call" as const, toolName: "bash", input: { command: "pwd" }, providerToolCallId: "provider-call" };
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [part], updatedAt: 4 }), "updated");
  const revision = getMessageSession(db, "ws-a", "s-a")!.revision;
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [part], updatedAt: 5 }), "updated");
  assert.equal(getMessageSession(db, "ws-a", "s-a")!.revision, revision);
  assert.throws(
    () => flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ ...part, input: { command: "ls" } }], updatedAt: 6 }),
    /replay does not match/
  );
  assert.equal(getMessageSession(db, "ws-a", "s-a")!.revision, revision);
});

test("replacement, ancestor pointer CAS and compaction preserve graph immutability", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "old", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  const replacement = replaceStreamingAssistant(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", oldMessageId: "old", newMessageId: "new", expectedHeadMessageId: "old", expectedRevision: 2, runNoticeText: "retrying", retryCount: 1, nextRetryAt: 100, createdAt: 4 });
  assert.equal(replacement.result, "updated"); assert.equal(getMessage(db, "old")!.status, "superseded"); assert.equal(replacement.message!.replacesMessageId, "old"); assert.equal(replacement.message!.previousMessageId, "u");
  assert.equal(isAncestor(db, "ws-a", "new", "u"), true);
  db.prepare("update agent_message set status='completed' where id='new'").run();
  const current = getMessageSession(db, "ws-a", "s-a")!;
  moveMessageHead(db, { workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "new", expectedRevision: current.revision, nextHeadMessageId: "u", updatedAt: 5 });
  const afterMove = getMessageSession(db, "ws-a", "s-a")!;
  db.prepare("update session_run_state set last_response_total_tokens=64000 where workspace_id='ws-a' and session_id='s-a'").run();
  const compacted = commitCompactionMessageForTest(db, { id: "c", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: afterMove.revision, textPartId: "cp", text: "summary", createdAt: 6 });
  assert.equal(compacted.type, "compaction"); assert.equal(getMessageSession(db, "ws-a", "s-a")!.contextRootMessageId, "c");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.lastResponseTotalTokens, null);
});

test("revertBeforeUserMessage removes the selected User and all following messages from the visible chain", () => {
  const db = createDb(); session(db);
  appendMessage(db, { id: "user-1", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendMessage(db, { id: "assistant-1", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user-1", expectedRevision: 1, type: "assistant", status: "completed", parts: [], createdAt: 3 });
  appendMessage(db, { id: "user-2", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "assistant-1", expectedRevision: 2, type: "user", status: "completed", parts: [], createdAt: 4 });
  appendMessage(db, { id: "assistant-2", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user-2", expectedRevision: 3, type: "assistant", status: "completed", parts: [], createdAt: 5 });
  const current = getMessageSession(db, "ws-a", "s-a")!;

  revertBeforeUserMessage(db, {
    workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: current.headMessageId,
    expectedRevision: current.revision, targetMessageId: "user-2", updatedAt: 6
  });

  const reverted = getMessageSession(db, "ws-a", "s-a")!;
  assert.equal(reverted.headMessageId, "assistant-1");
  assert.equal(reverted.contextRootMessageId, "user-1");
  assert.equal(reverted.revision, 5);
});

test("revertBeforeUserMessage can remove the first User and reset an uncompacted Session to an empty chain", () => {
  const db = createDb(); session(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const current = getMessageSession(db, "ws-a", "s-a")!;
  revertBeforeUserMessage(db, { workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: current.revision, targetMessageId: "user", updatedAt: 3 });
  const reverted = getMessageSession(db, "ws-a", "s-a")!;
  assert.equal(reverted.headMessageId, null);
  assert.equal(reverted.contextRootMessageId, null);
  assert.equal(reverted.revision, 2);
});

test("revertBeforeUserMessage rejects Assistant targets without changing the Session", () => {
  const db = createDb(); session(db);
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendMessage(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, type: "assistant", status: "completed", parts: [], createdAt: 3 });
  const current = getMessageSession(db, "ws-a", "s-a")!;
  assert.throws(
    () => revertBeforeUserMessage(db, { workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "assistant", expectedRevision: current.revision, targetMessageId: "assistant", updatedAt: 4 }),
    (error: unknown) => error instanceof AgentMessageDomainError && error.code === "MESSAGE_TARGET_INVALID"
  );
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), current);
});

test("fenced compaction rejects stale Run without mutating the Message graph", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  db.prepare("update session_run_state set last_response_total_tokens=32000 where workspace_id='ws-a' and session_id='s-a'").run();
  db.prepare("update session_run_state set status='idle',active_run_id=null where workspace_id='ws-a' and session_id='s-a'").run();

  const result = commitCompactionMessageWithRunFence(db, {
    id: "c", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a",
    expectedHeadMessageId: "u", expectedRevision: 1, textPartId: "cp", text: "summary", createdAt: 3
  });

  assert.equal(result, null);
  assert.equal(getMessage(db, "c"), null);
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a") && {
    headMessageId: getMessageSession(db, "ws-a", "s-a")!.headMessageId,
    contextRootMessageId: getMessageSession(db, "ws-a", "s-a")!.contextRootMessageId,
    revision: getMessageSession(db, "ws-a", "s-a")!.revision
  }, { headMessageId: "u", contextRootMessageId: "u", revision: 1 });
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.lastResponseTotalTokens, 32000);
});

test("cancel convergence cancels queued, marks running unknown, idles state and fences late writeback", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", parts: [{ id: "call-1", position: 0, type: "tool_call", toolName: "bash", input: {} }, { id: "call-2", position: 1, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 4 });
  completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", executions: [{ id: "q", callPartId: "call-1", originSessionId: "s-a", originRunId: "run-a", status: "queued" }, { id: "r", callPartId: "call-2", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 5 });
  updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "r", status: "running", startedAt: 6, updatedAt: 6 });
  // A second streaming attempt exists at cancellation time.
  const current = getMessageSession(db, "ws-a", "s-a")!;
  appendStreamingAssistant(db, { id: "later", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision, runId: "run-a", createdAt: 7 });
  assert.equal(persistRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "cancelled", code: "run_cancelled", detail: null, updatedAt: 8 }), "updated");
  assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 8 }), { kind: "transitioned", finalStatus: "cancelled" });
  assert.equal(getMessage(db, "later")!.status, "cancelled"); assert.equal(getToolExecution(db, "q")!.status, "cancelled"); assert.equal(getToolExecution(db, "r")!.status, "unknown");
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a"), { workspaceId: "ws-a", sessionId: "s-a", status: "idle", activeRunId: null, runNoticeText: "", retryCount: 0, nextRetryAt: null, lastResponseTotalTokens: null, activeRunStartedAt: null, lastRunDurationMs: 7, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 8 });
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "later", parts: [{ id: "late", position: 0, type: "text", text: "no" }], updatedAt: 9 }), "ignored");
  assert.equal(updateMessageRunNotice(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", runNoticeText: "late retry", retryCount: 99, nextRetryAt: 99, updatedAt: 9 }), "ignored");
  assert.equal(completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "later", executions: [], updatedAt: 9 }), "ignored");
  assert.deepEqual(replaceStreamingAssistant(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", oldMessageId: "later", newMessageId: "late-replacement", expectedHeadMessageId: "later", expectedRevision: getMessageSession(db, "ws-a", "s-a")!.revision, runNoticeText: "late retry", retryCount: 99, nextRetryAt: 99, createdAt: 9 }), { result: "ignored", message: null });
});

test("replacement preserves partial ToolCall without creating an execution and persists retry notice metadata", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "old", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  assert.equal(flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "old", parts: [{ id: "old-call-1", position: 2, type: "tool_call", toolName: "read", input: { filePath: "one" }, providerToolCallId: "provider-1" }, { id: "old-call-2", position: 3, type: "tool_call", toolName: "read", input: { filePath: "two" }, providerToolCallId: "provider-2" }], updatedAt: 4 }), "updated");
  assert.equal(updateMessageRunNotice(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", runNoticeText: "retrying", retryCount: 3, nextRetryAt: 99, updatedAt: 5 }), "updated");
  const replacement = replaceStreamingAssistant(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", oldMessageId: "old", newMessageId: "new", expectedHeadMessageId: "old", expectedRevision: 3, runNoticeText: "retrying", retryCount: 2, nextRetryAt: 99, createdAt: 6 });

  assert.equal(getMessage(db, "old")?.status, "superseded");
  assert.equal((db.prepare("select count(*) as count from agent_tool_execution where call_part_id in ('old-call-1','old-call-2')").get() as { count: number }).count, 0);
  const oldParts = db.prepare("select provider_tool_call_id as providerToolCallId from agent_message_part where message_id='old' and type='tool_call' order by position").all() as Array<{ providerToolCallId: string }>;
  assert.deepEqual(oldParts.map((part) => part.providerToolCallId), ["provider-1", "provider-2"]);
  assert.equal(replacement.result, "updated"); assert.equal(replacement.message!.previousMessageId, "u"); assert.equal(replacement.message!.replacesMessageId, "old");
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a") && { active: getMessageRunState(db, "ws-a", "s-a")!.activeAssistantMessageId, messages: getMessageRunState(db, "ws-a", "s-a")!.nonTerminalMessageIds, retryCount: getMessageRunState(db, "ws-a", "s-a")!.retryCount, nextRetryAt: getMessageRunState(db, "ws-a", "s-a")!.nextRetryAt }, { active: "new", messages: ["new"], retryCount: 2, nextRetryAt: 99 });
});

test("run start and settlement are fenced against an active or late Run", () => {
  const db = createDb(); session(db);
  db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('run-1','ws-a','s-a',null,'agent','provider','model','running',1,1)").run();
  db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values ('run-2','ws-a','s-a',null,'agent','provider','model','running',1,1)").run();
  startMessageRun(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-1", updatedAt: 2, noticeText: "running" });
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a"), {
    workspaceId: "ws-a", sessionId: "s-a", status: "running", activeRunId: "run-1", runNoticeText: "running",
    retryCount: 0, nextRetryAt: null, lastResponseTotalTokens: null, activeRunStartedAt: 1, lastRunDurationMs: null,
    activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 2
  });
  assert.throws(() => startMessageRun(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-2", updatedAt: 3 }), /not idle/);
  assert.equal(settleMessageRunIfCurrent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "late", updatedAt: 4 }), false);
  assert.equal(settleMessageRunIfCurrent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-1", updatedAt: 5, noticeText: "done" }), true);
  startMessageRun(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-2", updatedAt: 6 });
  assert.equal(settleMessageRunIfCurrent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-1", updatedAt: 7 }), false);
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.activeRunId, "run-2");
});

test("replacement and failed completion preserve run-state and graph atomically", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "old", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, runId: "run-a", createdAt: 3 });
  const replacement = replaceStreamingAssistant(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", oldMessageId: "old", newMessageId: "new", expectedHeadMessageId: "old", expectedRevision: 2, runNoticeText: "retrying", retryCount: 1, nextRetryAt: 100, createdAt: 4 });
  assert.equal(replacement.result, "updated");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.activeAssistantMessageId, replacement.message!.id);
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a")?.nonTerminalMessageIds, ["new"]);
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "new", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 5 });
  const before = getMessageSession(db, "ws-a", "s-a")!;
  assert.throws(() => completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "new", executions: [], updatedAt: 6 }), /exactly match/);
  assert.equal(getMessage(db, "new")?.status, "streaming");
  assert.equal(getToolExecution(db, "missing"), null);
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a")?.nonTerminalMessageIds, ["new"]);
  assert.equal(getMessageSession(db, "ws-a", "s-a")?.revision, before.revision);
});

test("assistant completion rejects mismatched execution origins without partially committing", () => {
  for (const execution of [
    { id: "wrong-session", originSessionId: "other-session", originRunId: "run-a" },
    { id: "wrong-run", originSessionId: "s-a", originRunId: "other-run" },
  ]) {
    const db = createDb(); session(db); activate(db);
    appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "user", expectedRevision: 1, runId: "run-a", createdAt: 3 });
    flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 4 });
    const before = getMessageSession(db, "ws-a", "s-a")!;

    assert.throws(
      () => completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", executions: [{ ...execution, callPartId: "call", status: "queued" }], updatedAt: 5 }),
      /origin must match/
    );
    assert.equal(getMessage(db, "assistant")?.status, "streaming");
    assert.equal(getToolExecution(db, execution.id), null);
    assert.equal(getMessageSession(db, "ws-a", "s-a")?.revision, before.revision);
    assert.deepEqual(getMessageRunState(db, "ws-a", "s-a")?.nonTerminalMessageIds, ["assistant"]);
    assert.deepEqual(getMessageRunState(db, "ws-a", "s-a")?.nonTerminalToolExecutionIds, []);
  }
});

test("head and fork reject context-root violations and unsettled execution without copying graph rows", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const root = commitCompactionMessageForTest(db, { id: "c", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, textPartId: "cp", text: "summary", createdAt: 3 });
  appendStreamingAssistant(db, { id: "a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: root.id, expectedRevision: 2, runId: "run-a", createdAt: 4 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 5 });
  completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "a", executions: [{ id: "e", callPartId: "call", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 6 });
  const current = getMessageSession(db, "ws-a", "s-a")!;
  assert.throws(
    () => moveMessageHead(db, { workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision, nextHeadMessageId: "u", updatedAt: 7 }),
    (error) => error instanceof AgentMessageDomainError && error.code === "MESSAGE_TARGET_BEFORE_CONTEXT_ROOT"
  );
  assert.throws(
    () => moveMessageHead(db, { workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision, nextHeadMessageId: "a", updatedAt: 7 }),
    (error) => error instanceof AgentMessageDomainError && error.code === "MESSAGE_TARGET_HAS_NON_TERMINAL_EXECUTIONS"
  );
  assert.throws(
    () => forkMessageSession(db, { id: "fork", workspaceId: "ws-a", sourceSessionId: "s-a", expectedHeadMessageId: current.headMessageId, expectedRevision: current.revision, targetMessageId: root.id, title: "fork", kind: "primary", createdAt: 8 }),
    (error) => error instanceof AgentMessageDomainError && error.code === "SESSION_NOT_IDLE"
  );
  assert.equal((db.prepare("select count(*) as count from agent_session where id='fork'").get() as { count: number }).count, 0);
});

test("failure recovery fences the active Run and atomically settles streaming Messages and Executions", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "recovery-user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "recovery-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "recovery-user", expectedRevision: 1, createdAt: 3 });
  flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "recovery-assistant", parts: [{ id: "recovery-call", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 4 });
  completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "recovery-assistant", executions: [{ id: "recovery-queued", callPartId: "recovery-call", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 5 });
  appendStreamingAssistant(db, { id: "recovery-streaming", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "recovery-assistant", expectedRevision: 4, createdAt: 6 });
  updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "recovery-queued", status: "running", updatedAt: 7, startedAt: 7 });

  assert.equal(persistRunTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "failed",
    code: "run_startup_recovery_failed", detail: null, updatedAt: 8,
  }), "updated");
  assert.deepEqual(convergeRunTerminal(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 8,
  }), { kind: "transitioned", finalStatus: "failed" });
  assert.equal(getMessage(db, "recovery-streaming")?.status, "failed");
  assert.equal(getToolExecution(db, "recovery-queued")?.status, "unknown");
  assert.equal((db.prepare("select status from agent_run where run_id='run-a'").get() as { status: string }).status, "failed");
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a"), {
    workspaceId: "ws-a", sessionId: "s-a", status: "idle", activeRunId: null, runNoticeText: "",
    retryCount: 0, nextRetryAt: null, lastResponseTotalTokens: null, activeRunStartedAt: null, lastRunDurationMs: 7,
    activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 8
  });
  assert.deepEqual(convergeRunTerminal(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 9,
  }), { kind: "already_converged", finalStatus: "failed" });
});

test("Compaction fenced commit 对同一不可变请求精确重放，差异请求 fail closed", () => {
  const db = createDb();
  session(db); activate(db);
  const user = appendMessage(db, { id: "u-replay", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const current = getMessageSession(db, "ws-a", "s-a")!;
  assert.equal(getMessageRunState(db, "ws-a", "s-a")!.activeRunId, "run-a");
  const request = { id: "c-replay", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "u-replay", expectedRevision: current.revision, textPartId: "cp-replay", text: "summary", createdAt: 3 };
  db.prepare("update session_run_state set last_response_total_tokens=100 where workspace_id='ws-a' and session_id='s-a'").run();
  assert.equal(commitCompactionMessageWithRunFence(db, request)?.id, "c-replay");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.lastResponseTotalTokens, null);
  db.prepare("update session_run_state set last_response_total_tokens=25 where workspace_id='ws-a' and session_id='s-a'").run();
  assert.equal(commitCompactionMessageWithRunFence(db, request)?.id, "c-replay");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.lastResponseTotalTokens, 25);
  assert.equal(commitCompactionMessageWithRunFence(db, { ...request, text: "different" }), null);
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.lastResponseTotalTokens, 25);
  db.prepare(`insert into agent_message (id, workspace_id, previous_message_id, replaces_message_id, depth, type, status, origin_session_id, origin_run_id, updated_revision, created_at, updated_at)
    values ('other-message', 'ws-a', null, null, 0, 'runtime', 'completed', 's-a', null, 0, 3, 3)`).run();
  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('other-part', 'other-message', 0, 'text', 'summary', 0, 3, 3)`).run();
  assert.equal(commitCompactionMessageWithRunFence(db, { ...request, textPartId: "other-part" }), null);

  db.prepare(`insert into agent_message_part (id, message_id, position, type, text, updated_revision, created_at, updated_at)
    values ('extra-part', 'c-replay', 1, 'reasoning', 'extra', 0, 3, 3)`).run();
  assert.equal(commitCompactionMessageWithRunFence(db, request), null);
  db.prepare("delete from agent_message_part where id = 'extra-part'").run();

  db.prepare("update agent_message set replaces_message_id = 'u-replay' where id = 'c-replay'").run();
  assert.equal(commitCompactionMessageWithRunFence(db, request), null);
  assert.equal((db.prepare("select count(*) as count from agent_message where type = 'compaction'").get() as { count: number }).count, 1);
});

test("new Run starts running/work_pending, then work progress and terminal intent are idempotent", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "phase-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 1 });
  assert.deepEqual(getRunRecord(db, "phase-run") && {
    status: getRunRecord(db, "phase-run")!.status,
    executionPhase: getRunRecord(db, "phase-run")!.executionPhase,
    intended: getRunRecord(db, "phase-run")!.intendedTerminalCode,
    actual: getRunRecord(db, "phase-run")!.terminalResultCode,
  }, { status: "running", executionPhase: "work_pending", intended: null, actual: null });
  assert.equal(markRunWorkInProgress(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "phase-run", updatedAt: 2 }), "updated");
  assert.equal(markRunWorkInProgress(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "phase-run", updatedAt: 3 }), "already_in_progress");
  const intent = { workspaceId: "ws-a", sessionId: "s-a", runId: "phase-run", status: "completed" as const, code: "run_completed" as const, detail: null, updatedAt: 4 };
  assert.equal(persistRunTerminalIntent(db, intent), "updated");
  assert.equal(persistRunTerminalIntent(db, { ...intent, updatedAt: 5 }), "already_persisted");
  assert.deepEqual(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "phase-run" }), { status: "completed", code: "run_completed", detail: null });
  assert.throws(() => persistRunTerminalIntent(db, { ...intent, code: "run_failed", status: "failed", updatedAt: 6 }), /terminal intent conflicts/);
  db.close();
});

test("terminal Assistant skeleton commits Assistant completion and intent together", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "terminal-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='terminal-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "terminal-user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "terminal-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "terminal-run", expectedHeadMessageId: "terminal-user", expectedRevision: 1, createdAt: 3 });
  assert.equal(completeTerminalAssistantWithIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "terminal-run", messageId: "terminal-assistant", responseTotalTokens: 9,
    status: "completed", code: "run_completed", detail: null, updatedAt: 4,
  }), "updated");
  assert.equal(getMessage(db, "terminal-assistant")?.status, "completed");
  assert.equal(getRunRecord(db, "terminal-run")?.executionPhase, "terminal_intent_persisted");
  assert.deepEqual(convergeRunTerminal(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "terminal-run", updatedAt: 5,
  }), { kind: "transitioned", finalStatus: "completed" });
  assert.equal(getRunRecord(db, "terminal-run")?.executionPhase, "terminal");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.status, "idle");
  db.close();
});

test("terminal Assistant only accepts matching run kind success intent and exact replay", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "user-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "user", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='user-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "user-message", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "user-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "user-run", expectedHeadMessageId: "user-message", expectedRevision: 1, createdAt: 3 });
  const request = { workspaceId: "ws-a", sessionId: "s-a", runId: "user-run", messageId: "user-assistant", responseTotalTokens: 9, status: "completed" as const, code: "run_completed" as const, detail: null, updatedAt: 4 };
  assert.throws(() => completeTerminalAssistantWithIntent(db, { ...request, code: "subtask_completed" }), /conflicts with run kind/);
  assert.equal(getMessage(db, "user-assistant")?.status, "streaming");
  assert.equal(completeTerminalAssistantWithIntent(db, request), "updated");
  assert.equal(completeTerminalAssistantWithIntent(db, request), "updated");
  assert.throws(() => completeTerminalAssistantWithIntent(db, { ...request, updatedAt: 5 }), /replay conflicts/);
  assert.throws(() => completeTerminalAssistantWithIntent(db, { ...request, responseTotalTokens: 10 }), /replay conflicts/);
  db.close();
});

test("terminal Assistant responseTotalTokens stores normalized number or null and replays by that value", () => {
  const complete = (runId: string, messageId: string, responseTotalTokens?: number | null) => {
    const db = createDb(); session(db);
    createMessageRunRecord(db, { runId, workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 1 });
    db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id='ws-a' and session_id='s-a'").run(runId);
    appendMessage(db, { id: `${messageId}-user`, workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendStreamingAssistant(db, { id: messageId, workspaceId: "ws-a", sessionId: "s-a", runId, expectedHeadMessageId: `${messageId}-user`, expectedRevision: 1, createdAt: 3 });
    db.prepare("update session_run_state set last_response_total_tokens=99 where workspace_id='ws-a' and session_id='s-a'").run();
    const input = { workspaceId: "ws-a", sessionId: "s-a", runId, messageId, status: "completed" as const, code: "run_completed" as const, detail: null, updatedAt: 4 };
    assert.equal(completeTerminalAssistantWithIntent(db, responseTotalTokens === undefined ? input : { ...input, responseTotalTokens }), "updated");
    return { db, input };
  };

  const omitted = complete("token-omitted-run", "token-omitted");
  assert.equal(getMessageRunState(omitted.db, "ws-a", "s-a")?.lastResponseTotalTokens, null);
  assert.equal(completeTerminalAssistantWithIntent(omitted.db, omitted.input), "updated");
  assert.equal(completeTerminalAssistantWithIntent(omitted.db, { ...omitted.input, responseTotalTokens: null }), "updated");
  assert.throws(() => completeTerminalAssistantWithIntent(omitted.db, { ...omitted.input, responseTotalTokens: 0 }), /replay conflicts/);
  omitted.db.close();

  const nulled = complete("token-null-run", "token-null", null);
  assert.equal(getMessageRunState(nulled.db, "ws-a", "s-a")?.lastResponseTotalTokens, null);
  assert.equal(completeTerminalAssistantWithIntent(nulled.db, nulled.input), "updated");
  nulled.db.close();

  const numbered = complete("token-number-run", "token-number", 9.8);
  assert.equal(getMessageRunState(numbered.db, "ws-a", "s-a")?.lastResponseTotalTokens, 9);
  assert.equal(completeTerminalAssistantWithIntent(numbered.db, { ...numbered.input, responseTotalTokens: 9.1 }), "updated");
  assert.throws(() => completeTerminalAssistantWithIntent(numbered.db, numbered.input), /replay conflicts/);
  assert.throws(() => completeTerminalAssistantWithIntent(numbered.db, { ...numbered.input, responseTotalTokens: 10 }), /replay conflicts/);
  numbered.db.close();
});

test("terminal Assistant rejects subtask/user reversal and manual runs without partial intent", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "subtask-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "subtask", status: "running", createdAt: 1 });
  createMessageRunRecord(db, { runId: "manual-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='subtask-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "start", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "subtask-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "subtask-run", expectedHeadMessageId: "start", expectedRevision: 1, createdAt: 3 });
  assert.throws(() => completeTerminalAssistantWithIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "subtask-run", messageId: "subtask-assistant", status: "completed", code: "run_completed", detail: null, updatedAt: 4 }), /conflicts with run kind/);
  assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "subtask-run" }), null);
  assert.equal(completeTerminalAssistantWithIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "subtask-run", messageId: "subtask-assistant", status: "completed", code: "subtask_completed", detail: null, updatedAt: 4 }), "updated");
  db.prepare("update session_run_state set active_run_id='manual-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendStreamingAssistant(db, { id: "manual-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run", expectedHeadMessageId: "subtask-assistant", expectedRevision: 3, createdAt: 5 });
  assert.throws(() => completeTerminalAssistantWithIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "manual-run", messageId: "manual-assistant", status: "completed", code: "run_completed", detail: null, updatedAt: 6 }), /manual compaction/);
  assert.equal(getMessage(db, "manual-assistant")?.status, "streaming");
  db.close();
});

test("Compaction skeleton atomically writes strict compaction, Session pointers and terminal intent", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "compaction-user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "compaction-user-text", position: 0, type: "text", text: "keep" }], createdAt: 2 });
  const message = commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "compaction-user", expectedRevision: 1, text: "summary", retainedFromMessageId: "compaction-user", createdAt: 3, primaryProfile: primaryProfile(),
  });
  assert.deepEqual({ type: message.type, status: message.status, retainedFromMessageId: message.retainedFromMessageId, parts: message.parts.map((part) => ({ type: part.type, position: part.position, text: "text" in part ? part.text : null })) }, {
    type: "compaction", status: "completed", retainedFromMessageId: "compaction-user", parts: [{ type: "text", position: 0, text: "summary" }],
  });
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a") && { head: getMessageSession(db, "ws-a", "s-a")!.headMessageId, root: getMessageSession(db, "ws-a", "s-a")!.contextRootMessageId }, { head: "compaction", root: "compaction" });
  assert.deepEqual(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), { status: "completed", code: "compaction_completed", detail: null });
  assert.equal(commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "compaction-user", expectedRevision: 1, text: "summary", retainedFromMessageId: "compaction-user", createdAt: 3, primaryProfile: primaryProfile(),
  }).id, "compaction");
  assert.throws(() => commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "compaction-user", expectedRevision: 1, text: "different", retainedFromMessageId: "compaction-user", createdAt: 3,
  }), /replay conflicts/);
  db.close();
});

test("Compaction skeleton accepts a whole Assistant ToolCall block as a retained suffix anchor", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "before-tool", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "tool-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", expectedHeadMessageId: "before-tool", expectedRevision: 1, createdAt: 3 });
  assert.equal(flushStreamingParts(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", messageId: "tool-assistant", updatedAt: 4,
    parts: [{ id: "tool-call", position: 0, type: "tool_call", toolName: "bash", input: { command: "pwd" } }],
  }), "updated");
  assert.equal(completeAssistantWithExecutions(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", messageId: "tool-assistant", updatedAt: 5,
    executions: [{ id: "tool-execution", callPartId: "tool-call", originSessionId: "s-a", originRunId: "compaction-run", status: "queued" }],
  }), "updated");
  assert.equal(updateToolExecution(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", executionId: "tool-execution", status: "failed", error: "expected", completedAt: 6, updatedAt: 6,
  }), "updated");
  const head = getMessageSession(db, "ws-a", "s-a")!;
  const message = commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision, text: "summary", retainedFromMessageId: "tool-assistant", createdAt: 7, primaryProfile: primaryProfile(),
  });
  assert.equal(message.retainedFromMessageId, "tool-assistant");
  db.close();
});

test("Compaction retained anchor rejects a profile that does not match the persisted Run", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [{ id: "text", position: 0, type: "text", text: "keep" }], createdAt: 2 });
  const before = getMessageSession(db, "ws-a", "s-a")!;
  assert.throws(() => commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "anchor", expectedRevision: 1, text: "summary", retainedFromMessageId: "anchor", createdAt: 3, primaryProfile: primaryProfile("other-model"),
  }), /does not match the retained compaction run/);
  assert.equal(getMessage(db, "compaction"), null);
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), before);
  assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null);
  db.close();
});

test("Compaction retained anchor requires a non-empty Primary projection and preserves all state on failure", () => {
  const appendAnchor = (db: Database.Database, kind: "empty-user" | "empty-system" | "incompatible-replay") => {
    if (kind === "incompatible-replay") {
      appendMessage(db, {
        id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0,
        type: "assistant", status: "completed", parts: [{ id: "reason", position: 0, type: "reasoning", text: "" }], createdAt: 2,
      });
      db.prepare("update agent_message_part set provider_replay_json=? where id='reason'").run(JSON.stringify({
        version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "other-provider", model: "model" },
        item: { type: "reasoning", itemId: "reason", encryptedContent: "private" },
      }));
      return;
    }
    appendMessage(db, {
      id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0,
      type: kind === "empty-user" ? "user" : "system", status: "completed", parts: [{ id: "empty", position: 0, type: "text", text: "" }], createdAt: 2,
    });
  };
  for (const kind of ["empty-user", "empty-system", "incompatible-replay"] as const) {
    const db = createDb(); session(db);
    appendAnchor(db, kind);
    createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 3 });
    db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
    const beforeSession = getMessageSession(db, "ws-a", "s-a")!;
    const beforeRun = getRunRecord(db, "compaction-run")!;
    assert.throws(() => commitCompactionWithTerminalIntent(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
      expectedHeadMessageId: "anchor", expectedRevision: 1, text: "summary", retainedFromMessageId: "anchor", createdAt: 4, primaryProfile: primaryProfile(),
    }), /no visible primary projection/, kind);
    assert.equal(getMessage(db, "compaction"), null, kind);
    assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), beforeSession, kind);
    assert.deepEqual(getRunRecord(db, "compaction-run"), beforeRun, kind);
    assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null, kind);
    db.close();
  }
});

test("Compaction retained anchor accepts a compatible official OpenAI Responses replay-only Assistant", () => {
  const db = createDb(); session(db);
  appendMessage(db, {
    id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0,
    type: "assistant", status: "completed", parts: [{ id: "reason", position: 0, type: "reasoning", text: "" }], createdAt: 2,
  });
  db.prepare("update agent_message_part set provider_replay_json=? where id='reason'").run(JSON.stringify(replay({ type: "reasoning", itemId: "reason", encryptedContent: "private" })));
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 3 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  const message = commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "anchor", expectedRevision: 1, text: "summary", retainedFromMessageId: "anchor", createdAt: 4, primaryProfile: primaryProfile("model", "gpt-5"),
  });
  assert.equal(message.retainedFromMessageId, "anchor");
  db.close();
});

test("Compaction skeleton rejects an unreachable retained anchor without mutating session pointers", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const before = getMessageSession(db, "ws-a", "s-a")!;
  assert.throws(() => commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "user", expectedRevision: 1, text: "summary", retainedFromMessageId: "missing", createdAt: 3, primaryProfile: primaryProfile(),
  }), /retained anchor/);
  assert.equal(getMessage(db, "compaction"), null);
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), before);
  assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null);
  db.close();
});

test("Compaction skeleton rejects missing, queued, and running ToolCall executions without partial writes", () => {
  for (const status of [null, "queued", "running"] as const) {
    const db = createDb(); session(db);
    createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 1 });
    db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
    appendMessage(db, { id: "before-tool", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendMessage(db, {
      id: "tool-assistant", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "before-tool", expectedRevision: 1,
      type: "assistant", status: "completed", originRunId: "compaction-run", createdAt: 3,
      parts: [{ id: "tool-call", position: 0, type: "tool_call", toolName: "bash", input: { command: "pwd" } }],
    });
    if (status != null) {
      db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at)
        values ('tool-execution','tool-call','s-a','compaction-run',?,0,2,4,4)`).run(status);
    }
    const before = getMessageSession(db, "ws-a", "s-a")!;
    assert.throws(() => commitCompactionWithTerminalIntent(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
      expectedHeadMessageId: "tool-assistant", expectedRevision: 2, text: "summary", retainedFromMessageId: "tool-assistant", createdAt: 5, primaryProfile: primaryProfile(),
    }), /exactly one execution|non-terminal/, status ?? "missing");
    assert.equal(getMessage(db, "compaction"), null, status ?? "missing");
    assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), before, status ?? "missing");
    assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null, status ?? "missing");
    db.close();
  }
});

test("Compaction skeleton rejects a physically reachable original replaced by the current summary", () => {
  const db = createDb(); session(db);
  appendMessage(db, { id: "old", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  commitCompactionMessageForTest(db, {
    id: "previous-summary", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "old", expectedRevision: 1,
    textPartId: "previous-summary-text", text: "old summary", retainedFromMessageId: null, createdAt: 3,
  });
  appendMessage(db, { id: "after-summary", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "previous-summary", expectedRevision: 2, type: "user", status: "completed", parts: [], createdAt: 4 });
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 5 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  const before = getMessageSession(db, "ws-a", "s-a")!;
  assert.throws(() => commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "after-summary", expectedRevision: 3, text: "summary", retainedFromMessageId: "old", createdAt: 6, primaryProfile: primaryProfile(),
  }), /effective original block/);
  assert.equal(getMessage(db, "compaction"), null);
  assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), before);
  assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null);
  db.close();
});

test("Compaction skeleton rejects runtime, failed, and compaction anchor types without partial writes", () => {
  for (const [anchorType, appendAnchor] of [
    ["runtime", (db: Database.Database) => appendMessage(db, { id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "original", expectedRevision: 1, type: "runtime", status: "completed", parts: [], createdAt: 3 })],
    ["failed", (db: Database.Database) => appendMessage(db, { id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "original", expectedRevision: 1, type: "assistant", status: "failed", parts: [], createdAt: 3 })],
    ["compaction", (db: Database.Database) => commitCompactionMessageForTest(db, { id: "anchor", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "original", expectedRevision: 1, textPartId: "anchor-text", text: "old summary", retainedFromMessageId: null, createdAt: 3 })],
  ] as const) {
    const db = createDb(); session(db);
    appendMessage(db, { id: "original", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendAnchor(db);
    createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "manual_compaction", status: "running", createdAt: 4 });
    db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
    const before = getMessageSession(db, "ws-a", "s-a")!;
    assert.throws(() => commitCompactionWithTerminalIntent(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
      expectedHeadMessageId: "anchor", expectedRevision: 2, text: "summary", retainedFromMessageId: "anchor", createdAt: 5, primaryProfile: primaryProfile(),
    }), /effective original block/, anchorType);
    assert.equal(getMessage(db, "compaction"), null, anchorType);
    assert.deepEqual(getMessageSession(db, "ws-a", "s-a"), before, anchorType);
    assert.equal(getPersistedRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run" }), null, anchorType);
    db.close();
  }
});

test("Compaction skeleton rejects an invalid Run without writing a partial Message", () => {
  const db = createDb(); session(db);
  createMessageRunRecord(db, { runId: "compaction-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", runKind: "user", status: "running", createdAt: 1 });
  db.prepare("update session_run_state set status='running',active_run_id='compaction-run' where workspace_id='ws-a' and session_id='s-a'").run();
  appendMessage(db, { id: "compaction-user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  assert.throws(() => commitCompactionWithTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "compaction-run", id: "compaction", textPartId: "compaction-text",
    expectedHeadMessageId: "compaction-user", expectedRevision: 1, text: "summary", retainedFromMessageId: null, createdAt: 3,
  }), /not eligible/);
  assert.equal(getMessage(db, "compaction"), null);
  assert.equal(getRunRecord(db, "compaction-run")?.executionPhase, "work_pending");
  db.close();
});


test("terminal convergence 将 completed intent 原子收敛并支持重放", () => {
  const db = createDb(); session(db); activate(db);
  const before = getMessageSession(db, "ws-a", "s-a")!;
  assert.equal(persistRunTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "completed", code: "run_completed", detail: null, updatedAt: 2,
  }), "updated");
  assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 3 }), {
    kind: "transitioned", finalStatus: "completed",
  });
  const run = getRunRecord(db, "run-a");
  assert.equal(run?.status, "completed");
  assert.equal(run?.executionPhase, "terminal");
  assert.equal(run?.terminalResultCode, "run_completed");
  assert.equal(run?.intendedTerminalStatus, null);
  assert.equal(getMessageSession(db, "ws-a", "s-a")?.revision, before.revision + 1);
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.status, "idle");
  assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 4 }), {
    kind: "already_converged", finalStatus: "completed",
  });
});

test("completed convergence 遇到未完成产物会回滚并保留 intent", () => {
  for (const artifact of ["streaming", "queued", "running"] as const) {
    const db = createDb(); session(db); activate(db);
    appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendStreamingAssistant(db, { id: "assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "user", expectedRevision: 1, createdAt: 3 });
    if (artifact !== "streaming") {
      flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", parts: [{ id: "call", position: 0, type: "tool_call", toolName: "bash", input: {} }], updatedAt: 4 });
      completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "assistant", executions: [{ id: "execution", callPartId: "call", originSessionId: "s-a", originRunId: "run-a", status: "queued" }], updatedAt: 5 });
      if (artifact === "running") {
        assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "execution", status: "running", startedAt: 6, updatedAt: 6 }), "updated");
      }
    }
    assert.equal(persistRunTerminalIntent(db, {
      workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "completed", code: "run_completed", detail: null, updatedAt: 7,
    }), "updated");
    assert.throws(() => convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 8 }), /completed terminal intent has/);
    assert.equal(getRunRecord(db, "run-a")?.executionPhase, "terminal_intent_persisted", artifact);
    assert.equal(getMessageRunState(db, "ws-a", "s-a")?.activeRunId, "run-a", artifact);
    if (artifact === "streaming") assert.equal(getMessage(db, "assistant")?.status, "streaming");
    else assert.equal(getToolExecution(db, "execution")?.status, artifact);
  }
});

test("failed 与 cancelled convergence 结算本 run 的流式消息及未完成工具", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const db = createDb(); session(db); activate(db);
    appendMessage(db, { id: "user", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
    appendStreamingAssistant(db, { id: "tool-assistant", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "user", expectedRevision: 1, createdAt: 3 });
    flushStreamingParts(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "tool-assistant", parts: [
      { id: "queued-call", position: 0, type: "tool_call", toolName: "bash", input: {} },
      { id: "running-call", position: 1, type: "tool_call", toolName: "bash", input: {} },
    ], updatedAt: 4 });
    completeAssistantWithExecutions(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", messageId: "tool-assistant", executions: [
      { id: "queued", callPartId: "queued-call", originSessionId: "s-a", originRunId: "run-a", status: "queued" },
      { id: "running", callPartId: "running-call", originSessionId: "s-a", originRunId: "run-a", status: "queued" },
    ], updatedAt: 5 });
    assert.equal(updateToolExecution(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", executionId: "running", status: "running", startedAt: 6, updatedAt: 6 }), "updated");
    const beforeStreaming = getMessageSession(db, "ws-a", "s-a")!;
    appendStreamingAssistant(db, {
      id: "streaming", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a",
      expectedHeadMessageId: beforeStreaming.headMessageId, expectedRevision: beforeStreaming.revision, createdAt: 7,
    });
    const code = status === "failed" ? "run_failed" : "run_cancelled";
    assert.equal(persistRunTerminalIntent(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status, code, detail: null, updatedAt: 8 }), "updated");
    assert.deepEqual(convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 9 }), { kind: "transitioned", finalStatus: status });
    assert.equal(getMessage(db, "streaming")?.status, status);
    assert.equal(getToolExecution(db, "queued")?.status, "cancelled");
    assert.equal(getToolExecution(db, "running")?.status, "unknown");
    assert.equal(getRunRecord(db, "run-a")?.terminalResultCode, code);
  }
});


test("terminal convergence 按 origin session/run 隔离其他运行中的产物", () => {
  const db = createDb(); session(db, "s-a"); session(db, "s-b");
  activate(db, "s-a", "ws-a", "run-a"); activate(db, "s-b", "ws-a", "run-b");
  appendMessage(db, { id: "user-a", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant-a", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "user-a", expectedRevision: 1, createdAt: 3 });
  appendMessage(db, { id: "user-b", workspaceId: "ws-a", sessionId: "s-b", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  appendStreamingAssistant(db, { id: "assistant-b", workspaceId: "ws-a", sessionId: "s-b", runId: "run-b", expectedHeadMessageId: "user-b", expectedRevision: 1, createdAt: 3 });
  assert.equal(persistRunTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "failed", code: "run_failed", detail: null, updatedAt: 4,
  }), "updated");
  convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 5 });
  assert.equal(getMessage(db, "assistant-a")?.status, "failed");
  assert.equal(getMessage(db, "assistant-b")?.status, "streaming");
  assert.equal(getMessageRunState(db, "ws-a", "s-b")?.activeRunId, "run-b");
});

test("terminal convergence 的 stale active-run fence 不产生部分写入", () => {
  const db = createDb(); session(db); activate(db);
  assert.equal(persistRunTerminalIntent(db, {
    workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", status: "failed", code: "run_failed", detail: null, updatedAt: 2,
  }), "updated");
  createMessageRunRecord(db, { runId: "new-run", workspaceId: "ws-a", sessionId: "s-a", triggerMessageId: null, agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 3 });
  db.prepare("update session_run_state set active_run_id='new-run' where workspace_id='ws-a' and session_id='s-a'").run();
  assert.throws(() => convergeRunTerminal(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 4 }), /fence/);
  assert.equal(getRunRecord(db, "run-a")?.executionPhase, "terminal_intent_persisted");
  assert.equal(getMessageRunState(db, "ws-a", "s-a")?.activeRunId, "new-run");
});
