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
      autoCompactThresholdPct: 80,
      visionModel: null,
      updatedAt: Date.now()
    },
    vision: null,
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
      return { sessionId: "sess_child", runId: "run_child", workspacePath: process.cwd(), agentName: "Child" };
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
