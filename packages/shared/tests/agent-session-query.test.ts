import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AGENT_SESSION_QUERY_ERROR_CODES,
  AGENT_SESSION_QUERY_MAX_SECONDS,
  AgentSessionQueryItemSchema,
  AgentSessionQueryRequestSchema,
  AgentSessionQueryResponseSchema,
  type AgentSessionQueryResponse
} from "../src/contracts/agent-session-query.js";

const request = { workspaceId: "a", updatedWithinSeconds: 86400 };
const item = {
  id: "session-a", title: "", kind: "primary", status: "idle", createdAt: -1, updatedAt: 1000,
  userMessageCount: 0, completedAssistantMessageCount: 0
} as const;
const response: AgentSessionQueryResponse = {
  ...request, updatedFrom: 0, updatedTo: 86400000, kind: "all", status: "all", total: 1, items: [item]
};

test("session query request has a mandatory bounded numeric window and optional all filters", () => {
  assert.equal(AGENT_SESSION_QUERY_MAX_SECONDS, 7776000);
  assert.equal(Value.Check(AgentSessionQueryRequestSchema, request), true);
  assert.deepEqual(Value.Default(AgentSessionQueryRequestSchema, { ...request }), { ...request, kind: "all", status: "all" });
  for (const seconds of [1, 7776000]) {
    assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, updatedWithinSeconds: seconds }), true);
  }
  for (const seconds of [0, -1, 0.5, 7776001, Number.MAX_SAFE_INTEGER + 1, "1", null, true]) {
    assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, updatedWithinSeconds: seconds }), false);
  }
  for (const workspaceId of ["", " \t\n", null]) {
    assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, workspaceId }), false);
  }
  assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, workspaceId: " 项目甲 " }), true);
  assert.equal(Value.Check(AgentSessionQueryRequestSchema, { workspaceId: "a" }), false);
  assert.equal(Value.Check(AgentSessionQueryRequestSchema, { updatedWithinSeconds: 1 }), false);
  for (const kind of ["primary", "subtask", "all"]) {
    for (const status of ["idle", "running", "all"]) {
      assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, kind, status }), true);
    }
  }
  for (const value of ["", "Primary", "unknown", null]) {
    assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, kind: value }), false);
    assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, status: value }), false);
  }
});

test("session query contracts are closed and do not expose pagination, metrics or business fields", () => {
  for (const extra of ["limit", "cursor", "since", "until", "json", "all", "purpose"]) {
    assert.equal(Value.Check(AgentSessionQueryRequestSchema, { ...request, [extra]: 1 }), false);
  }
  for (const extra of ["nextCursor", "token", "cookie", "runCount", "toolCount", "purpose"]) {
    assert.equal(Value.Check(AgentSessionQueryResponseSchema, { ...response, [extra]: 1 }), false);
    assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, [extra]: 1 }), false);
  }
});

test("session query DTO accepts empty titles, zero matching sessions and all concrete states", () => {
  assert.equal(Value.Check(AgentSessionQueryResponseSchema, response), true);
  assert.equal(Value.Check(AgentSessionQueryResponseSchema, { ...response, total: 0, items: [] }), true);
  for (const kind of ["primary", "subtask"]) {
    for (const status of ["idle", "running"]) {
      assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, kind, status }), true);
    }
  }
  assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, kind: "all" }), false);
  assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, status: "all" }), false);
  assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, id: "" }), false);
  for (const key of Object.keys(item)) {
    const incomplete: Record<string, unknown> = { ...item };
    delete incomplete[key];
    assert.equal(Value.Check(AgentSessionQueryItemSchema, incomplete), false, key);
  }
  for (const key of Object.keys(response)) {
    const incomplete: Record<string, unknown> = { ...response };
    delete incomplete[key];
    assert.equal(Value.Check(AgentSessionQueryResponseSchema, incomplete), false, key);
  }
});

test("session query counts are nonnegative safe integers and timestamps fit Date", () => {
  for (const count of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, userMessageCount: count, completedAssistantMessageCount: count }), true);
  }
  for (const count of [-1, 1.5, null, "0", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    for (const key of ["userMessageCount", "completedAssistantMessageCount"]) {
      assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, [key]: count }), false);
    }
    assert.equal(Value.Check(AgentSessionQueryResponseSchema, { ...response, total: count }), false);
  }
  for (const timestamp of [-8_640_000_000_000_000, -1, 0, 8_640_000_000_000_000]) {
    for (const key of ["createdAt", "updatedAt"]) {
      assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, [key]: timestamp }), true);
    }
    for (const key of ["updatedFrom", "updatedTo"]) {
      assert.equal(Value.Check(AgentSessionQueryResponseSchema, { ...response, [key]: timestamp }), true);
    }
  }
  for (const timestamp of [1.5, null, "0", true, 8_640_000_000_000_001, -8_640_000_000_000_001, Infinity, NaN]) {
    for (const key of ["createdAt", "updatedAt"]) {
      assert.equal(Value.Check(AgentSessionQueryItemSchema, { ...item, [key]: timestamp }), false);
    }
    for (const key of ["updatedFrom", "updatedTo"]) {
      assert.equal(Value.Check(AgentSessionQueryResponseSchema, { ...response, [key]: timestamp }), false);
    }
  }
  assert.deepEqual(AGENT_SESSION_QUERY_ERROR_CODES, {
    invalid: "AGENT_SESSION_QUERY_INVALID", stateInvalid: "AGENT_SESSION_QUERY_STATE_INVALID"
  });
});
