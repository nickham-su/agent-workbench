import assert from "node:assert/strict";
import test from "node:test";
import { BuiltinToolProvider } from "./builtin.js";

test("subtask prefork summary 透传 messages-context.system 到 one-shot 调用", async () => {
  let captured: {
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
  } | null = null;

  class TestBuiltinProvider extends BuiltinToolProvider {
    protected override async generateSingleCallSummary(params: {
      profile: {
        provider: unknown;
        model: unknown;
      };
      input: {
        messages: Array<{ role: string; content: unknown }>;
        system?: string;
        timeoutMs: number;
        abortSignal: AbortSignal;
      };
    }) {
      captured = {
        system: params.input.system,
        messages: params.input.messages
      };
      return { text: "prefork summary", totalTokens: null };
    }
  }

  const provider = new TestBuiltinProvider();
  const updatedToolItems: Array<{ status: string; output: Record<string, unknown> }> = [];

  const ctx = {
    profile: {
      provider: {},
      model: {},
      agent: {
        tools: ["subtask"],
        pluginTools: [],
        mcpServers: []
      }
    },
    run: {
      workspaceId: "ws_1",
      sessionId: "sess_parent",
      runId: "run_parent",
      workspacePath: process.cwd()
    },
    pendingTool: {
      itemId: 9,
      status: "queued",
      toolName: "subtask",
      toolCallId: "call_1",
      args: {}
    },
    signal: AbortSignal.timeout(3_000),
    apiClient: {
      async getSubtaskPreforkPlan() {
        return {
          shouldPrefork: true,
          thresholdPct: 95,
          parentLastResponseTotalTokens: 123,
          childContextWindowTokens: 456
        };
      },
      async getMessagesContext(input: { appendMessage?: { role: string; content: string } }) {
        return {
          headItemId: 1,
          system: "LANG-SYSTEM",
          messages: [{ role: "user", content: "history" }, ...(input.appendMessage ? [input.appendMessage] : [])]
        };
      },
      async startSubtaskRun() {
        return { sessionId: "sub_sess", runId: "sub_run", workspacePath: process.cwd() };
      },
      async getSubtaskStatus() {
        return { status: "completed" as const };
      },
      async getSubtaskResult() {
        return { resultText: "done" };
      }
    },
    processNestedRun: async () => {},
    updateToolItem: async (params: { status: "running" | "completed" | "failed"; output: Record<string, unknown> }) => {
      updatedToolItems.push(params);
    },
    nowMs: () => Date.now(),
    renderToolText: () => "rendered"
  } as any;

  const result = await provider.execute(
    "subtask",
    {
      description: "desc",
      prompt: "prompt",
      agentId: "default",
      session: { mode: "fork" }
    },
    ctx
  );

  assert.equal((result as any).subtaskSessionId, "sub_sess");
  assert.equal(captured?.system, "LANG-SYSTEM");
  assert.equal(updatedToolItems[0]?.status, "running");
});
