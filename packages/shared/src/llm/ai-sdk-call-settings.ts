import type { CallSettings } from "ai";

export const AI_SDK_CALL_SETTING_KEYS = [
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "headers",
  "allowSystemInMessages",
] as const;

export const AI_SDK_RESERVED_OPTION_KEYS = [
  "model",
  "system",
  "prompt",
  "messages",
  "input",
  "abortSignal",
  "providerOptions",
  "tools",
  "toolChoice",
  "maxRetries",
] as const;

export type ConfigurableAiSdkCallSettings = Pick<
  CallSettings,
  | "maxOutputTokens"
  | "temperature"
  | "topP"
  | "topK"
  | "presencePenalty"
  | "frequencyPenalty"
  | "stopSequences"
  | "seed"
  | "headers"
> & {
  allowSystemInMessages?: boolean;
};

export class AiSdkCallSettingsError extends Error {
  constructor(
    readonly key: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AiSdkCallSettingsError";
  }
}

const ALLOWED_KEYS = new Set<string>(AI_SDK_CALL_SETTING_KEYS);
const RESERVED_KEYS = new Set<string>(AI_SDK_RESERVED_OPTION_KEYS);
export const AI_SDK_REDACTED_HEADER_VALUE = "[removed: unsafe header value; delete this header and save settings]";

export type AiSdkRequestHeaderNameClassification = "allowed" | "blocked" | "invalid";
const HTTP_FIELD_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_REQUEST_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

function toRecordObject(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function isSafeObjectKey(raw: string) {
  return raw !== "" && raw !== "__proto__" && raw !== "prototype" && raw !== "constructor";
}

function fail(key: string | null, message: string): never {
  throw new AiSdkCallSettingsError(key, message);
}

function finiteNumber(key: string, value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(key, `AI SDK setting '${key}' must be a finite number`);
  }
  return value;
}

function integer(key: string, value: unknown) {
  const parsed = finiteNumber(key, value);
  if (!Number.isInteger(parsed)) {
    return fail(key, `AI SDK setting '${key}' must be an integer`);
  }
  return parsed;
}

export function classifyAiSdkRequestHeaderName(raw: string): AiSdkRequestHeaderNameClassification {
  if (!HTTP_FIELD_NAME_TOKEN.test(raw) || !isSafeObjectKey(raw.toLowerCase())) return "invalid";
  return BLOCKED_REQUEST_HEADER_NAMES.has(raw.toLowerCase()) ? "blocked" : "allowed";
}

/**
 * Removes legacy unsafe header values from read-side projections while keeping
 * the original name as an actionable, fail-closed marker. The marker is never a
 * valid replacement value: parseAiSdkCallSettings still rejects the blocked or
 * invalid name before any SDK request can be created.
 */
export function redactUnsafeAiSdkHeadersForRead(raw: unknown): unknown {
  const source = toRecordObject(raw);
  if (!source) return null;
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    headers[name] = classifyAiSdkRequestHeaderName(name) === "allowed"
      ? value
      : AI_SDK_REDACTED_HEADER_VALUE;
  }
  return headers;
}

function parseHeaders(value: unknown) {
  const source = toRecordObject(value);
  if (!source) return fail("headers", "AI SDK setting 'headers' must be an object of string values");
  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey;
    const classification = classifyAiSdkRequestHeaderName(key);
    if (classification === "invalid") {
      return fail("headers", `AI SDK setting 'headers' contains an invalid header name: ${JSON.stringify(rawKey)}`);
    }
    const normalizedKey = key.toLowerCase();
    if (seenNames.has(normalizedKey)) {
      return fail("headers", `AI SDK setting 'headers' contains a duplicate header name: ${JSON.stringify(rawKey)}`);
    }
    seenNames.add(normalizedKey);
    if (classification === "blocked") {
      return fail("headers", `AI SDK setting 'headers.${key}' is not allowed to override authentication, credential, transport, or request integrity headers`);
    }
    if (typeof rawValue !== "string") {
      return fail("headers", `AI SDK setting 'headers.${key}' must be a string`);
    }
    if (rawValue.includes("\0") || rawValue.includes("\r") || rawValue.includes("\n")) {
      return fail("headers", `AI SDK setting 'headers.${key}' contains invalid control characters`);
    }
    headers[key] = rawValue;
  }
  return headers;
}

export function parseAiSdkCallSettings(raw: unknown): ConfigurableAiSdkCallSettings {
  if (raw == null) return {};
  const source = toRecordObject(raw);
  if (!source) throw new AiSdkCallSettingsError(null, "AI SDK settings must be an object");

  const result: ConfigurableAiSdkCallSettings = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key)) {
      fail(key || null, `AI SDK setting key is invalid: ${JSON.stringify(rawKey)}`);
    }
    if (RESERVED_KEYS.has(key)) {
      fail(key, `AI SDK setting '${key}' is reserved and cannot be configured`);
    }
    if (!ALLOWED_KEYS.has(key)) {
      fail(key, `Unsupported AI SDK setting '${key}'. Supported settings: ${AI_SDK_CALL_SETTING_KEYS.join(", ")}`);
    }

    switch (key) {
      case "maxOutputTokens": {
        const parsed = integer(key, value);
        if (parsed < 1) fail(key, "AI SDK setting 'maxOutputTokens' must be >= 1");
        result.maxOutputTokens = parsed;
        break;
      }
      case "temperature":
        result.temperature = finiteNumber(key, value);
        break;
      case "topP":
        result.topP = finiteNumber(key, value);
        break;
      case "topK":
        result.topK = finiteNumber(key, value);
        break;
      case "presencePenalty":
        result.presencePenalty = finiteNumber(key, value);
        break;
      case "frequencyPenalty":
        result.frequencyPenalty = finiteNumber(key, value);
        break;
      case "stopSequences":
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
          fail(key, "AI SDK setting 'stopSequences' must be an array of strings");
        }
        result.stopSequences = [...value];
        break;
      case "seed":
        result.seed = integer(key, value);
        break;
      case "headers":
        result.headers = parseHeaders(value);
        break;
      case "allowSystemInMessages":
        if (typeof value !== "boolean") fail(key, "AI SDK setting 'allowSystemInMessages' must be a boolean");
        result.allowSystemInMessages = value;
        break;
    }
  }
  return result;
}
