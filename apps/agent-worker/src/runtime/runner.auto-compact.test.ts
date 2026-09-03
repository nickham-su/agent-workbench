import test from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { AgentRunner, buildCompactionUserPrompt } from "./runner.js";
import { ApiConflictError } from "./apiClient.js";

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
    headItemId: 1,
    system: "Compaction system",
    messages: [{ role: "user", content: "Summarize this session." }]
  };
}

function createProcessRunPromptContext(lastResponseTotalTokens: number | null, headItemId: number) {
  return {
    pendingTools: [],
    tools: [],
    headItemId,
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
  const compactCalls: Array<{ expectedHeadItemId: number | null }> = [];
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
      async updateRunState() {},
      async getPromptContext() {
        promptContextCallCount += 1;
        return promptContextCallCount === 1
          ? createProcessRunPromptContext(110_000, 1)
          : createProcessRunPromptContext(null, 2);
      },
      async getMessagesContext() {
        return createMessagesContext();
      },
      async compactContext(input: { expectedHeadItemId: number | null }) {
        compactCalls.push({ expectedHeadItemId: input.expectedHeadItemId });
        controller.abort();
        return { compacted: true, summaryItemId: 2, archivedCount: 1 };
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
    /context length exceeded/
  );
  assert.deepEqual(calls, ["primary-provider/primary-model"]);
});

test("processRun 自动压缩真实入口使用候选模型", async () => {
  const result = await runProcessRunAutoCompactionTest({ candidateContextLimitError: false });

  assert.deepEqual(result.summaryCalls, ["compaction-provider/compaction-model"]);
  assert.deepEqual(result.compactCalls, [{ expectedHeadItemId: 1 }]);
  assert.deepEqual(result.terminalStatuses, ["cancelled"]);
});

test("processRun 自动压缩真实入口在候选超限时回退主模型", async () => {
  const result = await runProcessRunAutoCompactionTest({ candidateContextLimitError: true });

  assert.deepEqual(result.summaryCalls, [
    "compaction-provider/compaction-model",
    "primary-provider/primary-model"
  ]);
  assert.deepEqual(result.compactCalls, [{ expectedHeadItemId: 1 }]);
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
          headItemId: 1,
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
          headItemId: 1,
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

test("compactContext 在可恢复失败时按 modelRequestMaxRetries 重试", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let observedDelayMs: number | undefined;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    observedDelayMs = ms;
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    let compactCalls = 0;
    const runStateUpdates: Array<{ runNoticeText?: string }> = [];
    class TestRunner extends AgentRunner {
      protected override async generateCompactionSummary() {
        return "summary-ok";
      }
    }
    const runner = new TestRunner(
      {
        async compactContext() {
          compactCalls += 1;
          if (compactCalls === 1) {
            throw new Error("request failed: 500 upstream unavailable");
          }
          return { compacted: true, summaryItemId: 10, archivedCount: 4 };
        },
        async updateRunState(input: { runNoticeText?: string }) {
          runStateUpdates.push(input);
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );

    const result = await (runner as any).compactContext({
      profile: {
        runtime: { modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 2_000 },
        model: {},
        provider: {}
      },
      run: {
        workspaceId: "ws",
        sessionId: "sess",
        runId: "run"
      },
      context: {
        headItemId: 1,
        uiLocale: "zh-CN"
      },
      signal: AbortSignal.timeout(1_000)
    });

    assert.equal(result, true);
    assert.equal(compactCalls, 2);
    assert.equal(observedDelayMs, 2_000);
    assert.ok(runStateUpdates.some((it) => String(it.runNoticeText || "").includes("Compaction failed, retrying")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("compactContext 候选和主模型都上下文超限时不重复 candidate->primary 流程", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    const summaryCalls: string[] = [];
    class TestRunner extends AgentRunner {
      protected override async generateSingleCallSummary(params: any): Promise<{ text: string; totalTokens: number | null }> {
        const profile = `${params.profile.provider.id}/${params.profile.model.id}`;
        summaryCalls.push(profile);
        const error = new Error("context length exceeded") as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }
    }
    const runner = new TestRunner(
      { async getMessagesContext() { return createMessagesContext(); }, async updateRunState() {} } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );

    await assert.rejects(
      () => (runner as any).compactContext({
        profile: {
          ...createCompactionProfile(),
          runtime: { modelRequestMaxRetries: 3 }
        },
        run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
        context: { ...createCompactionContext(null), headItemId: 1 },
        signal: AbortSignal.timeout(1_000)
      }),
      /context length exceeded/
    );

    assert.deepEqual(summaryCalls, [
      "compaction-provider/compaction-model",
      "primary-provider/primary-model"
    ]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("compactContext 已重试后遇到 ApiConflictError 保留错误语义", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
  let compactCalls = 0;
  class TestRunner extends AgentRunner {
    protected override async generateCompactionSummary() {
      return "summary-ok";
    }
  }
  const runner = new TestRunner(
    {
      async compactContext() {
        compactCalls += 1;
        if (compactCalls === 1) throw new Error("request failed: 500 upstream unavailable");
        throw new ApiConflictError("context conflict");
      },
      async updateRunState() {}
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await assert.rejects(
    () =>
      (runner as any).compactContext({
        profile: {
          runtime: { modelRequestMaxRetries: 3 },
          model: {},
          provider: {}
        },
        run: {
          workspaceId: "ws",
          sessionId: "sess",
          runId: "run"
        },
        context: {
          headItemId: 1,
          uiLocale: "zh-CN"
        },
        signal: AbortSignal.timeout(1_000)
      }),
    ApiConflictError
  );
    assert.equal(compactCalls, 2);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("compactContext 首次遇到 ApiConflictError 不安排重试并立即向上抛出", async () => {
  let compactCalls = 0;
  class TestRunner extends AgentRunner {
    protected override async generateCompactionSummary() {
      return "summary-ok";
    }
  }
  const runner = new TestRunner(
    {
      async compactContext() {
        compactCalls += 1;
        throw new ApiConflictError("context conflict");
      },
      async updateRunState() {
        throw new Error("run state should not be updated for a conflict");
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  await assert.rejects(
    () => (runner as any).compactContext({
      profile: {
        runtime: { modelRequestMaxRetries: 3 },
        model: {},
        provider: {}
      },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headItemId: 1, uiLocale: "zh-CN" },
      signal: AbortSignal.timeout(1_000)
    }),
    ApiConflictError
  );
  assert.equal(compactCalls, 1);
});

test("compactContext 返回 compacted:false 时不重试并清理 notice", async () => {
  let compactCalls = 0;
  class TestRunner extends AgentRunner {
    protected override async generateCompactionSummary() {
      return "summary-ok";
    }
  }
  const runner = new TestRunner(
    {
      async compactContext() {
        compactCalls += 1;
        return { compacted: false, summaryItemId: null, archivedCount: 0 };
      },
      async updateRunState() {}
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  const result = await (runner as any).compactContext({
    profile: {
      runtime: { modelRequestMaxRetries: 3 },
      model: {},
      provider: {}
    },
    run: {
      workspaceId: "ws",
      sessionId: "sess",
      runId: "run"
    },
    context: {
      headItemId: 1,
      uiLocale: "zh-CN"
    },
    signal: AbortSignal.timeout(1_000)
  });

  assert.equal(result, false);
  assert.equal(compactCalls, 1);
});

test("compactContext 压缩成功后 updateRunState 失败不应触发重试", async () => {
  let compactCalls = 0;
  let runStateCalls = 0;
  class TestRunner extends AgentRunner {
    protected override async generateCompactionSummary() {
      return "summary-ok";
    }
  }
  const runner = new TestRunner(
    {
      async compactContext() {
        compactCalls += 1;
        return { compacted: true, summaryItemId: 8, archivedCount: 2 };
      },
      async updateRunState() {
        runStateCalls += 1;
        throw new Error("request failed: 500 update failed");
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  const result = await (runner as any).compactContext({
    profile: {
      runtime: { modelRequestMaxRetries: 3 },
      model: {},
      provider: {}
    },
    run: {
      workspaceId: "ws",
      sessionId: "sess",
      runId: "run"
    },
    context: {
      headItemId: 1,
      uiLocale: "zh-CN"
    },
    signal: AbortSignal.timeout(1_000)
  });

  assert.equal(result, true);
  assert.equal(compactCalls, 1);
  assert.equal(runStateCalls, 1);
});

test("compactContext 重试后 summary 为空会清理 retry notice", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;
  try {
    let summaryCalls = 0;
    const runStateUpdates: Array<{ runNoticeText?: string }> = [];
    class TestRunner extends AgentRunner {
      protected override async generateCompactionSummary() {
        summaryCalls += 1;
        if (summaryCalls === 1) {
          throw new Error("request failed: 500 summary unavailable");
        }
        return "";
      }
    }
    const runner = new TestRunner(
      {
        async compactContext() {
          throw new Error("compactContext should not be called when summary is empty");
        },
        async updateRunState(input: { runNoticeText?: string }) {
          runStateUpdates.push(input);
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );

    const result = await (runner as any).compactContext({
      profile: { runtime: { modelRequestMaxRetries: 1 }, model: {}, provider: {} },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headItemId: 1, uiLocale: "zh-CN" },
      signal: AbortSignal.timeout(1_000)
    });

    assert.equal(result, false);
    assert.ok(runStateUpdates.some((it) => String(it.runNoticeText || "").includes("Compaction failed, retrying")));
    assert.equal(runStateUpdates.at(-1)?.runNoticeText, "");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("compactContext 使用 Profile 的 120s 退避上限并在第六次重试等待 64000ms", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const observedDelays: number[] = [];
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (typeof ms === "number" && ms > 0) observedDelays.push(ms);
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    let compactCalls = 0;
    const runStateUpdates: Array<{ runNoticeText?: string }> = [];
    class TestRunner extends AgentRunner {
      protected override async generateCompactionSummary() {
        return "summary-ok";
      }
    }
    const runner = new TestRunner(
      {
        async compactContext() {
          compactCalls += 1;
          if (compactCalls <= 6) throw new Error("request failed: 500 upstream unavailable");
          return { compacted: true, summaryItemId: 10, archivedCount: 4 };
        },
        async updateRunState(input: { runNoticeText?: string }) {
          runStateUpdates.push(input);
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );

    const result = await (runner as any).compactContext({
      profile: {
        runtime: { modelRequestMaxRetries: 6, modelRequestRetryBackoffMaxMs: 120_000 },
        model: {},
        provider: {}
      },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headItemId: 1, uiLocale: "zh-CN" },
      signal: AbortSignal.timeout(1_000)
    });

    assert.equal(result, true);
    assert.equal(compactCalls, 7);
    assert.deepEqual(observedDelays.slice(-6), [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
    assert.ok(runStateUpdates.some((update) => String(update.runNoticeText || "").includes("64s")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
