import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_SDK_REDACTED_HEADER_VALUE,
  AI_SDK_RESERVED_OPTION_KEYS,
  AiSdkCallSettingsError,
  classifyAiSdkRequestHeaderName,
  parseAiSdkCallSettings,
  redactUnsafeAiSdkHeadersForRead,
} from "../src/llm/ai-sdk-call-settings.js";

test("AI SDK call settings 解析全部受支持字段", () => {
  const parsed = parseAiSdkCallSettings({
    maxOutputTokens: 512,
    temperature: 0.25,
    topP: 0.9,
    topK: 40,
    presencePenalty: 0.1,
    frequencyPenalty: -0.2,
    stopSequences: ["END"],
    seed: 7,
    headers: { "x-model-config": "shared" },
    allowSystemInMessages: true,
  });

  assert.deepEqual(parsed, {
    maxOutputTokens: 512,
    temperature: 0.25,
    topP: 0.9,
    topK: 40,
    presencePenalty: 0.1,
    frequencyPenalty: -0.2,
    stopSequences: ["END"],
    seed: 7,
    headers: { "x-model-config": "shared" },
    allowSystemInMessages: true,
  });
});

test("AI SDK call settings 拒绝未知字段", () => {
  assert.throws(
    () => parseAiSdkCallSettings({ unsupportedFlag: true }),
    (error) => error instanceof AiSdkCallSettingsError
      && error.key === "unsupportedFlag"
      && /Unsupported AI SDK setting 'unsupportedFlag'/.test(error.message),
  );
});

test("AI SDK call settings 拒绝所有 reserved 字段", () => {
  for (const key of AI_SDK_RESERVED_OPTION_KEYS) {
    assert.throws(
      () => parseAiSdkCallSettings({ [key]: "override" }),
      (error) => error instanceof AiSdkCallSettingsError
        && error.key === key
        && new RegExp(`AI SDK setting '${key}' is reserved`).test(error.message),
    );
  }
});

test("AI SDK call settings 校验字段类型", () => {
  const invalidValues = [
    { value: { maxOutputTokens: 1.5 }, pattern: /maxOutputTokens.*integer/ },
    { value: { seed: 1.5 }, pattern: /seed.*integer/ },
    { value: { allowSystemInMessages: "true" }, pattern: /allowSystemInMessages.*boolean/ },
    { value: { stopSequences: [1] }, pattern: /stopSequences.*array of strings/ },
    { value: { temperature: Number.POSITIVE_INFINITY }, pattern: /temperature.*finite number/ },
  ];

  for (const item of invalidValues) {
    assert.throws(() => parseAiSdkCallSettings(item.value), item.pattern);
  }
});

test("AI SDK call settings headers 接受普通自定义头", () => {
  assert.deepEqual(parseAiSdkCallSettings({ headers: {} }), { headers: {} });
  assert.deepEqual(
    parseAiSdkCallSettings({ headers: { "x-model-config": "shared", "X-Trace_Id": "trace" } }),
    { headers: { "x-model-config": "shared", "X-Trace_Id": "trace" } },
  );
});

test("AI SDK call settings headers 按大小写不敏感规则拒绝凭证和传输控制头", () => {
  const blockedNames = [
    "authorization",
    "AuThOrIzAtIoN",
    "proxy-authorization",
    "X-API-KEY",
    "api-key",
    "Cookie",
    "set-cookie",
    "HOST",
    "content-length",
    "Transfer-Encoding",
    "connection",
    "proxy-connection",
    "keep-alive",
    "upgrade",
    "TE",
    "trailer",
    "Expect",
  ];
  const sensitiveValue = "must-not-appear-in-error";

  for (const name of blockedNames) {
    assert.throws(
      () => parseAiSdkCallSettings({ headers: { [name]: sensitiveValue } }),
      (error) => error instanceof AiSdkCallSettingsError
        && error.key === "headers"
        && /is not allowed to override/.test(error.message)
        && !error.message.includes(sensitiveValue),
      `${name} should be blocked`,
    );
  }
});

test("AI SDK call settings headers 使用标准 HTTP field-name token", () => {
  for (const name of ["", "x bad", "x:bad", "x-中文", " x-leading", "x-trailing "]) {
    assert.throws(
      () => parseAiSdkCallSettings({ headers: { [name]: "value" } }),
      /invalid header name/,
      `${JSON.stringify(name)} should be invalid`,
    );
  }
  assert.throws(
    () => parseAiSdkCallSettings({ headers: { "x-test": "one", "X-Test": "two" } }),
    /duplicate header name/,
  );
});

test("AI SDK call settings headers 仅接受安全字符串值", () => {
  assert.throws(() => parseAiSdkCallSettings({ headers: [] }), /headers.*object of string values/);
  assert.throws(() => parseAiSdkCallSettings({ headers: { "x-count": 1 } }), /headers\.x-count.*string/);
  assert.throws(() => parseAiSdkCallSettings({ headers: { "x-test": "value\nnext" } }), /invalid control characters/);
  assert.throws(() => parseAiSdkCallSettings({ headers: { "x-test": "value\rnext" } }), /invalid control characters/);
  assert.throws(() => parseAiSdkCallSettings({ headers: { "x-test": "value\0next" } }), /invalid control characters/);
});

test("AI SDK header 名称分类是大小写不敏感的共享权威规则", () => {
  for (const name of ["Authorization", "authorization", "X-API-Key", "x-api-key", "HOST", "transfer-encoding"]) {
    assert.equal(classifyAiSdkRequestHeaderName(name), "blocked");
  }
  assert.equal(classifyAiSdkRequestHeaderName("x-model-config"), "allowed");
  assert.equal(classifyAiSdkRequestHeaderName("bad header"), "invalid");
});

test("历史 headers 读侧投影清除 unsafe value 并保留 fail-closed 标记", () => {
  const secret = "unique-history-secret";
  const projected = redactUnsafeAiSdkHeadersForRead({
    Authorization: secret,
    "x-api-key": secret,
    "bad header": secret,
    "x-model-config": "kept",
  });

  assert.deepEqual(projected, {
    Authorization: AI_SDK_REDACTED_HEADER_VALUE,
    "x-api-key": AI_SDK_REDACTED_HEADER_VALUE,
    "bad header": AI_SDK_REDACTED_HEADER_VALUE,
    "x-model-config": "kept",
  });
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.throws(
    () => parseAiSdkCallSettings({ headers: projected }),
    /headers\.Authorization.*not allowed to override/,
  );
  assert.equal(redactUnsafeAiSdkHeadersForRead(secret), null);
});
