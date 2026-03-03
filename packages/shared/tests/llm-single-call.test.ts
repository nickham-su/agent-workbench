import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSingleCallText, streamSingleCallText, type SingleCallModelProfile } from "../src/llm/single-call.js";

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
