import assert from "node:assert/strict";
import test from "node:test";
import type { AgentItemView } from "@agent-workbench/shared";
import {
  createEmptyAgentPresentation,
  splitAvailableAgents,
} from "./agentAvailableAgentPresentation.js";

function createAgent(id: string, name: string, scope: AgentItemView["scope"]): AgentItemView {
  return {
    id,
    name,
    summary: "",
    prompt: "",
    tools: ["read"],
    mcpServers: [],
    pluginTools: [],
    defaultModel: { providerId: "provider", modelId: "model" },
    scope,
    order: 0,
    resolvedModel: null,
  };
}

test("完整 Agent 列表仅将 user/both 放入选择器，并保留全部角色名称", () => {
  const presentation = splitAvailableAgents([
    createAgent("user", "主会话角色", "user"),
    createAgent("subtask", "子任务角色", "subtask"),
    createAgent("both", "通用角色", "both"),
  ]);

  assert.deepEqual(presentation.agentOptions.map((agent) => agent.value), ["user", "both"]);
  assert.deepEqual(presentation.subtaskAgentLabels, {
    user: "主会话角色",
    subtask: "子任务角色",
    both: "通用角色",
  });
});

test("清空 Agent 展示状态可防止 Workspace 切换后复用旧选项或名称映射", () => {
  assert.deepEqual(createEmptyAgentPresentation(), {
    agentOptions: [],
    subtaskAgentLabels: {},
  });
});
