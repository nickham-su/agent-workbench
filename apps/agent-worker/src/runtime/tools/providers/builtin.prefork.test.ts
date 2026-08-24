import assert from "node:assert/strict";
import test from "node:test";
import type { AgentApiClient, ExecutionProfile, PromptContext } from "../../apiClient.js";
import type { ToolExecutionContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

type PreforkApiClient = Pick<AgentApiClient, "getSubtaskPreforkPlan" | "getMessagesContext" | "startSubtaskRun" | "getSubtaskStatus" | "getSubtaskResult">;

const preforkArgs = { description: "desc", prompt: "prompt", agentId: "default", session: { mode: "fork" as const } };

type SummaryParams = {
  profile: { provider: ExecutionProfile["provider"]; model: ExecutionProfile["model"] };
  input: {
    messages: Array<{ role: string; content: unknown }>;
    system?: string;
    sessionId?: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
  };
};
type SummaryResult = { text: string; totalTokens: number | null };

function createPreforkContext(apiClient: PreforkApiClient, signal = new AbortController().signal) {
  const context: ToolExecutionContext = {
    profile: {} as ExecutionProfile,
    run: { workspaceId: "ws_1", sessionId: "sess_parent", runId: "run_parent", workspaceRepoDirNames: [], workspacePath: process.cwd() },
    pendingTool: { itemId: 9, status: "queued", toolName: "subtask", toolCallId: "call_1", args: {} },
    signal,
    apiClient: apiClient as unknown as AgentApiClient,
    promptContext: {} as PromptContext,
    processNestedRun: async () => undefined,
    updateToolItem: async () => undefined,
    nowMs: () => Date.now(),
    renderToolText: () => "rendered"
  };
  return context;
}

test("subtask prefork summary 透传 messages-context.system 到 one-shot 调用", async () => {
  let captured: {
    system?: string;
    sessionId?: string;
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
        sessionId?: string;
        timeoutMs: number;
        abortSignal: AbortSignal;
      };
    }) {
      captured = {
        system: params.input.system,
        sessionId: params.input.sessionId,
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
      workspaceRepoDirNames: [],
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
  assert.equal((captured as { sessionId?: string } | null)?.sessionId, "sess_parent");
  assert.equal(updatedToolItems[0]?.status, "running");
});

function successfulStart() {
  return { sessionId: "sub_sess", runId: "sub_run", workspacePath: process.cwd(), agentName: "Child", reused: false };
}

function completedChild() {
  return { status: "completed" as const };
}

function childResult() {
  return { resultText: "done" };
}

test("subtask prefork shouldPrefork=false 跳过上下文摘要但仍按固定 95 启动", async () => {
  let contextCalls = 0;
  let startCalls = 0;
  let thresholdPct: number | undefined;
  const apiClient = {
    async getSubtaskPreforkPlan(input: Parameters<AgentApiClient["getSubtaskPreforkPlan"]>[0]) {
      thresholdPct = input.thresholdPct;
      return { shouldPrefork: false, thresholdPct: 95, parentLastResponseTotalTokens: 1, childContextWindowTokens: 10, thresholdTokens: 9 };
    },
    async getMessagesContext() {
      contextCalls += 1;
      return { headItemId: null, system: "system", messages: [] };
    },
    async startSubtaskRun() {
      startCalls += 1;
      return successfulStart();
    },
    async getSubtaskStatus() { return completedChild(); },
    async getSubtaskResult() { return childResult(); }
  } as PreforkApiClient;
  const provider = new BuiltinToolProvider();
  await provider.execute("subtask", preforkArgs, createPreforkContext(apiClient));
  assert.equal(thresholdPct, 95);
  assert.equal(contextCalls, 0);
  assert.equal(startCalls, 1);
});

test("subtask prefork 摘要为空时不发送摘要字段并继续启动", async () => {
  let startInput: Parameters<AgentApiClient["startSubtaskRun"]>[0] | null = null;
  const apiClient = {
    async getSubtaskPreforkPlan() { return { shouldPrefork: true, thresholdPct: 95, parentLastResponseTotalTokens: 123, childContextWindowTokens: 456, thresholdTokens: 433 }; },
    async getMessagesContext() { return { headItemId: 1, system: "system", messages: [] }; },
    async startSubtaskRun(input: Parameters<AgentApiClient["startSubtaskRun"]>[0]) { startInput = input; return successfulStart(); },
    async getSubtaskStatus() { return completedChild(); },
    async getSubtaskResult() { return childResult(); }
  } as PreforkApiClient;
  class EmptySummaryProvider extends BuiltinToolProvider {
    protected override async generateSingleCallSummary(_params: SummaryParams): Promise<SummaryResult> { return { text: "   ", totalTokens: null }; }
  }
  await new EmptySummaryProvider().execute("subtask", preforkArgs, createPreforkContext(apiClient));
  const capturedStartInput = startInput;
  assert.ok(capturedStartInput);
  assert.equal("preforkSummaryText" in capturedStartInput, false);
  assert.equal("preforkMeta" in capturedStartInput, false);
});

test("subtask prefork 普通摘要错误固定脱敏 warning 后降级启动", async () => {
  let startCalls = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const apiClient = {
      async getSubtaskPreforkPlan() { return { shouldPrefork: true, thresholdPct: 95, parentLastResponseTotalTokens: 123, childContextWindowTokens: 456, thresholdTokens: 433 }; },
      async getMessagesContext() { return { headItemId: 1, system: "system", messages: [] }; },
      async startSubtaskRun() { startCalls += 1; return successfulStart(); },
      async getSubtaskStatus() { return completedChild(); },
      async getSubtaskResult() { return childResult(); }
    } as PreforkApiClient;
    class FailedSummaryProvider extends BuiltinToolProvider {
      protected override async generateSingleCallSummary(_params: SummaryParams): Promise<SummaryResult> { throw new Error("prompt TOKEN full result"); }
    }
    await new FailedSummaryProvider().execute("subtask", preforkArgs, createPreforkContext(apiClient));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(startCalls, 1);
  assert.equal(warnings.length, 1);
  assert.equal(String(warnings[0]?.[0]), "[agent-worker] subtask prefork summary failed; falling back to normal fork");
  assert.equal(String(warnings[0]?.[0]).includes("TOKEN"), false);
  assert.equal(String(warnings[0]?.[0]).includes("prompt"), false);
  assert.equal(String(warnings[0]?.[0]).includes("full result"), false);
});

for (const abortCase of [
  { label: "AbortError", error: Object.assign(new Error("summary stopped"), { name: "AbortError" }) },
  { label: "abort message", error: new Error("request aborted") },
  { label: "abort code", error: Object.assign(new Error("request stopped"), { code: "ABORT_ERR" }) }
]) {
  test(`subtask prefork ${abortCase.label} 不启动 child`, async () => {
    let startCalls = 0;
    const apiClient = {
      async getSubtaskPreforkPlan() { return { shouldPrefork: true, thresholdPct: 95, parentLastResponseTotalTokens: 123, childContextWindowTokens: 456, thresholdTokens: 433 }; },
      async getMessagesContext() { return { headItemId: 1, system: "system", messages: [] }; },
      async startSubtaskRun() { startCalls += 1; return successfulStart(); },
      async getSubtaskStatus() { return completedChild(); },
      async getSubtaskResult() { return childResult(); }
    } as PreforkApiClient;
    class AbortSummaryProvider extends BuiltinToolProvider {
      protected override async generateSingleCallSummary(_params: SummaryParams): Promise<SummaryResult> { throw abortCase.error; }
    }
    await assert.rejects(() => new AbortSummaryProvider().execute("subtask", preforkArgs, createPreforkContext(apiClient)), abortCase.error);
    assert.equal(startCalls, 0);
  });
}

test("subtask prefork 成功时透传固定 threshold 与一致 preforkMeta", async () => {
  let startInput: Parameters<AgentApiClient["startSubtaskRun"]>[0] | null = null;
  const apiClient = {
    async getSubtaskPreforkPlan(input: Parameters<AgentApiClient["getSubtaskPreforkPlan"]>[0]) {
      assert.equal(input.thresholdPct, 95);
      return { shouldPrefork: true, thresholdPct: 95, parentLastResponseTotalTokens: 123, childContextWindowTokens: 456, thresholdTokens: 433 };
    },
    async getMessagesContext() { return { headItemId: 1, system: "system", messages: [] }; },
    async startSubtaskRun(input: Parameters<AgentApiClient["startSubtaskRun"]>[0]) { startInput = input; return successfulStart(); },
    async getSubtaskStatus() { return completedChild(); },
    async getSubtaskResult() { return childResult(); }
  } as PreforkApiClient;
  class SummaryProvider extends BuiltinToolProvider {
    protected override async generateSingleCallSummary(_params: SummaryParams): Promise<SummaryResult> { return { text: "summary", totalTokens: 7 }; }
  }
  await new SummaryProvider().execute("subtask", preforkArgs, createPreforkContext(apiClient));
  const capturedStartInput = startInput as Parameters<AgentApiClient["startSubtaskRun"]>[0] | null;
  assert.ok(capturedStartInput, "startSubtaskRun input should be captured");
  assert.deepEqual(capturedStartInput.preforkMeta, { thresholdPct: 95, parentLastResponseTotalTokens: 123, childContextWindowTokens: 456 });
  assert.equal(capturedStartInput.preforkSummaryText, "summary");
});

test("subtask prefork 摘要成功后立即 abort 不启动 child", async () => {
  const controller = new AbortController();
  let startCalls = 0;
  const apiClient = {
    async getSubtaskPreforkPlan() {
      return { shouldPrefork: true, thresholdPct: 95, parentLastResponseTotalTokens: 123, childContextWindowTokens: 456, thresholdTokens: 433 };
    },
    async getMessagesContext() { return { headItemId: 1, system: "system", messages: [] }; },
    async startSubtaskRun() { startCalls += 1; return successfulStart(); },
    async getSubtaskStatus() { return completedChild(); },
    async getSubtaskResult() { return childResult(); }
  } as PreforkApiClient;
  class AbortAfterSummaryProvider extends BuiltinToolProvider {
    protected override async generateSingleCallSummary(_params: SummaryParams): Promise<SummaryResult> {
      controller.abort();
      return { text: "summary", totalTokens: 7 };
    }
  }

  await assert.rejects(
    () => new AbortAfterSummaryProvider().execute("subtask", preforkArgs, createPreforkContext(apiClient, controller.signal)),
    (err: unknown) => {
      assert.equal((err as { name?: unknown }).name, "AbortError");
      return true;
    }
  );
  assert.equal(startCalls, 0);
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
