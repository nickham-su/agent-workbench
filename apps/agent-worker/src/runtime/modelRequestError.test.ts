import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { APICallError } from "ai";
import { AGENT_MODEL_ERROR_BODY_MAX_LENGTH } from "@agent-workbench/shared";
import { buildModelRequestError } from "./modelRequestError.js";

const key = "fixture-provider-key-123";
const replay = "fixture-private-replay-456";
function apiError(responseBody?: string, statusCode = 429) {
  return new APICallError({ message: `must not publish error.message ${key}`, statusCode,
    url: `https://example.invalid/${key}`, requestBodyValues: { prompt: "private request" },
    responseHeaders: { authorization: key }, responseBody });
}

test("错误详情保留上游 JSON 诊断，但不附带请求、原始异常或敏感字段", () => {
  const detail = buildModelRequestError(apiError(JSON.stringify({ error: { message: `quota exceeded ${key}`, code: "quota_limit" },
    api_key: key, nested: { access_token: replay, encrypted_content: replay, providerReplay: { item: replay }, password: replay },
    serialized: JSON.stringify({ secret: replay, keep: "diagnostic" }) })), { secrets: [key] });
  assert.equal(detail.statusCode, 429);
  const text = JSON.stringify(detail);
  for (const secret of [key, replay, "private request", "example.invalid", "must not publish"]) assert.equal(text.includes(secret), false);
  assert.match(text, /quota exceeded/);
  assert.match(text, /quota_limit/);
  assert.match(text, /diagnostic/);
  assert.match(text, /\*\*\*/);
  assert.equal(detail.truncated, false);
});

test("非 JSON 响应按原文保留并遮蔽凭证、Authorization 与 replay 字段", () => {
  const body = `<html>upstream unavailable ${key}</html>\nAuthorization: Bearer other-fixture-token\napi_key='other-fixture-key'\nencrypted_content="${replay}"`;
  const detail = buildModelRequestError(apiError(body, 502), { secrets: [key] });
  assert.match(detail.responseBody!, /<html>upstream unavailable/);
  for (const value of [key, replay, "other-fixture-token", "other-fixture-key"]) assert.equal(detail.responseBody!.includes(value), false);
});

test("可信 SDK 错误可从有界 cause 链提取；不把伪造结构当响应体", () => {
  assert.equal(buildModelRequestError(new Error("wrapped", { cause: apiError("service overloaded") })).responseBody, "service overloaded");
  assert.equal(buildModelRequestError({ responseBody: key, message: key, statusCode: 401 }).responseBody, null);
  const cyclic = new Error(key, { cause: null }); cyclic.cause = cyclic;
  assert.equal(buildModelRequestError(cyclic).responseBody, null);
  let deep: unknown = apiError(key);
  for (let i = 0; i < 6; i++) deep = new Error("wrapper", { cause: deep });
  assert.equal(buildModelRequestError(deep).responseBody, null);
});

test("没有响应体时展示受控超时/网络原因，不将 SDK data 冒充原始响应体", () => {
  const detail = buildModelRequestError(apiError());
  assert.equal(detail.responseBody, null);
  assert.match(detail.message, /HTTP 429/);
  assert.match(buildModelRequestError(new Error(key), { timeout: { kind: "idle", durationMs: 60_000 } }).message, /idle timeout after 60000ms/);
  assert.match(buildModelRequestError(new Error(key), { timeout: { kind: "total", durationMs: 90_000 } }).message, /total timeout after 90000ms/);
  assert.match(buildModelRequestError(new TypeError(key, { cause: Object.assign(new Error(key), { code: "ECONNRESET" }) })).message, /ECONNRESET/);
  assert.equal(buildModelRequestError(apiError("")).responseBody, "");
});

test("脱敏在截断前完成，超长体有长度上限且跨截断点的凭证不会泄漏", () => {
  const body = "x".repeat(AGENT_MODEL_ERROR_BODY_MAX_LENGTH - 3) + key + "y".repeat(100);
  const detail = buildModelRequestError(apiError(body), { secrets: [key] });
  assert.equal(detail.responseBody!.length, AGENT_MODEL_ERROR_BODY_MAX_LENGTH);
  assert.equal(detail.responseBody!.includes(key.slice(0, 4)), false);
  assert.equal(detail.truncated, true);
});

test("深层 JSON、畸形 replay 对象与编码凭证仍有安全边界", () => {
  const deeplyNested = '['.repeat(100) + JSON.stringify({ encrypted_content: replay }) + ']'.repeat(100);
  const deep = buildModelRequestError(apiError(deeplyNested));
  assert.doesNotMatch(deep.responseBody!, new RegExp(replay));
  assert.match(deep.responseBody!, /nested content omitted/);
  const malformed = buildModelRequestError(apiError(`upstream error; providerReplay: { "item": "${replay}"`));
  assert.doesNotMatch(malformed.responseBody!, new RegExp(replay));
  const encodedKey = "fixture-key/+=";
  assert.equal(buildModelRequestError(apiError(`upstream ${encodeURIComponent(encodedKey)}`), { secrets: [encodedKey] }).responseBody, "upstream ***");
  const withCause = new APICallError({ message: "failed", url: "https://example.invalid", requestBodyValues: {}, cause: Object.assign(new Error("private"), { code: "ENOTFOUND" }) });
  assert.match(buildModelRequestError(withCause).message, /ENOTFOUND/);
});

test("连续长文本、JSON 字符串及畸形 JSON 的多尺寸扫描保持有界", () => {
  // Deliberately broad: detect the old multi-second quadratic path, not GC noise.
  const started = performance.now();
  for (const size of [8_192, 16_384, 32_768, 65_536]) {
    const text = "x".repeat(size);
    const plain = buildModelRequestError(apiError(text));
    assert.equal(plain.responseBody, text.slice(0, AGENT_MODEL_ERROR_BODY_MAX_LENGTH));
    const literal = JSON.stringify(text);
    assert.equal(buildModelRequestError(apiError(literal)).responseBody, literal.slice(0, AGENT_MODEL_ERROR_BODY_MAX_LENGTH));
    const json = buildModelRequestError(apiError(JSON.stringify({ token: replay, message: text })));
    assert.match(json.responseBody!, /"message"/);
    assert.match(json.responseBody!, /\*\*\*/);
    assert.equal(json.responseBody!.includes(replay), false);
    const malformed = buildModelRequestError(apiError(`{"access_token":"${replay}","message":"${text}`));
    assert.equal(malformed.responseBody!.includes(replay), false);
    assert.match(malformed.responseBody!, /\*\*\*/);
    assert.equal(malformed.responseBody!.length <= AGENT_MODEL_ERROR_BODY_MAX_LENGTH, true);
  }
  assert.ok(performance.now() - started < 2_000, "bounded diagnostics should not take seconds on 64 KiB input");
});

test("长字段名、长值、转义和未闭合引号不触发回溯或暴露敏感值", () => {
  const long = "x".repeat(65_536);
  const bodies = [
    `${long}_token=${replay}`,
    `${long}_secret='${replay}'`,
    `${long}_password="${replay}"`,
    `access_token=${replay}${long}`,
    `api_key="${"\\\"".repeat(32_768)}${replay}"; keep=diagnostic`,
    `secret='${long}${replay}`,
    `providerReplay${" ".repeat(65_536)}: { nested: "${replay}"`,
  ];
  const started = performance.now();
  for (const body of bodies) {
    const detail = buildModelRequestError(apiError(body));
    assert.equal(detail.responseBody!.includes(replay), false);
    assert.equal(detail.responseBody!.length <= AGENT_MODEL_ERROR_BODY_MAX_LENGTH, true);
    if (/^(?:access_token|api_key|secret)=/.test(body)) assert.match(detail.responseBody!, /\*\*\*/);
    if (body.endsWith("keep=diagnostic")) assert.match(detail.responseBody!, /keep=diagnostic/);
  }
  assert.ok(performance.now() - started < 2_000, "long fields and quoted values must be scanned without backtracking");
});

test("常规字段、HTTP 凭证及畸形敏感对象脱敏回归", () => {
  for (const field of ["api_key", "access-token", "client_secret", "PASSWORD", "x-authorization", "encrypted_content", "reasoningEncryptedContent", "provider_replay_json"]) {
    for (const value of [`"${replay}"`, `'${replay}'`, replay]) {
      const detail = buildModelRequestError(apiError(`diagnostic; "${field}" = ${value}; keep=yes`));
      assert.equal(detail.responseBody!.includes(replay), false, field);
      assert.match(detail.responseBody!, /keep=yes/);
    }
  }
  const http = buildModelRequestError(apiError(`https://fixture-user:${replay}@example.invalid/ Bearer ${replay} Basic ${replay}`));
  assert.equal(http.responseBody!.includes(replay), false);
  assert.equal(http.responseBody!.includes("fixture-user"), false);
  for (const field of ["providerReplay", "encrypted_content", "reasoning_encrypted_content"]) {
    const detail = buildModelRequestError(apiError(`error; ${field}: [{ item: "${replay}"`));
    assert.equal(detail.responseBody!.includes(replay), false);
    assert.match(detail.responseBody!, /\*\*\*/);
  }
});

test("敏感字段名和字段值跨输出截断边界仍先完成脱敏", () => {
  const limit = AGENT_MODEL_ERROR_BODY_MAX_LENGTH;
  const valueAcrossCut = `${"x".repeat(limit - 20)}\naccess_token=${replay}; diagnostic`;
  const value = buildModelRequestError(apiError(valueAcrossCut));
  assert.equal(value.responseBody!.includes(replay.slice(0, 5)), false);
  assert.match(value.responseBody!, /\*\*\*/);
  const keyAcrossCut = `${"x".repeat(limit - 7)}\naccess_token=${replay}`;
  const field = buildModelRequestError(apiError(keyAcrossCut));
  assert.equal(field.responseBody!.length, limit);
  assert.equal(field.truncated, true);
  assert.equal(field.responseBody!.includes(replay), false);
});

test("输入或累计工作超预算时安全省略整段正文，绝不返回未脱敏前缀", () => {
  const budget = AGENT_MODEL_ERROR_BODY_MAX_LENGTH * 8;
  const oversized = [
    `${key} ${"x".repeat(budget - key.length - 4)}${key}`,
    `${replay} ${"x".repeat(budget - replay.length - 5)}access_token=${replay}`,
    JSON.stringify({ message: `${key}${"x".repeat(budget)}`, token: replay }),
    `{"message":"${key}${"x".repeat(budget)}`,
  ];
  // Also exercise the shared work budget on an otherwise accepted-size body.
  oversized.push(
    `${key}${"x".repeat(200_000)}`,
    JSON.stringify({ message: `${key}${"x".repeat(200_000)}`, token: replay }),
    JSON.stringify({ nested: JSON.stringify({ message: `${key}${"x".repeat(200_000)}` }) }),
  );
  const started = performance.now();
  for (const body of oversized) {
    const detail = buildModelRequestError(apiError(body), { secrets: [key, ...Array.from({ length: 12 }, (_, i) => `fixture-${i}`)] });
    assert.equal(detail.statusCode, 429);
    assert.equal(detail.truncated, true);
    assert.match(detail.responseBody!, /^\[Response body omitted: diagnostic processing limit exceeded\]$/);
    assert.equal(detail.responseBody!.includes(key), false);
    assert.equal(detail.responseBody!.includes(replay), false);
  }
  assert.ok(performance.now() - started < 2_000, "oversized diagnostics must fail closed within a bounded budget");
});

test("处理边界以内保留脱敏后的正文，凭证配置超预算则同样安全省略", () => {
  const budget = AGENT_MODEL_ERROR_BODY_MAX_LENGTH * 8;
  const detail = buildModelRequestError(apiError("x".repeat(budget)));
  assert.equal(detail.responseBody, "x".repeat(AGENT_MODEL_ERROR_BODY_MAX_LENGTH));
  assert.equal(detail.truncated, true);
  for (const secrets of [Array.from({ length: 33 }, (_, i) => `fixture-${i}`), ["x".repeat(budget + 1)]]) {
    const omitted = buildModelRequestError(apiError(key), { secrets });
    assert.match(omitted.responseBody!, /processing limit exceeded/);
    assert.equal(omitted.responseBody!.includes(key), false);
    assert.equal(omitted.truncated, true);
  }
});
