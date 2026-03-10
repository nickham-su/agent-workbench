import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunner } from "./runner.js";

function queuedPluginTool(input?: Partial<{ itemId: number; toolName: string; toolCallId: string }>) {
  return {
    itemId: input?.itemId ?? 1,
    status: "queued" as const,
    toolName: input?.toolName ?? "plugin_debug-tools_echo_inspect",
    toolCallId: input?.toolCallId ?? `call_${input?.itemId ?? 1}`,
    args: { message: "hello", includeRaw: false, mode: "ok" }
  };
}

test("executePendingTools uses ToolRegistry snapshot so queued plugin tools are not misclassified as disabled", async () => {
  const updates: Array<{ status?: string; output?: unknown }> = [];
  const apiClient = {
    async updateContextItem(input: { status?: string; output?: unknown }) {
      updates.push({ status: input.status, output: input.output });
      return { id: 1 };
    },
    async updateRunState() {
      return;
    },
    async getPluginRuntimeSnapshots() {
      return {
        plugins: [
          {
            id: "debug-tools",
            path: "/tmp/debug-tools",
            manifest: {
              schemaVersion: 1,
              id: "debug-tools",
              name: "Debug Tools",
              version: "0.1.0",
              entry: "dist/index.js",
              capabilities: ["tools"],
              tools: [
                {
                  name: "echo_inspect",
                  description: "fixture echo"
                }
              ]
            },
            entryPath: "/tmp/debug-tools/dist/index.js",
            enabled: true,
            state: "ready",
            diagnostics: [],
            capabilities: {
              tools: [
                {
                  canonicalName: "plugin_debug-tools_echo_inspect",
                  shortName: "echo_inspect",
                  description: "fixture echo"
                }
              ]
            }
          }
        ],
        updatedAt: Date.now()
      };
    }
  };

  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let receivedAvailableToolNames: ReadonlySet<string> | null = null;
  (runner as any).toolRegistry.listTools = async () => [
    {
      name: "plugin_debug-tools_echo_inspect",
      description: "fixture echo",
      inputSchema: { type: "object", properties: {} },
      source: "plugin"
    }
  ];
  (runner as any).toolRegistry.isToolEnabled = async (_toolName: string, ctx: { availableToolNames?: ReadonlySet<string> }) => {
    receivedAvailableToolNames = ctx.availableToolNames ?? null;
    return true;
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read"],
        pluginTools: ["plugin_debug-tools_echo_inspect"],
        mcpServers: []
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "sess_test",
      runId: "run_test",
      workspacePath: process.cwd()
    },
    context: {
      pendingTools: [queuedPluginTool()],
      tools: [],
      headItemId: null,
      system: "",
      messages: [],
      lastResponseTotalTokens: null,
      uiLocale: null
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.ok(receivedAvailableToolNames, "should use registry-generated tool snapshot");
  assert.equal((receivedAvailableToolNames as ReadonlySet<string>).has("plugin_debug-tools_echo_inspect"), true);
  assert.equal(updates.some((item) => item.status === "failed"), false);
});
