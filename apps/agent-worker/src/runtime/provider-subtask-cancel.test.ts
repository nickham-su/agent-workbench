import assert from "node:assert/strict";
import test from "node:test";
import type { AgentApiClient, ExecutionProfile, PromptContext } from "./apiClient.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { BuiltinToolProvider } from "./tools/providers/builtin.js";

function baseContext(): PromptContext {
  return {
    pendingTools: [],
    tools: [],
    headItemId: null,
    system: "",
    messages: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  };
}

function baseProfile(): ExecutionProfile {
  return {
    resolved: {
      runId: "run_parent",
      sessionId: "sess_parent",
      workspaceId: "ws_test",
      agentId: "agent_test",
      providerId: "openai",
      modelId: "gpt-4o-mini"
    },
    runtime: {
      modelIdleTimeoutMs: 0,
      modelTotalTimeoutMs: 0,
      modelRequestMaxRetries: 0,
      modelRequestRetryBackoffMaxMs: 60_000,
      autoCompactThresholdPct: 80,
      maxSubtaskDepth: 1,
      sessionTerminalSoundEnabled: true,
      visionModel: null,
      compactionModel: null,
      updatedAt: Date.now()
    },
    vision: null,
    compaction: null,
    agent: {
      id: "agent_test",
      name: "agent_test",
      summary: "",
      prompt: "",
      tools: [],
      mcpServers: [],
      pluginTools: [],
      defaultModel: null
    },
    provider: {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      options: { baseURL: "", apiKey: "test" }
    },
    model: {
      id: "gpt-4o-mini",
      name: "gpt-4o-mini",
      contextWindowTokens: 128000
    }
  };
}

type SubtaskApiClient = Pick<
  AgentApiClient,
  "startSubtaskRun" | "getSubtaskStatus" | "getSubtaskResult" | "completeRun" | "getMessagesContext"
>;

function asAgentApiClient(client: SubtaskApiClient): AgentApiClient {
  return client as unknown as AgentApiClient;
}

test("subtask provider 父 abort 后不再额外 complete child cancelled", async () => {
  const provider = new BuiltinToolProvider();
  const controller = new AbortController();
  const completeCalls: Array<{ status: string; sessionId: string; runId: string }> = [];
  const getResultCalls: Array<{ sessionId: string; runId: string }> = [];
  let getStatusCalls = 0;

  const processNestedRun: ToolExecutionContext["processNestedRun"] = async () => {
    controller.abort();
    return;
  };

  const apiClient: Pick<AgentApiClient, "startSubtaskRun" | "getSubtaskStatus" | "getSubtaskResult" | "completeRun" | "getMessagesContext"> = {
    async startSubtaskRun() {
      return { sessionId: "sess_child", runId: "run_child", workspacePath: process.cwd(), agentName: "Child", reused: false };
    },
    async getSubtaskStatus() {
      getStatusCalls += 1;
      return { status: "cancelled" };
    },
    async getSubtaskResult(input: { sessionId: string; runId: string }) {
      getResultCalls.push(input);
      return { resultText: "cancelled" };
    },
    async completeRun(input: { status: string; sessionId: string; runId: string }) {
      completeCalls.push(input);
      return;
    },
    async getMessagesContext() {
      return {
        headItemId: null,
        system: "",
        messages: []
      };
    }
  };

  const ctx: ToolExecutionContext = {
    profile: baseProfile(),
    run: {
      workspaceId: "ws_test",
      sessionId: "sess_parent",
      runId: "run_parent",
      workspacePath: process.cwd(),
      workspaceRepoDirNames: [],
      inputText: "parent"
    },
    pendingTool: {
      itemId: 1,
      status: "queued",
      toolName: "subtask",
      toolCallId: "call_subtask",
      args: {}
    },
    signal: controller.signal,
    apiClient: asAgentApiClient(apiClient),
    promptContext: baseContext(),
    processNestedRun,
    updateToolItem: async () => {
      return;
    },
    nowMs: () => Date.now(),
    renderToolText: () => "Subtask started."
  };

  await assert.rejects(
    provider.execute(
      "subtask",
      {
        agentId: "agent_test",
        description: "child",
        prompt: "do it",
        session: { mode: "fork" }
      },
      ctx
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "AbortError");
      return true;
    }
  );

  assert.equal(getStatusCalls, 0);
  assert.deepEqual(getResultCalls, []);
  assert.deepEqual(completeCalls, []);
});

test("subtask provider 复用 running child 时轮询而不重复执行", async () => {
  const provider = new BuiltinToolProvider();
  let processNestedRunCalls = 0;
  let getStatusCalls = 0;
  let getResultCalls = 0;
  const apiClient: SubtaskApiClient = {
    async startSubtaskRun() {
      return { sessionId: "sess_child", runId: "run_child", workspacePath: process.cwd(), agentName: "Child", reused: true };
    },
    async getSubtaskStatus() {
      getStatusCalls += 1;
      return { status: getStatusCalls === 1 ? "running" : "completed" };
    },
    async getSubtaskResult() {
      getResultCalls += 1;
      return { resultText: "reused result" };
    },
    async completeRun() {
      return;
    },
    async getMessagesContext() {
      return { headItemId: null, system: "", messages: [] };
    }
  };
  const ctx: ToolExecutionContext = {
    profile: baseProfile(),
    run: { workspaceId: "ws_test", sessionId: "sess_parent", runId: "run_parent", workspacePath: process.cwd(), workspaceRepoDirNames: [] },
    pendingTool: { itemId: 1, status: "queued", toolName: "subtask", toolCallId: "call_subtask", args: {} },
    signal: new AbortController().signal,
    apiClient: asAgentApiClient(apiClient),
    promptContext: baseContext(),
    processNestedRun: async () => {
      processNestedRunCalls += 1;
    },
    updateToolItem: async () => undefined,
    nowMs: () => Date.now(),
    renderToolText: () => "Subtask started."
  };

  const result = await provider.execute("subtask", {
    agentId: "agent_test",
    description: "child",
    prompt: "do it",
    session: { mode: "new" }
  }, ctx) as { resultText: string };

  assert.equal(processNestedRunCalls, 0);
  assert.equal(getStatusCalls, 2);
  assert.equal(getResultCalls, 1);
  assert.equal(result.resultText, "reused result");
});

test("subtask provider 复用 terminal child 时直接读取结果", async () => {
  const provider = new BuiltinToolProvider();
  let processNestedRunCalls = 0;
  let getStatusCalls = 0;
  const apiClient: SubtaskApiClient = {
    async startSubtaskRun() {
      return { sessionId: "sess_child", runId: "run_child", workspacePath: process.cwd(), agentName: "Child", reused: true };
    },
    async getSubtaskStatus() {
      getStatusCalls += 1;
      return { status: "completed" };
    },
    async getSubtaskResult() {
      return { resultText: "terminal result" };
    },
    async completeRun() {
      return;
    },
    async getMessagesContext() {
      return { headItemId: null, system: "", messages: [] };
    }
  };
  const ctx: ToolExecutionContext = {
    profile: baseProfile(),
    run: { workspaceId: "ws_test", sessionId: "sess_parent", runId: "run_parent", workspacePath: process.cwd(), workspaceRepoDirNames: [] },
    pendingTool: { itemId: 1, status: "queued", toolName: "subtask", toolCallId: "call_subtask", args: {} },
    signal: new AbortController().signal,
    apiClient: asAgentApiClient(apiClient),
    promptContext: baseContext(),
    processNestedRun: async () => {
      processNestedRunCalls += 1;
    },
    updateToolItem: async () => undefined,
    nowMs: () => Date.now(),
    renderToolText: () => "Subtask started."
  };

  const result = await provider.execute("subtask", {
    agentId: "agent_test",
    description: "child",
    prompt: "do it",
    session: { mode: "existing", sessionId: "sess_child" }
  }, ctx) as { resultText: string };

  assert.equal(processNestedRunCalls, 0);
  assert.equal(getStatusCalls, 1);
  assert.equal(result.resultText, "terminal result");
});

test("subtask provider reused child 等待超时只结束当前等待，不修改 child", async () => {
  const previousInterval = process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS;
  const previousTimeout = process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS;
  process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS = "1";
  process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS = "5";
  try {
    const provider = new BuiltinToolProvider();
    let processNestedRunCalls = 0;
    let getStatusCalls = 0;
    let getResultCalls = 0;
    const apiClient: SubtaskApiClient = {
      async startSubtaskRun() {
        return { sessionId: "sess_child", runId: "run_child", workspacePath: process.cwd(), agentName: "Child", reused: true };
      },
      async getSubtaskStatus() {
        getStatusCalls += 1;
        return { status: "running" };
      },
      async getSubtaskResult() {
        getResultCalls += 1;
        return { resultText: "unexpected" };
      },
      async completeRun() {
        throw new Error("reused child must not be modified");
      },
      async getMessagesContext() {
        return { headItemId: null, system: "", messages: [] };
      }
    };
    const ctx: ToolExecutionContext = {
      profile: baseProfile(),
      run: { workspaceId: "ws_test", sessionId: "sess_parent", runId: "run_parent", workspacePath: process.cwd(), workspaceRepoDirNames: [] },
      pendingTool: { itemId: 1, status: "queued", toolName: "subtask", toolCallId: "call_subtask", args: {} },
      signal: new AbortController().signal,
      apiClient: asAgentApiClient(apiClient),
      promptContext: baseContext(),
      processNestedRun: async () => {
        processNestedRunCalls += 1;
      },
      updateToolItem: async () => undefined,
      nowMs: () => Date.now(),
      renderToolText: () => "Subtask started."
    };

    await assert.rejects(
      provider.execute("subtask", { agentId: "agent_test", description: "child", prompt: "do it", session: { mode: "new" } }, ctx),
      /wait timed out.*child may still be running and was not modified/
    );
    assert.equal(processNestedRunCalls, 0);
    assert.ok(getStatusCalls >= 2);
    assert.equal(getResultCalls, 0);
  } finally {
    if (previousInterval == null) delete process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS;
    else process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS = previousInterval;
    if (previousTimeout == null) delete process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS;
    else process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS = previousTimeout;
  }
});

test("subtask provider 保留 API 深度拒绝的 409 错误文本", async () => {
  const provider = new BuiltinToolProvider();
  for (const code of ["AGENT_SUBTASK_DEPTH_UNKNOWN", "AGENT_SUBTASK_MAX_DEPTH_EXCEEDED"]) {
    const apiClient: SubtaskApiClient = {
      async startSubtaskRun() {
        throw new Error(`request failed: 409 subtask rejected (${code})`);
      },
      async getSubtaskStatus() {
        return { status: "completed" };
      },
      async getSubtaskResult() {
        return { resultText: "" };
      },
      async completeRun() {
        return;
      },
      async getMessagesContext() {
        return { headItemId: null, system: "", messages: [] };
      }
    };
    const ctx: ToolExecutionContext = {
      profile: baseProfile(),
      run: { workspaceId: "ws_test", sessionId: "sess_parent", runId: "run_parent", workspacePath: process.cwd(), workspaceRepoDirNames: [] },
      pendingTool: { itemId: 1, status: "queued", toolName: "subtask", toolCallId: "call_subtask", args: {} },
      signal: new AbortController().signal,
      apiClient: asAgentApiClient(apiClient),
      promptContext: baseContext(),
      processNestedRun: async () => undefined,
      updateToolItem: async () => undefined,
      nowMs: () => Date.now(),
      renderToolText: () => "Subtask started."
    };
    await assert.rejects(
      provider.execute("subtask", { agentId: "agent_test", description: "child", prompt: "do it", session: { mode: "new" } }, ctx),
      (err: unknown) => err instanceof Error && err.message.includes(`409 subtask rejected (${code})`)
    );
  }
});
