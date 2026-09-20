import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendMessage,
  commitCompactionMessageForTest,
  createMessageRunRecord,
  createMessageSession,
  forkMessageSession,
  startMessageRun,
} from "../agent-message.store.js";
import { RuntimeTranscriptProjector } from "./runtime-transcript-projector.js";
import {
  ModelContextInvariantError,
  ModelContextResolver,
  projectModelContextToPrompt,
} from "./model-context-resolver.js";

type Fixture = { db: Database.Database; resolver: ModelContextResolver };

type MessagePart =
  | { id: string; position: number; type: "text"; text: string }
  | {
      id: string;
      position: number;
      type: "tool_call";
      toolName: "bash";
      input: Record<string, unknown>;
      providerToolCallId: string;
    }
  | { id: string; position: number; type: "reasoning"; text: string
    };

function createFixture(): Fixture {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
  createMessageSession(db, {
    id: "session",
    workspaceId: "ws",
    title: "Session",
    kind: "primary",
    createdAt: 1,
  });
  return { db, resolver: new ModelContextResolver(db) };
}

function head(db: Database.Database) {
  return db.prepare("select head_message_id as headMessageId, revision from agent_session where id='session'").get() as {
    headMessageId: string | null;
    revision: number;
  };
}

function append(
  db: Database.Database,
  input: {
    id: string;
    type?: "user" | "assistant" | "runtime";
    status?: "completed" | "failed";
    text?: string;
    parts?: MessagePart[];
  },
) {
  const current = head(db);
  return appendMessage(db, {
    id: input.id,
    workspaceId: "ws",
    sessionId: "session",
    expectedHeadMessageId: current.headMessageId,
    expectedRevision: current.revision,
    type: input.type ?? "user",
    status: input.status ?? "completed",
    parts: input.parts ?? [{
      id: `${input.id}-text`,
      position: 0,
      type: "text",
      text: input.text ?? input.id,
    }],
    createdAt: current.revision + 2,
  });
}

function clearContextRoot(db: Database.Database) {
  db.prepare("update agent_session set context_root_message_id = null where id='session'").run();
}

test("Resolver separates the full Timeline chain from model context and preserves retained-tail replay metadata", () => {
  const { db, resolver } = createFixture();
  append(db, { id: "old-user", text: "old" });
  append(db, { id: "retained-user", text: "retained" });
  const first = head(db);
  commitCompactionMessageForTest(db, {
    id: "summary-1",
    workspaceId: "ws",
    sessionId: "session",
    expectedHeadMessageId: first.headMessageId,
    expectedRevision: first.revision,
    textPartId: "summary-1-text",
    text: "summary one",
    retainedFromMessageId: "retained-user",
    createdAt: 10,
  });
  append(db, { id: "after-summary", type: "assistant", text: "answer" });
  db.prepare("update agent_message_part set provider_replay_json = ? where id = 'after-summary-text'").run(JSON.stringify({
    version: 1,
    provider: {
      npm: "@ai-sdk/openai",
      api: "responses",
      providerId: "openai",
      model: "gpt-test",
    },
    item: { type: "text", itemId: "response-item" },
  }));

  const second = head(db);
  commitCompactionMessageForTest(db, {
    id: "summary-2",
    workspaceId: "ws",
    sessionId: "session",
    expectedHeadMessageId: second.headMessageId,
    expectedRevision: second.revision,
    textPartId: "summary-2-text",
    text: "summary two",
    retainedFromMessageId: "retained-user",
    createdAt: 12,
  });
  append(db, { id: "new-user", text: "new" });

  const resolved = resolver.resolve({ workspaceId: "ws", sessionId: "session" });
  assert.deepEqual(
    resolved.blocks.map((block) => block.sourceMessageId),
    ["summary-2", "retained-user", "after-summary", "new-user"],
  );
  assert.equal(resolved.blocks.some((block) => block.sourceMessageId === "old-user"), false);
  assert.equal(resolved.blocks.some((block) => block.sourceMessageId === "summary-1"), false);
  assert.deepEqual(
    resolved.blocks.find((block) => block.sourceMessageId === "after-summary")?.providerReplay.map((item) => item.partId),
    ["after-summary-text"],
  );
  assert.equal(resolved.providerReplayByPartId.get("after-summary-text")?.item.type, "text");
});

test("Resolver skips runtime and failed history without a compaction root", () => {
  const { db, resolver } = createFixture();
  append(db, { id: "user", text: "visible" });
  append(db, { id: "runtime", type: "runtime", text: "runtime" });
  append(db, { id: "failed", status: "failed", text: "failed" });
  clearContextRoot(db);

  const resolved = resolver.resolve({ workspaceId: "ws", sessionId: "session" });
  assert.deepEqual(resolved.blocks.map((block) => block.sourceMessageId), ["user"]);
});

test("pending tool executions remain in the source but stop model transcript before their Assistant", () => {
  const { db, resolver } = createFixture();
  append(db, { id: "user", text: "request" });
  createMessageRunRecord(db, {
    runId: "run",
    workspaceId: "ws",
    sessionId: "session",
    triggerMessageId: "user",
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    status: "running",
    createdAt: 4,
  });
  startMessageRun(db, { workspaceId: "ws", sessionId: "session", runId: "run", updatedAt: 4 });
  append(db, {
    id: "assistant",
    type: "assistant",
    parts: [{
      id: "call",
      position: 0,
      type: "tool_call",
      toolName: "bash",
      input: {},
      providerToolCallId: "provider-call",
    }],
  });
  db.prepare(`
    insert into agent_tool_execution (
      id, call_part_id, origin_session_id, origin_run_id, status, result_truncated,
      updated_revision, created_at, updated_at
    ) values ('execution', 'call', 'session', 'run', 'queued', 0, 3, 6, 6)
  `).run();
  clearContextRoot(db);

  const resolved = resolver.resolve({ workspaceId: "ws", sessionId: "session" });
  assert.equal(resolved.blocks.at(-1)?.toolExecutions[0]?.status, "queued");
  const projected = projectModelContextToPrompt({
    workspaceId: "ws",
    triggerMessageId: "user",
    resolved,
    projector: new RuntimeTranscriptProjector(),
    stopBeforeAssistantMessageIds: new Set(["assistant"]),
  });
  assert.deepEqual(projected.messages, [{ role: "user", content: "request" }]);
});

test("Resolver rejects stale compaction-source reads and validates a current run", () => {
  const { db, resolver } = createFixture();
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('other','other','Other','/other',1,1)").run();
  append(db, { id: "user", text: "request" });
  createMessageRunRecord(db, {
    runId: "run",
    workspaceId: "ws",
    sessionId: "session",
    triggerMessageId: "user",
    agentId: "agent",
    providerId: "provider",
    modelId: "model",
    status: "running",
    createdAt: 3,
  });
  startMessageRun(db, { workspaceId: "ws", sessionId: "session", runId: "run", updatedAt: 3 });
  assert.doesNotThrow(() => resolver.resolve({ workspaceId: "ws", sessionId: "session", runId: "run" }));
  assert.throws(
    () => resolver.resolve({ workspaceId: "other", sessionId: "session", runId: "run" }),
    (error: unknown) => error instanceof ModelContextInvariantError && error.message === "session not found",
  );
  db.prepare("update session_run_state set status='idle', active_run_id=null where workspace_id='ws' and session_id='session'").run();
  assert.throws(
    () => resolver.resolve({ workspaceId: "ws", sessionId: "session", runId: "run" }),
    (error: unknown) => error instanceof ModelContextInvariantError && error.message === "run is not the active model context run",
  );
  db.prepare("update session_run_state set status='running', active_run_id='run' where workspace_id='ws' and session_id='session'").run();
  db.prepare(`update agent_run set execution_phase='terminal_intent_persisted',
    intended_terminal_status='completed', intended_terminal_code='run_completed', intended_terminal_detail=null
    where run_id='run'`).run();
  assert.throws(
    () => resolver.resolve({ workspaceId: "ws", sessionId: "session", runId: "run" }),
    (error: unknown) => error instanceof ModelContextInvariantError && error.message === "run is not the active model context run",
    "terminal_intent_persisted",
  );
  db.prepare(`update agent_run set status='completed', execution_phase='terminal',
    intended_terminal_status=null, intended_terminal_code=null, intended_terminal_detail=null,
    terminal_result_code='run_completed', terminal_result_detail=null
    where run_id='run'`).run();
  assert.throws(
    () => resolver.resolve({ workspaceId: "ws", sessionId: "session", runId: "run" }),
    (error: unknown) => error instanceof ModelContextInvariantError && error.message === "run is not the active model context run",
    "terminal",
  );
  db.close();
});

test("Resolver keeps one deferred WAL snapshot when another connection advances the Session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "awb-resolver-snapshot-"));
  const databasePath = path.join(directory, "db.sqlite");
  const reader = new Database(databasePath);
  const writer = new Database(databasePath);
  try {
    for (const db of [reader, writer]) {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 2000");
    }
    initSchema(reader);
    reader.pragma("journal_mode = WAL");
    writer.pragma("journal_mode = WAL");
    reader.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
    createMessageSession(reader, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
    appendMessage(reader, {
      id: "before", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
      type: "user", status: "completed", parts: [{ id: "before-text", position: 0, type: "text", text: "before" }], createdAt: 2,
    });
    class SnapshotResolver extends ModelContextResolver {
      private advanced = false;
      protected override onReadSnapshotEstablished() {
        if (this.advanced) return;
        this.advanced = true;
        appendMessage(writer, {
          id: "after", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "before", expectedRevision: 1,
          type: "user", status: "completed", parts: [{ id: "after-text", position: 0, type: "text", text: "after" }], createdAt: 3,
        });
      }
    }
    const resolver = new SnapshotResolver(reader);
    const snapshot = resolver.resolve({ workspaceId: "ws", sessionId: "session" });
    assert.equal(snapshot.headMessageId, "before");
    assert.equal(snapshot.sessionRevision, 1);
    assert.deepEqual(snapshot.blocks.map((block) => block.sourceMessageId), ["before"]);
    const current = resolver.resolve({ workspaceId: "ws", sessionId: "session" });
    assert.equal(current.headMessageId, "after");
    assert.equal(current.sessionRevision, 2);
  } finally {
    writer.close();
    reader.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Resolver batches Part hydration inside one context transaction", () => {
  const { db, resolver } = createFixture();
  for (let index = 0; index < 405; index += 1) {
    append(db, { id: `message-${index}`, text: `message ${index}` });
  }
  clearContextRoot(db);
  const resolved = resolver.resolve({ workspaceId: "ws", sessionId: "session" });
  assert.equal(resolved.blocks.length, 405);
  assert.equal(resolved.blocks[0]?.message.id, "message-0");
  assert.equal(resolved.blocks.at(-1)?.message.id, "message-404");
  db.close();
});

test("Provider replay visibleIndex follows actual transcript visibility", () => {
  const { db, resolver } = createFixture();
  append(db, { id: "user", text: "request" });
  append(db, {
    id: "assistant", type: "assistant", parts: [
      { id: "reasoning", position: 0, type: "reasoning", text: "private" },
      { id: "empty", position: 1, type: "text", text: "" },
      { id: "visible", position: 2, type: "text", text: "answer" },
      { id: "call", position: 3, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: "call-id" },
    ],
  });
  db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at,started_at,completed_at)
    values ('execution','call','session',null,'completed',0,2,4,4,4,4)`).run();
  const envelope = (item: unknown) => JSON.stringify({ version: 1, provider: { npm: "@ai-sdk/openai", api: "responses", providerId: "openai", model: "test" }, item });
  db.prepare("update agent_message_part set provider_replay_json=? where id='reasoning'").run(envelope({ type: "reasoning", itemId: "r", encryptedContent: "x" }));
  db.prepare("update agent_message_part set provider_replay_json=? where id='empty'").run(envelope({ type: "text", itemId: "empty" }));
  db.prepare("update agent_message_part set provider_replay_json=? where id='visible'").run(envelope({ type: "text", itemId: "visible" }));
  db.prepare("update agent_message_part set provider_replay_json=? where id='call'").run(envelope({ type: "function_call", itemId: "call" }));
  clearContextRoot(db);

  const projected = projectModelContextToPrompt({
    workspaceId: "ws", triggerMessageId: "user", resolved: resolver.resolve({ workspaceId: "ws", sessionId: "session" }),
    projector: new RuntimeTranscriptProjector(), includeReplayOnlyAssistants: true,
  });
  assert.deepEqual(projected.providerReplay[0]?.parts.map((part) => [part.type, part.visibleIndex]), [
    ["reasoning", 0], ["text", 0], ["tool_call", 1],
  ]);
  db.close();
});

test("Resolver accepts a shared fork ancestor in the same workspace", () => {
  const { db, resolver } = createFixture();
  append(db, { id: "shared-user", text: "shared" });
  forkMessageSession(db, {
    id: "child", workspaceId: "ws", sourceSessionId: "session", expectedHeadMessageId: "shared-user",
    expectedRevision: 1, targetMessageId: "shared-user", title: "child", kind: "subtask", createdAt: 3,
  });
  const child = resolver.resolve({ workspaceId: "ws", sessionId: "child" });
  assert.deepEqual(child.blocks.map((block) => block.message.id), ["shared-user"]);
  db.close();
});

test("Resolver fail-closes corrupt replay and a missing ToolExecution", () => {
  const { db, resolver } = createFixture();
  append(db, { id: "user", text: "request" });
  append(db, { id: "assistant", type: "assistant", parts: [{
    id: "call", position: 0, type: "tool_call", toolName: "bash", input: {}, providerToolCallId: "call",
  }] });
  clearContextRoot(db);
  assert.throws(() => resolver.resolve({ workspaceId: "ws", sessionId: "session" }), /exactly one execution/);
  db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at)
    values ('execution','call','session',null,'completed',0,2,4,4)`).run();
  db.prepare("update agent_message_part set provider_replay_json='not-json' where id='call'").run();
  assert.throws(() => resolver.resolve({ workspaceId: "ws", sessionId: "session" }), /provider replay/);
  db.close();
});

test("Resolver keeps attachment metadata without reading attachment bytes", () => {
  const { db, resolver } = createFixture();
  db.prepare("insert into agent_attachment (id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values ('attachment','ws','attachment-key','image.png','image/png',1,1)")
    .run();
  appendMessage(db, {
    id: "image-user", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", createdAt: 2,
    parts: [{ id: "image", position: 0, type: "image", attachmentId: "attachment", mediaType: "image/png", filename: "image.png" }],
  });
  clearContextRoot(db);
  assert.deepEqual(resolver.resolve({ workspaceId: "ws", sessionId: "session" }).blocks[0]?.attachments, [{
    partId: "image", attachmentId: "attachment", mediaType: "image/png", filename: "image.png",
  }]);
  db.close();
});

test("Resolver batches ToolExecution hydration when call parts cross the SQLite IN batch", () => {
  const { db, resolver } = createFixture();
  const parts = Array.from({ length: 401 }, (_, index) => ({
    id: `call-${index}`, position: index, type: "tool_call" as const, toolName: "bash" as const,
    input: {}, providerToolCallId: `provider-${index}`,
  }));
  append(db, { id: "assistant", type: "assistant", parts });
  const insert = db.prepare(`insert into agent_tool_execution (id,call_part_id,origin_session_id,origin_run_id,status,result_truncated,updated_revision,created_at,updated_at)
    values (@id,@callPartId,'session',null,'completed',0,1,3,3)`);
  const insertAll = db.transaction(() => {
    for (let index = 0; index < 401; index += 1) insert.run({ id: `execution-${index}`, callPartId: `call-${index}` });
  });
  insertAll();
  clearContextRoot(db);
  assert.equal(resolver.resolve({ workspaceId: "ws", sessionId: "session" }).blocks[0]?.toolExecutions.length, 401);
  db.close();
});
