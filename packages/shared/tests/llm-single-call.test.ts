import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSingleCallText, streamSingleCallText, type SingleCallModelProfile } from "../src/llm/single-call.js";
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

test("openai apiMode 支持 chatCompletions 值", async () => {
  const profile = createMockProfile();
  profile.provider.options.apiMode = "chatCompletions";
  await assert.rejects(
    () => generateSingleCallText(profile, { messages: [{ role: "user", content: "hello" }], timeoutMs: 0 }),
    /timeoutMs must be >= 1/
  );
});

test("single-call openai 在提供 sessionId 且未配置有效 promptCacheKey 时自动补默认值", async () => {
  const profile = createMockProfile();
  profile.model.options = {
    providerOptionsByKey: {
      openai: {
        promptCacheKey: "   "
      }
    }
  };
  profile.provider.options.apiMode = "chatCompletions";
  let requestBody = "";

  const server = createServer(async (req, res) => {
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
      sessionId: "sess_single",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 5_000
    });

    assert.equal(result.text, "hello");
    assert.match(requestBody, /"prompt_cache_key":"awb:sess_single"/);
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
