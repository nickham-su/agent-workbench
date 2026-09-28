import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSingleCallText, streamSingleCallText, type SingleCallModelProfile } from "../src/llm/single-call.js";
import { AI_SDK_REDACTED_HEADER_VALUE } from "../src/llm/ai-sdk-call-settings.js";
import { createServer } from "node:http";

function createMockProfile(): SingleCallModelProfile {
  return {
    provider: {
      id: "ppchat",
      npm: "@ai-sdk/openai",
      options: {
        baseURL: "https://example.invalid/v1",
        apiKey: "sk-test"
      }
    },
    model: {
      id: "mock-model"
    }
  };
}

test("generateSingleCallText 默认禁止 tools", async () => {
  const profile = createMockProfile();
  await assert.rejects(
    () =>
      generateSingleCallText(profile, {
        messages: [{ role: "user", content: "hello" }],
        tools: {} as any
      }),
    /tools are disabled by default/
  );
});

for (const provider of [
  { npm: "@ai-sdk/moonshotai", model: "kimi-k2.6", namespace: "moonshotai", expectedThinking: { type: "enabled", keep: "all" } },
  { npm: "@ai-sdk/moonshotai", model: "custom-kimi-alias", namespace: "moonshotai", expectedThinking: { type: "enabled" } },
  { npm: "@ai-sdk/moonshotai", model: "moonshot-v1-8k", namespace: "moonshotai", expectedThinking: null },
  { npm: "@ai-sdk/deepseek", model: "deepseek-custom-alias", namespace: "deepseek", expectedThinking: { type: "enabled" } },
] as const) {
  test(`${provider.npm} single-call accepts configured model ID and applies fixed policy through SDK`, async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: provider.model,
        choices: [{ index: 0, delta: { content: "reply" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: provider.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr !== "string");
      const profile: SingleCallModelProfile = {
        provider: { id: `config-${provider.namespace}`, npm: provider.npm,
          options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${addr.port}/v1` } },
        model: { id: "local-model", providerModelId: `  ${provider.model}  `, options: {
          providerOptionsByKey: { [provider.namespace]: { thinking: { type: "disabled" },
            reasoningHistory: "discarded", reasoningEffort: "low", parallelToolCalls: true } },
        } },
      };
      const input = { messages: [{ role: "user" as const, content: "hello" }], timeoutMs: 5_000 };
      const result = await generateSingleCallText(profile, input);
      assert.equal(result.text, "reply");
      assert.equal(requests[0]?.model, provider.model);
      if (provider.expectedThinking === null) assert.equal(Object.hasOwn(requests[0]!, "thinking"), false);
      else assert.deepEqual(requests[0]?.thinking, provider.expectedThinking);
      const requestText = JSON.stringify(requests[0]);
      assert.doesNotMatch(requestText, /reasoningEffort|reasoningHistory|discarded|disabled|"low"/);
      // The streaming single-call path must use the same policy without replay state.
      const events = [];
      for await (const event of streamSingleCallText(profile, input)) events.push(event);
      assert.deepEqual(events[0], { type: "text-delta", text: "reply" });
      assert.equal(requests[1]?.model, provider.model);
      assert.deepEqual(requests[1]?.thinking, requests[0]?.thinking);
      if (provider.expectedThinking === null) assert.equal(Object.hasOwn(requests[1]!, "thinking"), false);
      assert.doesNotMatch(JSON.stringify(requests[1]), /reasoningEffort|reasoningHistory|discarded|disabled|"low"/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
}

test("generateSingleCallText 会拒绝白名单外参数", async () => {
  const profile = createMockProfile();
  await assert.rejects(
    () =>
      generateSingleCallText(profile, {
        messages: [{ role: "user", content: "hello" }],
        foo: "bar"
      } as any),
    /unsupported single-call model parameter: foo/
  );
});

test("streamSingleCallText 延迟校验参数,迭代时才抛错", async () => {
  const profile = createMockProfile();
  const stream = streamSingleCallText(profile, {
    messages: [{ role: "user", content: "hello" }],
    tools: {} as any
  });
  assert.ok(stream);

  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {
        // unreachable
      }
    },
    /tools are disabled by default/
  );
});

test("generateSingleCallText 校验 timeoutMs", async () => {
  const profile = createMockProfile();
  await assert.rejects(
    () =>
      generateSingleCallText(profile, {
        messages: [{ role: "user", content: "hello" }],
        timeoutMs: 0
      }),
    /timeoutMs must be >= 1/
  );
});

test("generateSingleCallText 允许 null 关闭单次调用超时", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let timerCount = 0;
  globalThis.setTimeout = ((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    timerCount += 1;
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  const profile = createMockProfile();
  try {
    await assert.rejects(
      () =>
        generateSingleCallText(profile, {
          messages: [{ role: "user", content: "hello" }],
          timeoutMs: null,
          tools: {} as any,
        }),
      /tools are disabled by default/,
    );
    assert.equal(timerCount, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("single-call 传递共享 headers 与 allowSystemInMessages", async () => {
  const profile = createMockProfile();
  profile.model.options = {
    aiSdk: {
      headers: { "x-model-config": "single-call" },
      allowSystemInMessages: true,
    },
  };
  let configuredHeader = "";
  let authorizationHeader = "";
  let requestBody = "";
  const server = createServer(async (req, res) => {
    configuredHeader = String(req.headers["x-model-config"] || "");
    authorizationHeader = String(req.headers.authorization || "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    requestBody = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"mock-model"}}\n\n');
    res.write('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","phase":"final_answer"}}\n\n');
    res.write('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hello"}\n\n');
    res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","phase":"final_answer"}}\n\n');
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1},"service_tier":null}}\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    profile.provider.options.baseURL = `http://127.0.0.1:${address.port}/v1`;
    const result = await generateSingleCallText(profile, {
      messages: [
        { role: "system", content: "message-level system" },
        { role: "user", content: "hello" },
      ],
      timeoutMs: 5_000,
    });
    assert.equal(result.text, "hello");
    assert.equal(configuredHeader, "single-call");
    assert.equal(authorizationHeader, "Bearer sk-test");
    assert.match(requestBody, /message-level system/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("single-call 历史敏感 header 在 fetch 前明确失败且不泄漏值", async () => {
  const profile = createMockProfile();
  const sensitiveValue = "single-call-secret-sentinel";
  profile.model.options = {
    aiSdk: {
      headers: { Authorization: AI_SDK_REDACTED_HEADER_VALUE },
    },
  };
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    profile.provider.options.baseURL = `http://127.0.0.1:${address.port}/v1`;
    await assert.rejects(
      () => generateSingleCallText(profile, {
        messages: [{ role: "user", content: "hello" }],
        timeoutMs: 5_000,
      }),
      (error) => error instanceof Error
        && /headers\.Authorization.*not allowed to override/.test(error.message)
        && !error.message.includes(sensitiveValue),
    );
    assert.equal(requestCount, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("single-call 对未知或 reserved aiSdk 字段明确报错", async () => {
  for (const [aiSdk, expected] of [
    [{ unsupportedFlag: true }, /Unsupported AI SDK setting 'unsupportedFlag'/],
    [{ model: "override" }, /AI SDK setting 'model' is reserved/],
  ] as const) {
    const profile = createMockProfile();
    profile.model.options = { aiSdk };
    await assert.rejects(
      () => generateSingleCallText(profile, { messages: [{ role: "user", content: "hello" }] }),
      expected,
    );
  }
});

test("single-call 官方 openai 走 Responses 并自动补 promptCacheKey", async () => {
  const profile = createMockProfile();
  profile.model.options = {
    providerOptionsByKey: {
      openai: {
        promptCacheKey: "   "
      }
    }
  };
  let requestPath = "";
  let requestBody = "";

  const server = createServer(async (req, res) => {
    requestPath = req.url || "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    requestBody = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"mock-model"}}\n\n');
    res.write('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","phase":"final_answer"}}\n\n');
    res.write('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"hello"}\n\n');
    res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","phase":"final_answer"}}\n\n');
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1},"service_tier":null}}\n\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    profile.provider.options.baseURL = `http://127.0.0.1:${address.port}/v1`;

    const result = await generateSingleCallText(profile, {
      sessionId: "sess_single",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 5_000
    });

    assert.equal(result.text, "hello");
    assert.equal(result.totalTokens, 2);
    assert.equal(requestPath, "/v1/responses");
    assert.match(requestBody, /"prompt_cache_key":"awb:sess_single"/);
    assert.match(requestBody, /"input":\[{"role":"user","content":\[{"type":"input_text","text":"hello"}\]}\]/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("openai-compatible provider 会走 shared single-call 分支并发起 chat/completions 请求", async () => {
  const profile = createMockProfile();
  profile.provider.npm = "@ai-sdk/openai-compatible";
  let requestPath = "";
  let authHeader = "";
  let requestBody = "";

  const server = createServer(async (req, res) => {
    requestPath = req.url || "";
    authHeader = String(req.headers.authorization || "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    requestBody = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"resp_1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"},"index":0}]}\n\n');
    res.write('data: {"id":"resp_1","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    profile.provider.options.baseURL = `http://127.0.0.1:${address.port}/v1`;

    const result = await generateSingleCallText(profile, {
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 5_000
    });

    assert.equal(result.text, "hello");
    assert.equal(result.totalTokens, 2);
    assert.equal(requestPath, "/v1/chat/completions");
    assert.equal(authHeader, "Bearer sk-test");
    assert.match(requestBody, /"model":"mock-model"/);
    assert.match(requestBody, /"messages":\[{"role":"user","content":"hello"}\]/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
