import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import { streamText, type ModelMessage } from "ai";
import {
  applyOpenAiResponsesReplay,
  buildOpenAiResponsesProviderOptions,
  openAiResponsesTerminalStatus,
} from "./openai-responses-replay.js";

const profile = {
  provider: { id: "provider-a", npm: "@ai-sdk/openai" },
  model: { id: "internal-model", providerModelId: "gpt-5" },
};

const replayProvider = {
  npm: "@ai-sdk/openai" as const,
  api: "responses" as const,
  providerId: "provider-a",
  model: "gpt-5",
};

type ReplaySource = NonNullable<AgentApiPromptContextResponse["providerReplay"]>;

function completedSse() {
  const events = [
    { type: "response.created", response: { id: "resp-test", created_at: 1, model: "gpt-5" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-new", phase: "final_answer" } },
    { type: "response.output_text.delta", item_id: "msg-new", delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-new", phase: "final_answer" } },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, service_tier: null } },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function captureResponsesRequest(params: {
  messages: ModelMessage[];
  source?: ReplaySource;
  requestOptions?: unknown;
  replayProfile?: typeof profile;
  responseSse?: string;
}) {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | null = null;
  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    requestUrl = input instanceof Request ? input.url : String(input);
    if (typeof init?.body !== "string") throw new Error("expected JSON request body");
    requestBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(params.responseSse ?? completedSse(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const openai = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://example.invalid/v1",
    fetch: mockFetch,
  });
  const replayed = applyOpenAiResponsesReplay({
    profile: params.replayProfile ?? profile,
    messages: params.messages,
    source: params.source,
  });
  const result = streamText({
    model: openai.responses("gpt-5"),
    messages: replayed,
    providerOptions: {
      openai: buildOpenAiResponsesProviderOptions(params.requestOptions),
    },
    includeRawChunks: true,
  });
  const chunks: unknown[] = [];
  for await (const chunk of result.fullStream) {
    chunks.push(chunk);
    // 消费真实 AI SDK Responses SSE 流，确保请求转换与响应解析均执行。
  }
  assert.ok(requestBody);
  return { requestUrl, requestBody: requestBody as Record<string, unknown>, chunks };
}

function inputItems(body: Record<string, unknown>) {
  assert.ok(Array.isArray(body.input));
  return body.input as Array<Record<string, unknown>>;
}

test("真实 AI SDK：Assistant string 会携带 compatible reasoning/text replay 出站", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "question" },
    { role: "assistant", content: "plain answer" },
  ];
  const source: ReplaySource = [{
    assistantOrdinal: 1,
    parts: [
      {
        visibleIndex: 0,
        type: "reasoning",
        text: "summary",
        providerReplay: {
          version: 1,
          provider: replayProvider,
          item: { type: "reasoning", itemId: "rs-1", encryptedContent: "cipher-1", summaryIndex: 0 },
        },
      },
      {
        visibleIndex: 0,
        type: "text",
        providerReplay: {
          version: 1,
          provider: replayProvider,
          item: { type: "text", itemId: "msg-1", phase: "final_answer" },
        },
      },
    ],
  }];

  const { requestUrl, requestBody } = await captureResponsesRequest({
    messages,
    source,
    requestOptions: {
      include: ["message.output_text.logprobs"],
      store: true,
      previousResponseId: "resp-old",
      previous_response_id: "resp-snake",
      "previous-response-id": "resp-kebab",
      conversation: "conv-old",
      reasoningContext: "all_turns",
      reasoning_context: "current_turn",
      "reasoning-context": "current_turn",
      textVerbosity: "low",
    },
  });

  assert.equal(requestUrl, "https://example.invalid/v1/responses");
  assert.equal(requestBody.store, false);
  assert.deepEqual(requestBody.include, ["message.output_text.logprobs", "reasoning.encrypted_content"]);
  const textOptions = requestBody.text as Record<string, unknown> | undefined;
  assert.equal(textOptions?.verbosity, "low");
  for (const forbidden of [
    "previous_response_id", "previousResponseId", "previous-response-id",
    "conversation", "reasoningContext", "reasoning_context", "reasoning-context",
  ]) {
    assert.equal(Object.hasOwn(requestBody, forbidden), false, `unexpected ${forbidden}`);
  }
  assert.deepEqual(inputItems(requestBody), [
    { role: "user", content: [{ type: "input_text", text: "question" }] },
    { type: "reasoning", id: "rs-1", encrypted_content: "cipher-1", summary: [{ type: "summary_text", text: "summary" }] },
    { role: "assistant", content: [{ type: "output_text", text: "plain answer" }], id: "msg-1", phase: "final_answer" },
  ]);
});

test("真实 AI SDK：replay-only Assistant 序列化为单独 reasoning item", async () => {
  const source: ReplaySource = [{ assistantOrdinal: 1, parts: [{
    visibleIndex: 0,
    type: "reasoning",
    text: "",
    providerReplay: {
      version: 1,
      provider: replayProvider,
      item: { type: "reasoning", itemId: "rs-only", encryptedContent: "cipher-only" },
    },
  }] }];
  const { requestBody } = await captureResponsesRequest({
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: [] },
      { role: "user", content: "continue" },
    ],
    source,
  });
  assert.deepEqual(inputItems(requestBody), [
    { role: "user", content: [{ type: "input_text", text: "question" }] },
    { type: "reasoning", id: "rs-only", encrypted_content: "cipher-only", summary: [] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);
});

test("真实 AI SDK：聚合同 item 多 summary，并保持多 reasoning/function/output 顺序与身份", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "use tool" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { filePath: "README.md" } },
      ],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        output: { type: "text", value: "file contents" },
      }],
    },
  ];
  const source: ReplaySource = [{
    assistantOrdinal: 1,
    parts: [
      {
        visibleIndex: 0,
        type: "reasoning",
        text: "first summary",
        providerReplay: { version: 1, provider: replayProvider, item: { type: "reasoning", itemId: "rs-1", encryptedContent: "cipher-1", summaryIndex: 0 } },
      },
      {
        visibleIndex: 0,
        type: "reasoning",
        text: "second summary",
        providerReplay: { version: 1, provider: replayProvider, item: { type: "reasoning", itemId: "rs-1", encryptedContent: "cipher-1", summaryIndex: 1 } },
      },
      {
        visibleIndex: 0,
        type: "reasoning",
        text: "another item",
        providerReplay: { version: 1, provider: replayProvider, item: { type: "reasoning", itemId: "rs-2", encryptedContent: "cipher-2", summaryIndex: 0 } },
      },
      {
        visibleIndex: 0,
        type: "text",
        providerReplay: { version: 1, provider: replayProvider, item: { type: "text", itemId: "msg-1", phase: "commentary" } },
      },
      {
        visibleIndex: 1,
        type: "tool_call",
        providerReplay: { version: 1, provider: replayProvider, item: { type: "function_call", itemId: "fc-1" } },
      },
    ],
  }];

  const { requestBody } = await captureResponsesRequest({ messages, source });
  assert.deepEqual(inputItems(requestBody), [
    { role: "user", content: [{ type: "input_text", text: "use tool" }] },
    {
      type: "reasoning",
      id: "rs-1",
      encrypted_content: "cipher-1",
      summary: [
        { type: "summary_text", text: "first summary" },
        { type: "summary_text", text: "second summary" },
      ],
    },
    { type: "reasoning", id: "rs-2", encrypted_content: "cipher-2", summary: [{ type: "summary_text", text: "another item" }] },
    { role: "assistant", content: [{ type: "output_text", text: "calling" }], id: "msg-1", phase: "commentary" },
    { type: "function_call", call_id: "call-1", name: "read", arguments: JSON.stringify({ filePath: "README.md" }), id: "fc-1" },
    { type: "function_call_output", call_id: "call-1", output: "file contents" },
  ]);
});

test("真实 AI SDK：provider/model 不匹配时最终请求不含 replay metadata", async () => {
  const messages: ModelMessage[] = [{ role: "assistant", content: "plain answer" }];
  const source: ReplaySource = [{
    assistantOrdinal: 0,
    parts: [{
      visibleIndex: 0,
      type: "reasoning",
      text: "must not replay",
      providerReplay: {
        version: 1,
        provider: replayProvider,
        item: { type: "reasoning", itemId: "rs-secret", encryptedContent: "cipher-secret" },
      },
    }],
  }];

  for (const replayProfile of [
    { ...profile, provider: { ...profile.provider, id: "provider-b" } },
    { ...profile, model: { ...profile.model, providerModelId: "gpt-5-mini" } },
  ]) {
    const { requestBody } = await captureResponsesRequest({ messages, source, replayProfile });
    const serialized = JSON.stringify(requestBody);
    assert.equal(serialized.includes("rs-secret"), false);
    assert.equal(serialized.includes("cipher-secret"), false);
    assert.deepEqual(inputItems(requestBody), [
      { role: "assistant", content: [{ type: "output_text", text: "plain answer" }] },
    ]);
  }
});

test("真实 AI SDK：raw chunk 保留 completed/incomplete 原生终态，EOF 不伪造终态", async () => {
  const responseCreated = { type: "response.created", response: { id: "resp-terminal", created_at: 1, model: "gpt-5" } };
  const terminalCases = [
    {
      expected: "completed" as const,
      event: { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, service_tier: null } },
    },
    {
      expected: "incomplete" as const,
      event: {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 1, output_tokens: 1 },
          service_tier: null,
        },
      },
    },
    {
      expected: "failed" as const,
      event: { type: "response.failed", response: { error: { code: "server_error" } } },
    },
  ];

  for (const testCase of terminalCases) {
    const responseSse = [responseCreated, testCase.event]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const { chunks } = await captureResponsesRequest({
      messages: [{ role: "user", content: "terminal check" }],
      responseSse,
    });
    const rawTerminal = chunks
      .map((chunk) => chunk as { type?: string; rawValue?: unknown })
      .find((chunk) => chunk.type === "raw" && openAiResponsesTerminalStatus(chunk.rawValue) != null);
    assert.equal(openAiResponsesTerminalStatus(rawTerminal?.rawValue), testCase.expected);
  }

  const eof = await captureResponsesRequest({
    messages: [{ role: "user", content: "terminal check" }],
    responseSse: `data: ${JSON.stringify(responseCreated)}\n\n`,
  });
  assert.equal(eof.chunks.some((chunk) => {
    const candidate = chunk as { type?: string; rawValue?: unknown };
    return candidate.type === "raw" && openAiResponsesTerminalStatus(candidate.rawValue) != null;
  }), false);
});
