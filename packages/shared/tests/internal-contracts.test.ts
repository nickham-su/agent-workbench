import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import * as AgentApiExport from "@agent-workbench/shared/internal-contracts/agent-api";
import {
  AgentWorkerCancelSessionAndWaitRequestSchema,
  AgentWorkerCancelSessionAndWaitResponseSchema,
  AgentWorkerCancelSessionRequestSchema,
  AgentWorkerCancelSessionResponseSchema,
  AgentWorkerEnqueueRequestSchema,
  AgentWorkerEnqueueResponseSchema,
  AgentWorkerHealthResponseSchema,
} from "../src/internal-contracts/agent-worker.js";
import {
  AgentApiConvergeRunTerminalRequestSchema,
  AgentApiConvergeRunTerminalResponseSchema,
  AgentApiMarkRunWorkInProgressRequestSchema,
  AgentApiMarkRunWorkInProgressResponseSchema,
  AgentApiPersistTerminalIntentRequestSchema,
  AgentApiPersistTerminalIntentResponseSchema,
} from "../src/internal-contracts/agent-api-run.js";
import { AgentApiCompleteTerminalAssistantRequestSchema } from "../src/internal-contracts/agent-api-message.js";
import { AGENT_TERMINAL_CODE_REGISTRY, isAgentTerminalCodeAllowed } from "../src/contracts/agent.js";
import {
  AgentApiSubtaskPreforkPlanRequestSchema,
  AgentApiSubtaskPreforkPlanResponseSchema,
  AgentApiSubtaskResultRequestSchema,
  AgentApiSubtaskResultResponseSchema,
  AgentApiSubtaskStartRequestSchema,
  AgentApiSubtaskStartResponseSchema,
  AgentApiSubtaskStatusRequestSchema,
  AgentApiSubtaskStatusResponseSchema,
  AgentSubtaskErrorCode,
} from "../src/internal-contracts/agent-api-subtask.js";

const validEnqueueRequest = {
  workspaceId: "ws-a",
  sessionId: "sess-a",
  runId: "run-a",
  workspacePath: "/workspace/a",
};

const validSubtaskStartRequest = {
  workspaceId: "ws-a",
  parentSessionId: "parent-sess",
  parentRunId: "parent-run",
  parentToolExecutionId: "execution-a",
  description: "A subtask",
  prompt: "Do the work",
  agentId: "agent-a",
  session: { mode: "new" as const },
};

const reasoningReplay = {
  version: 1,
  provider: {
    npm: "@ai-sdk/openai",
    api: "responses",
    providerId: "provider-a",
    model: "gpt-5",
  },
  item: {
    type: "reasoning",
    itemId: "rs_1",
    encryptedContent: "opaque-ciphertext",
    summaryIndex: 0,
  },
} as const;

test("provider replay envelope 与内部 flush 契约严格限制白名单和 part 类型", () => {
  assert.equal(Value.Check(AgentApiExport.AgentProviderReplayEnvelopeSchema, reasoningReplay), true);
  assert.equal(Value.Check(AgentApiExport.AgentApiFlushAssistantPartsRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "session-a",
    runId: "run-a",
    messageId: "message-a",
    updatedAt: 1,
    parts: [{ id: "part-a", position: 0, type: "reasoning", text: "", providerReplay: reasoningReplay }],
  }), true);

  assert.equal(Value.Check(AgentApiExport.AgentProviderReplayEnvelopeSchema, {
    ...reasoningReplay,
    provider: { ...reasoningReplay.provider, baseURL: "https://should-not-persist.example" },
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentProviderReplayEnvelopeSchema, {
    ...reasoningReplay,
    item: { ...reasoningReplay.item, providerMetadata: { arbitrary: true } },
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentProviderReplayEnvelopeSchema, {
    ...reasoningReplay,
    version: 2,
  }), false);
  assert.equal(Value.Check(AgentApiExport.AgentApiFlushAssistantPartsRequestSchema, {
    workspaceId: "ws-a",
    sessionId: "session-a",
    runId: "run-a",
    messageId: "message-a",
    updatedAt: 1,
    parts: [{ id: "part-a", position: 0, type: "text", text: "visible", providerReplay: reasoningReplay }],
  }), false);
});

test("provider replay 严格序列化并安全跳过损坏或未来版本数据", () => {
  const serialized = AgentApiExport.serializeAgentProviderReplay(reasoningReplay);
  assert.deepEqual(AgentApiExport.parseAgentProviderReplay(serialized), reasoningReplay);
  assert.equal(AgentApiExport.parseAgentProviderReplay("not-json"), null);
  assert.equal(AgentApiExport.parseAgentProviderReplay('{"version":2}'), null);
  assert.throws(() => AgentApiExport.serializeAgentProviderReplay({ ...reasoningReplay, apiKey: "secret" }), /invalid agent provider replay envelope/);
});

test("provider replay 更新保护 summaryIndex 与 phase，同时允许 reasoning 密文终态补齐", () => {
  const reasoningWithoutIndex = {
    ...reasoningReplay,
    item: { type: "reasoning" as const, itemId: "rs_1", encryptedContent: "cipher-initial" },
  };
  const reasoningWithIndex = {
    ...reasoningReplay,
    item: { type: "reasoning" as const, itemId: "rs_1", encryptedContent: "cipher-final", summaryIndex: 0 },
  };
  assert.doesNotThrow(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(reasoningWithoutIndex, reasoningWithIndex));
  assert.doesNotThrow(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(reasoningWithIndex, {
    ...reasoningWithIndex,
    item: { ...reasoningWithIndex.item, encryptedContent: "cipher-newer" },
  }));
  assert.throws(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(reasoningWithIndex, {
    ...reasoningWithIndex,
    item: { ...reasoningWithIndex.item, summaryIndex: 1 },
  }), /summaryIndex is immutable once known/);
  assert.throws(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(reasoningWithIndex, reasoningWithoutIndex), /summaryIndex is immutable once known/);

  const textWithoutPhase = {
    version: 1 as const,
    provider: reasoningReplay.provider,
    item: { type: "text" as const, itemId: "msg_1" },
  };
  const textWithPhase = {
    ...textWithoutPhase,
    item: { type: "text" as const, itemId: "msg_1", phase: "commentary" as const },
  };
  assert.doesNotThrow(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(textWithoutPhase, textWithPhase));
  assert.doesNotThrow(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(textWithPhase, textWithPhase));
  assert.throws(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(textWithPhase, {
    ...textWithPhase,
    item: { ...textWithPhase.item, phase: "final_answer" as const },
  }), /phase is immutable once known/);
  assert.throws(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(textWithPhase, textWithoutPhase), /phase is immutable once known/);

  assert.throws(() => AgentApiExport.assertAgentProviderReplayUpdateCompatible(reasoningWithIndex, {
    ...reasoningWithIndex,
    item: { ...reasoningWithIndex.item, itemId: "rs_other" },
  }), /item identity is immutable/);
});

test("agent-worker health response schema accepts only ok:true", () => {
  assert.equal(
    Value.Check(AgentWorkerHealthResponseSchema, { ok: true }),
    true,
  );
  assert.equal(
    Value.Check(AgentWorkerHealthResponseSchema, { ok: false }),
    false,
  );
  assert.equal(Value.Check(AgentWorkerHealthResponseSchema, {}), false);
});

test("Run terminal registry only accepts registered run-kind/status/code combinations", () => {
  assert.deepEqual(AGENT_TERMINAL_CODE_REGISTRY, {
    user: {
      completed: ["run_completed"],
      failed: ["context_limit_recovery_exhausted", "context_limit_media_requires_resend", "compaction_conflict", "run_enqueue_failed", "run_failed", "run_startup_recovery_failed"],
      cancelled: ["run_cancelled"]
    },
    subtask: {
      completed: ["subtask_completed"],
      failed: ["subtask_failed", "run_enqueue_failed", "run_startup_recovery_failed"],
      cancelled: ["run_cancelled"]
    },
    manual_compaction: {
      completed: ["compaction_completed", "compaction_not_needed", "compaction_no_progress", "compaction_oversized_tail", "compaction_media_requires_resend"],
      failed: ["compaction_pending_tools", "compaction_failed", "compaction_provider_unavailable", "compaction_conflict", "run_enqueue_failed", "run_startup_recovery_failed"],
      cancelled: ["run_cancelled"]
    }
  });
  for (const [runKind, statuses] of Object.entries(AGENT_TERMINAL_CODE_REGISTRY)) {
    for (const [status, codes] of Object.entries(statuses)) {
      for (const code of codes) {
        assert.equal(isAgentTerminalCodeAllowed(runKind as never, status as never, code as never), true);
      }
    }
  }
  assert.equal(isAgentTerminalCodeAllowed("user", "completed", "subtask_completed"), false);
  assert.equal(isAgentTerminalCodeAllowed("subtask", "completed", "run_failed"), false);
  assert.equal(isAgentTerminalCodeAllowed("subtask", "failed", "run_failed"), false);
  assert.equal(isAgentTerminalCodeAllowed("manual_compaction", "completed", "run_cancelled"), false);
  assert.equal(isAgentTerminalCodeAllowed("user", "completed", "unknown_code" as never), false);
});

test("Run phase internal DTOs strictly validate request, response, detail and terminal codes", () => {
  const base = { workspaceId: "ws-a", sessionId: "session-a", runId: "run-a", updatedAt: 1 };
  assert.equal(Value.Check(AgentApiMarkRunWorkInProgressRequestSchema, base), true);
  assert.equal(Value.Check(AgentApiMarkRunWorkInProgressRequestSchema, { ...base, unexpected: true }), false);
  assert.equal(Value.Check(AgentApiMarkRunWorkInProgressResponseSchema, { result: "updated" }), true);
  assert.equal(Value.Check(AgentApiMarkRunWorkInProgressResponseSchema, { result: "already_in_progress" }), true);
  assert.equal(Value.Check(AgentApiMarkRunWorkInProgressResponseSchema, { result: "ignored" }), false);

  const intent = { ...base, status: "completed", code: "run_completed", detail: null };
  assert.equal(Value.Check(AgentApiPersistTerminalIntentRequestSchema, intent), true);
  assert.equal(Value.Check(AgentApiPersistTerminalIntentRequestSchema, { ...intent, detail: "diagnostic" }), false);
  assert.equal(Value.Check(AgentApiPersistTerminalIntentRequestSchema, { ...intent, code: "unknown" }), false);
  assert.equal(Value.Check(AgentApiPersistTerminalIntentResponseSchema, { result: "updated" }), true);
  assert.equal(Value.Check(AgentApiPersistTerminalIntentResponseSchema, { result: "already_persisted" }), true);
  assert.equal(Value.Check(AgentApiPersistTerminalIntentResponseSchema, { result: "conflict" }), false);

  assert.equal(Value.Check(AgentApiConvergeRunTerminalRequestSchema, base), true);
  assert.equal(Value.Check(AgentApiConvergeRunTerminalResponseSchema, { kind: "transitioned", finalStatus: "completed" }), true);
  assert.equal(Value.Check(AgentApiConvergeRunTerminalResponseSchema, { kind: "already_converged", finalStatus: "cancelled" }), true);
  assert.equal(Value.Check(AgentApiConvergeRunTerminalResponseSchema, { kind: "transitioned", finalStatus: "running" }), false);
});

test("terminal Assistant internal DTO only accepts successful user or subtask intent with null detail", () => {
  const base = { workspaceId: "ws-a", sessionId: "session-a", runId: "run-a", messageId: "message-a", updatedAt: 1 };
  assert.equal(Value.Check(AgentApiCompleteTerminalAssistantRequestSchema, {
    ...base, intent: { status: "completed", code: "run_completed", detail: null },
  }), true);
  assert.equal(Value.Check(AgentApiCompleteTerminalAssistantRequestSchema, {
    ...base, intent: { status: "completed", code: "subtask_completed", detail: null },
  }), true);
  assert.equal(Value.Check(AgentApiCompleteTerminalAssistantRequestSchema, {
    ...base, responseTotalTokens: 1.5, intent: { status: "completed", code: "run_completed", detail: null },
  }), true);
  assert.equal(Value.Check(AgentApiCompleteTerminalAssistantRequestSchema, {
    ...base, responseTotalTokens: -1, intent: { status: "completed", code: "run_completed", detail: null },
  }), false);
  for (const intent of [
    { status: "failed", code: "run_failed", detail: null },
    { status: "cancelled", code: "run_cancelled", detail: null },
    { status: "completed", code: "compaction_completed", detail: null },
    { status: "completed", code: "run_completed", detail: "diagnostic" },
    { status: "completed", code: "unknown", detail: null },
  ]) assert.equal(Value.Check(AgentApiCompleteTerminalAssistantRequestSchema, { ...base, intent }), false);
});

test("agent-worker enqueue request schema preserves legacy workspaceRepoDirNames compatibility", () => {
  const compatibleValues = [undefined, ["repo-a", 1], null, "legacy"];
  for (const workspaceRepoDirNames of compatibleValues) {
    const request =
      workspaceRepoDirNames === undefined
        ? validEnqueueRequest
        : { ...validEnqueueRequest, workspaceRepoDirNames };
    assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, request), true);
  }

  assert.equal(
    Value.Check(AgentWorkerEnqueueRequestSchema, {
      ...validEnqueueRequest,
      inputText: "hello",
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentWorkerEnqueueRequestSchema, {
      ...validEnqueueRequest,
      inputText: null,
    }),
    true,
  );
});

test("agent-worker enqueue request accepts an optional recovery continuation", () => {
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, {
    ...validEnqueueRequest,
    resumeAssistantMessageId: "msg-recovered",
  }), true);
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, {
    ...validEnqueueRequest,
    resumeAssistantMessageId: null,
  }), true);
  assert.equal(Value.Check(AgentWorkerEnqueueRequestSchema, {
    ...validEnqueueRequest,
    resumeAssistantMessageId: 1,
  }), false);
});

test("agent-worker enqueue request schema rejects missing or invalid core fields", () => {
  const missingRequiredFieldCases = [
    "workspaceId",
    "sessionId",
    "runId",
    "workspacePath",
  ] as const;
  for (const field of missingRequiredFieldCases) {
    const request = { ...validEnqueueRequest } as Record<string, unknown>;
    delete request[field];
    assert.equal(
      Value.Check(AgentWorkerEnqueueRequestSchema, request),
      false,
      `missing ${field} must be rejected`,
    );
  }

  const invalidFieldCases: Array<[string, unknown]> = [
    ["workspaceId", 1],
    ["sessionId", 1],
    ["runId", 1],
    ["workspacePath", null],
    ["inputText", 1],
  ];
  for (const [field, value] of invalidFieldCases) {
    assert.equal(
      Value.Check(AgentWorkerEnqueueRequestSchema, {
        ...validEnqueueRequest,
        [field]: value,
      }),
      false,
      `invalid ${field} must be rejected`,
    );
  }
});

test("agent-worker cancel request and success response schemas validate expected shapes", () => {
  assert.equal(
    Value.Check(AgentWorkerCancelSessionRequestSchema, { sessionId: "sess-a" }),
    true,
  );
  assert.equal(
    Value.Check(AgentWorkerCancelSessionRequestSchema, { sessionId: 1 }),
    false,
  );
  assert.equal(Value.Check(AgentWorkerCancelSessionRequestSchema, {}), false);

  const responseSchemas = [
    AgentWorkerEnqueueResponseSchema,
    AgentWorkerCancelSessionResponseSchema,
  ];
  for (const schema of responseSchemas) {
    assert.equal(Value.Check(schema, { ok: true }), true);
    assert.equal(Value.Check(schema, {}), false);
    assert.equal(Value.Check(schema, { ok: false }), false);
    assert.equal(Value.Check(schema, { ok: "true" }), false);
  }
  assert.equal(Value.Check(AgentWorkerCancelSessionAndWaitRequestSchema, { sessionId: "sess-a", timeoutMs: 1 }), true);
  assert.equal(Value.Check(AgentWorkerCancelSessionAndWaitRequestSchema, { sessionId: "sess-a", timeoutMs: 0 }), false);
  assert.equal(Value.Check(AgentWorkerCancelSessionAndWaitResponseSchema, { ok: true, idle: true }), true);
  assert.equal(Value.Check(AgentWorkerCancelSessionAndWaitResponseSchema, { ok: true, idle: false }), true);
  assert.equal(Value.Check(AgentWorkerCancelSessionAndWaitResponseSchema, { ok: true }), false);
});

test("agent-api package export exposes only Message-model write contracts", () => {
  const endpoints = AgentApiExport.AgentApiEndpoints;
  assert.deepEqual(endpoints.createStreamingAssistant, {
    method: "POST",
    path: "/api/internal/agent/messages/assistant",
  });
  assert.deepEqual(endpoints.replaceStreamingAssistant, {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/replace",
  });
  assert.equal(
    AgentApiExport.AgentSubtaskErrorCode.PromptRequired,
    "AGENT_SUBTASK_PROMPT_REQUIRED",
  );
});

test("agent-api endpoint registry exposes Message/Run and read-side operations", () => {
  const endpoints = AgentApiExport.AgentApiEndpoints;
  assert.deepEqual(
    Object.keys(endpoints).sort(),
    [
      "archiveRead",
      "archiveSearch",
      "commitCompactionWithTerminalIntent",
      "confirmCompactionCommit",
      "completeAssistant",
      "completeTerminalAssistant",
      "convergeRunTerminal",
      "createStreamingAssistant",
      "discardStreamingAssistant",
      "flushAssistantParts",
      "replaceStreamingAssistant",
      "resumeStreamingAssistant",
      "getCompactionSource",
      "getExecutionProfile",
      "getMessagesContext",
      "getPromptContext",
      "getSubtaskPreforkPlan",
      "getSubtaskResult",
      "getSubtaskStatus",
      "markRunWorkInProgress",
      "persistRunTerminalIntent",
      "startSubtask",
      "updateRunNotice",
      "updateToolExecution",
    ].sort(),
  );
  assert.deepEqual(endpoints.markRunWorkInProgress, {
    method: "POST",
    path: "/api/internal/agent/runs/work-in-progress",
  });
  assert.deepEqual(endpoints.persistRunTerminalIntent, {
    method: "POST",
    path: "/api/internal/agent/runs/terminal-intent",
  });
  assert.deepEqual(endpoints.convergeRunTerminal, {
    method: "POST",
    path: "/api/internal/agent/runs/converge-terminal",
  });
  assert.deepEqual(endpoints.completeTerminalAssistant, {
    method: "POST",
    path: "/api/internal/agent/messages/assistant/complete-terminal",
  });
  assert.deepEqual(endpoints.getCompactionSource, {
    method: "POST",
    path: "/api/internal/agent/compaction-source",
  });
  assert.deepEqual(endpoints.commitCompactionWithTerminalIntent, {
    method: "POST",
    path: "/api/internal/agent/messages/compaction/complete",
  });
  assert.deepEqual(endpoints.confirmCompactionCommit, {
    method: "POST",
    path: "/api/internal/agent/messages/compaction/confirm",
  });
  assert.equal(Object.hasOwn(endpoints, "completeRun"), false);
  assert.equal(Object.hasOwn(AgentApiExport, "AgentApiRunCompleteRequestSchema"), false);
});

test("agent-api aggregate export exposes read-side schemas with stable shells and dynamic payloads", () => {
  const executionRequest = {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
  };
  const provider = {
    id: "provider-a",
    name: "Provider A",
    npm: "@ai-sdk/openai" as const,
    options: {
      baseURL: "https://example.invalid/v1",
      apiKey: "secret",
    },
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
    defaultModel: { providerId: "provider-a", modelId: "model-a" },
  };
  const executionResponse = {
    resolved: {
      ...executionRequest,
      agentId: "agent-a",
      providerId: "provider-a",
      modelId: "model-a",
    },
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
      updatedAt: 1,
    },
    vision: {
      source: "agent_default_fallback" as const,
      provider,
      model,
    },
    compaction: null,
  };
  const promptResponse = {
    headMessageId: "message-head-a",
    sessionRevision: 1,
    system: "system",
    messages: [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "attachment_ref",
            workspaceId: "ws-a",
            attachmentId: "att_123",
            mediaType: "image/png",
            filename: "image.png",
          },
        ],
      },
    ],
    tools: [
      {
        name: "plugin_tool",
        description: "dynamic schema",
        inputSchema: { type: "object", arbitrary: { nested: true } },
      },
    ],
    pendingTools: [
      {
        toolExecutionId: "execution-a",
        callPartId: "part-call-a",
        assistantMessageId: "message-assistant-a",
        status: "running" as const,
        toolName: "plugin_tool",
        args: ["dynamic", { payload: true }],
      },
    ],
    lastResponseTotalTokens: null,
    uiLocale: "zh-CN" as const,
    externalSkillRoots: [
      {
        sourceType: "repo" as const,
        repoId: "repo-a",
        rootDir: ".skills",
        rootPath: "/workspace/.skills",
      },
    ],
  };
  const messagesResponse = {
    headMessageId: null,
    system: "system",
    messages: [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result",
            toolCallId: "call-a",
            toolName: "bash",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ],
  };

  assert.equal(
    Value.Check(
      AgentApiExport.AgentApiExecutionProfileRequestSchema,
      executionRequest,
    ),
    true,
  );
  assert.equal(
    Value.Check(
      AgentApiExport.AgentApiPromptContextRequestSchema,
      executionRequest,
    ),
    true,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiMessagesContextRequestSchema, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      appendMessage: { role: "user", content: "one shot" },
    }),
    true,
  );
  assert.equal(
    Value.Check(
      AgentApiExport.AgentApiExecutionProfileResponseSchema,
      executionResponse,
    ),
    true,
  );
  assert.equal(
    Value.Check(
      AgentApiExport.AgentApiPromptContextResponseSchema,
      promptResponse,
    ),
    true,
  );
  assert.equal(
    Value.Check(
      AgentApiExport.AgentApiMessagesContextResponseSchema,
      messagesResponse,
    ),
    true,
  );
});

test("agent-api read-side schemas reject invalid stable fields without constraining dynamic payloads", () => {
  assert.equal(
    Value.Check(AgentApiExport.AgentApiExecutionProfileRequestSchema, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      runId: "",
    }),
    false,
  );
  const validExecutionProfile = {
    resolved: {
      runId: "run-a",
      sessionId: "sess-a",
      workspaceId: "ws-a",
      agentId: "agent-a",
      providerId: "provider-a",
      modelId: "model-a",
    },
    agent: {
      id: "agent-a",
      name: "Agent A",
      summary: "",
      prompt: "prompt",
      tools: ["bash"],
      pluginTools: [],
      mcpServers: [],
      defaultModel: { providerId: "provider-a", modelId: "model-a" },
    },
    provider: {
      id: "provider-a",
      name: "Provider A",
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://example.invalid/v1", apiKey: "secret" },
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
      updatedAt: 1,
    },
    vision: null,
    compaction: null,
  };
  assert.equal(
    Value.Check(
      AgentApiExport.AgentApiExecutionProfileResponseSchema,
      validExecutionProfile,
    ),
    true,
  );
  const {
    maxSubtaskDepth: _maxSubtaskDepth,
    ...runtimeWithoutMaxSubtaskDepth
  } = validExecutionProfile.runtime;
  assert.equal(
    Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, {
      ...validExecutionProfile,
      runtime: runtimeWithoutMaxSubtaskDepth,
    }),
    false,
  );
  const {
    modelRequestRetryBackoffMaxMs: _modelRequestRetryBackoffMaxMs,
    ...runtimeWithoutRetryBackoffMax
  } = validExecutionProfile.runtime;
  assert.equal(
    Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, {
      ...validExecutionProfile,
      runtime: runtimeWithoutRetryBackoffMax,
    }),
    false,
  );
  const {
    sessionTerminalSoundEnabled: _sessionTerminalSoundEnabled,
    ...runtimeWithoutSessionTerminalSoundEnabled
  } = validExecutionProfile.runtime;
  assert.equal(
    Value.Check(AgentApiExport.AgentApiExecutionProfileResponseSchema, {
      ...validExecutionProfile,
      runtime: runtimeWithoutSessionTerminalSoundEnabled,
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiMessagesContextRequestSchema, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      appendMessage: { role: "assistant", content: "not permitted" },
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiMessagesContextRequestSchema, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      appendMessage: { role: "user", content: "" },
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      headMessageId: "",
      sessionRevision: 0,
      system: "system",
      messages: [],
      tools: [],
      pendingTools: [],
      lastResponseTotalTokens: null,
      uiLocale: null,
      externalSkillRoots: [],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiMessagesContextResponseSchema, {
      headMessageId: null,
      sessionRevision: 0,
      system: "system",
      messages: [{ role: "developer", content: "unsupported stable role" }],
    }),
    false,
  );
});

test("agent-api prompt schemas permit only role-compatible content parts", () => {
  const responseShell = {
    headMessageId: null,
    sessionRevision: 0,
    system: "system",
    tools: [],
    pendingTools: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: [],
  };
  const attachmentRef = {
    type: "attachment_ref",
    workspaceId: "ws-a",
    attachmentId: "att_123",
    mediaType: "image/webp",
    filename: "screenshot.webp",
  };

  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "look" }, attachmentRef],
        },
      ],
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "text-only parts remain valid" }],
        },
      ],
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [{ role: "user", content: "legacy text-only message" }],
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [{ role: "assistant", content: [attachmentRef] }],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [
        {
          role: "user",
          content: [{ ...attachmentRef, storageKey: "att_123" }],
        },
      ],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [{ role: "user", content: [] }],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [{ role: "user", content: [attachmentRef] }],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [
        {
          role: "user",
          content: [attachmentRef, { type: "text", text: "late text" }],
        },
      ],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ],
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiExport.AgentApiPromptContextResponseSchema, {
      ...responseShell,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-a",
              toolName: "bash",
              output: { type: "binary" },
            },
          ],
        },
      ],
    }),
    false,
  );
});

test("agent-api subtask schemas preserve union and preforkMeta behavior", () => {
  assert.equal(
    Value.Check(AgentApiSubtaskPreforkPlanRequestSchema, {
      workspaceId: "ws-a",
      parentSessionId: "parent-sess",
      parentRunId: "parent-run",
      parentToolExecutionId: "execution-a",
      agentId: "agent-a",
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskPreforkPlanResponseSchema, {
      shouldPrefork: false,
      thresholdPct: 95,
      parentLastResponseTotalTokens: null,
      childContextWindowTokens: 1000,
      thresholdTokens: 950,
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartRequestSchema, validSubtaskStartRequest),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartRequestSchema, {
      ...validSubtaskStartRequest,
      session: { mode: "new", sessionId: "unexpected-but-legacy-compatible" },
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartRequestSchema, {
      ...validSubtaskStartRequest,
      session: { mode: "fork", sessionId: "unexpected-but-legacy-compatible" },
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartRequestSchema, {
      ...validSubtaskStartRequest,
      session: { mode: "existing", sessionId: "existing-session" },
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartRequestSchema, {
      ...validSubtaskStartRequest,
      session: { mode: "existing" },
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartRequestSchema, {
      ...validSubtaskStartRequest,
      preforkMeta: {
        thresholdPct: 95,
        parentLastResponseTotalTokens: 100,
        childContextWindowTokens: 1000,
        extra: true,
      },
    }),
    false,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStartResponseSchema, {
      sessionId: "child-sess",
      runId: "child-run",
      workspacePath: "/workspace/a",
      agentName: "agent-a",
      reused: false,
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskResultRequestSchema, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      runId: "run-a",
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskResultResponseSchema, { resultText: "partial" }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStatusRequestSchema, {
      workspaceId: "ws-a",
      sessionId: "sess-a",
      runId: "run-a",
    }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStatusResponseSchema, { status: "completed" }),
    true,
  );
  assert.equal(
    Value.Check(AgentApiSubtaskStatusResponseSchema, { status: "queued" }),
    false,
  );
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
    "AGENT_SUBTASK_PARENT_NOT_ACTIVE",
    "AGENT_SUBTASK_SESSION_RUNNING",
    "AGENT_SUBTASK_PROMPT_REQUIRED",
    "AGENT_SUBTASK_FORK_BOUNDARY_INVALID",
  ]);
  const actualCodes = new Set(Object.values(AgentSubtaskErrorCode));
  assert.deepEqual(actualCodes, expectedCodes);
  assert.equal(actualCodes.size, expectedCodes.size);
});
