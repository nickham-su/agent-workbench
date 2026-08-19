import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import type { AgentContextItemRecord } from "@agent-workbench/shared";
import {
  AgentApiEndpoints,
  buildAgentApiContextItemPath,
  type AgentApiCompactContextRequest,
  type AgentApiCompactContextResponse,
  type AgentApiCreateContextItemRequest,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { AgentApiClient, ApiConflictError } from "./apiClient.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function startServer(handler: (request: { method?: string; url?: string; body: unknown }) => { status: number; body: unknown }) {
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const result = handler({
        method: req.method,
        url: req.url,
        body: text ? JSON.parse(text) : null
      });
      res.statusCode = result.status;
      res.setHeader("content-type", "application/json");
      res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

const runStateInput = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  status: "running" as const,
  activeRunId: "RUN",
  activeAssistantItemId: null
};

const runCompleteInput = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  status: "completed" as const
};

const contextItem: AgentContextItemRecord = {
  id: 17,
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  turnId: "TURN",
  step: 1,
  prevId: 16,
  kind: "tool",
  status: "completed",
  archiveAt: null,
  boundaryReason: null,
  output: {
    type: "tool",
    toolName: "bash",
    toolCallId: "CALL",
    args: { command: "echo ok" },
    result: { stdout: "ok" }
  },
  createdAt: 100,
  updatedAt: 200
};

const contextCreateInput: AgentApiCreateContextItemRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  turnId: "TURN",
  step: 1,
  prevId: 16,
  kind: "tool",
  status: "queued",
  output: {
    type: "tool",
    toolName: "bash",
    toolCallId: "CALL",
    args: { command: "echo ok" }
  }
};

const compactInput: AgentApiCompactContextRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  expectedHeadItemId: 17,
  summaryText: "SUMMARY"
};

const compactResponse: AgentApiCompactContextResponse = {
  compacted: true,
  summaryItemId: 18,
  archivedCount: 2
};

const subtaskPreforkInput: AgentApiSubtaskPreforkPlanRequest = {
  workspaceId: "WORKSPACE",
  parentSessionId: "PARENT_SESSION",
  parentRunId: "PARENT_RUN",
  parentToolItemId: 9,
  agentId: "AGENT"
};
const subtaskStartInput: AgentApiSubtaskStartRequest = {
  workspaceId: "WORKSPACE",
  parentSessionId: "PARENT_SESSION",
  parentRunId: "PARENT_RUN",
  parentToolItemId: 9,
  description: "child task",
  prompt: "do the child task",
  agentId: "AGENT",
  session: { mode: "fork" }
};
const subtaskResultInput: AgentApiSubtaskResultRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "CHILD_SESSION",
  runId: "CHILD_RUN"
};
const subtaskStatusInput: AgentApiSubtaskStatusRequest = subtaskResultInput;

test("run methods use shared endpoint method/path and validate literal success", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    return { status: 200, body: { ok: true } };
  });
  const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });

  await client.updateRunState(runStateInput);
  await client.completeRun(runCompleteInput);

  assert.deepEqual(
    requests.map((request) => ({ method: request.method, url: request.url })),
    [
      { method: AgentApiEndpoints.updateRunState.method, url: AgentApiEndpoints.updateRunState.path },
      { method: AgentApiEndpoints.completeRun.method, url: AgentApiEndpoints.completeRun.path }
    ]
  );
});

test("strict rejects a successful response schema mismatch", async () => {
  const origin = await startServer(() => ({ status: 200, body: { ok: false } }));
  const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });

  await assert.rejects(
    () => client.updateRunState(runStateInput),
    /response schema validation failed: POST \/api\/internal\/agent\/run-state/
  );
});

test("warn logs a bounded schema warning and continues", async () => {
  const warnings: string[] = [];
  const origin = await startServer(() => ({ status: 200, body: { ok: false, token: "TOKEN", runId: "RUN" } }));
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) }
  });

  await client.completeRun(runCompleteInput);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", /endpoint=.*run-complete/);
  assert.match(warnings[0] || "", /method=POST/);
  assert.equal(warnings[0]?.includes("TOKEN"), false);
  assert.equal(warnings[0]?.includes("RUN"), false);
});

test("warn without an injected logger emits a warning", async () => {
  const origin = await startServer(() => ({ status: 200, body: { ok: false } }));
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const client = new AgentApiClient({
      apiOrigin: origin,
      internalToken: "TOKEN",
      responseValidation: "warn"
    });
    await client.updateRunState(runStateInput);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] || ""), /endpoint=.*run-state/);
});

test("compact uses shared endpoint/method/body and validates the unwrapped success response", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    return { status: 200, body: compactResponse };
  });
  const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });

  const result = await client.compactContext(compactInput);

  assert.deepEqual(result, compactResponse);
  assert.deepEqual(requests, [{
    method: AgentApiEndpoints.compactContext.method,
    url: AgentApiEndpoints.compactContext.path,
    body: compactInput
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "ok"), false);
});

test("compact strict and warn preserve the success schema boundary", async () => {
  const invalidResponse = { compacted: true, summaryItemId: 18 };
  const strictOrigin = await startServer(() => ({ status: 200, body: invalidResponse }));
  const strictClient = new AgentApiClient({ apiOrigin: strictOrigin, internalToken: "TOKEN" });
  await assert.rejects(
    () => strictClient.compactContext(compactInput),
    /response schema validation failed: POST \/api\/internal\/agent\/context\/compact/
  );

  const warnings: string[] = [];
  const warnOrigin = await startServer(() => ({ status: 200, body: invalidResponse }));
  const warnClient = new AgentApiClient({
    apiOrigin: warnOrigin,
    internalToken: "TOKEN",
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) }
  });
  const parsed = await warnClient.compactContext(compactInput);
  assert.deepEqual(parsed, invalidResponse);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", /endpoint=.*context\/compact/);
  assert.equal(warnings[0]?.includes("TOKEN"), false);
  assert.equal(warnings[0]?.includes("SUMMARY"), false);

  const malformedOrigin = await startServer(() => ({ status: 200, body: "not-json" }));
  const malformedClient = new AgentApiClient({
    apiOrigin: malformedOrigin,
    internalToken: "TOKEN",
    responseValidation: "warn"
  });
  await assert.rejects(() => malformedClient.compactContext(compactInput));

  const non2xxOrigin = await startServer(() => ({ status: 500, body: { message: "server error" } }));
  const non2xxClient = new AgentApiClient({
    apiOrigin: non2xxOrigin,
    internalToken: "TOKEN",
    responseValidation: "warn"
  });
  await assert.rejects(() => non2xxClient.compactContext(compactInput), /request failed: 500/);
});

test("compact maps both 409 response bodies to ApiConflictError without inspecting code", async () => {
  for (const body of [
    { message: "session head conflict" },
    { message: "session head conflict", code: "conflict_head:17" }
  ]) {
    const origin = await startServer(() => ({ status: 409, body }));
    const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });
    await assert.rejects(() => client.compactContext(compactInput), ApiConflictError);
  }
});

test("subtask methods use shared endpoints, forward typed bodies, and validate each success shape", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    if (request.url === AgentApiEndpoints.getSubtaskPreforkPlan.path) {
      return { status: 200, body: {
        shouldPrefork: true,
        thresholdPct: 95,
        parentLastResponseTotalTokens: 123,
        childContextWindowTokens: 456,
        thresholdTokens: 433
      } };
    }
    if (request.url === AgentApiEndpoints.startSubtask.path) {
      return { status: 200, body: {
        sessionId: "CHILD_SESSION",
        runId: "CHILD_RUN",
        workspacePath: "/workspace/child",
        agentName: "child-agent",
        reused: false
      } };
    }
    if (request.url === AgentApiEndpoints.getSubtaskResult.path) {
      return { status: 200, body: { resultText: "partial result" } };
    }
    return { status: 200, body: { status: "completed" } };
  });
  const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });

  await client.getSubtaskPreforkPlan(subtaskPreforkInput);
  await client.startSubtaskRun(subtaskStartInput);
  await client.getSubtaskResult(subtaskResultInput);
  await client.getSubtaskStatus(subtaskStatusInput);
  assert.deepEqual(requests, [
    { method: AgentApiEndpoints.getSubtaskPreforkPlan.method, url: AgentApiEndpoints.getSubtaskPreforkPlan.path, body: subtaskPreforkInput },
    { method: AgentApiEndpoints.startSubtask.method, url: AgentApiEndpoints.startSubtask.path, body: subtaskStartInput },
    { method: AgentApiEndpoints.getSubtaskResult.method, url: AgentApiEndpoints.getSubtaskResult.path, body: subtaskResultInput },
    { method: AgentApiEndpoints.getSubtaskStatus.method, url: AgentApiEndpoints.getSubtaskStatus.path, body: subtaskStatusInput }
  ]);
});

test("subtask strict/warn validation applies to all success responses without exposing payloads", async () => {
  const invalidResponses = [
    { shouldPrefork: true },
    { sessionId: "CHILD_SESSION" },
    { resultText: 123 },
    { status: "queued" }
  ];
  const inputs = [subtaskPreforkInput, subtaskStartInput, subtaskResultInput, subtaskStatusInput];
  const methods = ["getSubtaskPreforkPlan", "startSubtaskRun", "getSubtaskResult", "getSubtaskStatus"] as const;
  for (let i = 0; i < methods.length; i += 1) {
    const origin = await startServer(() => ({ status: 200, body: invalidResponses[i] }));
    const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });
    await assert.rejects(() => client[methods[i]](inputs[i] as never), /response schema validation failed/);
  }

  const warnings: string[] = [];
  const origin = await startServer((request) => {
    if (request.url === AgentApiEndpoints.getSubtaskPreforkPlan.path) return { status: 200, body: { shouldPrefork: true, secret: "PROMPT" } };
    if (request.url === AgentApiEndpoints.startSubtask.path) return { status: 200, body: { sessionId: "CHILD_SESSION", secret: "PROMPT" } };
    if (request.url === AgentApiEndpoints.getSubtaskResult.path) return { status: 200, body: { resultText: 123, secret: "PROMPT" } };
    return { status: 200, body: { status: "queued", secret: "PROMPT" } };
  });
  const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN", responseValidation: "warn", logger: { warn: (message: string) => warnings.push(message) } });
  await client.getSubtaskPreforkPlan(subtaskPreforkInput);
  await client.startSubtaskRun(subtaskStartInput);
  await client.getSubtaskResult(subtaskResultInput);
  await client.getSubtaskStatus(subtaskStatusInput);
  assert.equal(warnings.length, 4);
  assert.equal(warnings.every((warning) => !warning.includes("TOKEN") && !warning.includes("PROMPT")), true);
});

test("subtask warn does not relax malformed JSON or non-2xx responses", async () => {
  const malformedOrigin = await startServer(() => ({ status: 200, body: "not-json" }));
  const malformedClient = new AgentApiClient({ apiOrigin: malformedOrigin, internalToken: "TOKEN", responseValidation: "warn" });
  await assert.rejects(() => malformedClient.getSubtaskStatus(subtaskStatusInput));

  const errorOrigin = await startServer(() => ({ status: 500, body: { message: "server error" } }));
  const errorClient = new AgentApiClient({ apiOrigin: errorOrigin, internalToken: "TOKEN", responseValidation: "warn" });
  await assert.rejects(() => errorClient.getSubtaskResult(subtaskResultInput), /request failed: 500/);
});

test("subtask 409 remains an ordinary raw non-2xx Error for every endpoint", async () => {
  const methods = [
    ["getSubtaskPreforkPlan", subtaskPreforkInput],
    ["startSubtaskRun", subtaskStartInput],
    ["getSubtaskResult", subtaskResultInput],
    ["getSubtaskStatus", subtaskStatusInput]
  ] as const;
  for (const [method, input] of methods) {
    const origin = await startServer(() => ({ status: 409, body: { message: "business conflict", code: "AGENT_SUBTASK_DEPTH_UNKNOWN" } }));
    const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });
    await assert.rejects(
      () => client[method](input as never),
      (error: unknown) => error instanceof Error && !(error instanceof ApiConflictError) && /request failed: 409/.test(error.message)
    );
  }
});

test("warn does not relax JSON parse or non-2xx failures", async () => {
  const malformedOrigin = await startServer(() => ({ status: 200, body: "not-json" }));
  const malformedClient = new AgentApiClient({
    apiOrigin: malformedOrigin,
    internalToken: "TOKEN",
    responseValidation: "warn"
  });
  await assert.rejects(() => malformedClient.updateRunState(runStateInput));

  const errorOrigin = await startServer(() => ({ status: 500, body: { message: "server error" } }));
  const errorClient = new AgentApiClient({
    apiOrigin: errorOrigin,
    internalToken: "TOKEN",
    responseValidation: "warn"
  });
  await assert.rejects(() => errorClient.completeRun(runCompleteInput), /request failed: 500/);
});

test("context create/update use shared contracts and return complete records", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    return { status: 200, body: { ok: true, item: contextItem } };
  });
  const client = new AgentApiClient({ apiOrigin: origin, internalToken: "TOKEN" });

  assert.deepEqual(await client.createContextItem(contextCreateInput), contextItem);
  assert.deepEqual(
    await client.updateContextItem({
      itemId: contextItem.id,
      status: "completed",
      output: contextItem.output,
      updatedAt: contextItem.updatedAt
    }),
    contextItem
  );
  assert.deepEqual(
    requests.map((request) => ({ method: request.method, url: request.url })),
    [
      { method: AgentApiEndpoints.createContextItem.method, url: AgentApiEndpoints.createContextItem.path },
      { method: AgentApiEndpoints.updateContextItem.method, url: buildAgentApiContextItemPath(contextItem.id) }
    ]
  );
  assert.deepEqual(requests[1]?.body, {
    status: "completed",
    output: contextItem.output,
    updatedAt: contextItem.updatedAt
  });
});

test("context create maps 409 to ApiConflictError while update preserves raw non-2xx", async () => {
  const createOrigin = await startServer(() => ({ status: 409, body: { code: "conflict_head:17" } }));
  const createClient = new AgentApiClient({ apiOrigin: createOrigin, internalToken: "TOKEN" });
  await assert.rejects(() => createClient.createContextItem(contextCreateInput), ApiConflictError);

  const updateOrigin = await startServer(() => ({ status: 409, body: { code: "conflict_head:17" } }));
  const updateClient = new AgentApiClient({ apiOrigin: updateOrigin, internalToken: "TOKEN" });
  await assert.rejects(
    () => updateClient.updateContextItem({ itemId: 17, status: "completed", output: contextItem.output }),
    /request failed: 409/
  );
});

test("context response validation observes strict/warn boundaries and path builder rejects invalid ids", async () => {
  const strictOrigin = await startServer(() => ({ status: 200, body: { ok: true, item: { id: 17 } } }));
  const strictClient = new AgentApiClient({ apiOrigin: strictOrigin, internalToken: "TOKEN" });
  await assert.rejects(() => strictClient.createContextItem(contextCreateInput), /response schema validation failed/);

  const warnings: string[] = [];
  const warnOrigin = await startServer(() => ({
    status: 200,
    body: { ok: true, item: { id: 17 }, token: "TOKEN", prompt: "PROMPT", result: "TOOL_RESULT" }
  }));
  const warnClient = new AgentApiClient({
    apiOrigin: warnOrigin,
    internalToken: "TOKEN",
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) }
  });
  const item = await warnClient.updateContextItem({ itemId: 17, status: "completed", output: contextItem.output });
  assert.deepEqual(item, { id: 17 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes("TOKEN"), false);
  assert.equal(warnings[0]?.includes("PROMPT"), false);
  assert.equal(warnings[0]?.includes("TOOL_RESULT"), false);

  for (const itemId of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(() => warnClient.updateContextItem({ itemId, status: "completed", output: contextItem.output }), RangeError);
  }
});
