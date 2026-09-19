import test from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { AgentRunner, ControlWritePermanentError, ModelContextLengthExceededError, buildCompactionUserPrompt } from "./runner.js";
import {
  ApiConflictError,
  InternalRpcHttpError,
  InternalRpcInvalidResponseError,
  InternalRpcNetworkError,
  InternalRpcTimeoutError,
} from "./apiClient.js";

function createCompactionProfile(input?: {
  candidate?: { providerId?: string; modelId?: string; contextWindowTokens?: number } | null;
}) {
  const candidate = input?.candidate === null
    ? null
    : {
        source: "runtime_compaction" as const,
        provider: {
          id: input?.candidate?.providerId ?? "compaction-provider",
          name: "Compaction Provider",
          npm: "@ai-sdk/openai" as const,
          options: { baseURL: "https://compaction.example.test", apiKey: "compaction-key" }
        },
        model: {
          id: input?.candidate?.modelId ?? "compaction-model",
          name: "Compaction Model",
          contextWindowTokens: input?.candidate?.contextWindowTokens ?? 100_000
        }
      };
  return {
    resolved: { workspaceId: "ws", sessionId: "sess" },
    runtime: {
      modelRequestMaxRetries: 0,
      autoCompactThresholdPct: 80,
      compactionModel: candidate ? { providerId: candidate.provider.id, modelId: candidate.model.id } : null
    },
    provider: {
      id: "primary-provider",
      name: "Primary Provider",
      npm: "@ai-sdk/openai" as const,
      options: { baseURL: "https://primary.example.test", apiKey: "primary-key" }
    },
    model: {
      id: "primary-model",
      name: "Primary Model",
      contextWindowTokens: 128_000
    },
    compaction: candidate
  };
}

function createCompactionContext(lastResponseTotalTokens: number | null) {
  return {
    lastResponseTotalTokens,
    uiLocale: "en-US" as const
  };
}

function createMessagesContext() {
  return {
    headMessageId: "message-head",
    system: "Compaction system",
    messages: [{ role: "user", content: "Summarize this session." }]
  };
}

function createProcessRunPromptContext(lastResponseTotalTokens: number | null, headMessageId: string) {
  return {
    pendingTools: [],
    tools: [],
    headMessageId,
    sessionRevision: 0,
    system: "",
    messages: [],
    lastResponseTotalTokens,
    uiLocale: "en-US" as const,
    externalSkillRoots: []
  };
}

async function runProcessRunAutoCompactionTest(input: { candidateContextLimitError: boolean }) {
  const profile = createCompactionProfile({ candidate: { contextWindowTokens: 110_000 } });
  const summaryCalls: string[] = [];
  const compactCalls: Array<{ expectedHeadMessageId: string | null; expectedRevision: number }> = [];
  const terminalStatuses: string[] = [];
  let promptContextCallCount = 0;
  const controller = new AbortController();

  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any): Promise<{ text: string; totalTokens: number | null }> {
      const modelKey = `${params.profile.provider.id}/${params.profile.model.id}`;
      summaryCalls.push(modelKey);
      if (input.candidateContextLimitError && modelKey === "compaction-provider/compaction-model") {
        const error = new Error("context length exceeded") as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }
      return { text: "summary", totalTokens: null };
    }
  }

  const runner = new TestRunner(
    {
      async getExecutionProfile() {
        return profile;
      },
      async updateRunNotice() {},
      async getPromptContext() {
        promptContextCallCount += 1;
        return promptContextCallCount === 1
          ? createProcessRunPromptContext(110_000, "message-head")
          : createProcessRunPromptContext(null, "message-next");
      },
      async getMessagesContext() {
        return createMessagesContext();
      },
      async commitCompaction(input: { expectedHeadMessageId: string | null; expectedRevision: number }) {
        compactCalls.push({ expectedHeadMessageId: input.expectedHeadMessageId, expectedRevision: input.expectedRevision });
        controller.abort();
        return { result: "updated", summaryMessageId: "message-compaction" };
      },
      async completeRun(input: { status: string }) {
        terminalStatuses.push(input.status);
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await (runner as any).processRun(
    { workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: "." },
    controller.signal
  );

  return { summaryCalls, compactCalls, terminalStatuses };
}

test("shouldAutoCompact 基于当前模型 contextWindowTokens 计算阈值", () => {
  const runner = new AgentRunner({} as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const shouldAutoCompact = (runner as any).shouldAutoCompact.bind(runner) as (input: {
    context: { lastResponseTotalTokens: number | null };
    model: { contextWindowTokens: number };
    runtime: { autoCompactThresholdPct: number };
  }) => boolean;

  const context = { lastResponseTotalTokens: 90_000 };
  assert.equal(
    shouldAutoCompact({ context, model: { contextWindowTokens: 100_000 }, runtime: { autoCompactThresholdPct: 80 } }),
    true
  );
  assert.equal(
    shouldAutoCompact({ context, model: { contextWindowTokens: 200_000 }, runtime: { autoCompactThresholdPct: 80 } }),
    false
  );
  assert.equal(
    shouldAutoCompact({
      context: { lastResponseTotalTokens: null },
      model: { contextWindowTokens: 100_000 },
      runtime: { autoCompactThresholdPct: 80 }
    }),
    false
  );

  const profile = createCompactionProfile({ candidate: { contextWindowTokens: 64_000 } });
  assert.equal(
    shouldAutoCompact({
      context: { lastResponseTotalTokens: 90_000 },
      model: profile.model,
      runtime: profile.runtime
    }),
    false
  );
});

test("buildCompactionUserPrompt 按 uiLocale 返回对应语言", () => {
  const zh = buildCompactionUserPrompt({ uiLocale: "zh-CN" });
  const en = buildCompactionUserPrompt({ uiLocale: "en-US" });
  const fallback = buildCompactionUserPrompt({ uiLocale: null });

  assert.ok(zh.includes("请基于当前会话内容输出一份结构化总结"));
  assert.ok(zh.includes("重点覆盖:"));
  assert.ok(en.includes("Please produce a structured summary of the current session"));
  assert.ok(en.includes("Focus on:"));
  assert.ok(fallback.includes("Please produce a structured summary of the current session"));
  assert.ok(zh.includes("若上下文包含与工作目标相关的文档,请在总结中列出文档路径"));
  assert.ok(en.includes("if the context includes documents relevant to the work goal, list their document paths in the summary"));
  assert.equal(fallback.includes("请基于当前会话内容输出一份结构化总结"), false);
});

test("generateCompactionSummary 未配置候选时使用主模型", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      return { text: "summary", totalTokens: null };
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile({ candidate: null }),
    context: createCompactionContext(80_000),
    signal: AbortSignal.timeout(1_000)
  });

  assert.deepEqual(calls, ["primary-provider/primary-model"]);
});

test("generateCompactionSummary 候选容量足够时使用候选模型", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      return { text: "summary", totalTokens: null };
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile({ candidate: { contextWindowTokens: 100_000 } }),
    context: createCompactionContext(100_000),
    signal: AbortSignal.timeout(1_000)
  });

  assert.deepEqual(calls, ["compaction-provider/compaction-model"]);
});

test("generateCompactionSummary 候选容量不足时使用主模型", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      return { text: "summary", totalTokens: null };
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile({ candidate: { contextWindowTokens: 99_999 } }),
    context: createCompactionContext(100_000),
    signal: AbortSignal.timeout(1_000)
  });

  assert.deepEqual(calls, ["primary-provider/primary-model"]);
});

test("generateCompactionSummary usage 缺失时先尝试候选模型", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      return { text: "summary", totalTokens: null };
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile(),
    context: createCompactionContext(null),
    signal: AbortSignal.timeout(1_000)
  });

  assert.deepEqual(calls, ["compaction-provider/compaction-model"]);
});

test("generateCompactionSummary 候选上下文超限时仅回退主模型一次", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      const profile = `${params.profile.provider.id}/${params.profile.model.id}`;
      calls.push(profile);
      if (profile === "compaction-provider/compaction-model") {
        const error = new Error("The prompt is too long for this model") as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }
      return { text: "primary summary", totalTokens: null };
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  const text = await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile(),
    context: createCompactionContext(null),
    signal: AbortSignal.timeout(1_000)
  });

  assert.equal(text, "primary summary");
  assert.deepEqual(calls, ["compaction-provider/compaction-model", "primary-provider/primary-model"]);
});

test("generateCompactionSummary 识别结构化上下文超限错误并回退主模型", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      const profile = `${params.profile.provider.id}/${params.profile.model.id}`;
      calls.push(profile);
      if (profile === "compaction-provider/compaction-model") {
        throw new APICallError({
          message: "bad request",
          url: "https://compaction.example.test",
          requestBodyValues: {},
          statusCode: 400,
          data: { error: { code: "context_length_exceeded" } }
        });
      }
      return { text: "primary summary", totalTokens: null };
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile(),
    context: createCompactionContext(null),
    signal: AbortSignal.timeout(1_000)
  });

  assert.deepEqual(calls, ["compaction-provider/compaction-model", "primary-provider/primary-model"]);
});

test("generateCompactionSummary 非上下文超限错误不回退主模型", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any): Promise<{ text: string; totalTokens: number | null }> {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      throw new Error("request failed: 429 rate limited");
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await assert.rejects(
    () => (runner as any).generateCompactionSummary({
      profile: createCompactionProfile(),
      context: createCompactionContext(null),
      signal: AbortSignal.timeout(1_000)
    }),
    /429 rate limited/
  );
  assert.deepEqual(calls, ["compaction-provider/compaction-model"]);
});

test("generateCompactionSummary 不把 maxOutputTokens 校验错误误判为上下文超限", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any): Promise<{ text: string; totalTokens: number | null }> {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      throw new Error("maxOutputTokens must be a finite number");
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await assert.rejects(
    () => (runner as any).generateCompactionSummary({
      profile: createCompactionProfile(),
      context: createCompactionContext(null),
      signal: AbortSignal.timeout(1_000)
    }),
    /maxOutputTokens must be a finite number/
  );
  assert.deepEqual(calls, ["compaction-provider/compaction-model"]);
});

test("generateCompactionSummary 候选与主模型相同时不重复回退", async () => {
  const calls: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any): Promise<{ text: string; totalTokens: number | null }> {
      calls.push(`${params.profile.provider.id}/${params.profile.model.id}`);
      const error = new Error("context length exceeded") as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }
  }
  const runner = new TestRunner(
    { async getMessagesContext() { return createMessagesContext(); } } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );
  const profile = createCompactionProfile({
    candidate: { providerId: "primary-provider", modelId: "primary-model", contextWindowTokens: 128_000 }
  });

  await assert.rejects(
    () => (runner as any).generateCompactionSummary({
      profile,
      context: createCompactionContext(null),
      signal: AbortSignal.timeout(1_000)
    }),
    /cannot be split further on Message boundaries/
  );
  assert.deepEqual(calls, ["primary-provider/primary-model"]);
});

test("processRun 自动压缩真实入口使用候选模型", async () => {
  const result = await runProcessRunAutoCompactionTest({ candidateContextLimitError: false });

  assert.deepEqual(result.summaryCalls, ["compaction-provider/compaction-model"]);
  assert.deepEqual(result.compactCalls, [{ expectedHeadMessageId: "message-head", expectedRevision: 0 }]);
  assert.deepEqual(result.terminalStatuses, ["cancelled"]);
});

test("processRun 自动压缩真实入口在候选超限时回退主模型", async () => {
  const result = await runProcessRunAutoCompactionTest({ candidateContextLimitError: true });

  assert.deepEqual(result.summaryCalls, [
    "compaction-provider/compaction-model",
    "primary-provider/primary-model"
  ]);
  assert.deepEqual(result.compactCalls, [{ expectedHeadMessageId: "message-head", expectedRevision: 0 }]);
  assert.deepEqual(result.terminalStatuses, ["cancelled"]);
});

test("generateCompactionSummary 透传 messages-context.system 到单次调用", async () => {
  let captured: {
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
  } | null = null;
  class TestRunner extends AgentRunner {
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
      return { text: "ok", totalTokens: null };
    }
  }

  const runner = new TestRunner(
    {
      async getMessagesContext(input: { appendMessage?: { role: string; content: string } }) {
        return {
          headMessageId: "message-head",
          system: "LANG-SYSTEM",
          messages: [{ role: "user", content: "hello" }, ...(input.appendMessage ? [input.appendMessage] : [])]
        };
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  const text = await (runner as any).generateCompactionSummary({
    profile: { resolved: { workspaceId: "ws", sessionId: "sess" }, provider: {}, model: {} },
    context: { uiLocale: "zh-CN" },
    signal: AbortSignal.timeout(1_000)
  });
  assert.equal(text, "ok");
  assert.equal((captured as { system?: string } | null)?.system, "LANG-SYSTEM");
});

test("generateCompactionSummary 使用 messages-context 追加压缩提示词", async () => {
  const runner = new AgentRunner(
    {
      async getMessagesContext(input: { appendMessage?: { role: string; content: string } }) {
        return {
          headMessageId: "message-head",
          system: "",
          messages: [
            { role: "user", content: "hello" },
            ...(input.appendMessage ? [input.appendMessage] : [])
          ]
        };
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  const resEn = await (runner as any).apiClient.getMessagesContext({
    appendMessage: { role: "user", content: buildCompactionUserPrompt({ uiLocale: "en-US" }) }
  });
  assert.ok(String(resEn.messages.at(-1)?.content || "").includes("Please produce a structured summary of the current session"));

  const resZh = await (runner as any).apiClient.getMessagesContext({
    appendMessage: { role: "user", content: buildCompactionUserPrompt({ uiLocale: "zh-CN" }) }
  });
  assert.ok(String(resZh.messages.at(-1)?.content || "").includes("请基于当前会话内容输出一份结构化总结"));
});

test("compactContext 对任意 Provider 错误持续重试，不受 profile 次数限制", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const observedDelays: number[] = [];
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    observedDelays.push(Number(ms));
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    let summaryCalls = 0;
    let commitCalls = 0;
    const notices: string[] = [];
    class TestRunner extends AgentRunner {
      protected override async generateCompactionSummary() {
        summaryCalls += 1;
        if (summaryCalls < 3) throw new Error("request failed: 401 provider rejected request");
        return "summary-ok";
      }
    }
    const runner = new TestRunner({
      async commitCompaction() {
        commitCalls += 1;
        return { result: "updated", summaryMessageId: "message-compaction" };
      },
      async updateRunNotice(input: { runNoticeText?: string }) {
        notices.push(String(input.runNoticeText || ""));
      }
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);

    const result = await (runner as any).compactContext({
      profile: { runtime: { modelRequestMaxRetries: 0 }, model: {}, provider: {} },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headMessageId: "message-head", sessionRevision: 0, uiLocale: "zh-CN" },
      signal: AbortSignal.timeout(1_000)
    });

    assert.equal(result, true);
    assert.equal(summaryCalls, 3);
    assert.equal(commitCalls, 1);
    assert.deepEqual(observedDelays.slice(0, 2), [2_000, 4_000]);
    assert.ok(notices.some((notice) => notice.includes("attempt 2")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("manual compaction 的永久 control-read 不调用 Provider 且收敛失败", async () => {
  for (const error of [
    new InternalRpcHttpError({ method: "POST", endpoint: "/messages", status: 400 }),
    new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/messages", stage: "schema" }),
    new Error("program error"),
  ]) {
    let providerCalls = 0;
    const terminalStatuses: string[] = [];
    class TestRunner extends AgentRunner {
      protected override async generateSingleCallSummary() { providerCalls += 1; return { text: "summary", totalTokens: null }; }
    }
    const runner = new TestRunner({
      async getExecutionProfile() { return createCompactionProfile(); },
      async getPromptContext() { return createProcessRunPromptContext(null, "message-head"); },
      async getMessagesContext() { throw error; },
      async completeRun(input: { status: string }) { terminalStatuses.push(input.status); },
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    await (runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", runKind: "manual_compaction", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
    assert.equal(providerCalls, 0);
    assert.deepEqual(terminalStatuses, ["failed"]);
  }
});

test("manual compaction 的 transient control-read 重试成功后才调用 Provider", async () => {
  for (const error of [
    new InternalRpcNetworkError({ method: "POST", endpoint: "/messages" }),
    new InternalRpcTimeoutError({ method: "POST", endpoint: "/messages", timeoutMs: 1 }),
    new InternalRpcHttpError({ method: "POST", endpoint: "/messages", status: 500 }),
  ]) {
    let reads = 0;
    let providerCalls = 0;
    const terminalStatuses: string[] = [];
    class TestRunner extends AgentRunner {
      protected override async generateSingleCallSummary() { providerCalls += 1; return { text: "summary", totalTokens: null }; }
    }
    const runner = new TestRunner({
      async getExecutionProfile() { return createCompactionProfile(); },
      async getPromptContext() { return createProcessRunPromptContext(null, "message-head"); },
      async getMessagesContext() { if (reads++ === 0) throw error; return createMessagesContext(); },
      async commitCompaction() { return { result: "updated", summaryMessageId: "summary" }; },
      async completeRun(input: { status: string }) { terminalStatuses.push(input.status); },
      async updateRunNotice() { return { result: "updated" }; },
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { controlWriteSleep: async () => true });
    await (runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", runKind: "manual_compaction", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
    assert.equal(reads, 2);
    assert.equal(providerCalls, 1);
    assert.deepEqual(terminalStatuses, ["completed"]);
  }
});

test("control-read retry sleep 被取消时不调用 Provider 并收敛 cancelled", async () => {
  const controller = new AbortController();
  let providerCalls = 0;
  const terminalStatuses: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary() { providerCalls += 1; return { text: "summary", totalTokens: null }; }
  }
  const runner = new TestRunner({
    async getExecutionProfile() { return createCompactionProfile(); },
    async getPromptContext() { return createProcessRunPromptContext(null, "message-head"); },
    async getMessagesContext() { throw new InternalRpcNetworkError({ method: "POST", endpoint: "/messages" }); },
    async updateRunNotice() { return { result: "updated" }; },
    async completeRun(input: { status: string }) { terminalStatuses.push(input.status); },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { controlWriteSleep: async () => { controller.abort(); return false; } });
  await (runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", runKind: "manual_compaction", workspacePath: ".", workspaceRepoDirNames: [] }, controller.signal);
  assert.equal(providerCalls, 0);
  assert.deepEqual(terminalStatuses, ["cancelled"]);
});

function createContextLimitProcessRunner(input: {
  modelOutcomes: Array<"context-limit" | "success">;
  compactOutcomes?: Array<true | false | Error>;
  noticeOutcomes?: Array<"success" | Error>;
}) {
  const contexts = [
    createProcessRunPromptContext(null, "head-before"),
    createProcessRunPromptContext(null, "head-after-discard"),
    createProcessRunPromptContext(null, "head-after-compact-1"),
    createProcessRunPromptContext(null, "head-after-compact-2"),
  ];
  const promptHeads: Array<string | null> = [];
  const modelHeads: Array<string | null> = [];
  const compactHeads: Array<string | null> = [];
  const terminalStatuses: string[] = [];
  let noticeAttempts = 0;
  let promptIndex = 0;
  const runner = new AgentRunner({
    async getExecutionProfile() { return createCompactionProfile(); },
    async getPromptContext() {
      const context = contexts[Math.min(promptIndex, contexts.length - 1)]!;
      promptIndex += 1;
      promptHeads.push(context.headMessageId);
      return context;
    },
    async updateRunNotice() {
      noticeAttempts += 1;
      const outcome = input.noticeOutcomes?.shift() ?? "success";
      if (outcome instanceof Error) throw outcome;
      return { result: "updated" };
    },
    async completeRun(value: { status: string }) { terminalStatuses.push(value.status); },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { controlWriteSleep: async () => true });

  (runner as any).runModelStep = async ({ context }: { context: { headMessageId: string | null } }) => {
    modelHeads.push(context.headMessageId);
    const outcome = input.modelOutcomes.shift() ?? "success";
    if (outcome === "context-limit") throw new ModelContextLengthExceededError("assistant", new Error("context length exceeded"));
    return { aborted: false, toolCallCount: 0, hasVisibleText: true, assistantMessageId: "assistant" };
  };
  (runner as any).compactContext = async ({ context }: { context: { headMessageId: string | null } }) => {
    compactHeads.push(context.headMessageId);
    const outcome = input.compactOutcomes?.shift() ?? true;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };

  return { runner, promptHeads, modelHeads, compactHeads, terminalStatuses, noticeAttempts: () => noticeAttempts };
}

test("context-limit 由 processRun 外层压缩、重读 PromptContext 后成功", async () => {
  const fixture = createContextLimitProcessRunner({ modelOutcomes: ["context-limit", "success"] });
  await (fixture.runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.deepEqual(fixture.modelHeads, ["head-before", "head-after-compact-1"]);
  assert.deepEqual(fixture.compactHeads, ["head-after-discard"]);
  assert.deepEqual(fixture.terminalStatuses, ["completed"]);
});

test("context-limit compaction notice 的瞬时控制写失败会重试后继续压缩", async () => {
  const fixture = createContextLimitProcessRunner({
    modelOutcomes: ["context-limit", "success"],
    noticeOutcomes: [new InternalRpcNetworkError({ method: "POST", endpoint: "/run-notice" }), "success"],
  });
  await (fixture.runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.equal(fixture.noticeAttempts(), 2);
  assert.equal(fixture.compactHeads.length, 1);
  assert.deepEqual(fixture.terminalStatuses, ["completed"]);
});

test("永久控制错误 cause 含 input_too_long 时 processRun 不进入 compaction", async () => {
  const compactHeads: Array<string | null> = [];
  const terminalStatuses: string[] = [];
  const runner = new AgentRunner({
    async getExecutionProfile() { return createCompactionProfile(); },
    async getPromptContext() { return createProcessRunPromptContext(null, "head-before"); },
    async completeRun(value: { status: string }) { terminalStatuses.push(value.status); },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    throw new ControlWritePermanentError("flush assistant parts", Object.assign(
      new Error("input too long"),
      { code: "input_too_long" },
    ));
  };
  (runner as any).compactContext = async ({ context }: { context: { headMessageId: string | null } }) => {
    compactHeads.push(context.headMessageId);
    return true;
  };

  await (runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.deepEqual(compactHeads, []);
  assert.deepEqual(terminalStatuses, ["failed"]);
});

test("context-limit 重复超限最多执行两次外层压缩后失败", async () => {
  const fixture = createContextLimitProcessRunner({ modelOutcomes: ["context-limit", "context-limit", "context-limit"] });
  await (fixture.runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.equal(fixture.compactHeads.length, 2);
  assert.equal(fixture.modelHeads.length, 3);
  assert.deepEqual(fixture.terminalStatuses, ["failed"]);
});

test("context-limit compaction 无进展时有限失败", async () => {
  const fixture = createContextLimitProcessRunner({ modelOutcomes: ["context-limit"], compactOutcomes: [false] });
  await (fixture.runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.equal(fixture.compactHeads.length, 1);
  assert.deepEqual(fixture.terminalStatuses, ["failed"]);
});

test("context-limit compaction provider 失败时有限失败", async () => {
  const fixture = createContextLimitProcessRunner({ modelOutcomes: ["context-limit"], compactOutcomes: [new Error("compaction failed")] });
  await (fixture.runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.equal(fixture.compactHeads.length, 1);
  assert.deepEqual(fixture.terminalStatuses, ["failed"]);
});

test("empty compaction summary 作为 Provider 错误重试后完成", async () => {
  let summaries = 0;
  const terminalStatuses: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary() { summaries += 1; return { text: summaries === 1 ? "" : "summary", totalTokens: null }; }
  }
  const runner = new TestRunner({
    async getExecutionProfile() { return createCompactionProfile(); },
    async getPromptContext() { return createProcessRunPromptContext(null, "message-head"); },
    async getMessagesContext() { return createMessagesContext(); },
    async updateRunNotice() { return { result: "updated" }; },
    async commitCompaction() { return { result: "updated", summaryMessageId: "summary" }; },
    async completeRun(input: { status: string }) { terminalStatuses.push(input.status); },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { controlWriteSleep: async () => true });
  await (runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", runKind: "manual_compaction", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.equal(summaries, 2);
  assert.deepEqual(terminalStatuses, ["completed"]);
});

test("commit response-loss 重放同一个不可变 Compaction 请求并完成", async () => {
  const requests: any[] = [];
  const terminalStatuses: string[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary() { return { text: "summary", totalTokens: null }; }
  }
  const runner = new TestRunner({
    async getExecutionProfile() { return createCompactionProfile(); },
    async getPromptContext() { return createProcessRunPromptContext(null, "message-head"); },
    async getMessagesContext() { return createMessagesContext(); },
    async updateRunNotice() { return { result: "updated" }; },
    async commitCompaction(input: unknown) {
      requests.push(input);
      if (requests.length === 1) throw new InternalRpcNetworkError({ method: "POST", endpoint: "/compaction" });
      return { result: "updated", summaryMessageId: (input as { messageId: string }).messageId };
    },
    async completeRun(input: { status: string }) { terminalStatuses.push(input.status); },
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, { controlWriteSleep: async () => true, nowMs: () => 123 });
  await (runner as any).processRun({ workspaceId: "ws", sessionId: "sess", runId: "run", runKind: "manual_compaction", workspacePath: ".", workspaceRepoDirNames: [] }, new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(terminalStatuses, ["completed"]);
});

test("未消费 recovery continuation 时优先进入恢复模型步骤并跳过自动压缩", async () => {
  const controller = new AbortController();
  let compactCalls = 0;
  let resumedMessageId: string | null = null;
  const runner = new AgentRunner({
    async getExecutionProfile() { return createCompactionProfile({ candidate: null }); },
    async getPromptContext() { return createProcessRunPromptContext(110_000, "message-head"); },
    async completeRun() {},
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).compactContext = async () => { compactCalls += 1; return true; };
  (runner as any).runModelStep = async (params: { recoveryContinuation: { messageId: string | null } }) => {
    resumedMessageId = params.recoveryContinuation.messageId;
    controller.abort();
    return { toolCallNames: new Set<string>() };
  };

  await (runner as any).processRun({
    workspaceId: "ws",
    sessionId: "sess",
    runId: "run",
    workspacePath: ".",
    resumeAssistantMessageId: "assistant-recovery"
  }, controller.signal);

  assert.equal(resumedMessageId, "assistant-recovery");
  assert.equal(compactCalls, 0);
});

test("compactContext 在 Provider 重试退避期间响应用户取消", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const controller = new AbortController();
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
    controller.abort();
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    let summaryCalls = 0;
    class TestRunner extends AgentRunner {
      protected override async generateCompactionSummary(): Promise<string> {
        summaryCalls += 1;
        throw new Error("request failed: 400 invalid provider request");
      }
    }
    const runner = new TestRunner({ async updateRunNotice() {} } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).compactContext({
      profile: { runtime: {}, model: {}, provider: {} },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headMessageId: "message-head", sessionRevision: 0, uiLocale: "en-US" },
      signal: controller.signal
    });
    assert.equal(result, false);
    assert.equal(summaryCalls, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("generateCompactionSummary 为单次 Provider 调用固定 600 秒超时", async () => {
  let timeoutMs: number | null = null;
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      timeoutMs = params.input.timeoutMs;
      return { text: "summary", totalTokens: null };
    }
  }
  const runner = new TestRunner({
    async getMessagesContext() { return createMessagesContext(); }
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile({ candidate: null }),
    context: createCompactionContext(null),
    signal: AbortSignal.timeout(1_000)
  });
  assert.equal(timeoutMs, 600_000);
});

test("generateCompactionSummary 按 Message 边界分块且中间摘要不写入控制面", async () => {
  const callSizes: number[] = [];
  class TestRunner extends AgentRunner {
    protected override async generateSingleCallSummary(params: any) {
      const sourceCount = params.input.messages.length - 1;
      callSizes.push(sourceCount);
      if (sourceCount > 2) {
        const error = new Error("context length exceeded") as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }
      return { text: `summary-${sourceCount}`, totalTokens: null };
    }
  }
  const runner = new TestRunner({
    async getMessagesContext() {
      return {
        headMessageId: "message-head",
        system: "",
        messages: [
          { role: "user", content: "one" }, { role: "assistant", content: "two" },
          { role: "user", content: "three" }, { role: "assistant", content: "four" }
        ]
      };
    }
  } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const text = await (runner as any).generateCompactionSummary({
    profile: createCompactionProfile({ candidate: null }), context: createCompactionContext(null), signal: AbortSignal.timeout(1_000)
  });
  assert.deepEqual(callSizes, [4, 2, 2]);
  assert.equal(text, "summary-2\n\n---\n\nsummary-2");
});

test("超过八个 Compaction 输入块稳定失败，且不提交 Compaction Message", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    let commits = 0;
    class TestRunner extends AgentRunner {
      protected override async generateSingleCallSummary(params: any): Promise<{ text: string; totalTokens: number | null }> {
        if (params.input.messages.length <= 2) return { text: "leaf", totalTokens: null };
        const error = new Error("context length exceeded") as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }
    }
    const runner = new TestRunner({
      async getMessagesContext() {
        return { headMessageId: "message-head", system: "", messages: Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index) })) };
      },
      async commitCompaction() { commits += 1; return { result: "updated", summaryMessageId: "unexpected" }; },
      async updateRunNotice() { throw new Error("input limit must not enter Provider retry notice"); }
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    await assert.rejects(
      () => (runner as any).compactContext({
        profile: createCompactionProfile({ candidate: null }),
        run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
        context: { headMessageId: "message-head", sessionRevision: 0, uiLocale: "en-US" },
        signal: AbortSignal.timeout(1_000)
      }),
      /exceeds 8 Message blocks/
    );
    assert.equal(commits, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
