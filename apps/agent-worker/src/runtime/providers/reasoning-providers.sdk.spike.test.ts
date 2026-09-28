import assert from "node:assert/strict";
import test from "node:test";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { jsonSchema, streamText, type ModelMessage } from "ai";

// A contract test for the installed SDK versions, not evidence that an official endpoint accepts these models.
type Provider = "moonshotai" | "deepseek";
type Chunk = Record<string, unknown>;
const toolCallId = "call-spike-1";
const history: ModelMessage[] = [
  { role: "user", content: "calculate" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "think first" },
      { type: "text", text: "running tool" },
      { type: "tool-call", toolCallId, toolName: "echo", input: { value: "hello" } },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "echo", output: { type: "text", value: "hello" } }] },
];

function sse(chunks: Chunk[]) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function chatChunk(model: string, delta: Chunk, finishReason: string | null = null): Chunk {
  return {
    id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function capture(params: {
  provider: Provider;
  model: string;
  messages?: ModelMessage[];
  options: Record<string, string | { type: string }>;
  chunks?: Chunk[];
  withTool?: boolean;
}) {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requestUrl = input instanceof Request ? input.url : String(input);
    const rawBody = init?.body;
    assert.equal(typeof rawBody, "string");
    requestBody = JSON.parse(rawBody as string) as Record<string, unknown>;
    return new Response(sse(params.chunks ?? [
      chatChunk(params.model, { reasoning_content: "new thought" }),
      chatChunk(params.model, { content: "done" }),
      chatChunk(params.model, {}, "stop"),
      { id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model: params.model,
        choices: [], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } },
    ]), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const model = params.provider === "moonshotai"
    ? createMoonshotAI({ apiKey: "fixture-only", fetch }).chatModel(params.model)
    : createDeepSeek({ apiKey: "fixture-only", fetch }).chat(params.model);
  const result = streamText({
    model,
    messages: params.messages ?? history,
    providerOptions: { [params.provider]: params.options },
    ...(params.withTool ? { tools: { echo: { inputSchema: jsonSchema({
      type: "object", properties: { value: { type: "string" } }, required: ["value"],
    }) } } } : {}),
  });
  const chunks: Array<Record<string, unknown>> = [];
  for await (const chunk of result.fullStream) {
    chunks.push(chunk as Record<string, unknown>);
  }
  assert.ok(requestBody, "SDK did not make a request");
  return { requestUrl, requestBody, chunks, usage: await result.usage, warnings: await result.warnings };
}

function assistant(body: Record<string, unknown>) {
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(messages));
  const message = messages.find((item) => item.role === "assistant");
  assert.ok(message);
  return message;
}

for (const model of ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
  test(`Moonshot SDK ${model}: fixed thinking and historical reasoning/tool call`, async () => {
    const result = await capture({ provider: "moonshotai", model, options: {
      thinking: { type: "enabled" }, reasoningHistory: "preserved",
    }, withTool: true });
    assert.equal(result.requestUrl, "https://api.moonshot.ai/v1/chat/completions");
    assert.equal(result.requestBody.model, model);
    assert.deepEqual(result.requestBody.thinking, model === "kimi-k2.6"
      ? { type: "enabled", keep: "all" }
      : { type: "enabled" });
    assert.equal(assistant(result.requestBody).reasoning_content, "think first");
    assert.equal((assistant(result.requestBody).tool_calls as Array<Record<string, unknown>>)[0]?.id, toolCallId);
    const toolResult = (result.requestBody.messages as Array<Record<string, unknown>>).find((item) => item.role === "tool");
    assert.equal(toolResult?.tool_call_id, toolCallId);
    assert.ok(result.chunks.some((chunk) => chunk.type === "reasoning-delta"));
    assert.ok(result.chunks.some((chunk) => chunk.type === "text-delta"));
    assert.equal(result.usage.inputTokens, 6);
    assert.equal(result.usage.outputTokens, 4);
  });
}

for (const model of ["moonshot-v1-8k", "moonshot-v1-32k"]) {
  test(`Moonshot SDK ${model}: unsupported thinking is omitted without blocking the request`, async () => {
    const result = await capture({ provider: "moonshotai", model,
      options: { thinking: { type: "enabled" }, reasoningHistory: "preserved" },
      messages: [{ role: "user", content: "hello" }],
      chunks: [chatChunk(model, { content: "done" }), chatChunk(model, {}, "stop")],
    });
    assert.equal(result.requestUrl, "https://api.moonshot.ai/v1/chat/completions");
    assert.equal(result.requestBody.model, model);
    assert.equal(Object.hasOwn(result.requestBody, "thinking"), false);
    assert.equal(Object.hasOwn(result.requestBody, "reasoningHistory"), false);
    assert.deepEqual((result.requestBody.messages as Array<Record<string, unknown>>).map((message) => message.role), ["user"]);
    assert.ok(result.warnings?.some((warning) => warning.type === "unsupported-setting" &&
      warning.details?.includes("moonshotai.thinking")));
    assert.ok(result.warnings?.some((warning) => warning.type === "unsupported-setting" &&
      warning.details?.includes("moonshotai.reasoningHistory")));
    assert.ok(result.chunks.some((chunk) => chunk.type === "text-delta"));
    assert.equal(result.chunks.some((chunk) => chunk.type === "reasoning-delta"), false);
  });
}

for (const model of ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"]) {
  test(`DeepSeek SDK ${model}: thinking and history serializer`, async () => {
    const result = await capture({ provider: "deepseek", model, options: { thinking: { type: "enabled" } }, withTool: true });
    assert.equal(result.requestUrl, "https://api.deepseek.com/chat/completions");
    assert.deepEqual(result.requestBody.thinking, { type: "enabled" });
    assert.equal(assistant(result.requestBody).reasoning_content, "think first");
    assert.equal((assistant(result.requestBody).tool_calls as Array<Record<string, unknown>>)[0]?.id, toolCallId);
    assert.ok(result.chunks.some((chunk) => chunk.type === "reasoning-delta"));
    assert.equal(result.usage.inputTokens, 6);
    assert.equal(result.usage.outputTokens, 4);
  });
}

test("DeepSeek V4 retains prior-turn reasoning; older model drops it", async () => {
  for (const model of ["deepseek-v4-pro", "deepseek-chat"]) {
    const result = await capture({ provider: "deepseek", model, options: {
      thinking: { type: "enabled" },
    }, messages: [...history, { role: "user", content: "next turn" }] });
    assert.equal(assistant(result.requestBody).reasoning_content,
      model === "deepseek-v4-pro" ? "think first" : undefined);
  }
});

test("DeepSeek V4 retains multi-step reasoning for assistant tool continuation", async () => {
  const secondId = "call-spike-2";
  const messages: ModelMessage[] = [
    ...history,
    { role: "assistant", content: [
      { type: "reasoning", text: "second thought" },
      { type: "tool-call", toolCallId: secondId, toolName: "echo", input: { value: "again" } },
    ] },
    { role: "tool", content: [
      { type: "tool-result", toolCallId: secondId, toolName: "echo", output: { type: "text", value: "again" } },
    ] },
  ];
  const result = await capture({ provider: "deepseek", model: "deepseek-v4-pro", messages, options: {
    thinking: { type: "enabled" },
  }, withTool: true });
  const assistantMessages = (result.requestBody.messages as Array<Record<string, unknown>>)
    .filter((item) => item.role === "assistant");
  assert.deepEqual(assistantMessages.map((item) => item.reasoning_content), ["think first", "second thought"]);
  assert.deepEqual(assistantMessages.map((item) => (item.tool_calls as Array<Record<string, unknown>>)[0]?.id),
    [toolCallId, secondId]);
  assert.deepEqual((result.requestBody.messages as Array<Record<string, unknown>>)
    .filter((item) => item.role === "tool").map((item) => item.tool_call_id), [toolCallId, secondId]);
});

test("DeepSeek streaming reasoning, text, tools and usage", async () => {
  const model = "deepseek-v4-pro";
  const result = await capture({ provider: "deepseek", model, options: { thinking: { type: "enabled" } }, withTool: true,
    chunks: [
      chatChunk(model, { reasoning_content: "thought" }),
      chatChunk(model, { tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: "echo", arguments: '{"value":' } }] }),
      chatChunk(model, { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }),
      chatChunk(model, {}, "tool_calls"),
      { id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model, choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12, prompt_cache_hit_tokens: 2 } },
    ],
  });
  assert.ok(result.chunks.some((chunk) => chunk.type === "reasoning-delta"));
  assert.ok(result.chunks.some((chunk) => chunk.type === "tool-call" && chunk.toolCallId === toolCallId));
  assert.equal(result.usage.inputTokens, 9);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.usage.cachedInputTokens, 2);
});

test("Moonshot streaming reasoning, text, tools and usage", async () => {
  const model = "kimi-k2.6";
  const result = await capture({ provider: "moonshotai", model,
    options: { thinking: { type: "enabled" }, reasoningHistory: "preserved" }, withTool: true,
    chunks: [
      chatChunk(model, { reasoning_content: "thought" }),
      chatChunk(model, { content: "working" }),
      chatChunk(model, { tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: "echo", arguments: '{"value":' } }] }),
      chatChunk(model, { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }),
      chatChunk(model, {}, "tool_calls"),
      { id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model,
        choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } },
    ],
  });
  assert.ok(result.chunks.some((chunk) => chunk.type === "reasoning-delta"));
  assert.ok(result.chunks.some((chunk) => chunk.type === "text-delta"));
  assert.ok(result.chunks.some((chunk) => chunk.type === "tool-call" && chunk.toolCallId === toolCallId));
  assert.equal(result.usage.inputTokens, 9);
  assert.equal(result.usage.outputTokens, 3);
});

test("DeepSeek V4 serializes empty reasoning for an assistant without a reasoning part", async () => {
  const model = "deepseek-v4-pro";
  const result = await capture({ provider: "deepseek", model,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "again" },
    ],
    options: { thinking: { type: "enabled" } },
  });
  assert.equal(assistant(result.requestBody).reasoning_content, "");
});

for (const provider of ["moonshotai", "deepseek"] as const) {
  test(`${provider}: adjacent reasoning parts and post-text reasoning streaming`, async () => {
    const model = provider === "moonshotai" ? "kimi-k2.6" : "deepseek-v4-pro";
    const result = await capture({ provider, model,
      options: provider === "moonshotai"
        ? { thinking: { type: "enabled" }, reasoningHistory: "preserved" }
        : { thinking: { type: "enabled" } },
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: [
        { type: "reasoning", text: "one" }, { type: "reasoning", text: "two" }, { type: "text", text: "response" },
      ] }, { role: "user", content: "next" }],
      chunks: [chatChunk(model, { reasoning_content: "one" }), chatChunk(model, { content: "response" }),
        chatChunk(model, { reasoning_content: "two" }), chatChunk(model, {}, "stop")],
    });
    assert.equal(assistant(result.requestBody).reasoning_content, "onetwo");
    assert.deepEqual(result.chunks.filter((chunk) => chunk.type === "reasoning-delta")
      .map((chunk) => chunk.text), ["one", "two"]);
    // Moonshot keeps one reasoning segment across text; DeepSeek closes/reopens it.
    // Both SDKs reuse "reasoning-0"; the Runner must not assume ids are unique per block.
    const segments = provider === "moonshotai" ? 1 : 2;
    assert.equal(result.chunks.filter((chunk) => chunk.type === "reasoning-start").length, segments);
    assert.equal(result.chunks.filter((chunk) => chunk.type === "reasoning-end").length, segments);
  });
}

for (const provider of ["moonshotai", "deepseek"] as const) {
  for (const reasoning of ["", null] as const) {
    test(`${provider}: ${reasoning === null ? "absent" : "empty"} reasoning is not invented`, async () => {
      const model = provider === "moonshotai" ? "kimi-k2.6" : "deepseek-v4-pro";
      const delta = reasoning === null ? { content: "ok" } : { reasoning_content: "", content: "ok" };
      const result = await capture({ provider, model, options: provider === "moonshotai"
        ? { thinking: { type: "enabled" }, reasoningHistory: "preserved" }
        : { thinking: { type: "enabled" } }, messages: [{ role: "user", content: "hello" }],
      chunks: [chatChunk(model, delta), chatChunk(model, {}, "stop")], });
      assert.equal(result.chunks.filter((chunk) => chunk.type === "reasoning-delta").length, 0);
      assert.ok(result.chunks.some((chunk) => chunk.type === "text-delta"));
    });
  }
}
