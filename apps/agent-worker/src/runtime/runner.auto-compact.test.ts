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
  assert.ok(zh.includes("若上下文包含与工作目标相关的文档,请在总结中列出文档路径"));
  assert.ok(en.includes("if the context includes documents relevant to the work goal, list their document paths in the summary"));
  assert.equal(fallback.includes("请基于当前会话内容输出一份结构化总结"), false);
});

test("generateCompactionSummary 使用 messages-context 追加压缩提示词", async () => {
  const runner = new AgentRunner(
    {
      async getMessagesContext(input: { appendMessage?: { role: string; content: string } }) {
        return {
          headItemId: 1,
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
