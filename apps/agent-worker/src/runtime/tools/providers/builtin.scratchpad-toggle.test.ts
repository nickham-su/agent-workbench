import assert from "node:assert/strict";
import test from "node:test";
import type { AgentApiClient, ExecutionProfile, PromptContext } from "../../apiClient.js";
import type { AvailableToolContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

function createProfile(tools: ExecutionProfile["agent"]["tools"]): ExecutionProfile {
  return {
    resolved: {
      runId: "run_1",
      sessionId: "sess_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      providerId: "openai",
      modelId: "gpt-4o-mini"
    },
    runtime: {
      modelIdleTimeoutMs: 0,
      modelTotalTimeoutMs: 0,
      modelRequestMaxRetries: 0,
      autoCompactThresholdPct: 80,
      visionModel: null,
      compactionModel: null,
      updatedAt: Date.now()
    },
    vision: null,
    compaction: null,
    agent: {
      id: "agent_1",
      name: "agent_1",
      summary: "",
      prompt: "",
      tools,
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

function createPromptContext(tools: PromptContext["tools"]): PromptContext {
  return {
    pendingTools: [],
    tools,
    headItemId: null,
    system: "",
    messages: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  };
}

function createCtx(tools: ExecutionProfile["agent"]["tools"], promptTools: PromptContext["tools"] = []): AvailableToolContext {
  return {
    profile: createProfile(tools),
    promptContext: createPromptContext(promptTools),
    apiClient: {} as AgentApiClient,
    availableToolNames: new Set(promptTools.map((item) => item.name))
  };
}

test("builtin provider 未配置 scratchpad 时不启用", () => {
  const provider = new BuiltinToolProvider();
  assert.equal(provider.isToolEnabled("scratchpad", createCtx([])), false);
});

test("builtin provider 配置 scratchpad 时启用", () => {
  const provider = new BuiltinToolProvider();
  assert.equal(provider.isToolEnabled("scratchpad", createCtx(["scratchpad"])), true);
});

test("builtin provider listTools 仅暴露 promptContext 中的 scratchpad", async () => {
  const provider = new BuiltinToolProvider();
  const hidden = await provider.listTools(createCtx([], []));
  assert.equal(hidden.some((item) => item.name === "scratchpad"), false);

  const visible = await provider.listTools(createCtx(["scratchpad"], [
    {
      name: "scratchpad",
      description: "Record a short scratchpad entry.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" }
        }
      }
    }
  ]));
  assert.equal(visible.some((item) => item.name === "scratchpad"), true);
});
