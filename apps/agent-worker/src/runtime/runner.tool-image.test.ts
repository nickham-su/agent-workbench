import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText, type LanguageModel, type ModelMessage } from "ai";
import type { streamText as streamTextType } from "ai";
import type { AgentApiPromptContextResponse } from "@agent-workbench/shared/internal-contracts/agent-api";
import type { ExecutionProfile } from "./apiClient.js";
import { AgentRunner, materializePromptAttachments, projectAssistantDebugRecordForTest } from "./runner.js";
import { chatEndpointDigest } from "./providers/conversation-state/endpoint-identity.js";

const missingImageText = "此前已成功查看该图片，但源文件当前不存在，无法再次加载。";
const outsideWindowText = "图片已超出加载范围，如需查看请重新调用 view_image。";
const oversizedImageText = "图片超过大小限制，本轮未加载。";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x45]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0x45]);
const assistant = { role: "assistant" as const, content: [
  { type: "tool-call" as const, toolCallId: "call-a", toolName: "view_image", input: { path: "screens/a.png" } },
  { type: "tool-call" as const, toolCallId: "call-b", toolName: "view_image", input: { path: "screens/b.jpg" } },
] };
const toolResults = { role: "tool" as const, content: [
  { type: "tool-result" as const, toolCallId: "call-a", toolName: "view_image", output: { type: "image_ref" as const, path: "screens/a.png" } },
  { type: "tool-result" as const, toolCallId: "call-b", toolName: "view_image", output: { type: "image_ref" as const, path: "screens/b.jpg" } },
] };

type Input = Parameters<typeof materializePromptAttachments>[0];
async function withImages(run: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(path.join(process.cwd(), "apps/agent-worker/.image-projection-test-"));
  try {
    await fs.mkdir(path.join(workspacePath, "screens"));
    await fs.writeFile(path.join(workspacePath, "screens/a.png"), png);
    await fs.writeFile(path.join(workspacePath, "screens/b.jpg"), jpg);
    await run(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}
const prepare = (workspacePath: string, providerNpm: string, messages: Input["messages"]) =>
  materializePromptAttachments({ messages, providerNpm, run: { workspaceId: "ws", workspacePath }, attachmentStorage: undefined });

// All four input roles count, including a text-only tool exchange.
const nineLaterMessages: Input["messages"] = [
  { role: "system", content: "system 1" },
  { role: "user", content: "user 1" },
  { role: "assistant", content: "assistant 1" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "later", toolName: "bash", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "later", toolName: "bash", output: { type: "text", value: "ok" } }] },
  { role: "system", content: "system 2" },
  { role: "user", content: "user 2" },
  { role: "assistant", content: "assistant 2" },
  { role: "system", content: "system 3" },
];

for (const providerNpm of ["@ai-sdk/openai", "@ai-sdk/deepseek"]) {
  const native = providerNpm === "@ai-sdk/openai";
  test(`${providerNpm}: the image tool message at position 10 loads, position 11 becomes text`, async () => withImages(async (workspacePath) => {
    for (const outside of [false, true]) {
      const input = [assistant, toolResults, ...nineLaterMessages,
        ...(outside ? [{ role: "system", content: "one more" } as const] : [])] as Input["messages"];
      const original = JSON.stringify(input);
      const messages = await prepare(workspacePath, providerNpm, input);
      const results = (messages[1] as Extract<ModelMessage, { role: "tool" }>).content;
      assert.deepEqual(results.map((result) => result.toolCallId), ["call-a", "call-b"]);
      if (outside) {
        const expected = native ? { type: "content", value: [{ type: "text", text: outsideWindowText }] }
          : { type: "text", value: outsideWindowText };
        assert.ok(results.every((result) => JSON.stringify(result.output) === JSON.stringify(expected)));
        assert.equal(messages.length, input.length, "no empty image carrier");
      } else {
        // Its Assistant is already outside, but the Tool itself is the tenth message.
        if (native) assert.ok(results.every((result) => result.output.type === "content" && result.output.value[0]?.type === "media"));
        else {
          const carrier = messages[2] as Extract<ModelMessage, { role: "user" }>;
          assert.ok(Array.isArray(carrier.content));
          assert.deepEqual(carrier.content.map((part) => part.type), ["text", "file", "text", "file"]);
        }
      }
      assert.equal(JSON.stringify(input), original);
    }
  }));

  test(`${providerNpm}: out-of-window images skip file access but keep validation and neighboring text`, async (t) => withImages(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "screens/a.png"), "invalid image");
    await fs.rm(path.join(workspacePath, "screens/b.jpg"));
    const input = [assistant, { ...toolResults, content: [
      { ...toolResults.content[0]!, output: [{ type: "text", value: "before" }, toolResults.content[0]!.output, { type: "text", value: "after" }] },
      toolResults.content[1]!,
    ] }, ...nineLaterMessages, { role: "system", content: "one more" }] as Input["messages"];
    const original = JSON.stringify(input);
    const mocked = t.mock.method(fs, "open", async () => { throw new Error("out-of-window image must not be opened"); });
    const messages = await prepare(workspacePath, providerNpm, input);
    assert.equal(mocked.mock.callCount(), 0);
    const result = (messages[1] as Extract<ModelMessage, { role: "tool" }>).content[0]!;
    assert.deepEqual(result.output, native
      ? { type: "content", value: ["before", outsideWindowText, "after"].map((text) => ({ type: "text", text })) }
      : { type: "text", value: ["before", outsideWindowText, "after"].join("\n") });
    assert.equal(messages.length, input.length);
    assert.equal(JSON.stringify(input), original);
    const forged = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "forged", toolName: "bash", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "forged", toolName: "bash", output: { type: "image_ref", path: "screens/a.png" } }] },
      ...nineLaterMessages, { role: "system", content: "one more" },
    ] as Input["messages"];
    await assert.rejects(prepare(workspacePath, providerNpm, forged), /unexpected tool image reference/);
    const mismatched = [assistant, { ...toolResults, content: [...toolResults.content].reverse() }, ...nineLaterMessages,
      { role: "system", content: "one more" }] as Input["messages"];
    await assert.rejects(prepare(workspacePath, providerNpm, mismatched), /call order/);
    const invalid = structuredClone(input);
    (invalid[1] as any).content[0].output = { type: "image_ref", path: 123 };
    await assert.rejects(prepare(workspacePath, providerNpm, invalid), /invalid tool result output/);
  }));

  test(`${providerNpm}: historical oversized image becomes text alongside a surviving image`, async () => withImages(async (workspacePath) => {
    const input = [assistant, toolResults] as Input["messages"];
    await prepare(workspacePath, providerNpm, input);
    await fs.truncate(path.join(workspacePath, "screens/a.png"), 10 * 1024 * 1024 + 1);
    const messages = await prepare(workspacePath, providerNpm, input);
    const results = (messages[1] as Extract<ModelMessage, { role: "tool" }>).content;
    assert.deepEqual(results[0]!.output, native
      ? { type: "content", value: [{ type: "text", text: oversizedImageText }] }
      : { type: "text", value: oversizedImageText });
    assert.deepEqual(results.map((result) => result.toolCallId), ["call-a", "call-b"]);
    if (native) assert.ok(results[1]!.output.type === "content" && results[1]!.output.value[0]?.type === "media");
    else {
      const carrier = messages[2] as Extract<ModelMessage, { role: "user" }>;
      assert.ok(Array.isArray(carrier.content));
      assert.deepEqual(carrier.content.map((part) => part.type), ["text", "file"]);
      assert.ok(carrier.content[1]?.type === "file" && carrier.content[1].filename === "b.jpg");
    }
  }));
}

test("deferred image carrier messages do not shrink the ten-input-message window", async () => withImages(async (workspacePath) => {
  const input = [assistant, toolResults, assistant, toolResults,
    ...Array.from({ length: 7 }, (_, i) => ({ role: "system" as const, content: `system ${i}` }))] as Input["messages"];
  const original = JSON.stringify(input);
  const messages = await prepare(workspacePath, "@ai-sdk/deepseek", input);
  assert.equal(input.length, 11);
  assert.equal(messages.length, 13);
  // The first Tool is tenth in the input, but twelfth after both carriers are added.
  for (const index of [2, 5]) {
    const carrier = messages[index] as Extract<ModelMessage, { role: "user" }>;
    assert.equal(carrier.role, "user");
    assert.ok(Array.isArray(carrier.content));
    assert.deepEqual(carrier.content.map((part) => part.type), ["text", "file", "text", "file"]);
  }
  assert.equal(JSON.stringify(input), original);
}));

test("user attachments outside the tool-image window still load and keep single-image validation", async () => {
  const input = [{ role: "user", content: [{ type: "attachment_ref", workspaceId: "ws", attachmentId: "att_1",
    path: ".awb/agent/attachments/att_1.png", mediaType: "image/png", filename: "original.png" }] },
    ...Array.from({ length: 10 }, () => ({ role: "system", content: "later" }))] as Input["messages"];
  let calls = 0;
  const prepareAttachment = (bytes: Uint8Array) => materializePromptAttachments({ messages: input,
    providerNpm: "@ai-sdk/deepseek", run: { workspaceId: "ws", workspacePath: process.cwd() },
    attachmentStorage: { async read() { calls += 1; return { bytes, mediaType: "image/png" }; } },
  });
  const messages = await prepareAttachment(png);
  assert.equal(calls, 1);
  const user = messages[0] as Extract<ModelMessage, { role: "user" }>;
  assert.ok(Array.isArray(user.content) && user.content[0]?.type === "file");
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
    await assert.rejects(prepareAttachment(bytes), /10 MiB per-image budget/);
  }
});

test("text-only tool result arrays become SDK content without reading an image", async () => {
  const messages: Input["messages"] = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "text-call", toolName: "view_image", input: { path: "missing.png" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "text-call", toolName: "view_image",
      output: [{ type: "text", value: "first" }, { type: "text", value: "second" }] }] }
  ];
  const projected = await prepare("/unused-workspace", "@ai-sdk/openai", messages);
  assert.deepEqual((projected[1] as Extract<ModelMessage, { role: "tool" }>).content[0]?.output, {
    type: "content", value: [{ type: "text", text: "first" }, { type: "text", text: "second" }]
  });
  assert.equal(projected.length, 2);
  for (const native of [true, false]) {
    let body: string | null = null;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      body = String(init?.body);
      return new Response("fixture response", { status: 400 });
    };
    const model = native ? createOpenAI({ apiKey: "fixture", fetch }).responses("gpt-4o")
      : createOpenAICompatible({ name: "fixture", baseURL: "https://example.invalid/v1", apiKey: "fixture", fetch }).chatModel("image-model");
    const stream = streamText({ model, messages: projected, maxRetries: 0, onError() { /* mocked request */ } });
    try { for await (const _part of stream.fullStream) { /* SDK request */ } } catch { /* fixture returns 400 */ }
    assert.ok(body, "the SDK must serialize a text-only tool array");
    assert.match(body, /first/);
    assert.match(body, /second/);
  }
});

for (const providerNpm of ["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible", "@ai-sdk/moonshotai", "@ai-sdk/deepseek"]) {
  test(`${providerNpm}: two ordered tool images serialize without base64 in debug record`, async () => withImages(async (workspacePath) => {
    const messages = await prepare(workspacePath, providerNpm, [
      { role: "user", content: "look" }, assistant, toolResults,
    ] as Input["messages"]);
    const debug = JSON.stringify(projectAssistantDebugRecordForTest({ status: "running", request: { messages } }));
    assert.doesNotMatch(debug, /iVBOR|\/9j\/|137,80,78,71/);
    const native = providerNpm === "@ai-sdk/openai" || providerNpm === "@ai-sdk/anthropic";
    assert.equal(messages.length, native ? 3 : 4);
    const results = (messages[2] as Extract<ModelMessage, { role: "tool" }>).content;
    assert.deepEqual(results.map((item) => item.toolCallId), ["call-a", "call-b"]);
    if (native) {
      for (const result of results) {
        assert.equal(result.output.type, "content");
        if (result.output.type === "content") assert.equal(result.output.value[0]?.type, "media");
      }
    } else {
      for (const result of results) assert.equal(result.output.type, "text");
      const appended = messages[3] as Extract<ModelMessage, { role: "user" }>;
      assert.equal(appended.role, "user");
      assert.ok(Array.isArray(appended.content));
      if (Array.isArray(appended.content)) assert.deepEqual(appended.content.map((part) => part.type), ["text", "file", "text", "file"]);
    }
    let body: Record<string, unknown> | null = null;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("invalid fixture response", { status: 400, headers: { "content-type": "text/plain" } });
    };
    const model: LanguageModel = providerNpm === "@ai-sdk/openai"
      ? createOpenAI({ apiKey: "fixture", fetch }).responses("gpt-4o")
      : providerNpm === "@ai-sdk/anthropic"
        ? createAnthropic({ apiKey: "fixture", fetch })("claude-sonnet-4-5")
        : providerNpm === "@ai-sdk/openai-compatible"
          ? createOpenAICompatible({ name: "fixture", baseURL: "https://example.invalid/v1", apiKey: "fixture", fetch }).chatModel("image-model")
          : providerNpm === "@ai-sdk/moonshotai"
            ? createMoonshotAI({ apiKey: "fixture", fetch }).chatModel("kimi-k2.6")
            : createDeepSeek({ apiKey: "fixture", fetch }).chat("deepseek-chat");
    const stream = streamText({ model, messages, maxRetries: 0, onError() { /* mocked response intentionally fails */ } });
    try { for await (const _part of stream.fullStream) { /* trigger SDK serialization */ } } catch { /* fixture returns 400 */ }
    assert.ok(body, "the real SDK must serialize the request");
    const serialized = JSON.stringify(body);
    if (native) {
      if (providerNpm === "@ai-sdk/openai") assert.equal((body as Record<string, unknown>).input instanceof Array, true);
      assert.match(serialized, providerNpm === "@ai-sdk/openai" ? /input_image/ : /"type":"image"/);
      assert.match(serialized, /call-a/);
      assert.match(serialized, /call-b/);
    } else {
      const wire = (body as Record<string, unknown>).messages as Array<{ role: string; content: unknown }>;
      assert.deepEqual(wire.map((item) => item.role), ["user", "assistant", "tool", "tool", "user"]);
      assert.deepEqual((wire[4]?.content as Array<{ type: string }>).map((part) => part.type), ["text", "image_url", "text", "image_url"]);
      assert.ok(wire.slice(2, 4).every((item) => typeof item.content === "string" && !String(item.content).includes("data:image/")));
      assert.match(serialized, /call-a.*screens\/a\.png/);
      assert.match(serialized, /call-b.*screens\/b\.jpg/);
    }
  }));
}

for (const providerNpm of ["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible", "@ai-sdk/moonshotai", "@ai-sdk/deepseek"]) {
  for (const removed of ["file", "directory"] as const) {
    test(`${providerNpm}: missing historical image ${removed} becomes tool text`, async () => withImages(async (workspacePath) => {
      const input = [assistant, toolResults] as Input["messages"];
      const original = JSON.stringify(input);
      await prepare(workspacePath, providerNpm, input);
      await fs.rm(path.join(workspacePath, removed === "file" ? "screens/a.png" : "screens"), { recursive: true });
      const messages = await prepare(workspacePath, providerNpm, input);
      const native = providerNpm === "@ai-sdk/openai" || providerNpm === "@ai-sdk/anthropic";
      const results = (messages[1] as Extract<ModelMessage, { role: "tool" }>).content;
      assert.deepEqual(results.map((result) => result.toolCallId), ["call-a", "call-b"]);
      const placeholder = native ? { type: "content", value: [{ type: "text", text: missingImageText }] }
        : { type: "text", value: missingImageText };
      assert.deepEqual(results[0]?.output, placeholder);
      if (removed === "directory") {
        assert.deepEqual(results[1]?.output, placeholder);
        assert.equal(messages.length, 2, "no synthetic user message without a surviving image");
      } else if (native) {
        assert.equal(messages.length, 2);
        const output = results[1]!.output;
        assert.ok(output.type === "content" && output.value[0]?.type === "media");
      } else {
        assert.equal(messages.length, 3);
        const content = (messages[2] as Extract<ModelMessage, { role: "user" }>).content;
        assert.ok(Array.isArray(content));
        assert.deepEqual(content.map((part) => part.type), ["text", "file"]);
        assert.ok(content[1]?.type === "file" && content[1].filename === "b.jpg");
      }
      assert.equal(JSON.stringify(input), original, "projection must not rewrite historical results");
    }));
  }
}

test("missing historical image preserves adjacent tool text segments", async () => withImages(async (workspacePath) => {
  await fs.rm(path.join(workspacePath, "screens/a.png"));
  const input = [assistant, { ...toolResults, content: [
    { ...toolResults.content[0]!, output: [{ type: "text", value: "before" }, toolResults.content[0]!.output, { type: "text", value: "after" }] },
    toolResults.content[1]!,
  ] }] as Input["messages"];
  for (const providerNpm of ["@ai-sdk/openai", "@ai-sdk/deepseek"]) {
    const messages = await prepare(workspacePath, providerNpm, input);
    const output = (messages[1] as Extract<ModelMessage, { role: "tool" }>).content[0]!.output;
    assert.deepEqual(output, providerNpm === "@ai-sdk/openai"
      ? { type: "content", value: ["before", missingImageText, "after"].map((text) => ({ type: "text", text })) }
      : { type: "text", value: ["before", missingImageText, "after"].join("\n") });
  }
}));

test("non-missing historical image errors remain local failures", async (t) => withImages(async (workspacePath) => {
  const originalOpen = fs.open.bind(fs);
  for (const code of ["EACCES", "EPERM", "EIO", "ENOTDIR"]) {
    const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/a.png")) throw Object.assign(new Error("fixture read failure"), { code });
      return originalOpen(...args);
    });
    await assert.rejects(prepare(workspacePath, "@ai-sdk/openai", [assistant, toolResults] as Input["messages"]), /cannot read a valid tool image/);
    mocked.mock.restore();
  }
  await fs.writeFile(path.join(workspacePath, "screens/a.png"), jpg);
  await assert.rejects(prepare(workspacePath, "@ai-sdk/deepseek", [assistant, toolResults] as Input["messages"]), /cannot read a valid tool image/);
}));

test("mixed, failed and separate turns never attach an unrelated image", async () => withImages(async (workspacePath) => {
  const mixed: Input["messages"] = [assistant, { role: "tool", content: [
    toolResults.content[0]!, { ...toolResults.content[1]!, output: { type: "error-text", value: "unreadable" } },
  ] }] as Input["messages"];
  const messages = await prepare(workspacePath, "@ai-sdk/deepseek", mixed);
  assert.equal(messages.length, 3);
  const user = messages[2] as Extract<ModelMessage, { role: "user" }>;
  assert.equal(Array.isArray(user.content) && user.content.length, 2);
  const failed = await prepare(workspacePath, "@ai-sdk/deepseek", [assistant, { role: "tool", content: [
    { ...toolResults.content[0]!, output: { type: "error-text", value: "a failed" } },
    { ...toolResults.content[1]!, output: { type: "error-text", value: "b failed" } },
  ] }] as Input["messages"]);
  assert.equal(failed.length, 2);
  const separate = await prepare(workspacePath, "@ai-sdk/deepseek", [assistant, toolResults,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "next", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "next", toolName: "bash", output: { type: "text", value: "ok" } }] },
  ] as Input["messages"]);
  assert.deepEqual(separate.map((item) => item.role), ["assistant", "tool", "user", "assistant", "tool"]);
  await assert.rejects(prepare(workspacePath, "@ai-sdk/deepseek", [assistant, { ...toolResults, content: [...toolResults.content].reverse() }] as Input["messages"]), /call order/);
}));

/** Source ordinals name the original PromptContext, before Chat's synthetic image users exist. */
function reasoningHistory(profile: ExecutionProfile, ordinals: number[]): NonNullable<AgentApiPromptContextResponse["providerReplay"]> {
  const npm = profile.provider.npm;
  if (npm !== "@ai-sdk/moonshotai" && npm !== "@ai-sdk/deepseek") throw new Error("unexpected reasoning provider");
  const model = profile.model.providerModelId ?? profile.model.id;
  const provenance = {
    providerNpm: npm, protocol: npm === "@ai-sdk/moonshotai" ? "moonshot-chat" : "deepseek-chat",
    protocolVersion: 1, providerId: profile.provider.id, model, endpointDigest: chatEndpointDigest(profile),
  } as const;
  return ordinals.map((assistantOrdinal, index) => ({
    assistantOrdinal, assistantProvenance: provenance,
    parts: [{ type: "reasoning", visibleIndex: 0, text: `reasoning-${index + 1}`,
      providerReplay: { version: 1, provider: {
        npm, api: "chat-completions", protocolVersion: 1, providerId: profile.provider.id,
        model, endpointDigest: chatEndpointDigest(profile),
      }, item: { type: "reasoning" } },
    }],
  })) as NonNullable<AgentApiPromptContextResponse["providerReplay"]>;
}

for (const provider of [
  { npm: "@ai-sdk/moonshotai", model: "kimi-k2.6" },
  { npm: "@ai-sdk/deepseek", model: "deepseek-v4-pro" },
  { npm: "@ai-sdk/deepseek", model: "deepseek-reasoner" },
] as const) {
  test(`${provider.npm}/${provider.model}: Runner reasoning ordinals survive multi-turn image users in actual SDK wire request`, async () => withImages(async (workspacePath) => {
    const profile = { provider: { id: "config-a", npm: provider.npm, options: {
      apiKey: "fixture", baseURL: "https://fixture.invalid/v1",
    } }, model: { id: "local", providerModelId: provider.model },
    agent: { tools: [], pluginTools: [], mcpServers: [] }, runtime: { modelRequestMaxRetries: 0 } } as unknown as ExecutionProfile;
    const laterAssistant = { role: "assistant" as const, content: [
      { type: "tool-call" as const, toolCallId: "call-c", toolName: "view_image", input: { path: "screens/a.png" } },
    ] };
    const originalMessages: Input["messages"] = [
      { role: "user", content: "inspect two turns" }, assistant, toolResults,
      laterAssistant, { role: "tool", content: [{ type: "tool-result", toolCallId: "call-c", toolName: "view_image",
        output: { type: "image_ref", path: "screens/a.png" } }] },
      { role: "assistant", content: [{ type: "text", text: "completed both inspections" }] },
    ] as Input["messages"];
    const unchanged = JSON.stringify(originalMessages);
    let wireBody: Record<string, unknown> | null = null;
    let runnerMessages: ModelMessage[] | null = null;
    let sawProviderReasoning = false;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const choice = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
        id: "fixture", object: "chat.completion.chunk", created: 1, model: provider.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      const chunks = [choice({ reasoning_content: "provider-reasoning" }), choice({ content: "provider answer" }),
        choice({}, "stop"), { id: "fixture", object: "chat.completion.chunk", created: 1,
          model: provider.model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const runner = new AgentRunner({
      async createStreamingAssistant() { return { result: "updated" }; },
      async flushAssistantParts() { return { result: "updated" }; },
      async completeAssistant() { return { result: "updated" }; },
      async completeTerminalAssistant() { return { result: "updated" }; },
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
      streamText: ((request: { messages: ModelMessage[]; providerOptions?: unknown }) => ({ fullStream: (async function* () {
        runnerMessages = request.messages;
        const sdkModel = provider.npm === "@ai-sdk/moonshotai"
          ? createMoonshotAI({ apiKey: "fixture", fetch }).chatModel(provider.model)
          : createDeepSeek({ apiKey: "fixture", fetch }).chat(provider.model);
        const sdk = streamText({ model: sdkModel, messages: request.messages,
          providerOptions: request.providerOptions as any, maxRetries: 0 });
        for await (const part of sdk.fullStream) {
          if (part.type === "reasoning-delta") sawProviderReasoning = true;
          yield part;
        }
      })() })) as unknown as typeof streamTextType,
    });
    (runner as any).toolRegistry.listTools = async () => [];
    await (runner as any).runModelStep({ profile,
      run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath, workspaceRepoDirNames: [], inputText: "inspect" },
      context: { pendingTools: [], tools: [], system: "", headMessageId: null, sessionRevision: 0,
        messages: originalMessages, providerReplay: reasoningHistory(profile, [1, 3, 5]) },
      step: 1, signal: new AbortController().signal, repeatedToolCallCounter: new Map(),
    });
    assert.equal(JSON.stringify(originalMessages), unchanged, "reasoning and media preparation must not mutate source context");
    assert.ok(runnerMessages && wireBody, "Runner and the real SDK both received the request");
    assert.ok(sawProviderReasoning, "Runner receives real SDK reasoning chunks from the Provider response");
    assert.deepEqual((runnerMessages as ModelMessage[]).map((message) => message.role),
      ["user", "assistant", "tool", "user", "assistant", "tool", "user", "assistant"]);
    const preparedAssistants = (runnerMessages as ModelMessage[]).filter((message) => message.role === "assistant") as Array<Extract<ModelMessage, { role: "assistant" }>>;
    assert.deepEqual(preparedAssistants.map((item) => Array.isArray(item.content)
      ? item.content.filter((part) => part.type === "reasoning").map((part) => part.text)
      : []), [["reasoning-1"], ["reasoning-2"], ["reasoning-3"]]);
    const wire = (wireBody as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    if (provider.npm === "@ai-sdk/moonshotai") {
      assert.deepEqual((wireBody as Record<string, unknown>).thinking, { type: "enabled", keep: "all" });
      assert.equal(Object.hasOwn(wireBody as Record<string, unknown>, "reasoningHistory"), false, "SDK maps the private option to thinking.keep");
    }
    assert.deepEqual(wire.map((message) => message.role),
      ["user", "assistant", "tool", "tool", "user", "assistant", "tool", "user", "assistant"]);
    assert.deepEqual([wire[1]?.tool_calls, wire[5]?.tool_calls].map((calls) => (calls as Array<{ id: string }>).map((call) => call.id)),
      [["call-a", "call-b"], ["call-c"]]);
    assert.deepEqual(wire.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
      ["call-a", "call-b", "call-c"]);
    assert.deepEqual(wire.filter((message) => message.role === "user" && Array.isArray(message.content))
      .map((message) => (message.content as Array<{ type: string }>).map((part) => part.type)),
      [["text", "image_url", "text", "image_url"], ["text", "image_url"]]);
    assert.deepEqual([wire[1]?.reasoning_content, wire[5]?.reasoning_content, wire[8]?.reasoning_content],
      provider.model === "deepseek-reasoner"
        ? [undefined, undefined, "reasoning-3"]
        : ["reasoning-1", "reasoning-2", "reasoning-3"]);
    assert.ok(wire[7]?.role === "user" && wire[8]?.role === "assistant", "DeepSeek's last user is the second synthetic image message");
  }));
}

for (const provider of [
  { npm: "@ai-sdk/moonshotai", model: "kimi-k2.6" },
  { npm: "@ai-sdk/deepseek", model: "deepseek-reasoner" },
] as const) {
  for (const nextImage of ["replace", "remove"] as const) {
    test(`${provider.npm}/${provider.model}: reasoning and image users stay aligned after remote failure (${nextImage})`,
      async () => withImages(async (workspacePath) => {
        const profile = { provider: { id: "config-a", npm: provider.npm, options: {
          apiKey: "fixture", baseURL: "https://fixture.invalid/v1",
        } }, model: { id: "local", providerModelId: provider.model },
        agent: { tools: [], pluginTools: [], mcpServers: [] },
        runtime: { modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 50 } } as unknown as ExecutionProfile;
        const originalMessages: Input["messages"] = [
          { role: "user", content: "inspect two turns" }, assistant, toolResults,
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-c", toolName: "view_image",
            input: { path: "screens/a.png" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "call-c", toolName: "view_image",
            output: { type: "image_ref", path: "screens/a.png" } }] },
          { role: "assistant", content: [{ type: "text", text: "completed both inspections" }] },
        ] as Input["messages"];
        const originalJson = JSON.stringify(originalMessages);
        const retryDelays: number[] = [];
        const wireBodies: Array<Record<string, unknown>> = [];
        const runnerRequests: ModelMessage[][] = [];
        const imagePath = path.join(workspacePath, "screens/a.png");
        const replacement = Buffer.concat([png, Buffer.from([0x59])]);
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (wireBodies.length === 1) {
            if (nextImage === "remove") await fs.rm(imagePath);
            else await fs.writeFile(imagePath, replacement);
            return new Response("remote request failed", { status: 500, headers: { "content-type": "text/plain" } });
          }
          const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: provider.model,
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } });
        };
        const runner = new AgentRunner({
          async createStreamingAssistant() { return { result: "updated" }; },
          async flushAssistantParts() { return { result: "updated" }; },
          async completeAssistant() { return { result: "updated" }; },
          async completeTerminalAssistant() { return { result: "updated" }; },
          async updateRunNotice() { return { result: "updated" }; },
          async replaceStreamingAssistant() { return { result: "updated" }; },
        } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
          modelRetrySleep: async (ms, signal) => {
            assert.ok(signal instanceof AbortSignal);
            assert.equal(signal.aborted, false);
            retryDelays.push(ms);
            return !signal.aborted;
          },
          streamText: ((request: { messages: ModelMessage[]; providerOptions?: unknown }) => {
            runnerRequests.push(request.messages);
            return { fullStream: (async function* () {
              const model = provider.npm === "@ai-sdk/moonshotai"
                ? createMoonshotAI({ apiKey: "fixture", fetch }).chatModel(provider.model)
                : createDeepSeek({ apiKey: "fixture", fetch }).chat(provider.model);
              const sdk = streamText({ model, messages: request.messages,
                providerOptions: request.providerOptions as any, maxRetries: 0, onError() { /* first remote failure is expected */ } });
              yield* sdk.fullStream;
            })() };
          }) as unknown as typeof streamTextType,
        });
        (runner as any).toolRegistry.listTools = async () => [];
        const execute = (runner as any).runModelStep({ profile,
          run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath,
            workspaceRepoDirNames: [], inputText: "inspect" },
          context: { pendingTools: [], tools: [], system: "", headMessageId: null, sessionRevision: 0,
            messages: originalMessages, providerReplay: reasoningHistory(profile, [1, 3, 5]) },
          step: 1, signal: new AbortController().signal, repeatedToolCallCounter: new Map(),
        });
        await execute;
        assert.deepEqual(retryDelays, [2_000]);
        assert.equal(JSON.stringify(originalMessages), originalJson, "the retry must not mutate original context");
        assert.equal(wireBodies.length, 2, "missing historical images must not prevent the next SDK call");
        assert.equal(runnerRequests.length, wireBodies.length);
        for (const [index, body] of wireBodies.entries()) {
          const missing = index === 1 && nextImage === "remove";
          const messages = runnerRequests[index]!;
          assert.deepEqual(messages.map((message) => message.role),
            missing ? ["user", "assistant", "tool", "user", "assistant", "tool", "assistant"]
              : ["user", "assistant", "tool", "user", "assistant", "tool", "user", "assistant"]);
          assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) =>
            Array.isArray(message.content) ? message.content.filter((part) => part.type === "reasoning")
              .map((part) => part.text) : []), [["reasoning-1"], ["reasoning-2"], ["reasoning-3"]]);
          const wire = body.messages as Array<Record<string, unknown>>;
          assert.deepEqual(wire.map((message) => message.role),
            missing ? ["user", "assistant", "tool", "tool", "user", "assistant", "tool", "assistant"]
              : ["user", "assistant", "tool", "tool", "user", "assistant", "tool", "user", "assistant"]);
          assert.deepEqual(wire.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
            ["call-a", "call-b", "call-c"]);
          assert.deepEqual(wire.filter((message) => message.role === "assistant").map((message) => message.reasoning_content),
            provider.npm === "@ai-sdk/moonshotai"
              ? ["reasoning-1", "reasoning-2", "reasoning-3"]
              : [undefined, missing ? "reasoning-2" : undefined, "reasoning-3"],
            "DeepSeek retains reasoning after the actual last user; a missing image adds no synthetic user");
          if (provider.npm === "@ai-sdk/moonshotai") assert.deepEqual(body.thinking, { type: "enabled", keep: "all" });
          const userImages = wire.filter((message) => message.role === "user" && Array.isArray(message.content)).map((message) =>
            (message?.content as Array<{ type: string; image_url?: { url: string } }>).filter((part) => part.type === "image_url")
              .map((part) => part.image_url?.url));
          assert.deepEqual(userImages.map((images) => images.length), missing ? [1] : [2, 1]);
          if (missing) {
            assert.ok(userImages[0]![0]?.endsWith(jpg.toString("base64")));
            for (const callId of ["call-a", "call-c"]) {
              assert.equal(wire.find((message) => message.tool_call_id === callId)?.content, missingImageText);
            }
          } else {
            const expectedPng = (index === 0 ? png : replacement).toString("base64");
            assert.ok(userImages[0]![0]?.endsWith(expectedPng) && userImages[1]![0]?.endsWith(expectedPng));
            assert.ok(userImages[0]![1]?.endsWith(jpg.toString("base64")));
          }
        }
      }));
  }
}

test("Runner reopens persisted tool image after remote error; deletion and oversize use placeholders on retry", async () => withImages(async (workspacePath) => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((fn: (...args: any[]) => void, _delay?: number, ...args: any[]) => originalSetTimeout(fn, 0, ...args)) as typeof setTimeout;
  try {
    for (const secondAttempt of ["replace", "remove", "oversize"] as const) {
      const requests: Array<{ messages: ModelMessage[] }> = [];
      const imagePath = path.join(workspacePath, "screens/a.png");
      await fs.writeFile(imagePath, png);
      const runner = new AgentRunner({
        async createStreamingAssistant() { return { result: "updated" }; },
        async flushAssistantParts() { return { result: "updated" }; },
        async completeAssistant() { return { result: "updated" }; },
        async completeTerminalAssistant() { return { result: "updated" }; },
        async updateRunNotice() { return { result: "updated" }; },
        async replaceStreamingAssistant() { return { result: "updated" }; },
      } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
        streamText: ((request: { messages: ModelMessage[] }) => {
          requests.push(request);
          return { fullStream: (async function* () {
            if (requests.length === 1) {
              if (secondAttempt === "remove") await fs.rm(imagePath);
              else if (secondAttempt === "oversize") await fs.truncate(imagePath, 10 * 1024 * 1024 + 1);
              else await fs.writeFile(imagePath, Buffer.concat([png, Buffer.from([0x59])]));
              yield { type: "error", error: new Error("remote request failed") };
            } else {
              yield { type: "text-delta", text: "ok" };
              yield { type: "raw", rawValue: { type: "response.completed", response: { output: [] } } };
              yield { type: "finish" };
            }
          })() };
        }) as unknown as typeof streamTextType,
      });
      (runner as any).toolRegistry.listTools = async () => [];
      const execute = (runner as any).runModelStep({
        profile: { model: { id: "gpt-4o-mini" }, provider: { npm: "@ai-sdk/openai", options: { apiKey: "fixture" } },
          agent: { tools: [], pluginTools: [], mcpServers: [] }, runtime: { modelRequestMaxRetries: 1, modelRequestRetryBackoffMaxMs: 50 } },
        run: { workspaceId: "ws", workspacePath, sessionId: "session", runId: "run", workspaceRepoDirNames: [], inputText: "look" },
        context: { messages: [{ role: "user", content: "look" }, assistant, toolResults], pendingTools: [],
          providerReplay: [], tools: [], system: "", sessionRevision: 0, headMessageId: null },
        step: 1, signal: new AbortController().signal, repeatedToolCallCounter: new Map(),
      });
      await execute;
      assert.equal(requests.length, 2);
      if (secondAttempt !== "replace") {
        const result = (requests[1]!.messages[2] as Extract<ModelMessage, { role: "tool" }>).content[0]!;
        assert.deepEqual(result.output, { type: "content", value: [{ type: "text", text: secondAttempt === "remove" ? missingImageText : oversizedImageText }] });
      } else {
        const media = (message: ModelMessage[]) => (((message[2] as any).content[0].output.value[0]) as { data: string }).data;
        assert.notEqual(media(requests[0]!.messages), media(requests[1]!.messages));
      }
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}));

test("user and tool images can exceed 20 MiB combined while each remains within the single-image limit", async () => withImages(async (workspacePath) => {
  await fs.writeFile(path.join(workspacePath, "screens/a.png"), Buffer.concat([png, Buffer.alloc(9 * 1024 * 1024)]));
  await fs.writeFile(path.join(workspacePath, "screens/b.jpg"), Buffer.concat([jpg, Buffer.alloc(9 * 1024 * 1024)]));
  const messages = [{ role: "user", content: [
    { type: "text", text: "look" },
    { type: "attachment_ref", workspaceId: "ws", attachmentId: "att_1", path: ".awb/agent/attachments/att_1.png", mediaType: "image/png", filename: "original.png" },
  ] }, assistant, toolResults] as Input["messages"];
  const prepared = await materializePromptAttachments({ messages, providerNpm: "@ai-sdk/openai",
    run: { workspaceId: "ws", workspacePath },
    attachmentStorage: { async read() { return { bytes: Buffer.alloc(9 * 1024 * 1024), mediaType: "image/png" }; } },
  });
  const user = prepared[0] as Extract<ModelMessage, { role: "user" }>;
  assert.ok(Array.isArray(user.content) && user.content[1]?.type === "file");
  const results = (prepared[2] as Extract<ModelMessage, { role: "tool" }>).content;
  assert.ok(results.every((result) => result.output.type === "content" && result.output.value[0]?.type === "media"));
}));

test("each preparation reopens original file, missing images become text and combined size is unrestricted", async () => withImages(async (workspacePath) => {
  const input = [assistant, toolResults] as Input["messages"];
  const first = await prepare(workspacePath, "@ai-sdk/openai", input);
  const firstData = (((first[1] as any).content[0].output.value[0]) as { data: string }).data;
  await fs.writeFile(path.join(workspacePath, "screens/a.png"), Buffer.concat([png, Buffer.from([0x58])]));
  const second = await prepare(workspacePath, "@ai-sdk/openai", input);
  const secondData = (((second[1] as any).content[0].output.value[0]) as { data: string }).data;
  assert.notEqual(firstData, secondData);
  await fs.rm(path.join(workspacePath, "screens/a.png"));
  const missing = await prepare(workspacePath, "@ai-sdk/openai", input);
  assert.deepEqual((missing[1] as Extract<ModelMessage, { role: "tool" }>).content[0]!.output,
    { type: "content", value: [{ type: "text", text: missingImageText }] });
  await fs.writeFile(path.join(workspacePath, "screens/a.png"), Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]));
  await fs.writeFile(path.join(workspacePath, "screens/b.jpg"), Buffer.concat([jpg, Buffer.alloc(8 * 1024 * 1024)]));
  const combined = await prepare(workspacePath, "@ai-sdk/openai", [assistant, toolResults, assistant, toolResults] as Input["messages"]);
  for (const index of [1, 3]) {
    const results = (combined[index] as Extract<ModelMessage, { role: "tool" }>).content;
    assert.ok(results.every((result) => result.output.type === "content" && result.output.value[0]?.type === "media"));
  }
}));
