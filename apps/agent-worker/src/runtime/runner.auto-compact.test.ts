import test from "node:test";
import assert from "node:assert/strict";
import { AgentRunner, buildCompactionUserPrompt } from "./runner.js";

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
  assert.equal(fallback.includes("请基于当前会话内容输出一份结构化总结"), false);
});

test("compactContext 使用 PromptContext.uiLocale 生成压缩提示词", async () => {
  const runner = new AgentRunner(
    {
      async compactContext(input: { summaryText: string }) {
        return { compacted: true, summaryItemId: 1, archivedCount: 2 };
      },
      async updateRunState() {
        return;
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );
  const compactContext = (runner as any).compactContext.bind(runner) as (input: {
    profile: { provider: unknown; model: unknown };
    run: { workspaceId: string; sessionId: string; runId: string };
    context: { headItemId: number | null; system: string; messages: Array<{ role: string; content: string }>; uiLocale: "zh-CN" | "en-US" | null };
    signal: AbortSignal;
  }) => Promise<boolean>;

  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  (runner as any).generateCompactionSummary = async (input: {
    context: { messages: Array<{ role: string; content: string }>; uiLocale: "zh-CN" | "en-US" | null };
  }) => {
    const messages = [
      ...input.context.messages,
      { role: "user", content: buildCompactionUserPrompt({ uiLocale: input.context.uiLocale }) }
    ];
    calls.push({ messages });
    return "summary";
  };

  {
    const signal = new AbortController().signal;
    await compactContext({
      profile: { provider: {}, model: {} },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headItemId: 1, system: "sys", messages: [{ role: "user", content: "hello" }], uiLocale: "en-US" },
      signal
    });
    await compactContext({
      profile: { provider: {}, model: {} },
      run: { workspaceId: "ws", sessionId: "sess", runId: "run" },
      context: { headItemId: 1, system: "sys", messages: [{ role: "user", content: "hello" }], uiLocale: "zh-CN" },
      signal
    });
  }

  assert.equal(calls.length, 2);
  assert.ok(String(calls[0]?.messages.at(-1)?.content || "").includes("Please produce a structured summary of the current session"));
  assert.ok(String(calls[1]?.messages.at(-1)?.content || "").includes("请基于当前会话内容输出一份结构化总结"));
});
