import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createSessionListFixture } from "./session-list-query.testkit.js";

test("continuable counts 0/1/50/51/100/101, static pages and limit+1 boundaries", () => {
  for (const count of [0, 1, 50, 51, 100, 101, 153]) {
    const { db, add, query } = createSessionListFixture();
    try {
      for (let i = 0; i < count; i++) add(`id-${String(i).padStart(4, "0")}`);
      for (const limit of [1, 50, 100]) {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = query.listSessions({ workspaceId: "a", scope: "continuable", limit, cursor });
          assert.equal(page.scope, "continuable");
          if (page.scope !== "continuable") throw new Error("unexpected scope");
          assert.ok(page.items.length <= limit);
          if (ids.length === 0) assert.equal(page.nextCursor !== null, count > limit);
          ids.push(...page.items.map((record) => record.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        const expected = db.prepare("select id from agent_session order by updated_at desc,id collate binary desc").all() as { id: string }[];
        assert.deepEqual(ids, expected.map((item) => item.id));
        assert.equal(new Set(ids).size, count);
      }
    } finally { db.close(); }
  }
});

test("SQL filters before LIMIT and preserves JS trim, head, kind and closed-primary semantics", () => {
  const { db, add, query } = createSessionListFixture();
  try {
    for (let i = 0; i < 100; i++) add(`excluded-${i}`, { title: "新会话", time: 100 });
    for (const title of [" ", "\t\n", "\u00a0\ufeff\u3000", "\u00a0新会话\u3000", "\u200b", "title  internal", "\t valid\u00a0"]) {
      const sql = db.prepare("select agent_trim_title(?) as title").get(title) as { title: string };
      assert.equal(sql.title, title.trim());
      add(`unicode-${title}`, { title });
    }
    add("null-head", { head: null }); // Revert can leave historical messages but a null head.
    add("subtask", { kind: "subtask" });
    add("fork", { head: "source-message" });
    add("closed");
    add("other-workspace", { workspaceId: "b" });
    db.prepare("insert into workspace_session_tab_state values ('a','closed',0,1)").run();
    const page = query.listSessions({ workspaceId: "a", scope: "continuable", limit: 100 });
    if (page.scope !== "continuable") throw new Error("unexpected scope");
    assert.deepEqual(new Set(page.items.map((record) => record.id)), new Set(["unicode-\u200b", "unicode-title  internal", "unicode-\t valid\u00a0", "fork", "closed"]));
    assert.equal(page.nextCursor, null);
    const before = db.prepare("select count(*) n from agent_session").get();
    query.listSessions({ workspaceId: "a", scope: "tabs" });
    assert.deepEqual(db.prepare("select count(*) n from agent_session").get(), before);
    assert.throws(() => query.listSessions({ workspaceId: "missing", scope: "tabs" }), { code: "WORKSPACE_NOT_FOUND" });
    assert.throws(() => query.listSessions({ workspaceId: "missing", scope: "continuable", limit: 50 }), { code: "WORKSPACE_NOT_FOUND" });
  } finally { db.close(); }
});

test("tabs restore all default primary plus opened subtask, ignoring meaningless/cross-workspace/orphan overrides", () => {
  const { db, add, query } = createSessionListFixture();
  try {
    for (let i = 0; i < 150; i++) add(`primary-${i}`);
    add("closed"); add("opened", { kind: "subtask" }); add("hidden", { kind: "subtask" }); add("foreign", { workspaceId: "b" });
    db.exec(`insert into workspace_session_tab_state values ('a','closed',0,1),('a','opened',1,1),('a','hidden',0,1),('a','primary-0',1,1),('a','orphan',0,1),('a','foreign',0,1)`);
    const result = query.listSessions({ workspaceId: "a", scope: "tabs" });
    if (result.scope !== "tabs") throw new Error("unexpected scope");
    assert.equal(result.items.length, 151);
    assert.deepEqual(result.tabState, { workspaceId: "a", closedSessionIds: ["closed"], openedSubtaskSessionIds: ["opened"] });
    assert.equal(result.items.some((item) => item.id === "hidden" || item.id === "closed" || item.id === "foreign"), false);
    assert.equal((db.prepare("select count(*) n from workspace_session_tab_state").get() as { n: number }).n, 6);
  } finally { db.close(); }
});

test("BINARY Unicode ID ordering is stable through tied cursor boundaries", () => {
  const { db, add, query } = createSessionListFixture();
  try {
    for (const id of ["Z", "a", "é", "中", "😀"]) add(id);
    let cursor: string | undefined;
    const actual: string[] = [];
    do {
      const page = query.listSessions({ workspaceId: "a", scope: "continuable", limit: 1, cursor });
      if (page.scope !== "continuable") throw new Error("unexpected scope");
      actual.push(...page.items.map((item) => item.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(actual, (db.prepare("select id from agent_session order by id collate binary desc").all() as { id: string }[]).map((item) => item.id));
  } finally { db.close(); }
});

test("WAL two-connection snapshot sees one database view for both items and overrides", () => {
  const directory = mkdtempSync(join(process.cwd(), ".session-snapshot-test-"));
  const { db, add, query } = createSessionListFixture(join(directory, "test.sqlite"));
  db.pragma("journal_mode=WAL");
  const writer = new Database(join(directory, "test.sqlite"));
  try {
    add("primary");
    let changed = false;
    const prepare = db.prepare.bind(db);
    // Hook only after the real transaction's first SELECT established its WAL view.
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql === "select 1 from workspaces where id = ?") {
        const get = statement.get.bind(statement);
        statement.get = ((...args: unknown[]) => {
          const result = get(...args);
          if (!changed) { changed = true; writer.exec("insert into workspace_session_tab_state values ('a','primary',0,1)"); }
          return result;
        }) as typeof statement.get;
      }
      return statement;
    }) as typeof db.prepare;
    const first = query.listSessions({ workspaceId: "a", scope: "tabs" });
    if (first.scope !== "tabs") throw new Error("unexpected scope");
    assert.deepEqual(first.items.map((item) => item.id), ["primary"]);
    assert.deepEqual(first.tabState.closedSessionIds, []);
    const next = query.listSessions({ workspaceId: "a", scope: "tabs" });
    if (next.scope !== "tabs") throw new Error("unexpected scope");
    assert.deepEqual(next.items, []); assert.deepEqual(next.tabState.closedSessionIds, ["primary"]);
    assert.equal(db.inTransaction, false);
  } finally { writer.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
