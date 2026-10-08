import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AgentApiEndpoints, AgentSubtaskErrorCode, type AgentApiSubtaskStartRequest } from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentService } from "../agent.service.js";
import { createP2Fixture } from "./subtask.helpers.js";
import type { AgentIntegrationFixture } from "../testkit/agent-integration-testkit.js";

function baseRequest() {
  return {
    workspaceId: "workspace", parentSessionId: "parent", parentRunId: "run", parentToolExecutionId: "tool",
    description: "summary", prompt: "summarize", agentId: "default", session: { mode: "fork" },
  };
}

async function injectStart(fixture: AgentIntegrationFixture, payload: unknown, authenticated = true) {
  return fixture.app.inject({
    method: AgentApiEndpoints.startSubtask.method,
    url: AgentApiEndpoints.startSubtask.path,
    ...(authenticated ? { headers: { "x-awb-agent-internal-token": fixture.internalToken } } : {}),
    payload: payload as Record<string, unknown>,
  });
}

async function assertRawError(fixture: AgentIntegrationFixture, payload: unknown, code: string) {
  const response = await injectStart(fixture, payload);
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().code, code, response.body);
}

test("subtask start raw source checks precede default AJV coercion/removal and prevent materialization", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const before = fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_session").get();
  const invalidSources = [null, 123, true, false, [], ["source"], {}, "", " \t\n "];
  for (const mode of ["new", "existing"]) {
    for (const sourceSessionId of [...invalidSources, "source"]) {
      await assertRawError(fixture, {
        ...baseRequest(), session: { mode, sourceSessionId }, preforkMeta: null,
      }, AgentSubtaskErrorCode.SourceSessionNotAllowed);
    }
  }
  for (const sourceSessionId of invalidSources) {
    await assertRawError(fixture, {
      ...baseRequest(), session: { mode: "fork", sourceSessionId }, preforkSummaryText: {},
    }, AgentSubtaskErrorCode.SourceSessionInvalid);
  }
  for (const mode of [undefined, null, 1, true, "invalid", ["fork"], {}]) {
    await assertRawError(fixture, {
      ...baseRequest(), session: { mode, sourceSessionId: null }, preforkMeta: null,
    }, AgentSubtaskErrorCode.SessionModeInvalid);
  }
  assert.deepEqual(fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_session").get(), before);
});

test("subtask start rejects any prefork field presence after a valid source, before prefork schema validation", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  const before = fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_session").get();
  const values = [null, "", "summary", 1, true, [], {}, { thresholdPct: 95, parentLastResponseTotalTokens: 1, childContextWindowTokens: 1000 }];
  for (const field of ["preforkSummaryText", "preforkMeta"]) {
    for (const value of values) {
      await assertRawError(fixture, {
        ...baseRequest(), session: { mode: "fork", sourceSessionId: "source" }, [field]: value,
      }, AgentSubtaskErrorCode.PreforkNotAllowed);
    }
  }
  await assertRawError(fixture, {
    ...baseRequest(), session: { mode: "fork", sourceSessionId: "source" }, preforkSummaryText: "x".repeat(100_001),
  }, AgentSubtaskErrorCode.PreforkNotAllowed);
  assert.deepEqual(fixture.db.prepare("SELECT COUNT(*) AS count FROM agent_session").get(), before);
});

test("subtask start authenticates new source checks first and retains legacy validation/auth order", async (t: TestContext) => {
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  for (const mode of ["fork", "new", "invalid"]) {
    const response = await injectStart(fixture, {
      ...baseRequest(), session: { mode, sourceSessionId: null }, preforkMeta: null,
    }, false);
    assert.equal(response.statusCode, 401, response.body);
    assert.deepEqual(response.json(), { message: "Unauthorized" });
  }
  // createApp's existing onRequest internal guard precedes decoding/schema for all requests.
  const legacyInvalid = await injectStart(fixture, {}, false);
  assert.equal(legacyInvalid.statusCode, 401, legacyInvalid.body);
  assert.deepEqual(legacyInvalid.json(), { message: "Unauthorized" });
  const authenticatedInvalid = await injectStart(fixture, {});
  assert.equal(authenticatedInvalid.statusCode, 400, authenticatedInvalid.body);
  assert.equal(authenticatedInvalid.json().code, undefined);
  assert.equal(legacyInvalid.json().code, undefined);
  const legacyValid = await injectStart(fixture, baseRequest(), false);
  assert.equal(legacyValid.statusCode, 401, legacyValid.body);
});

test("real createApp start route normalizes source and serializes only its optional top-level field", async (t: TestContext) => {
  // Stage one tests the HTTP boundary, not the not-yet-implemented materialization path.
  const calls: AgentApiSubtaskStartRequest[] = [];
  const legacyResponse = { sessionId: "child", runId: "child-run", workspacePath: "workspace", agentName: "summary-agent", reused: false };
  let reused = false;
  t.mock.method(AgentService.prototype, "startSubtaskRunFromWorker", async (input: AgentApiSubtaskStartRequest) => {
    calls.push(input);
    const source = input.session.mode === "fork" ? input.session.sourceSessionId : undefined;
    return { ...legacyResponse, reused, ...(source === undefined ? {} : { sourceSessionId: source }) };
  });
  const fixture = await createP2Fixture(t, { agentWorkerConcurrency: 0 });
  for (const nextReused of [false, true]) {
    reused = nextReused;
    const response = await injectStart(fixture, {
      ...baseRequest(), session: { mode: "fork", sourceSessionId: "  source-session \n" },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ...legacyResponse, reused, sourceSessionId: "source-session" });
    assert.deepEqual(calls.at(-1)?.session, { mode: "fork", sourceSessionId: "source-session" });
  }
  for (const session of [{ mode: "new" }, { mode: "fork" }, { mode: "existing", sessionId: "existing-session" }]) {
    const response = await injectStart(fixture, { ...baseRequest(), session });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ...legacyResponse, reused });
    assert.equal(Object.hasOwn(response.json(), "sourceSessionId"), false);
  }
  // No-source requests still use AJV's legacy field coercion rather than a new strict body validator.
  const coerced = await injectStart(fixture, { ...baseRequest(), agentId: 123, session: { mode: "fork", sessionId: 456 } });
  assert.equal(coerced.statusCode, 200, coerced.body);
  assert.equal(calls.at(-1)?.agentId, "123");
  assert.deepEqual(calls.at(-1)?.session, { mode: "fork", sessionId: "456" });
});
