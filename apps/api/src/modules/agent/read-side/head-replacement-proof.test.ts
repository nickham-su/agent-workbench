import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Value } from "@sinclair/typebox/value";
import { AgentHeadReplacementProofSchema, AgentTimelineDeltaResponseSchema } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { initSchema } from "../../../infra/db/schema.js";
import {
  appendMessage, appendStreamingAssistant, completeAssistantWithExecutions,
  createMessageRunRecord, createMessageSession, flushStreamingParts, getMessageSessionHead,
  replaceStreamingAssistant, startMessageRun
} from "../agent-message.store.js";
import { SqliteMessageQuery } from "./sqlite-message-query.js";

function createFixture(replacements = 2, db = new Database(":memory:")) {
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  appendMessage(db, {
    id: "user", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: null, expectedRevision: 0,
    type: "user", status: "completed", parts: [], createdAt: 2
  });
  createMessageRunRecord(db, {
    runId: "run", workspaceId: "ws", sessionId: "session", triggerMessageId: "user",
    agentId: "agent", providerId: "provider", modelId: "model", status: "running", createdAt: 3
  });
  startMessageRun(db, { workspaceId: "ws", sessionId: "session", runId: "run", updatedAt: 3 });
  appendStreamingAssistant(db, {
    id: "attempt-0", workspaceId: "ws", sessionId: "session", runId: "run",
    expectedHeadMessageId: "user", expectedRevision: 1, createdAt: 4
  });
  flushStreamingParts(db, {
    workspaceId: "ws", sessionId: "session", runId: "run", messageId: "attempt-0", updatedAt: 5,
    parts: [{ id: "old-part", position: 0, type: "text", text: "unpublished old attempt content" }]
  });
  const sinceRevision = getMessageSessionHead(db, { workspaceId: "ws", sessionId: "session" })!.revision;
  for (let i = 1; i <= replacements; i++) {
    const head = getMessageSessionHead(db, { workspaceId: "ws", sessionId: "session" })!;
    const result = replaceStreamingAssistant(db, {
      workspaceId: "ws", sessionId: "session", runId: "run", oldMessageId: `attempt-${i - 1}`, newMessageId: `attempt-${i}`,
      expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
      runNoticeText: "retrying", retryCount: i, nextRetryAt: null, createdAt: 5 + i
    });
    assert.equal(result.result, "updated");
  }
  const query = new SqliteMessageQuery(db);
  const request = { workspaceId: "ws", sessionId: "session", mode: "delta" as const, sinceRevision, knownHeadMessageId: "attempt-0" };
  return { db, query, request, toId: `attempt-${replacements}` };
}

test("ACC-PROOF-DIRECT/CHAIN: native retry history yields a constant, snapshot-bound summary without hidden content", () => {
  for (const count of [1, 2]) {
    const { db, query, request, toId } = createFixture(count);
    try {
      const response = query.getTimeline(request);
      assert.equal(response.timelineReset, true);
      assert.deepEqual(response.headReplacement, {
        workspaceId: "ws", sessionId: "session", runId: "run", fromMessageId: "attempt-0", toMessageId: toId,
        previousMessageId: "user", depth: 1, fromSupersededRevision: request.sinceRevision + 1,
        toUpdatedRevision: response.session.revision, toStatus: "streaming", replacementCount: count,
        atRevision: response.session.revision
      });
      assert.equal(Value.Check(AgentTimelineDeltaResponseSchema, response), true);
      assert.equal(Object.keys(response.headReplacement!).length, 12);
      assert.doesNotMatch(JSON.stringify(response), /unpublished old attempt content|old-part/);
      if (count === 2) {
        assert.doesNotMatch(JSON.stringify(response.headReplacement), /attempt-1/);
        assert.equal(response.messages.some((message) => message.id === "attempt-1"), false);
      }
      for (let i = 0; i < count; i++) {
        assert.throws(() => query.getMessage({ ...request, messageId: `attempt-${i}` }),
          (error: unknown) => error instanceof HttpError && error.statusCode === 404 && error.code === "MESSAGE_NOT_FOUND");
      }
    } finally { db.close(); }
  }
});

test("ACC-PROOF-SLOT: a completed replacement is found behind later messages and outside the reset tail page", () => {
  const { db, query, request, toId } = createFixture();
  try {
    completeAssistantWithExecutions(db, { ...request, runId: "run", messageId: toId, executions: [], updatedAt: 20 });
    for (const id of ["later-d", "later-e"]) {
      const head = getMessageSessionHead(db, request)!;
      appendMessage(db, {
        id, ...request, expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
        type: "user", status: "completed", parts: [], createdAt: 21
      });
    }
    const response = query.getTimeline({ ...request, limit: 1 });
    assert.deepEqual(response.messages.map((message) => message.id), ["later-e"]);
    assert.equal(response.headReplacement?.toMessageId, toId);
    assert.equal(response.headReplacement?.toStatus, "completed");
    const older = query.getTimeline({ ...request, mode: "before", beforeMessageId: response.nextBeforeMessageId!, limit: 10 });
    assert.deepEqual(older.messages.map((message) => message.id), ["user", toId, "later-d"]);
    assert.equal(Object.hasOwn(older, "headReplacement"), false);
  } finally { db.close(); }
});

test("ACC-PROOF-BOUND: exactly 256 edges are provable, 257 edges are not and no extra predecessor is read", () => {
  for (const edges of [256, 257]) {
    const { db, query, request } = createFixture(edges);
    try {
      const internal = query as unknown as { replacementHead: (workspaceId: string, messageId: string) => unknown };
      const original = internal.replacementHead.bind(query);
      const reads: string[] = [];
      internal.replacementHead = (workspaceId, messageId) => { reads.push(messageId); return original(workspaceId, messageId); };
      const runBefore = db.prepare("select * from session_run_state").all();
      const response = query.getTimeline(request);
      assert.equal(response.headReplacement?.replacementCount, edges === 256 ? 256 : undefined);
      // Candidate comes from the visible-slot query; these reads include from once.
      assert.equal(reads.length, 256);
      assert.equal(new Set(reads).size, reads.length);
      if (edges === 257) assert.equal(reads.includes("attempt-1"), false);
      assert.deepEqual(db.prepare("select * from session_run_state").all(), runBefore);
    } finally { db.close(); }
  }
});

test("ACC-PROOF-DAMAGE: corrupt replacement edges or headers omit evidence instead of exposing graph diagnostics", async (t) => {
  const cases: Array<[string, string]> = [
    ["cycle", "update agent_message set replaces_message_id = 'attempt-2' where id = 'attempt-1'"],
    ["broken link", "update agent_message set replaces_message_id = null where id = 'attempt-1'"],
    ["different workspace", "update agent_message set workspace_id = 'other-ws' where id = 'attempt-1'"],
    ["different session", "update agent_message set origin_session_id = 'other-session' where id = 'attempt-1'"],
    ["different run", "update agent_message set origin_run_id = 'different-run' where id = 'attempt-1'"],
    ["missing origin", "update agent_message set origin_run_id = null where id = 'attempt-0'"],
    ["wrong type", "update agent_message set type = 'user' where id = 'attempt-1'"],
    ["non-superseded parent", "update agent_message set status = 'failed' where id = 'attempt-1'"],
    ["wrong previous", "update agent_message set previous_message_id = null where id = 'attempt-1'"],
    ["wrong depth", "update agent_message set depth = 2 where id = 'attempt-1'"],
    ["negative revision", "update agent_message set updated_revision = -1 where id = 'attempt-1'"],
    ["fractional revision", "update agent_message set updated_revision = 4.5 where id = 'attempt-1'"],
    ["future revision", "update agent_message set updated_revision = 999 where id = 'attempt-1'"],
    ["equal supersede revisions", "update agent_message set updated_revision = (select updated_revision from agent_message where id = 'attempt-0') where id = 'attempt-1'"],
    ["from predates watermark", "update agent_message set updated_revision = 3 where id = 'attempt-0'"],
    ["candidate revision before parent", "update agent_message set updated_revision = 3 where id = 'attempt-2'"],
    ["candidate not assistant", "update agent_message set type = 'user' where id = 'attempt-2'"],
    ["candidate wrong slot", "update agent_message set previous_message_id = null where id = 'attempt-2'"],
    ["candidate superseded", "update agent_message set status = 'superseded' where id = 'attempt-2'"]
  ];
  for (const [name, sql] of cases) await t.test(name, () => {
    const { db, query, request } = createFixture();
    try {
      db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('other-ws','other-ws','Other','/other',1,1)").run();
      createMessageSession(db, { id: "other-session", workspaceId: "ws", title: "Other", kind: "primary", createdAt: 1 });
      // The test deliberately corrupts history; runtime writes never use this path.
      db.pragma("foreign_keys = OFF");
      db.pragma("ignore_check_constraints = ON");
      db.prepare(sql).run();
      const response = query.getTimeline(request);
      assert.equal(Object.hasOwn(response, "headReplacement"), false);
      assert.equal(Value.Check(AgentTimelineDeltaResponseSchema, response), true);
    } finally { db.close(); }
  });
});

test("ACC-PROOF-NO-PARAM/ISOLATION: only a valid native invisible knownHead delta can receive evidence", () => {
  const { db, query, request, toId } = createFixture();
  try {
    for (const input of [
      { ...request, knownHeadMessageId: undefined }, { ...request, knownHeadMessageId: toId },
      { ...request, knownHeadMessageId: "absent" }, { ...request, sinceRevision: undefined },
      { ...request, sinceRevision: 999 }, { ...request, sinceRevision: -1 },
      { ...request, sinceRevision: 1.5 }, { ...request, mode: "snapshot" as const },
      { ...request, mode: "before" as const, beforeMessageId: toId }
    ]) assert.equal(Object.hasOwn(query.getTimeline(input), "headReplacement"), false);

    createMessageSession(db, { id: "other-session", workspaceId: "ws", title: "Other", kind: "primary", createdAt: 1 });
    const anotherSession = query.getTimeline({ ...request, sessionId: "other-session", sinceRevision: 0 });
    assert.equal(Object.hasOwn(anotherSession, "headReplacement"), false);
    db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('other-ws','other-ws','Other','/other',1,1)").run();
    createMessageSession(db, { id: "other-ws-session", workspaceId: "other-ws", title: "Other", kind: "primary", createdAt: 1 });
    assert.equal(Object.hasOwn(query.getTimeline({ ...request, workspaceId: "other-ws", sessionId: "other-ws-session", sinceRevision: 0 }), "headReplacement"), false);

    // Inherited visible history is not a native retry of the requesting Session.
    createMessageSession(db, {
      id: "fork", workspaceId: "ws", title: "Fork", kind: "primary", createdAt: 20,
      forkedFromSessionId: "session", forkedFromMessageId: toId, headMessageId: toId, contextRootMessageId: "user"
    });
    db.prepare("update agent_session set revision = 100 where id = 'fork'").run();
    assert.equal(Object.hasOwn(query.getTimeline({ ...request, sessionId: "fork" }), "headReplacement"), false);

    assert.throws(() => query.getTimeline({ ...request, mode: "before", beforeMessageId: "attempt-0" }),
      (error: unknown) => error instanceof HttpError && error.code === "TIMELINE_CURSOR_NOT_FOUND");
    assert.equal(db.inTransaction, false);

    // A root change may still carry evidence but must not restore the old-head full-chain lookup.
    const internal = query as unknown as { isDisplayChainMessage: () => boolean };
    internal.isDisplayChainMessage = () => { throw new Error("root change must skip old-head visibility scan"); };
    const reset = query.getTimeline({ ...request, knownContextRootMessageId: "old-root" });
    assert.equal(reset.timelineReset, true);
    assert.equal(reset.headReplacement?.toMessageId, toId);
  } finally { db.close(); }
});

test("ACC-PROOF-SCHEMA: summary schema is strict and bounds statuses, counts, IDs and revisions", () => {
  const { db, query, request } = createFixture();
  try {
    const proof = query.getTimeline(request).headReplacement!;
    assert.equal(Value.Check(AgentHeadReplacementProofSchema, proof), true);
    for (const patch of [
      { replacementCount: 0 }, { replacementCount: 257 }, { replacementCount: 1.5 },
      { toStatus: "superseded" }, { fromMessageId: "" }, { depth: -1 },
      { atRevision: -1 }, { fromSupersededRevision: 1.1 }, { oldParts: [] }
    ]) assert.equal(Value.Check(AgentHeadReplacementProofSchema, { ...proof, ...patch }), false);
  } finally { db.close(); }
});

test("ACC-PROOF-READVIEW: concurrent WAL writer cannot mix later messages, Parts or proof into an earlier session revision", () => {
  const testsRoot = fileURLToPath(new URL("../../../../../../.tmp-tests/", import.meta.url));
  mkdirSync(testsRoot, { recursive: true });
  const directory = mkdtempSync(join(testsRoot, "head-proof-readview-"));
  const db = new Database(join(directory, "test.sqlite"));
  let writer: Database.Database | undefined;
  try {
    db.pragma("journal_mode = WAL");
    const { query, request, toId } = createFixture(1, db);
    writer = new Database(join(directory, "test.sqlite"));
    writer.pragma("foreign_keys = ON");
    const initialRevision = getMessageSessionHead(db, request)!.revision;
    const internal = query as unknown as { requireSession: (workspaceId: string, sessionId: string) => unknown };
    const requireSession = internal.requireSession.bind(query);
    let injected = false;
    internal.requireSession = (workspaceId, sessionId) => {
      const session = requireSession(workspaceId, sessionId);
      if (!injected) {
        injected = true;
        const replacement = replaceStreamingAssistant(writer!, {
          ...request, runId: "run", oldMessageId: toId, newMessageId: "later-attempt",
          expectedHeadMessageId: toId, expectedRevision: initialRevision,
          runNoticeText: "retrying", retryCount: 2, nextRetryAt: null, createdAt: 30
        });
        assert.equal(replacement.result, "updated");
        flushStreamingParts(writer!, {
          ...request, runId: "run", messageId: "later-attempt", updatedAt: 31,
          parts: [{ id: "later-part", position: 0, type: "text", text: "later snapshot text" }]
        });
      }
      return session;
    };
    const response = query.getTimeline(request);
    assert.equal(response.session.revision, initialRevision);
    assert.equal(response.headReplacement?.atRevision, initialRevision);
    assert.equal(response.headReplacement?.toMessageId, toId);
    assert.equal(response.headReplacement?.replacementCount, 1);
    assert.deepEqual(response.messages.map((message) => message.id), ["user", toId]);
    assert.doesNotMatch(JSON.stringify(response), /later-attempt|later-part|later snapshot text/);
    assert.equal(db.inTransaction, false);
    const next = query.getTimeline(request);
    assert.ok(next.session.revision > initialRevision);
    assert.equal(next.headReplacement?.replacementCount, 2);
    assert.equal(next.headReplacement?.toMessageId, "later-attempt");
    assert.match(JSON.stringify(next), /later snapshot text/);
  } finally {
    writer?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
