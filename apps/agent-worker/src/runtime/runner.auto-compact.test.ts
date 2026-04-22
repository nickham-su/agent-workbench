import test from "node:test";
import assert from "node:assert/strict";
import { AgentRunner, buildCompactionUserPrompt } from "./runner.js";
import { ApiConflictError } from "./apiClient.js";

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
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
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
        runtime: { modelRequestMaxRetries: 1 },
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
    assert.ok(runStateUpdates.some((it) => String(it.runNoticeText || "").includes("Compaction failed, retrying")));
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
