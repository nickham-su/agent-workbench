import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import * as AgentApiExport from "@agent-workbench/shared/internal-contracts/agent-api";
import {
  AgentWorkerCancelSessionRequestSchema,
  AgentWorkerCancelSessionResponseSchema,
  AgentWorkerEnqueueRequestSchema,
  AgentWorkerEnqueueResponseSchema,
  AgentWorkerHealthResponseSchema
} from "../src/internal-contracts/agent-worker.js";
import {
  AgentApiCompactContextRequestSchema,
  AgentApiCompactContextResponseSchema,
  AgentApiContextItemParamsSchema,
  AgentApiCreateContextItemRequestSchema,
  AgentApiCreateContextItemResponseSchema,
  AgentApiUpdateContextItemRequestSchema,
  AgentApiUpdateContextItemResponseSchema,
  AgentApiContextItemPathTemplate,
  buildAgentApiContextItemPath
} from "../src/internal-contracts/agent-api-context.js";
import {
  AgentApiRunCompleteRequestSchema,
  AgentApiRunCompleteResponseSchema,
  AgentApiRunStateRequestSchema,
  AgentApiRunStateResponseSchema
} from "../src/internal-contracts/agent-api-run.js";
import {
  AgentApiSubtaskPreforkPlanRequestSchema,
  AgentApiSubtaskPreforkPlanResponseSchema,
  AgentApiSubtaskResultRequestSchema,
  AgentApiSubtaskResultResponseSchema,
  AgentApiSubtaskStartRequestSchema,
  AgentApiSubtaskStartResponseSchema,
  AgentApiSubtaskStatusRequestSchema,
  AgentApiSubtaskStatusResponseSchema,
  AgentSubtaskErrorCode
} from "../src/internal-contracts/agent-api-subtask.js";

const validEnqueueRequest = {
  workspaceId: "ws-a",
  sessionId: "sess-a",
  runId: "run-a",
  workspacePath: "/workspace/a"
};

const validContextRecord = {
  id: 1,
  workspaceId: "ws-a",
  sessionId: "sess-a",
  runId: "run-a",
  turnId: null,
  step: 1,
  prevId: null,
  kind: "tool" as const,
  status: "completed" as const,
  archiveAt: null,
  boundaryReason: null,
  output: { type: "tool" as const, toolName: "bash" as const },
  createdAt: 1,
  updatedAt: 2
};

const validContextCreateRequest = {
  workspaceId: "ws-a",
  sessionId: "sess-a",
  runId: "run-a",
  turnId: null,
  step: 1,
  prevId: null,
  kind: "tool" as const,
  status: "completed" as const,
  output: { type: "tool" as const, toolName: "bash" as const }
};

const validSubtaskStartRequest = {
  workspaceId: "ws-a",
  parentSessionId: "parent-sess",
  parentRunId: "parent-run",
  parentToolItemId: 1,
  description: "A subtask",
  prompt: "Do the work",
  agentId: "agent-a",
  session: { mode: "new" as const }
};

test("agent-worker health response schema accepts only ok:true", () => {
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, { ok: true }), true);
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, { ok: false }), false);
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, {}), false);
});

test("agent-worker enqueue request schema preserves legacy workspaceRepoDirNames compatibility", () => {
  const compatibleValues = [undefined, ["repo-a", 1], null, "legacy"];
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

  const responseSchemas = [AgentWorkerEnqueueResponseSchema, AgentWorkerCancelSessionResponseSchema];
  for (const schema of responseSchemas) {
    assert.equal(Value.Check(schema, { ok: true }), true);
    assert.equal(Value.Check(schema, {}), false);
    assert.equal(Value.Check(schema, { ok: false }), false);
    assert.equal(Value.Check(schema, { ok: "true" }), false);
  }
});

test("agent-api package export exposes the aggregate contract without root export changes", () => {
  assert.equal(AgentApiExport.AgentApiEndpoints.updateRunState.path, "/api/internal/agent/run-state");
  assert.equal(AgentApiExport.AgentApiEndpoints.updateContextItem.method, "PATCH");
  assert.equal(AgentApiExport.AgentApiEndpoints.updateContextItem.path(7), "/api/internal/agent/context-items/7");
  assert.equal(Value.Check(AgentApiExport.AgentApiRunStateRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    status: "idle",
    activeRunId: null,
    activeAssistantItemId: null
  }), true);
  assert.equal(AgentApiExport.AgentSubtaskErrorCode.PromptRequired, "AGENT_SUBTASK_PROMPT_REQUIRED");
});

test("agent-api endpoint registry contains all twelve method/path definitions", () => {
  const endpoints = AgentApiExport.AgentApiEndpoints;
  assert.deepEqual(Object.keys(endpoints).sort(), [
    "compactContext",
    "completeRun",
    "createContextItem",
    "getExecutionProfile",
    "getMessagesContext",
    "getPromptContext",
    "getSubtaskPreforkPlan",
    "getSubtaskResult",
    "getSubtaskStatus",
    "startSubtask",
    "updateContextItem",
    "updateRunState"
  ].sort());
  assert.deepEqual(endpoints.updateRunState, { method: "POST", path: "/api/internal/agent/run-state" });
  assert.deepEqual(endpoints.completeRun, { method: "POST", path: "/api/internal/agent/run-complete" });
  assert.deepEqual(endpoints.createContextItem, { method: "POST", path: "/api/internal/agent/context-items" });
  assert.equal(endpoints.updateContextItem.method, "PATCH");
  assert.equal(endpoints.updateContextItem.path(7), buildAgentApiContextItemPath(7));
  assert.equal(endpoints.updateContextItem.routeTemplate, AgentApiContextItemPathTemplate);
  assert.deepEqual(endpoints.compactContext, { method: "POST", path: "/api/internal/agent/context/compact" });
  assert.deepEqual(endpoints.getSubtaskPreforkPlan, { method: "POST", path: "/api/internal/agent/subtask/prefork-plan" });
  assert.deepEqual(endpoints.startSubtask, { method: "POST", path: "/api/internal/agent/subtask/start" });
  assert.deepEqual(endpoints.getSubtaskResult, { method: "POST", path: "/api/internal/agent/subtask/result" });
  assert.deepEqual(endpoints.getSubtaskStatus, { method: "POST", path: "/api/internal/agent/subtask/status" });
  assert.deepEqual(endpoints.getExecutionProfile, { method: "POST", path: "/api/internal/agent/execution-profile" });
  assert.deepEqual(endpoints.getPromptContext, { method: "POST", path: "/api/internal/agent/prompt-context" });
  assert.deepEqual(endpoints.getMessagesContext, { method: "POST", path: "/api/internal/agent/messages-context" });
});

test("agent-api aggregate export exposes read-side schemas with stable shells and dynamic payloads", () => {
  const executionRequest = { workspaceId: "ws-a", sessionId: "sess-a", runId: "run-a" };
  const provider = {
    id: "provider-a",
    name: "Provider A",
    npm: "@ai-sdk/openai" as const,
    options: { baseURL: "https://example.invalid/v1", apiKey: "secret", apiMode: "responses" as const }
  };
  const model = { id: "model-a", name: "Model A", contextWindowTokens: 128000 };
  const agent = {
    id: "agent-a",
    name: "Agent A",
    summary: "",
    prompt: "prompt",
    tools: ["bash"],
    mcpServers: [],
    pluginTools: [],
    defaultModel: { providerId: "provider-a", modelId: "model-a" }
  };
  const executionResponse = {
    resolved: { ...executionRequest, agentId: "agent-a", providerId: "provider-a", modelId: "model-a" },
    agent,
    provider,
    model,
    runtime: {
      modelIdleTimeoutMs: 1000,
      modelTotalTimeoutMs: 2000,
      modelRequestMaxRetries: 0,
      modelRequestRetryBackoffMaxMs: 60_000,
      autoCompactThresholdPct: 80,
      maxSubtaskDepth: 1,
      sessionTerminalSoundEnabled: true,
      visionModel: null,
      compactionModel: null,
      updatedAt: 1
    },
    vision: {
      source: "agent_default_fallback" as const,
      provider,
      model
    },
    compaction: null
  };
  const promptResponse = {
    headItemId: 1,
    system: "system",
    messages: [
      {
        role: "assistant" as const,
        content: [{ type: "tool-call", toolCallId: "call-a", toolName: "bash", input: { command: "pwd" } }]
      },
      {
        role: "user" as const,
        content: [
          { type: "text", text: "inspect this" },
          { type: "attachment_ref", workspaceId: "ws-a", attachmentId: "att_123", mediaType: "image/png", filename: "image.png" }
        ]
      }
    ],
    tools: [{ name: "plugin_tool", description: "dynamic schema", inputSchema: { type: "object", arbitrary: { nested: true } } }],
    pendingTools: [{ itemId: 1, status: "running" as const, toolName: "plugin_tool", args: ["dynamic", { payload: true }] }],
    lastResponseTotalTokens: null,
    uiLocale: "zh-CN" as const,
    externalSkillRoots: [{ sourceType: "repo" as const, repoId: "repo-a", rootDir: ".skills", rootPath: "/workspace/.skills" }]
  };
  const messagesResponse = {
    headItemId: null,
    system: "system",
    messages: [{ role: "tool" as const, content: [{ type: "tool-result", toolCallId: "call-a", toolName: "bash", output: { type: "text", value: "done" } }] }]
  };

  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileRequestSchema, executionRequest), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextRequestSchema, executionRequest), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiMessagesContextRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    appendMessage: { role: "user", content: "one shot" }
  }), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, executionResponse), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, promptResponse), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiMessagesContextResponseSchema, messagesResponse), true);
});

test("agent-api read-side schemas reject invalid stable fields without constraining dynamic payloads", () => {
  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: ""
  }), false);
  const validExecutionProfile = {
    resolved: { runId: "run-a", sessionId: "sess-a", workspaceId: "ws-a", agentId: "agent-a", providerId: "provider-a", modelId: "model-a" },
    agent: {
      id: "agent-a",
      name: "Agent A",
      summary: "",
      prompt: "prompt",
      tools: ["bash"],
      pluginTools: [],
      mcpServers: [],
      defaultModel: { providerId: "provider-a", modelId: "model-a" }
    },
    provider: {
      id: "provider-a",
      name: "Provider A",
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://example.invalid/v1", apiKey: "secret" }
    },
    model: { id: "model-a", name: "Model A", contextWindowTokens: 128000 },
    runtime: {
      modelIdleTimeoutMs: 1000,
      modelTotalTimeoutMs: 2000,
      modelRequestMaxRetries: 0,
      modelRequestRetryBackoffMaxMs: 60_000,
      autoCompactThresholdPct: 80,
      maxSubtaskDepth: 1,
      sessionTerminalSoundEnabled: true,
      visionModel: null,
      compactionModel: null,
      updatedAt: 1
    },
    vision: null,
    compaction: null
  };
  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, validExecutionProfile), true);
  const { maxSubtaskDepth: _maxSubtaskDepth, ...runtimeWithoutMaxSubtaskDepth } = validExecutionProfile.runtime;
  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, {
    ...validExecutionProfile,
    runtime: runtimeWithoutMaxSubtaskDepth
  }), false);
  const { modelRequestRetryBackoffMaxMs: _modelRequestRetryBackoffMaxMs, ...runtimeWithoutRetryBackoffMax } = validExecutionProfile.runtime;
  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, {
    ...validExecutionProfile,
    runtime: runtimeWithoutRetryBackoffMax
  }), false);
  const { sessionTerminalSoundEnabled: _sessionTerminalSoundEnabled, ...runtimeWithoutSessionTerminalSoundEnabled } = validExecutionProfile.runtime;
  assert.equal(Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, {
    ...validExecutionProfile,
    runtime: runtimeWithoutSessionTerminalSoundEnabled
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiMessagesContextRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    appendMessage: { role: "assistant", content: "not permitted" }
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiMessagesContextRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    appendMessage: { role: "user", content: "" }
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    headItemId: 0,
    system: "system",
    messages: [],
    tools: [],
    pendingTools: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiMessagesContextResponseSchema, {
    headItemId: null,
    system: "system",
    messages: [{ role: "developer", content: "unsupported stable role" }]
  }), false);
});

test("agent-api prompt schemas permit only role-compatible content parts", () => {
  const responseShell = {
    headItemId: null,
    system: "system",
    tools: [],
    pendingTools: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  };
  const attachmentRef = {
    type: "attachment_ref",
    workspaceId: "ws-a",
    attachmentId: "att_123",
    mediaType: "image/webp",
    filename: "screenshot.webp"
  };

  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, attachmentRef] }]
  }), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [{ type: "text", text: "text-only parts remain valid" }] }]
  }), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: "legacy text-only message" }]
  }), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "assistant", content: [attachmentRef] }]
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [{ ...attachmentRef, storageKey: "att_123" }] }]
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [] }]
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [attachmentRef] }]
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [attachmentRef, { type: "text", text: "late text" }] }]
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }]
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
    ...responseShell,
    messages: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-a", toolName: "bash", output: { type: "binary" } }] }]
  }), false);
});

test("agent-api run schemas preserve nullable and optional fields", () => {
  assert.equal(Value.Check(AgentApiRunStateRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    status: "running",
    activeRunId: null,
    activeAssistantItemId: null,
    lastResponseTotalTokens: null,
    runNoticeText: null
  }), true);
  assert.equal(Value.Check(AgentApiRunStateRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    status: "idle",
    activeRunId: "run-a",
    activeAssistantItemId: 1,
    unexpected: true
  }), true);
  assert.equal(Value.Check(AgentApiRunCompleteRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    status: "completed"
  }), true);
  assert.equal(Value.Check(AgentApiRunCompleteRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    status: "running"
  }), false);
  assert.equal(Value.Check(AgentApiRunStateResponseSchema, { ok: true }), true);
  assert.equal(Value.Check(AgentApiRunCompleteResponseSchema, { ok: false }), false);
});

test("agent-api context schemas reuse public output and complete record schemas", () => {
  const validOutputs: Array<[string, Record<string, unknown>]> = [
    ["user_text", { type: "user_text", text: "hello" }],
    ["assistant_text", {
      type: "assistant_text",
      text: "answer",
      reasoning: { text: "thinking" },
      error: "provider warning"
    }],
    ["builtin tool", { type: "tool", toolName: "bash", args: { command: "pwd" }, result: { exitCode: 0 } }],
    ["MCP canonical tool", {
      type: "tool",
      toolName: "mcp_server-name_tool_name",
      args: ["--json", true],
      result: "ok"
    }],
    ["plugin canonical tool", {
      type: "tool",
      toolName: "plugin_demo-plugin_run",
      args: null,
      result: [1, "done", null]
    }],
    ["system_text", { type: "system_text", text: "system notice" }]
  ];
  for (const [label, output] of validOutputs) {
    assert.equal(
      Value.Check(AgentApiCreateContextItemRequestSchema, { ...validContextCreateRequest, output }),
      true,
      `${label} output should be accepted`
    );
    assert.equal(
      Value.Check(AgentApiUpdateContextItemRequestSchema, { output }),
      true,
      `${label} update output should be accepted`
    );
  }
  assert.equal(Value.Check(AgentApiCreateContextItemRequestSchema, {
    ...validContextCreateRequest,
    output: { type: "tool", toolName: "not-a-real-tool" }
  }), false);
  assert.equal(Value.Check(AgentApiCreateContextItemRequestSchema, {
    ...validContextCreateRequest,
    output: { type: "assistant_text" }
  }), false);
  assert.equal(Value.Check(AgentApiContextItemParamsSchema, { itemId: 1 }), true);
  assert.equal(Value.Check(AgentApiContextItemParamsSchema, { itemId: 0 }), false);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true, item: validContextRecord }), true);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true, item: null, ignored: true }), true);
  assert.equal(Value.Check(AgentApiUpdateContextItemResponseSchema, { ok: true, item: validContextRecord }), true);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true, item: { id: 1 } }), false);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true }), false);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true, item: null }), false);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true, item: validContextRecord, ignored: true }), false);
  assert.equal(Value.Check(AgentApiCreateContextItemResponseSchema, { ok: true, item: null, ignored: false }), false);
});

test("agent-api context path builder validates positive integer params", () => {
  assert.equal(AgentApiContextItemPathTemplate, "/api/internal/agent/context-items/:itemId");
  assert.equal(buildAgentApiContextItemPath(12), "/api/internal/agent/context-items/12");
  for (const invalidItemId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildAgentApiContextItemPath(invalidItemId), RangeError);
  }
});

test("agent-api compact schema models the bare success response without an ok wrapper", () => {
  assert.equal(Value.Check(AgentApiCompactContextRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    expectedHeadItemId: null,
    summaryText: "summary"
  }), true);
  assert.equal(Value.Check(AgentApiCompactContextRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    expectedHeadItemId: 0,
    summaryText: "summary"
  }), false);
  assert.equal(Value.Check(AgentApiCompactContextResponseSchema, {
    compacted: true,
    summaryItemId: 2,
    archivedCount: 3
  }), true);
  assert.equal(Value.Check(AgentApiCompactContextResponseSchema, { ok: true }), false);
});

test("agent-api subtask schemas preserve union and preforkMeta behavior", () => {
  assert.equal(Value.Check(AgentApiSubtaskPreforkPlanRequestSchema, {
    workspaceId: "ws-a",
    parentSessionId: "parent-sess",
    parentRunId: "parent-run",
    parentToolItemId: 1,
    agentId: "agent-a"
  }), true);
  assert.equal(Value.Check(AgentApiSubtaskPreforkPlanResponseSchema, {
    shouldPrefork: false,
    thresholdPct: 95,
    parentLastResponseTotalTokens: null,
    childContextWindowTokens: 1000,
    thresholdTokens: 950
  }), true);
  assert.equal(Value.Check(AgentApiSubtaskStartRequestSchema, validSubtaskStartRequest), true);
  assert.equal(Value.Check(AgentApiSubtaskStartRequestSchema, {
    ...validSubtaskStartRequest,
    session: { mode: "new", sessionId: "unexpected-but-legacy-compatible" }
  }), true);
  assert.equal(Value.Check(AgentApiSubtaskStartRequestSchema, {
    ...validSubtaskStartRequest,
    session: { mode: "fork", sessionId: "unexpected-but-legacy-compatible" }
  }), true);
  assert.equal(Value.Check(AgentApiSubtaskStartRequestSchema, {
    ...validSubtaskStartRequest,
    session: { mode: "existing", sessionId: "existing-session" }
  }), true);
  assert.equal(Value.Check(AgentApiSubtaskStartRequestSchema, {
    ...validSubtaskStartRequest,
    session: { mode: "existing" }
  }), false);
  assert.equal(Value.Check(AgentApiSubtaskStartRequestSchema, {
    ...validSubtaskStartRequest,
    preforkMeta: {
      thresholdPct: 95,
      parentLastResponseTotalTokens: 100,
      childContextWindowTokens: 1000,
      extra: true
    }
  }), false);
  assert.equal(Value.Check(AgentApiSubtaskStartResponseSchema, {
    sessionId: "child-sess",
    runId: "child-run",
    workspacePath: "/workspace/a",
    agentName: "agent-a",
    reused: false
  }), true);
  assert.equal(Value.Check(AgentApiSubtaskResultRequestSchema, { workspaceId: "ws-a", sessionId: "sess-a", runId: "run-a" }), true);
  assert.equal(Value.Check(AgentApiSubtaskResultResponseSchema, { resultText: "partial" }), true);
  assert.equal(Value.Check(AgentApiSubtaskStatusRequestSchema, { workspaceId: "ws-a", sessionId: "sess-a", runId: "run-a" }), true);
  assert.equal(Value.Check(AgentApiSubtaskStatusResponseSchema, { status: "completed" }), true);
  assert.equal(Value.Check(AgentApiSubtaskStatusResponseSchema, { status: "queued" }), false);
});

test("agent-api stable subtask error codes are finite and exact", () => {
  const expectedCodes = new Set([
    "AGENT_SUBTASK_ANCHOR_RUN_MISMATCH",
    "AGENT_SUBTASK_ANCHOR_INVALID",
    "AGENT_SUBTASK_AGENT_REQUIRED",
    "AGENT_DISABLED_IN_WORKSPACE",
    "AGENT_SUBTASK_PREFORK_THRESHOLD_INVALID",
    "AGENT_SUBTASK_DESCRIPTION_REQUIRED",
    "AGENT_SUBTASK_PREFORK_NOT_ALLOWED",
    "AGENT_SUBTASK_PREFORK_SUMMARY_TOO_LONG",
    "AGENT_SUBTASK_PREFORK_META_INVALID",
    "AGENT_SUBTASK_PREFORK_META_MISMATCH",
    "AGENT_SUBTASK_EXISTING_SESSION_MISMATCH",
    "AGENT_SUBTASK_DEPTH_UNKNOWN",
    "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED",
    "AGENT_SUBTASK_EXISTING_SESSION_REQUIRED",
    "AGENT_SUBTASK_SESSION_NOT_FOUND",
    "AGENT_SUBTASK_WORKSPACE_MISMATCH",
    "AGENT_SUBTASK_KIND_MISMATCH",
    "AGENT_SUBTASK_SESSION_ID_NOT_ALLOWED",
    "AGENT_SUBTASK_SESSION_MODE_INVALID",
    "AGENT_SUBTASK_SESSION_RUNNING",
    "AGENT_SUBTASK_PROMPT_REQUIRED",
    "AGENT_SUBTASK_FORK_BOUNDARY_INVALID"
  ]);
  const actualCodes = new Set(Object.values(AgentSubtaskErrorCode));
  assert.deepEqual(actualCodes, expectedCodes);
  assert.equal(actualCodes.size, expectedCodes.size);
});
