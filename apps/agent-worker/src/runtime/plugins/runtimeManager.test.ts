import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PluginRuntimeManager } from "./runtimeManager.js";
import type { PluginRuntimeSnapshotsResponse } from "@agent-workbench/shared";
import type { ToolExecutionContext } from "../tools/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");
const pluginDir = path.join(repoRoot, "test", "fixtures", "plugins", "debug-tools");
const pluginEntryPath = path.join(pluginDir, "index.js");

function createApiClient(response: PluginRuntimeSnapshotsResponse) {
  return {
    async getPluginRuntimeSnapshots() {
      return response;
    }
  } as any;
}

function createProfile() {
  return {
    agent: {
      tools: ["read", "write", "bash"],
      pluginTools: ["plugin_debug-tools_echo_inspect"],
      mcpServers: []
    }
  } as any;
}

function createContext() {
  return {
    profile: createProfile(),
    promptContext: {
      headItemId: null,
      system: "",
      messages: [],
      tools: [],
      pendingTools: [],
      lastResponseTotalTokens: null,
      uiLocale: null
    },
    apiClient: createApiClient({
      plugins: [
        {
          id: "debug-tools",
          path: pluginDir,
          manifest: {
            schemaVersion: 1,
            id: "debug-tools",
            name: "Debug Tools",
            version: "0.1.0",
            description: "fixture",
            entry: "index.js",
            capabilities: ["tools"],
            tools: [
              {
                name: "echo_inspect",
                description: "fixture echo",
                outputMode: "text+raw",
                riskLevel: "low"
              }
            ]
          },
          entryPath: pluginEntryPath,
          enabled: true,
          state: "ready",
          diagnostics: [],
          capabilities: {
            tools: [
              {
                canonicalName: "plugin_debug-tools_echo_inspect",
                shortName: "echo_inspect",
                description: "fixture echo",
                riskLevel: "low"
              }
            ]
          }
        }
      ],
      updatedAt: Date.now()
    })
  } as const;
}

function createExecutionContext(mode: "ok" | "throw" | "long_text", includeRaw = true): ToolExecutionContext {
  return {
    profile: createProfile(),
    run: {
      workspaceId: "ws_test",
      sessionId: "sess_test",
      runId: "run_test",
      workspacePath: repoRoot,
      workspaceRepoDirNames: [],
      inputText: undefined
    },
    pendingTool: {
      itemId: 1,
      status: "queued",
      toolName: "plugin_debug-tools_echo_inspect",
      toolCallId: "call_test",
      args: {
        message: "hello",
        tags: ["a", "b"],
        includeRaw,
        mode
      }
    },
    signal: new AbortController().signal,
    apiClient: createApiClient({ plugins: [], updatedAt: Date.now() }),
    promptContext: {
      headItemId: null,
      system: "",
      messages: [],
      tools: [],
      pendingTools: [],
      lastResponseTotalTokens: null,
      uiLocale: null,
      externalSkillRoots: []
    },
    processNestedRun: async () => {},
    updateToolItem: async () => {},
    nowMs: () => Date.now(),
    renderToolText: () => ""
  };
}

test("PluginRuntimeManager lists debug-tools fixture tool", async () => {
  const manager = new PluginRuntimeManager({ info() {}, warn() {}, error() {} });
  const tools = await manager.listTools(createContext() as any);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "plugin_debug-tools_echo_inspect");
  assert.equal(tools[0]?.source, "plugin");
});

test("PluginRuntimeManager executes debug-tools fixture ok branch", async () => {
  const manager = new PluginRuntimeManager({ info() {}, warn() {}, error() {} });
  const result = await manager.execute(
    "plugin_debug-tools_echo_inspect",
    { message: "hello", tags: ["a", "b"], includeRaw: true, mode: "ok" },
    {
      ...createExecutionContext("ok", true),
      apiClient: createContext().apiClient
    }
  );
  assert.equal(typeof result.text, "string");
  assert.match(result.text, /tool: plugin_debug-tools_echo_inspect/);
  assert.deepEqual((result.raw as any)?.receivedArgs.tags, ["a", "b"]);
});

test("PluginRuntimeManager executes debug-tools fixture long_text branch", async () => {
  const manager = new PluginRuntimeManager({ info() {}, warn() {}, error() {} });
  const result = await manager.execute(
    "plugin_debug-tools_echo_inspect",
    { message: "hello", includeRaw: false, mode: "long_text" },
    {
      ...createExecutionContext("long_text", false),
      apiClient: createContext().apiClient
    }
  );
  assert.equal(typeof result.text, "string");
  assert.ok(result.text.includes("debug-tools long_text: hello"));
  assert.ok(result.text.split("\n").length > 50);
  assert.equal("raw" in result, false);
});

test("PluginRuntimeManager propagates debug-tools fixture throw branch", async () => {
  const manager = new PluginRuntimeManager({ info() {}, warn() {}, error() {} });
  await assert.rejects(
    () => manager.execute(
      "plugin_debug-tools_echo_inspect",
      { message: "boom", includeRaw: true, mode: "throw" },
      {
        ...createExecutionContext("throw", true),
        apiClient: createContext().apiClient
      }
    ),
    /debug-tools requested failure/
  );
});
