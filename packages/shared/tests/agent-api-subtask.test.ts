import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentApiSubtaskSessionSchema,
  AgentApiSubtaskStartResponseSchema,
  AgentSubtaskErrorCode,
  hasAgentSubtaskSource,
  normalizeAgentSubtaskSource,
} from "../src/internal-contracts/agent-api.js";

const invalidSources = [undefined, null, 123, true, false, [], ["source"], {}, "", " \t\n "];

test("subtask source presence includes invalid values and never tightens legacy inputs", () => {
  for (const input of [undefined, null, [], {}, { session: null }, { session: [] }, { session: { mode: "legacy" } }]) {
    assert.equal(hasAgentSubtaskSource(input), false);
    assert.deepEqual(normalizeAgentSubtaskSource(input), { ok: true });
  }
  const legacy = { session: { mode: "fork", sessionId: 123 }, preforkSummaryText: null };
  assert.deepEqual(normalizeAgentSubtaskSource(legacy), { ok: true });
  for (const sourceSessionId of invalidSources) {
    assert.equal(hasAgentSubtaskSource({ session: { mode: "fork", sourceSessionId } }), true);
  }
});

test("subtask source normalization is pure, trims a string, and retains the legacy sessionId shape", () => {
  const input = Object.freeze({ session: Object.freeze({ mode: "fork", sourceSessionId: "  source-session \n", sessionId: "legacy-id" }) });
  assert.deepEqual(normalizeAgentSubtaskSource(input), { ok: true, sourceSessionId: "source-session" });
  assert.equal(input.session.sourceSessionId, "  source-session \n");
  assert.equal(Value.Check(AgentApiSubtaskSessionSchema, input.session), true);
  assert.equal(Value.Check(AgentApiSubtaskSessionSchema, { mode: "fork" }), true);
});

test("subtask source errors follow mode, allowed-mode, raw-value, prefork-presence order", () => {
  const assertCode = (input: unknown, code: string) => {
    const result = normalizeAgentSubtaskSource(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
  };
  for (const mode of [undefined, null, 1, true, "invalid", ["fork"], {}]) {
    assertCode({ session: { mode, sourceSessionId: null }, preforkMeta: null }, AgentSubtaskErrorCode.SessionModeInvalid);
  }
  for (const mode of ["new", "existing"]) {
    for (const sourceSessionId of [...invalidSources, "source"]) {
      assertCode({ session: { mode, sourceSessionId }, preforkMeta: null }, AgentSubtaskErrorCode.SourceSessionNotAllowed);
    }
  }
  for (const sourceSessionId of invalidSources) {
    assertCode({ session: { mode: "fork", sourceSessionId }, preforkSummaryText: {} }, AgentSubtaskErrorCode.SourceSessionInvalid);
  }
  for (const field of ["preforkSummaryText", "preforkMeta"]) {
    for (const value of [undefined, null, "", 1, true, [], {}, { thresholdPct: 95 }]) {
      assertCode({ session: { mode: "fork", sourceSessionId: "source" }, [field]: value }, AgentSubtaskErrorCode.PreforkNotAllowed);
    }
  }
});

test("subtask start response adds only the optional source ID to the five legacy fields", () => {
  const legacy = { sessionId: "child", runId: "run", workspacePath: "workspace", agentName: "agent", reused: false };
  assert.equal(Value.Check(AgentApiSubtaskStartResponseSchema, legacy), true);
  for (const reused of [false, true]) {
    assert.equal(Value.Check(AgentApiSubtaskStartResponseSchema, { ...legacy, reused, sourceSessionId: "source" }), true);
  }
  for (const sourceSessionId of [null, 123, true, [], {}, ""]) {
    assert.equal(Value.Check(AgentApiSubtaskStartResponseSchema, { ...legacy, sourceSessionId }), false);
  }
  assert.deepEqual(Object.keys(AgentApiSubtaskStartResponseSchema.properties), [
    "sessionId", "runId", "workspacePath", "agentName", "reused", "sourceSessionId",
  ]);
  assert.deepEqual(Object.keys(AgentApiSubtaskSessionSchema.anyOf[2].properties), ["mode", "sessionId", "sourceSessionId"]);
});
