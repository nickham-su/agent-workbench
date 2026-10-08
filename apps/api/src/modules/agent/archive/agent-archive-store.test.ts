import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { initSchema } from "../../../infra/db/schema.js";
import { appendMessage, commitCompactionMessageForTest, createMessageSession } from "../agent-message.store.js";
import { archiveRead, archiveSearch, rebuildArchivedTextFts } from "./agent-archive-store.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  db.prepare("insert into workspaces (id,dir_name,title,path,created_at,updated_at) values ('ws','ws','Workspace','/workspace',1,1)").run();
  createMessageSession(db, { id: "session", workspaceId: "ws", title: "Session", kind: "primary", createdAt: 1 });
  return db;
}

function append(db: Database.Database, input: { id: string; previous: string | null; revision: number; type?: "user" | "assistant" | "system" | "runtime"; status?: "completed" | "failed" | "cancelled" | "superseded"; text: string; partType?: "text" | "reasoning" }) {
  return appendMessage(db, {
    id: input.id, workspaceId: "ws", sessionId: "session", expectedHeadMessageId: input.previous, expectedRevision: input.revision,
    type: input.type ?? "user", status: input.status ?? "completed", parts: [{ id: `${input.id}-part`, position: 0, type: input.partType ?? "text", text: input.text }], createdAt: input.revision + 10,
  });
}

test("archive FTS only indexes eligible completed TextPart and keeps completion idempotent", () => {
  const db = fixture();
  append(db, { id: "user", previous: null, revision: 0, text: "中文归档检索内容" });
  append(db, { id: "reasoning", previous: "user", revision: 1, type: "assistant", text: "不应索引 reasoning", partType: "reasoning" });
  append(db, { id: "failed", previous: "reasoning", revision: 2, type: "assistant", status: "failed", text: "不应索引 failed" });
  assert.equal((db.prepare("select count(*) as count from agent_archived_text_fts").get() as { count: number }).count, 1);
  assert.equal((db.prepare("select count(*) as count from agent_text_part_fts_map").get() as { count: number }).count, 1);
  const row = db.prepare("select map.part_id as partId, map.fts_rowid as ftsRowid, fts.rowid as rowid from agent_text_part_fts_map map join agent_archived_text_fts fts on fts.rowid = map.fts_rowid").get() as { partId: string; ftsRowid: number; rowid: number };
  assert.deepEqual(row, { partId: "user-part", ftsRowid: row.rowid, rowid: row.rowid });
  rebuildArchivedTextFts(db, 99);
  rebuildArchivedTextFts(db, 100);
  assert.equal((db.prepare("select count(*) as count from agent_archived_text_fts").get() as { count: number }).count, 1);
  db.close();
});

test("公开 FTS 重建入口失败时原索引保持完整", () => {
  const db = fixture();
  append(db, { id: "old", previous: null, revision: 0, text: "stable old index" });
  const before = db.prepare("select map.part_id as partId, fts.text as text from agent_text_part_fts_map map join agent_archived_text_fts fts on fts.rowid = map.fts_rowid order by partId").all();
  db.exec(`create trigger reject_rebuild_map before insert on agent_text_part_fts_map begin select raise(abort, 'injected rebuild failure'); end;`);
  assert.throws(() => rebuildArchivedTextFts(db, 100), /injected rebuild failure/);
  const after = db.prepare("select map.part_id as partId, fts.text as text from agent_text_part_fts_map map join agent_archived_text_fts fts on fts.rowid = map.fts_rowid order by partId").all();
  assert.deepEqual(after, before);
  db.close();
});

test("archive read/search are bounded by context root, paginate stably, and validate opaque cursors", () => {
  const db = fixture();
  append(db, { id: "one", previous: null, revision: 0, text: "alpha searchable archive" });
  append(db, { id: "two", previous: "one", revision: 1, text: "beta searchable archive" });
  append(db, { id: "three", previous: "two", revision: 2, text: "current context" });
  commitCompactionMessageForTest(db, { id: "compact", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "three", expectedRevision: 3, textPartId: "compact-part", text: "summary", createdAt: 20 });
  const first = archiveRead(db, { workspaceId: "ws", sessionId: "session", limit: 1 });
  assert.deepEqual(first.items.map((item) => item.messageId), ["three"]);
  assert.ok(first.nextCursor);
  const second = archiveRead(db, { workspaceId: "ws", sessionId: "session", cursor: first.nextCursor!, limit: 1 });
  assert.deepEqual(second.items.map((item) => item.messageId), ["two"]);
  assert.ok(second.nextCursor);
  const results = archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "searchable", limit: 10 });
  assert.deepEqual(results.items.map((item) => item.messageId), ["two", "one"]);
  assert.throws(() => archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "ab" }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_ARCHIVE_QUERY_TOO_SHORT");
  assert.throws(() => archiveRead(db, { workspaceId: "ws", sessionId: "session", cursor: "forged" }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_ARCHIVE_CURSOR_INVALID");
  db.close();
});

test("archive 分页仅在确有后续项时返回 cursor", () => {
  const db = fixture();
  append(db, { id: "one", previous: null, revision: 0, text: "search page one" });
  append(db, { id: "two", previous: "one", revision: 1, text: "search page two" });
  append(db, { id: "current", previous: "two", revision: 2, text: "current" });
  commitCompactionMessageForTest(db, { id: "compact", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "current", expectedRevision: 3, textPartId: "compact-part", text: "summary", createdAt: 20 });
  const readFirst = archiveRead(db, { workspaceId: "ws", sessionId: "session", limit: 3 });
  assert.equal(readFirst.nextCursor, null, "刚好等于 limit 但无后续项时不可返回 cursor");
  const searchFirst = archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "search page", limit: 1 });
  assert.ok(searchFirst.nextCursor);
  const searchLast = archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "search page", cursor: searchFirst.nextCursor!, limit: 1 });
  assert.equal(searchLast.nextCursor, null);
  db.close();
});

test("archive search 将特殊字符作为普通文本且不泄露 FTS 错误", () => {
  const db = fixture();
  append(db, { id: "one", previous: null, revision: 0, text: "literal foo* alpha OR beta 中文\"词" });
  append(db, { id: "current", previous: "one", revision: 1, text: "current" });
  commitCompactionMessageForTest(db, { id: "compact", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "current", expectedRevision: 2, textPartId: "compact-part", text: "summary", createdAt: 20 });
  assert.deepEqual(archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "foo*" }).items.map((item) => item.messageId), ["one"]);
  assert.deepEqual(archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "OR beta" }).items.map((item) => item.messageId), ["one"]);
  assert.deepEqual(archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "中文\"词" }).items.map((item) => item.messageId), ["one"]);
  assert.doesNotThrow(() => archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "(((" }));
  db.close();
});

test("archive search 将 NUL 识别为稳定的参数错误", () => {
  const db = fixture();
  assert.throws(
    () => archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "abc\0def" }),
    (error: unknown) => error instanceof HttpError && error.code === "AGENT_ARCHIVE_QUERY_INVALID" && error.statusCode === 400,
  );
  db.close();
});

test("archive search 不将 FTS/map schema 故障伪装为 query 参数错误", () => {
  for (const tableName of ["agent_text_part_fts_map", "agent_archived_text_fts"]) {
    const db = fixture();
    append(db, { id: "one", previous: null, revision: 0, text: "search schema failure" });
    append(db, { id: "current", previous: "one", revision: 1, text: "current" });
    commitCompactionMessageForTest(db, { id: "compact", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "current", expectedRevision: 2, textPartId: "compact-part", text: "summary", createdAt: 20 });
    db.exec(`drop table ${tableName}`);
    assert.throws(
      () => archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "schema failure" }),
      (error: unknown) => !(error instanceof HttpError && error.code === "AGENT_ARCHIVE_QUERY_INVALID"),
      `${tableName} 缺失应作为内部故障上抛`,
    );
    db.close();
  }
});

test("archive pagination is complete, Chinese trigram matches, and shared history is only visible after compaction", () => {
  const db = fixture();
  append(db, { id: "one", previous: null, revision: 0, text: "共享中文检索一" });
  append(db, { id: "two", previous: "one", revision: 1, text: "共享中文检索二" });
  append(db, { id: "three", previous: "two", revision: 2, text: "共享中文检索三" });
  append(db, { id: "four", previous: "three", revision: 3, text: "当前上下文" });
  createMessageSession(db, {
    id: "uncompacted", workspaceId: "ws", title: "Uncompacted", kind: "primary",
    headMessageId: "four", contextRootMessageId: "one", createdAt: 20,
  });
  commitCompactionMessageForTest(db, {
    id: "compact", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "four", expectedRevision: 4,
    textPartId: "compact-part", text: "summary", createdAt: 21,
  });

  const readIds: string[] = [];
  let readCursor: string | undefined;
  do {
    const page = archiveRead(db, { workspaceId: "ws", sessionId: "session", cursor: readCursor, limit: 1 });
    readIds.push(...page.items.map((item) => item.messageId));
    readCursor = page.nextCursor ?? undefined;
  } while (readCursor);
  assert.deepEqual(readIds, ["four", "three", "two", "one"]);

  const searchIds: string[] = [];
  let searchCursor: string | undefined;
  do {
    const page = archiveSearch(db, { workspaceId: "ws", sessionId: "session", query: "中文检索", cursor: searchCursor, limit: 1 });
    searchIds.push(...page.items.map((item) => item.messageId));
    searchCursor = page.nextCursor ?? undefined;
  } while (searchCursor);
  assert.deepEqual(searchIds, ["three", "two", "one"]);
  assert.deepEqual(archiveSearch(db, { workspaceId: "ws", sessionId: "uncompacted", query: "中文检索" }).items, []);
  db.close();
});

test("FTS insertion failure rolls back the enclosing completed message transaction", () => {
  const db = fixture();
  db.exec(`
    create trigger reject_archive_fts
    before insert on agent_text_part_fts_map
    begin
      select raise(abort, 'injected FTS map failure');
    end;
  `);
  assert.throws(() => append(db, { id: "failed-fts", previous: null, revision: 0, text: "must roll back" }), /injected FTS map failure/);
  assert.equal((db.prepare("select count(*) as count from agent_message where id = 'failed-fts'").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_message_part where id = 'failed-fts-part'").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_archived_text_fts").get() as { count: number }).count, 0);
  assert.equal((db.prepare("select count(*) as count from agent_text_part_fts_map").get() as { count: number }).count, 0);
  db.close();
});

test("archive cursor rejects a real TextPart outside the eligible archive scope", () => {
  const db = fixture();
  append(db, { id: "one", previous: null, revision: 0, text: "eligible archived text" });
  append(db, { id: "failed", previous: "one", revision: 1, type: "assistant", status: "failed", text: "failed text" });
  append(db, { id: "current", previous: "failed", revision: 2, text: "current text" });
  commitCompactionMessageForTest(db, {
    id: "compact", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "current", expectedRevision: 3,
    textPartId: "compact-part", text: "summary", createdAt: 20,
  });
  const validCursor = archiveRead(db, { workspaceId: "ws", sessionId: "session", limit: 1 }).nextCursor!;
  const forged = JSON.parse(Buffer.from(validCursor, "base64url").toString("utf8")) as Record<string, unknown>;
  forged.messageId = "failed";
  forged.messageDepth = 1;
  forged.partId = "failed-part";
  forged.partPosition = 0;
  const invalidCursor = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
  assert.throws(() => archiveRead(db, { workspaceId: "ws", sessionId: "session", cursor: invalidCursor }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_ARCHIVE_CURSOR_INVALID");
  db.close();
});

test("archive cursor is invalidated when context root changes", () => {
  const db = fixture();
  append(db, { id: "one", previous: null, revision: 0, text: "first archived text" });
  append(db, { id: "two", previous: "one", revision: 1, text: "second archived text" });
  append(db, { id: "three", previous: "two", revision: 2, text: "current" });
  commitCompactionMessageForTest(db, { id: "compact-one", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "three", expectedRevision: 3, textPartId: "compact-one-part", text: "summary", createdAt: 20 });
  const page = archiveRead(db, { workspaceId: "ws", sessionId: "session", limit: 1 });
  commitCompactionMessageForTest(db, { id: "compact-two", workspaceId: "ws", sessionId: "session", expectedHeadMessageId: "compact-one", expectedRevision: 4, textPartId: "compact-two-part", text: "summary two", createdAt: 21 });
  assert.throws(() => archiveRead(db, { workspaceId: "ws", sessionId: "session", cursor: page.nextCursor! }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_ARCHIVE_CURSOR_INVALID");
  db.close();
});
