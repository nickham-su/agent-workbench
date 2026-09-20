import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRunner,
  ControlWritePermanentError,
  FencedWriteIgnoredError,
  FencedWriteMissingError,
  hasVisibleAssistantTextForTest,
  shouldStopForMaxStepsForTest
} from "./runner.js";

function baseContext() {
  return {
    pendingTools: [],
    tools: [],
    headMessageId: null,
    sessionRevision: 0,
    system: "",
    messages: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  };
}

function baseProfile() {
  return {
    model: "openai:gpt-4o-mini",
    provider: { npm: "@ai-sdk/openai", options: {} },
    agent: {
      tools: [],
      pluginTools: [],
      mcpServers: []
    },
    runtime: {}
  };
}

function baseRun() {
  return {
    workspaceId: "ws_test",
    sessionId: "sess_test",
    runId: "run_test",
    workspacePath: process.cwd(),
    workspaceRepoDirNames: [],
    inputText: "hello"
  };
}

test("hasVisibleAssistantTextForTest: whitespace-only 文本不算正常文本", () => {
  assert.equal(hasVisibleAssistantTextForTest("hello"), true);
  assert.equal(hasVisibleAssistantTextForTest("  hello\n"), true);
  assert.equal(hasVisibleAssistantTextForTest("   \n\t  "), false);
  assert.equal(hasVisibleAssistantTextForTest(""), false);
});

test("shouldStopForMaxStepsForTest: max steps 小于 6 时仍为第 6 次空回答预留空间", () => {
  assert.equal(shouldStopForMaxStepsForTest(1, 2), false);
  assert.equal(shouldStopForMaxStepsForTest(2, 2), false);
  assert.equal(shouldStopForMaxStepsForTest(5, 2), false);
  assert.equal(shouldStopForMaxStepsForTest(6, 2), true);
  assert.equal(shouldStopForMaxStepsForTest(127, 128), false);
  assert.equal(shouldStopForMaxStepsForTest(128, 128), true);
});

test("runModelStep: 存在 pending ToolExecution 时 fail-closed 且不调用模型", async () => {
  let modelInvocationCount = 0;
  const runner = new AgentRunner(
    {} as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
    {
      streamText: (() => {
        modelInvocationCount += 1;
        throw new Error("model must not be invoked");
      }) as any
    }
  );
  const context = { ...baseContext(), pendingTools: [{
    toolExecutionId: "execution_pending",
    callPartId: "part_pending",
    assistantMessageId: "message_pending",
    status: "running",
    toolName: "bash",
    toolCallId: "call_pending",
    args: { command: "pwd" }
  }] };

  await assert.rejects(
    (runner as any).runModelStep({ profile: baseProfile(), run: baseRun(), context, step: 1, signal: new AbortController().signal, repeatedToolCallCounter: new Map() }),
    /cannot invoke model while ToolExecution remains queued or running/
  );
  assert.equal(modelInvocationCount, 0);
});

test("processRun: 无 tool call 且有正常文本时 completed", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let runModelStepCount = 0;
  (runner as any).runModelStep = async () => {
    runModelStepCount += 1;
    return {
      aborted: false as const,
      toolCallCount: 0,
      assistantMessageId: 1,
      hasVisibleText: true
    };
  };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(runModelStepCount, 1);
  assert.deepEqual(completed, ["completed"]);
});

test("processRun: tool call 会重置空回答计数，并在后续第 6 次空回答时 completed", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const results = [
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 1, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false }
  ];
  let index = 0;
  (runner as any).runModelStep = async () => {
    const next = results[index];
    index += 1;
    if (!next) throw new Error("unexpected extra runModelStep call");
    return {
      aborted: false as const,
      assistantMessageId: index,
      toolCallCount: next.toolCallCount,
      hasVisibleText: next.hasVisibleText
    };
  };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(index, results.length);
  assert.deepEqual(completed, ["completed"]);
});

test("processRun: 正常文本会重置空回答计数并立即 completed", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const results = [
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: false },
    { toolCallCount: 0, hasVisibleText: true }
  ];
  let index = 0;
  (runner as any).runModelStep = async () => {
    const next = results[index];
    index += 1;
    if (!next) throw new Error("unexpected extra runModelStep call");
    return {
      aborted: false as const,
      assistantMessageId: index,
      toolCallCount: next.toolCallCount,
      hasVisibleText: next.hasVisibleText
    };
  };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(index, 3);
  assert.deepEqual(completed, ["completed"]);
});

test("processRun: 有 tool call 时继续执行 pending tools，不会因已有文本而直接 completed", async () => {
  const completed: string[] = [];
  let promptCalls = 0;
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      promptCalls += 1;
      if (promptCalls === 1) return baseContext();
      return {
        ...baseContext(),
        pendingTools: [{ toolExecutionId: "execution-1", callPartId: "part-call-1", assistantMessageId: "message-assistant-1", status: "queued" as const, toolName: "read", toolCallId: "call_1", args: {} }]
      };
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let runModelStepCount = 0;
  let executePendingToolsCount = 0;
  (runner as any).runModelStep = async () => {
    runModelStepCount += 1;
    return { aborted: false as const, toolCallCount: 1, assistantMessageId: 1, hasVisibleText: true };
  };
  (runner as any).executePendingTools = async () => {
    executePendingToolsCount += 1;
    return { paused: true as const };
  };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(runModelStepCount, 1);
  assert.equal(executePendingToolsCount, 1);
  assert.deepEqual(completed, []);
});

test("processRun: 下一轮无 pendingTools 时会丢弃旧快照，后续恢复 pending tool 走 fallback", async () => {
  const completed: string[] = [];
  const contexts = [
    baseContext(),
    baseContext(),
    {
      ...baseContext(),
      tools: [],
      pendingTools: [{ toolExecutionId: "execution-1", callPartId: "part-call-1", assistantMessageId: "message-assistant-1", status: "queued" as const, toolName: "read", toolCallId: "call_1", args: {} }]
    }
  ];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() {
      return {
        ...baseProfile(),
        agent: {
          tools: ["read"],
          pluginTools: [],
          mcpServers: []
        }
      };
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return contexts.shift() ?? baseContext();
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const firstSnapshot = new Set<string>(["plugin_debug-tools_echo_inspect"]);
  let runModelStepCount = 0;
  const pendingSnapshots: Array<ReadonlySet<string> | undefined> = [];
  let fallbackListToolsCount = 0;

  (runner as any).runModelStep = async () => {
    runModelStepCount += 1;
    if (runModelStepCount === 1) {
      return {
        aborted: false as const,
        toolCallCount: 1,
        assistantMessageId: 1,
        hasVisibleText: false,
        availableToolNames: firstSnapshot
      };
    }
    if (runModelStepCount === 2) {
      return {
        aborted: false as const,
        toolCallCount: 0,
        assistantMessageId: 2,
        hasVisibleText: false
      };
    }
    return {
      aborted: false as const,
      toolCallCount: 0,
      assistantMessageId: 3,
      hasVisibleText: true
    };
  };
  const originalExecutePendingTools = (runner as any).executePendingTools.bind(runner);
  (runner as any).executePendingTools = async (params: { availableToolNames?: ReadonlySet<string> }) => {
    pendingSnapshots.push(params.availableToolNames);
    return await originalExecutePendingTools(params);
  };
  (runner as any).toolRegistry.listTools = async () => {
    fallbackListToolsCount += 1;
    return [{ name: "read", description: "fixture read", inputSchema: { type: "object", properties: {} }, source: "builtin" }];
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(runModelStepCount, 3);
  assert.deepEqual(pendingSnapshots, [undefined]);
  assert.equal(fallbackListToolsCount, 1);
  assert.deepEqual(completed, ["completed"]);
});

test("processRun: reasoning-only 且无 tool call 时会继续空响应 step，并在第 6 次后 completed", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunNotice() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async persistRunTerminalIntent(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let calls = 0;
  (runner as any).runModelStep = async () => {
    calls += 1;
    return {
      aborted: false as const,
      assistantMessageId: calls,
      toolCallCount: 0,
      hasVisibleText: false,
      reasoningText: calls <= 6 ? "internal reasoning only" : ""
    };
  };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(calls, 6);
  assert.deepEqual(completed, ["completed"]);
});


test("processRun: model step fenced ignored 时静默停止且不 persistRunTerminalIntent", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { status: string }) { completed.push(input.status); }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => { throw new FencedWriteIgnoredError("flush assistant parts"); };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.deepEqual(completed, []);
});

test("processRun: ToolExecution 写回 fenced ignored 时静默停止且不 persistRunTerminalIntent", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() {
      return {
        ...baseContext(),
        pendingTools: [{
          toolExecutionId: "execution-1", callPartId: "part-call-1", assistantMessageId: "message-assistant-1",
          status: "queued", toolName: "read", toolCallId: "call_1", args: {}
        }]
      };
    },
    async persistRunTerminalIntent(input: { status: string }) { completed.push(input.status); }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).executePendingTools = async () => { throw new FencedWriteIgnoredError("tool execution running"); };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.deepEqual(completed, []);
});

test("processRun: fenced missing 时 failed persistRunTerminalIntent 恰好一次", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { status: string }) { completed.push(input.status); }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => { throw new FencedWriteMissingError("complete assistant"); };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.deepEqual(completed, ["failed"]);
});


test("processRun: 永久控制面错误仅 failed persistRunTerminalIntent 一次", async () => {
  const completed: string[] = [];
  const apiClient = {
    async markRunWorkInProgress() { return { result: "updated" as const }; },
    async convergeRunTerminal() { return { kind: "transitioned" as const, finalStatus: "completed" as const }; },
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() { return baseContext(); },
    async persistRunTerminalIntent(input: { status: string }) { completed.push(input.status); }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => { throw new ControlWritePermanentError("complete assistant", new Error("bad request")); };

  await (runner as any).processRun(baseRun(), new AbortController().signal);

  assert.deepEqual(completed, ["failed"]);
});
