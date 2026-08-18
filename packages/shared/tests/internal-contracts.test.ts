import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentWorkerCancelSessionRequestSchema,
  AgentWorkerCancelSessionResponseSchema,
  AgentWorkerEnqueueRequestSchema,
  AgentWorkerEnqueueResponseSchema,
  AgentWorkerHealthResponseSchema
} from "../src/internal-contracts/agent-worker.js";

const validEnqueueRequest = {
  workspaceId: "ws-a",
  sessionId: "sess-a",
  runId: "run-a",
  workspacePath: "/workspace/a"
};

test("agent-worker health response schema accepts only ok:true", () => {
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, { ok: true }), true);
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, { ok: false }), false);
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, {}), false);
});

test("agent-worker enqueue request schema preserves legacy workspaceRepoDirNames compatibility", () => {
  const compatibleValues = [
    undefined,
    ["repo-a", 1],
    null,
    "legacy"
  ];
  for (const workspaceRepoDirNames of compatibleValues) {
    const request = workspaceRepoDirNames === undefined
      ? validEnqueueRequest
      : { ...validEnqueueRequest, workspaceRepoDirNames };
    assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, request), true);
  }

  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, { ...validEnqueueRequest, inputText: "hello" }), true);
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, { ...validEnqueueRequest, inputText: null }), true);
});

test("agent-worker enqueue request schema rejects missing or invalid core fields", () => {
  const missingRequiredFieldCases = ["workspaceId", "sessionId", "runId", "workspacePath"] as const;
  for (const field of missingRequiredFieldCases) {
    const request = { ...validEnqueueRequest } as Record<string, unknown>;
    delete request[field];
    assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, request), false, `missing ${field} must be rejected`);
  }

  const invalidFieldCases: Array<[string, unknown]> = [
    ["workspaceId", 1],
    ["sessionId", 1],
    ["runId", 1],
    ["workspacePath", null],
    ["inputText", 1]
  ];
  for (const [field, value] of invalidFieldCases) {
    assert.equal(
      Value.Check(AgentWorkerEnqueueRequestSchema, { ...validEnqueueRequest, [field]: value }),
      false,
      `invalid ${field} must be rejected`
    );
  }
});

test("agent-worker cancel request and success response schemas validate expected shapes", () => {
  assert.equal(Value.Check(AgentWorkerCancelSessionRequestSchema, { sessionId: "sess-a" }), true);
  assert.equal(Value.Check(AgentWorkerCancelSessionRequestSchema, { sessionId: 1 }), false);
  assert.equal(Value.Check(AgentWorkerCancelSessionRequestSchema, {}), false);

  const responseSchemas = [
    AgentWorkerEnqueueResponseSchema,
    AgentWorkerCancelSessionResponseSchema
  ];
  for (const schema of responseSchemas) {
    assert.equal(Value.Check(schema, { ok: true }), true);
    assert.equal(Value.Check(schema, {}), false);
    assert.equal(Value.Check(schema, { ok: false }), false);
    assert.equal(Value.Check(schema, { ok: "true" }), false);
  }
});
