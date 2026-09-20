import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantDebugProjectionLimits,
  projectAssistantDebugRecord,
  serializeAssistantDebugRecord,
} from "./project-assistant-debug-record.js";

const SENTINELS = {
  encrypted: "OPENAI-ENCRYPTED-REASONING-SENTINEL",
  token: "Authorization-Bearer-secret-token-SENTINEL",
  attachment: "data:image/png;base64,ATTACHMENT-SENTINEL-0123456789",
  reasoning: "DEEPSEEK-REASONING-SENTINEL",
  tool: "TOOL-INPUT-RESULT-SENTINEL",
  error: "ERROR-MESSAGE-SENTINEL",
  raw: "RAW-HTTP-SSE-PAYLOAD-SENTINEL",
};

function serialized(value: unknown) {
  return JSON.stringify(value);
}

function assertNoSecrets(value: unknown, ...sentinels: string[]) {
  const output = typeof value === "string" ? value : serialized(value);
  for (const sentinel of sentinels) assert.doesNotMatch(output, new RegExp(sentinel));
}

test("running 投影最终 AI SDK request，并对结构化 reasoning Part 省略正文", () => {
  const record = projectAssistantDebugRecord({
    status: "running",
    request: {
      system: "system",
      messages: [
        { role: "user", content: "materialized attachment reference" },
        { role: "assistant", content: [{ type: "reasoning", text: SENTINELS.reasoning, id: "reasoning-1" }] },
      ],
      providerOptions: { openai: { store: false, reasoningEncryptedContent: SENTINELS.encrypted } },
      headers: { Authorization: SENTINELS.token },
    },
  });

  const output = serialized(record);
  assert.match(output, /materialized attachment reference/);
  assert.doesNotMatch(output, /source-only-context-message/);
  assert.match(output, /reasoning-text-not-logged/);
  assert.match(output, /codePointLength/);
  assertNoSecrets(record, SENTINELS.reasoning, SENTINELS.encrypted, SENTINELS.token);
});

test("completed 投影 fail-closed 处理附件、工具内容、raw payload 与字符串化 JSON", () => {
  const record = projectAssistantDebugRecord({
    status: "completed",
    request: {
      messages: [{ role: "user", content: [{ type: "image", data: SENTINELS.attachment, mediaType: "image/png" }] }],
      providerReplay: { item: { encryptedContent: SENTINELS.encrypted } },
      payload: JSON.stringify({ token: SENTINELS.token, toolInput: SENTINELS.tool }),
    },
    response: {
      text: "normal response",
      reasoningText: SENTINELS.reasoning,
      toolCalls: [{ input: { secret: SENTINELS.tool }, result: JSON.stringify({ password: SENTINELS.tool }) }],
      raw: { events: [SENTINELS.raw] },
      body: SENTINELS.raw,
    },
  });

  const output = serialized(record);
  assert.match(output, /normal response/);
  assert.match(output, /reasoning-text-not-logged/);
  assert.match(output, /attachment-content-not-logged/);
  assert.match(output, /tool-content-not-logged/);
  assert.match(output, /raw-payload-not-logged/);
  assertNoSecrets(record, SENTINELS.attachment, SENTINELS.encrypted, SENTINELS.reasoning, SENTINELS.tool, SENTINELS.raw, SENTINELS.token);
});

test("failed 投影只保留错误白名单摘要，禁止错误正文和嵌套原始载荷", () => {
  const error = Object.assign(new Error(`${SENTINELS.error} authorization=Bearer ${SENTINELS.token}`), {
    code: "context_length_exceeded",
    statusCode: 400,
    responseBody: JSON.stringify({ apiKey: SENTINELS.token, toolResult: SENTINELS.tool }),
    rawValue: { events: [SENTINELS.raw] },
  });
  const record = projectAssistantDebugRecord({
    status: "failed",
    error,
    response: { error: JSON.stringify({ token: SENTINELS.token, output: SENTINELS.tool }) },
  });

  const output = serialized(record);
  assert.match(output, /context_length_exceeded/);
  assert.match(output, /error-content-not-logged/);
  assertNoSecrets(record, SENTINELS.error, SENTINELS.token, SENTINELS.tool, SENTINELS.raw);
});

test("短 base64、inline token 和附件/工具对象都按 fail-closed 规则脱敏", () => {
  const shortBase64 = "U0VDUkVULVNIT1JULUJBU0U2NA==";
  const record = projectAssistantDebugRecord({
    status: "running",
    request: {
      url: `https://example.test/model?api_key=${SENTINELS.token}`,
      note: `secret=${SENTINELS.token} bearer ${SENTINELS.token}`,
      base64: shortBase64,
      attachment: { data: SENTINELS.attachment, type: "file" },
      input: { value: SENTINELS.tool },
  },
  });
  assertNoSecrets(record, SENTINELS.token, SENTINELS.attachment, SENTINELS.tool, shortBase64);
  assert.match(serialized(record), /attachment-content-not-logged/);
});

test("附件摘要不记录签名 URL、路径、query 或 userinfo", () => {
  const signedUrl = "https://user:password@cdn.example.test/private/photo.png?X-Amz-Signature=SIGNED-URL-SENTINEL&token=TOKEN-SENTINEL";
  const secretPath = "/private/workspaces/PATH-SENTINEL/attachment.bin";
  const record = projectAssistantDebugRecord({
    status: "running",
    request: { attachment: { type: "image", url: signedUrl, path: secretPath, data: SENTINELS.attachment } },
  });
  const output = serialized(record);
  assert.match(output, /urlPresent/);
  assert.match(output, /cdn\.example\.test/);
  assert.match(output, /pathPresent/);
  assertNoSecrets(record, "SIGNED-URL-SENTINEL", "TOKEN-SENTINEL", "PATH-SENTINEL", "user:password");
});

test("超限或损坏的疑似 JSON 字符串始终 fail-closed", () => {
  const oversized = `{\"safe\":true,\"middle\":\"${"x".repeat(1024 * 1024)}SENSITIVE-MIDDLE-SENTINEL\"}`;
  const malformed = `{\"token\":\"SENSITIVE-PREFIX-SENTINEL\",\"raw\":`;
  const record = projectAssistantDebugRecord({
    status: "failed",
    request: { note: oversized, raw: oversized, input: oversized },
    response: { payload: malformed, output: oversized },
    error: malformed,
  });
  const output = serialized(record);
  assert.match(output, /json-string-not-logged/);
  assertNoSecrets(record, "SENSITIVE-MIDDLE-SENTINEL", "SENSITIVE-PREFIX-SENTINEL");
});

test("最终 pretty 写盘值严格满足字段、文件名和 record 硬上限", () => {
  const long = "字".repeat(20_000);
  const filename = "文".repeat(600);
  const massive = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`field-${index}-${"x".repeat(400)}`, long]));
  const record = projectAssistantDebugRecord({
    status: "completed",
    request: { filename, text: long, massive },
    response: { rows: Array.from({ length: 10_000 }, () => ({ text: long })) },
  });
  const pretty = serializeAssistantDebugRecord(record);
  assert.ok(Buffer.byteLength(pretty, "utf8") <= assistantDebugProjectionLimits.maxRecordBytes);
  const parsed = JSON.parse(pretty) as { status: string; request?: Record<string, unknown> };
  const loggedFilename = parsed.request?.filename;
  if (typeof loggedFilename === "string") {
    assert.ok(Array.from(loggedFilename).length <= assistantDebugProjectionLimits.maxFilenameCodePoints);
  }
  assert.equal(parsed.status, "completed");
  assert.match(pretty, /truncated:utf8>4096|record-size-limit|assistant-debug-record-limit/);
});

test("超大 key、数组及 pretty 膨胀采用确定性降级，最终哨兵稳定", () => {
  const hugeKey = "k".repeat(2_000);
  const input = {
    status: "failed" as const,
    request: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`${hugeKey}-${index}`, "v".repeat(4_000)])),
    response: Array.from({ length: 50_000 }, () => "x".repeat(4_000)),
  };
  const first = serializeAssistantDebugRecord(projectAssistantDebugRecord(input));
  const second = serializeAssistantDebugRecord(projectAssistantDebugRecord(input));
  assert.equal(first, second);
  assert.ok(Buffer.byteLength(first, "utf8") <= assistantDebugProjectionLimits.maxRecordBytes);
  assert.match(first, /object-fields-truncated|array-items-truncated|assistant-debug-record-limit/);
});

test("投影异常降级为稳定哨兵，不向业务调用方抛出", () => {
  const throwing = new Proxy({}, { ownKeys() { throw new Error("projection boom"); } });
  const record = projectAssistantDebugRecord({ status: "running", request: throwing });
  assert.deepEqual(record, { status: "running", projectionOmittedReason: "assistant-debug-record-projection-failed", omitted: true });
});
