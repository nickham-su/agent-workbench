import assert from "node:assert/strict";
import test from "node:test";
import { decodeSessionCursor, encodeSessionCursor, parseSessionListQuery } from "./session-list-query.js";

const value = { v: 1 as const, workspaceId: "a", scope: "continuable" as const, limit: 50, updatedAt: 10, id: "中文-id" };
test("list scope rejects missing, duplicate, unknown and invalid pagination parameters", () => {
  for (const suffix of ["workspaceId=a", "scope=tabs", "workspaceId=&scope=tabs", "workspaceId=a&scope=all", "workspaceId=a&scope=tabs&limit=", "workspaceId=a&scope=tabs&cursor=", "workspaceId=a&scope=tabs&other=x", "workspaceId=a&scope=tabs&scope=tabs", "workspaceId=a&workspaceId=a&scope=tabs", ...["0", "101", "", "1.5", "NaN", "-1"].map((limit) => `workspaceId=a&scope=continuable&limit=${limit}`)]) {
    assert.throws(() => parseSessionListQuery(`/sessions?${suffix}`), { statusCode: 400 });
  }
  assert.deepEqual(parseSessionListQuery("/sessions?workspaceId=a&scope=tabs"), { workspaceId: "a", scope: "tabs" });
  assert.deepEqual(parseSessionListQuery("/sessions?workspaceId=a&scope=continuable"), { workspaceId: "a", scope: "continuable", limit: 50 });
  for (const limit of [1, 50, 100]) assert.equal(parseSessionListQuery(`/sessions?workspaceId=a&scope=continuable&limit=${limit}`).scope, "continuable");
});

test("cursor is canonical UTF8 base64url, versioned and bound to workspace/limit", () => {
  const cursor = encodeSessionCursor(value);
  assert.deepEqual(decodeSessionCursor(cursor, value), value);
  for (const other of [{ workspaceId: "b", limit: 50 }, { workspaceId: "a", limit: 1 }]) assert.throws(() => decodeSessionCursor(cursor, other), { code: "AGENT_SESSION_CURSOR_INVALID" });
  const encode = (input: unknown) => Buffer.from(JSON.stringify(input)).toString("base64url");
  for (const bad of ["", "!", cursor + "=", "a".repeat(8193), Buffer.from([0xff]).toString("base64url"), Buffer.from("not json").toString("base64url"), ...[null, [], {}, { ...value, extra: 1 }, { ...value, v: 2 }, { ...value, scope: "tabs" }, { ...value, updatedAt: -1 }, { ...value, updatedAt: Number.MAX_SAFE_INTEGER + 1 }, { ...value, id: "" }, { ...value, limit: "50" }].map(encode)]) {
    assert.throws(() => decodeSessionCursor(bad, value), { statusCode: 400, code: "AGENT_SESSION_CURSOR_INVALID" });
  }
  const { id: _id, ...missing } = value;
  assert.throws(() => decodeSessionCursor(encode(missing), value), { code: "AGENT_SESSION_CURSOR_INVALID" });
  assert.throws(() => encodeSessionCursor({ ...value, updatedAt: -1 }), { statusCode: 500, code: "AGENT_SESSION_METADATA_INVALID" });
  assert.throws(() => encodeSessionCursor({ ...value, id: "x".repeat(8192) }), { statusCode: 500 });
});
