import test from "node:test";
import assert from "node:assert/strict";
import { CliError } from "../src/errors.js";
import { parseSessionListOptions, validateSessionQueryResponse } from "../src/session-query.js";
import { escapeDisplayText, renderSessionList } from "../src/session-list-output.js";
import { defaultQuery, queryResponse } from "./session-fixture.js";

const exitCode = (code: number) => (error: unknown) => error instanceof CliError && error.exitCode === code;

test("strict duration converts supported units and exact 90-day boundaries without a client clock", () => {
  for (const [duration, seconds] of [
    ["1s", 1], ["30m", 1800], ["24h", 86400], ["7d", 604800],
    ["90d", 7776000], ["2160h", 7776000], ["129600m", 7776000], ["7776000s", 7776000]
  ] as const) {
    assert.equal(parseSessionListOptions({ workspace: "id", updatedWithin: duration }).updatedWithinSeconds, seconds);
  }
  for (const duration of ["", "0h", "-1h", "+1h", "01h", "1.5h", "1h30m", "3mo", "24H", "24", " 1s", "1s ", "1h\n", "1h\r", "1h\r\n", "1h\u2028", "1h\u2029", "7776001s", "91d", "2161h", "9007199254740992s", "99999999999999999999999999999d"]) {
    assert.throws(() => parseSessionListOptions({ workspace: "id", updatedWithin: duration }), exitCode(2));
  }
});

test("workspace preserves its original ID, filters default to all and strict enums reject empty values", () => {
  assert.deepEqual(parseSessionListOptions({ workspace: " id/中文+ ", updatedWithin: "1s" }), {
    workspaceId: " id/中文+ ", updatedWithinSeconds: 1, kind: "all", status: "all", duration: "1s"
  });
  for (const kind of ["primary", "subtask", "all"]) {
    for (const status of ["idle", "running", "all"]) {
      const query = parseSessionListOptions({ workspace: "id", updatedWithin: "1s", kind, status });
      assert.equal(query.kind, kind);
      assert.equal(query.status, status);
    }
  }
  for (const workspace of ["", " ", "\t\r\n"]) assert.throws(() => parseSessionListOptions({ workspace, updatedWithin: "1s" }), exitCode(2));
  for (const kind of ["", "Primary", "unknown", " all "]) assert.throws(() => parseSessionListOptions({ workspace: "id", updatedWithin: "1s", kind }), exitCode(2));
  for (const status of ["", "Running", "unknown", "all\n"]) assert.throws(() => parseSessionListOptions({ workspace: "id", updatedWithin: "1s", status }), exitCode(2));
});

test("DTO accepts empty/all data, boundary timestamps, safe count maxima and every filter pair", () => {
  assert.deepEqual(validateSessionQueryResponse(queryResponse(defaultQuery, 0), defaultQuery), queryResponse(defaultQuery, 0));
  const response = queryResponse();
  response.items[0].title = "";
  response.items[0].updatedAt = response.updatedFrom;
  response.items[0].userMessageCount = 0;
  response.items[0].completedAssistantMessageCount = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(validateSessionQueryResponse(response, defaultQuery), response);
  for (const kind of ["primary", "subtask", "all"]) {
    for (const status of ["idle", "running", "all"]) {
      const query = parseSessionListOptions({ workspace: "id", updatedWithin: "1s", kind, status });
      const item = queryResponse(query);
      assert.deepEqual(validateSessionQueryResponse(item, query), item);
    }
  }
  const query = parseSessionListOptions({ workspace: "id", updatedWithin: "1s" });
  for (const to of [-8_640_000_000_000_000 + 1000, -1, 8_640_000_000_000_000]) {
    const response = queryResponse(query);
    response.updatedTo = to;
    response.updatedFrom = to - 1000;
    response.items[0].updatedAt = response.updatedFrom;
    assert.deepEqual(validateSessionQueryResponse(response, query), response);
  }
});

test("DTO creation time is a required Date timestamp independent of the update window", () => {
  for (const createdAt of [-8_640_000_000_000_000, -1, 0, Date.UTC(2025, 11, 31), Date.UTC(2026, 0, 2) + 1, 8_640_000_000_000_000]) {
    const value = queryResponse();
    value.items[0].createdAt = createdAt;
    const parsed = validateSessionQueryResponse(value, defaultQuery);
    assert.deepEqual(parsed, value);
    assert.ok(renderSessionList(parsed, defaultQuery.duration).includes(`创建时间：${new Date(createdAt).toISOString()}\n最近更新时间：`));
  }
});

test("DTO rejects nonclosed structures, wrong echo, invalid window/total and missing fields", () => {
  for (const invalid of [null, [], "response", 1]) assert.throws(() => validateSessionQueryResponse(invalid, defaultQuery), exitCode(6));
  const mutate = (change: (value: Record<string, unknown>) => void) => {
    const value: Record<string, unknown> = JSON.parse(JSON.stringify(queryResponse()));
    change(value);
    assert.throws(() => validateSessionQueryResponse(value, defaultQuery), exitCode(6));
  };
  for (const key of ["workspaceId", "updatedWithinSeconds", "updatedFrom", "updatedTo", "kind", "status", "total", "items"]) mutate((value) => { delete value[key]; });
  for (const [key, invalid] of [
    ["workspaceId", "other"], ["updatedWithinSeconds", 86401], ["updatedWithinSeconds", "86400"],
    ["kind", "primary"], ["status", "running"], ["updatedFrom", Date.UTC(2026, 0, 1) - 1],
    ["updatedTo", null], ["updatedTo", 0.1], ["updatedTo", Number.MAX_SAFE_INTEGER],
    ["total", -1], ["total", 0.1], ["total", 0], ["total", Number.MAX_SAFE_INTEGER + 1], ["items", {}],
    ["nextCursor", "unexpected"], ["tokenCount", 1]
  ]) mutate((value) => { value[String(key)] = invalid; });
});

test("DTO rejects corrupt items, duplicate IDs, unsafe counts and mismatched filters/boundaries", () => {
  const query = parseSessionListOptions({ workspace: "id", updatedWithin: "1s", kind: "primary", status: "idle" });
  const mutateItem = (change: (value: Record<string, unknown>) => void) => {
    const value = queryResponse(query);
    change(value.items[0] as unknown as Record<string, unknown>);
    assert.throws(() => validateSessionQueryResponse(value, query), exitCode(6));
  };
  for (const key of ["id", "title", "kind", "status", "createdAt", "updatedAt", "userMessageCount", "completedAssistantMessageCount"]) mutateItem((value) => { delete value[key]; });
  for (const [key, invalid] of [
    ["id", ""], ["id", 1], ["title", null], ["kind", "all"], ["kind", "subtask"],
    ["status", "all"], ["status", "running"], ["updatedAt", Date.UTC(2026, 0, 2) + 1],
    ["updatedAt", Date.UTC(2026, 0, 2) - 1001], ["updatedAt", Number.MAX_SAFE_INTEGER],
    ["updatedAt", 1.5], ["createdAt", null], ["createdAt", "0"], ["createdAt", true],
    ["createdAt", 1.5], ["createdAt", 8_640_000_000_000_001], ["createdAt", -8_640_000_000_000_001],
    ["createdAt", Infinity], ["createdAt", NaN],
    ["userMessageCount", null], ["userMessageCount", -1],
    ["userMessageCount", 1.5], ["completedAssistantMessageCount", Number.MAX_SAFE_INTEGER + 1],
    ["token", "unexpected"]
  ]) mutateItem((value) => { value[String(key)] = invalid; });
  const duplicate = queryResponse(defaultQuery, 2);
  duplicate.items[1].id = duplicate.items[0].id;
  assert.throws(() => validateSessionQueryResponse(duplicate, defaultQuery), exitCode(6));
  for (const invalid of [null, [], "item"]) {
    const value = queryResponse();
    const malformed = { ...value, items: [invalid] };
    assert.throws(() => validateSessionQueryResponse(malformed, defaultQuery), exitCode(6));
  }
});

test("fixed text has UTC dates, visible control escapes, complete IDs and a zero-result end marker", () => {
  const response = queryResponse();
  response.items[0].id = "a-complete-session-identifier-that-is-not-truncated";
  response.items[0].title = "第一行\n第二行\t\\n\r\u001b[31m\u0085\u2028\u2029";
  const expected = [
    "Workspace：workspace-example", "筛选：最近 24h；类型 all；状态 all",
    "更新时间范围：2026-01-01T00:00:00.000Z 至 2026-01-02T00:00:00.000Z（含两端）", "匹配总数：1", "",
    "Session ID：a-complete-session-identifier-that-is-not-truncated",
    "标题：第一行\\n第二行\\t\\\\n\\r\\u001b[31m\\u0085\\u2028\\u2029",
    "类型：primary", "状态：idle", "创建时间：2025-12-31T00:00:00.000Z",
    "最近更新时间：2026-01-02T00:00:00.000Z",
    "用户消息累计数：2", "已完成助手消息累计数：8", "", "查询结束：已输出 1 个 Session。", ""
  ].join("\n");
  assert.equal(renderSessionList(response, "24h"), expected);
  const empty = renderSessionList(queryResponse(defaultQuery, 0), "24h");
  assert.match(empty, /匹配总数：0\n\n查询结束：已输出 0 个 Session。\n$/);
  assert.ok(!empty.includes("Session ID："));
  assert.ok(!empty.includes("创建时间："));
  response.items[0].title = "";
  assert.match(renderSessionList(response, "24h"), /标题：（空标题）/);
  assert.equal(escapeDisplayText("\0\b\f\x7f"), "\\u0000\\b\\f\\u007f");
  assert.equal(escapeDisplayText("id\nfield"), "id\\nfield");
});
