import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../infra/db/schema.js";
import {
  AgentMessageDomainError,
  AgentMessageConflictError,
  appendMessage,
  appendStreamingAssistant,
  cancelRunAndConverge,
  cancelWorkspaceRunsAndConverge,
  commitCompactionMessage,
  commitCompactionMessageWithRunFence,
  completeAssistantWithExecutions,
  createMessageSession,
  discardStreamingAssistant,
  failMessageRunAndConverge,
  flushStreamingParts,
  getMessage,
  getMessageRunState,
  getMessageSession,
  getToolExecution,
  isAncestor,
  moveMessageHead,
  forkMessageSession,
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
  db.prepare("insert into agent_run (run_id,workspace_id,session_id,trigger_message_id,agent_id,provider_id,model_id,status,created_at,updated_at) values (?,?,?,null,'agent','provider','model','running',1,1)").run(runId, workspaceId, sessionId);
  db.prepare("update session_run_state set status='running',active_run_id=? where workspace_id=? and session_id=?").run(runId, workspaceId, sessionId);
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

  const runtimeSessionIds = cancelWorkspaceRunsAndConverge(db, {
    workspaceId: "ws-a", updatedAt: 3, noticeText: "工作区删除",
  });

  assert.deepEqual(runtimeSessionIds, ["s-a", "s-a-2"]);
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

  db.prepare("update agent_run set status='failed' where run_id='r-discard'").run();
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
  assert.deepEqual(replaceStreamingAssistant(db, request), { result: "updated", message: getMessage(db, "new") });
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
  const compacted = commitCompactionMessage(db, { id: "c", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: afterMove.revision, textPartId: "cp", text: "summary", createdAt: 6 });
  assert.equal(compacted.type, "compaction"); assert.equal(getMessageSession(db, "ws-a", "s-a")!.contextRootMessageId, "c");
});

test("fenced compaction rejects stale Run without mutating the Message graph", () => {
  const db = createDb(); session(db); activate(db);
  appendMessage(db, { id: "u", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
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
  assert.equal(cancelRunAndConverge(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 8, noticeText: "用户已终止任务" }), true);
  assert.equal(getMessage(db, "later")!.status, "cancelled"); assert.equal(getToolExecution(db, "q")!.status, "cancelled"); assert.equal(getToolExecution(db, "r")!.status, "unknown");
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a"), { workspaceId: "ws-a", sessionId: "s-a", status: "idle", activeRunId: null, runNoticeText: "用户已终止任务", retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 8 });
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
    retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 2
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
  const root = commitCompactionMessage(db, { id: "c", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: "u", expectedRevision: 1, textPartId: "cp", text: "summary", createdAt: 3 });
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

  assert.equal(failMessageRunAndConverge(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 8 }), true);
  assert.equal(getMessage(db, "recovery-streaming")?.status, "failed");
  assert.equal(getToolExecution(db, "recovery-queued")?.status, "unknown");
  assert.equal((db.prepare("select status from agent_run where run_id='run-a'").get() as { status: string }).status, "failed");
  assert.deepEqual(getMessageRunState(db, "ws-a", "s-a"), {
    workspaceId: "ws-a", sessionId: "s-a", status: "idle", activeRunId: null, runNoticeText: "",
    retryCount: 0, nextRetryAt: null, activeAssistantMessageId: null, nonTerminalMessageIds: [], nonTerminalToolExecutionIds: [], updatedAt: 8
  });
  assert.equal(failMessageRunAndConverge(db, { workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", updatedAt: 9 }), false);
});

test("Compaction fenced commit 对同一不可变请求精确重放，差异请求 fail closed", () => {
  const db = createDb();
  session(db); activate(db);
  const user = appendMessage(db, { id: "u-replay", workspaceId: "ws-a", sessionId: "s-a", expectedHeadMessageId: null, expectedRevision: 0, type: "user", status: "completed", parts: [], createdAt: 2 });
  const current = getMessageSession(db, "ws-a", "s-a")!;
  assert.equal(getMessageRunState(db, "ws-a", "s-a")!.activeRunId, "run-a");
  const request = { id: "c-replay", workspaceId: "ws-a", sessionId: "s-a", runId: "run-a", expectedHeadMessageId: "u-replay", expectedRevision: current.revision, textPartId: "cp-replay", text: "summary", createdAt: 3 };
  assert.equal(commitCompactionMessageWithRunFence(db, request)?.id, "c-replay");
  assert.equal(commitCompactionMessageWithRunFence(db, request)?.id, "c-replay");
  assert.equal(commitCompactionMessageWithRunFence(db, { ...request, text: "different" }), null);
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
