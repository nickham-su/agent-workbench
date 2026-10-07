import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionActivityQuery } from "./session-activity-query.js";

const path = "/api/agent/sessions/query";
const base = "workspaceId=a&updatedWithinSeconds=86400";
const invalid = { statusCode: 400, code: "AGENT_SESSION_QUERY_INVALID" };

test("activity query requires workspace/time and preserves valid workspace IDs", () => {
  for (const suffix of ["", "workspaceId=a", "updatedWithinSeconds=1", "workspaceId=&updatedWithinSeconds=1", "workspaceId=+%09&updatedWithinSeconds=1"]) {
    assert.throws(() => parseSessionActivityQuery(`${path}?${suffix}`), invalid, suffix);
  }
  assert.throws(() => parseSessionActivityQuery(path), invalid);
  assert.deepEqual(parseSessionActivityQuery(`${path}?${base}`), {
    workspaceId: "a", updatedWithinSeconds: 86400, kind: "all", status: "all"
  });
  const workspaceId = " 项目?甲 &乙 ";
  const params = new URLSearchParams({ workspaceId, updatedWithinSeconds: "1" });
  assert.equal(parseSessionActivityQuery(`${path}?${params}`).workspaceId, workspaceId);
});

test("activity query only accepts canonical safe positive seconds through 90 days", () => {
  for (const value of ["1", "86400", "7776000"]) {
    assert.equal(parseSessionActivityQuery(`${path}?workspaceId=a&updatedWithinSeconds=${value}`).updatedWithinSeconds, Number(value));
  }
  for (const value of ["", "0", "00", "01", "-1", "+1", "1.0", "1e3", "true", "NaN", "Infinity", " 1", "1 ", "1\n", "1\r\n", "1\t", "1s", "7776001", "9007199254740992", "9".repeat(400), "１"]) {
    assert.throws(() => parseSessionActivityQuery(`${path}?workspaceId=a&updatedWithinSeconds=${encodeURIComponent(value)}`), invalid, value);
  }
});

test("activity query defaults filters to all and validates every kind/status combination", () => {
  for (const kind of ["primary", "subtask", "all"]) {
    for (const status of ["idle", "running", "all"]) {
      assert.deepEqual(parseSessionActivityQuery(`${path}?${base}&kind=${kind}&status=${status}`), {
        workspaceId: "a", updatedWithinSeconds: 86400, kind, status
      });
    }
  }
  for (const value of ["", "Primary", "unknown", " all", "all "]) {
    assert.throws(() => parseSessionActivityQuery(`${path}?${base}&kind=${encodeURIComponent(value)}`), invalid);
    assert.throws(() => parseSessionActivityQuery(`${path}?${base}&status=${encodeURIComponent(value)}`), invalid);
  }
});

test("activity query rejects duplicate decoded keys and all unknown parameters before coercion", () => {
  for (const extra of ["workspaceId=a", "updatedWithinSeconds=86400", "kind=all&kind=all", "status=all&status=all", "workspace%49d=a", "%6bind=all&kind=all", "limit=1", "cursor=x", "all=true", "json=true", "since=1", "until=2", "scope=tabs", "unknown=x", "__proto__=x", "=x", "="]) {
    assert.throws(() => parseSessionActivityQuery(`${path}?${base}&${extra}`), invalid, extra);
  }
});
