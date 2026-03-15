import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "./registry.js";
import type { ResolvedToolDefinition, ToolExecutionContext, ToolListContext, ToolProvider } from "./types.js";

function createToolListContext(): ToolListContext {
  return {
    profile: {
      agent: {
        tools: ["read"],
        pluginTools: [
          "plugin_debug-tools_echo_inspect",
          "plugin_debug-tools_foo_bar"
        ],
        mcpServers: []
      }
    } as any,
    promptContext: {
      headItemId: null,
      system: "",
      messages: [],
      tools: [],
      pendingTools: [],
      lastResponseTotalTokens: null,
      uiLocale: null,
      repoSkillRoots: []
    },
    apiClient: {} as any
  };
}

function createExecutionContext(): ToolExecutionContext {
  return {
    profile: createToolListContext().profile,
    run: {
      workspaceId: "ws_test",
      sessionId: "sess_test",
      runId: "run_test",
      workspacePath: process.cwd()
    },
    pendingTool: {
      itemId: 1,
      status: "queued",
      toolName: "read",
      toolCallId: "call_test",
      args: {}
    },
    signal: new AbortController().signal,
    apiClient: {} as any,
    promptContext: createToolListContext().promptContext,
    processNestedRun: async () => {},
    updateToolItem: async () => {},
    nowMs: () => Date.now(),
    renderToolText: () => ""
  };
}

test("ToolRegistry dedupes tools by name", async () => {
  const provider: ToolProvider = {
    canHandle: () => true,
    async listTools(_ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
      return [
        {
          name: "read",
          description: "read",
          inputSchema: { type: "object" },
          source: "builtin"
        },
        {
          name: "plugin_debug-tools_echo_inspect",
          description: "echo",
          inputSchema: { type: "object" },
          source: "plugin"
        }
      ];
    },
    isToolEnabled: () => true,
    async execute() {
      return {};
    }
  };

  const registry = new ToolRegistry([provider]);
  const tools = await registry.listTools(createToolListContext());

  assert.equal(tools.length, 2);
  assert.ok(tools.some((t) => t.name === "read"));
  assert.ok(tools.some((t) => t.name === "plugin_debug-tools_echo_inspect"));
});

test("ToolRegistry overwrites previous tool on same name (last provider wins)", async () => {
  const provider: ToolProvider = {
    canHandle: () => true,
    async listTools(_ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
      return [
        {
          name: "plugin_debug-tools_foo_bar",
          description: "a",
          inputSchema: { type: "object" },
          source: "plugin"
        },
        {
          name: "plugin_debug-tools_foo_bar",
          description: "b (wins)",
          inputSchema: { type: "object" },
          source: "plugin"
        }
      ];
    },
    isToolEnabled: () => true,
    async execute() {
      return {};
    }
  };

  const registry = new ToolRegistry([provider]);
  const tools = await registry.listTools(createToolListContext());

  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "plugin_debug-tools_foo_bar");
  assert.equal(tools[0]?.description, "b (wins)");
});
