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
  assert.equal((captured as { system?: string } | null)?.system, "LANG-SYSTEM");
  assert.equal(updatedToolItems[0]?.status, "running");
});

test("apply_patch 仅对明确可恢复的 prepare IO 错误单次重试", async () => {
  class TestBuiltinProvider extends BuiltinToolProvider {
    prepareCalls = 0;
    applyCalls = 0;

    protected override async prepareApplyPatch(params: { workspacePath: string; patchText: string; signal?: AbortSignal }) {
      this.prepareCalls += 1;
      if (this.prepareCalls === 1) {
        throw new Error("IO_RETRYABLE: add failed for /tmp/workspace/a.txt (EBUSY)");
      }
      return {
        operations: [],
        files: [],
        summary: { added: [], modified: [], deleted: [], moved: [], fileCount: 0, additions: 0, deletions: 0 },
        notes: [],
        text: "Success. Updated the following files:\n",
        snapshots: []
      } as any;
    }

    protected override async applyPreparedPatch() {
      this.applyCalls += 1;
    }
  }

  const provider = new TestBuiltinProvider();
  const result = await provider.execute(
    "apply_patch",
    { patchText: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new" },
    {
      profile: { provider: {}, model: {}, agent: { tools: ["apply_patch"], pluginTools: [], mcpServers: [] } },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: process.cwd() },
      signal: new AbortController().signal,
      apiClient: {} as any
    } as any
  );

  assert.equal(provider.prepareCalls, 2);
  assert.equal(provider.applyCalls, 1);
  assert.equal((result as any).text, "Success. Updated the following files:\n");
});

test("apply_patch 不会对 legacy patch 做自动重试且失败文本不重复套壳", async () => {
  class TestBuiltinProvider extends BuiltinToolProvider {
    prepareCalls = 0;

    protected override async prepareApplyPatch(): Promise<any> {
      this.prepareCalls += 1;
      throw new Error("only supports git unified diff\nDetected legacy patch format");
    }
  }

  const provider = new TestBuiltinProvider();
  await assert.rejects(
    () => provider.execute(
      "apply_patch",
      { patchText: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" },
      {
        profile: { provider: {}, model: {}, agent: { tools: ["apply_patch"], pluginTools: [], mcpServers: [] } },
        run: { workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: process.cwd() },
        signal: new AbortController().signal,
        apiClient: {} as any
      } as any
    ),
    (err: unknown) => {
      assert.match(String(err), /apply_patch verification failed: LEGACY_PATCH_FORMAT/);
      assert.match(String(err), /Repair attempted: no/);
      return true;
    }
  );
  assert.equal(provider.prepareCalls, 1);
});
