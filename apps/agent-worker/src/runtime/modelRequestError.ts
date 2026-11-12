import { APICallError } from "ai";
import { AGENT_MODEL_ERROR_BODY_MAX_LENGTH, type AgentModelRequestError } from "@agent-workbench/shared";

const REDACTED = "***";
// Bound parsing/formatting as well as scanning. Oversized input is omitted, never
// sliced before redaction: a secret or a sensitive field may cross that boundary.
const MAX_BODY_PROCESSING_LENGTH = AGENT_MODEL_ERROR_BODY_MAX_LENGTH * 8;
const PROCESSING_LIMIT_NOTICE = "[Response body omitted: diagnostic processing limit exceeded]";
const PROCESSING_LIMIT = Symbol("diagnostic processing limit");
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
const SENSITIVE_KEY = /^(?:authorization|proxyAuthorization|credential|credentials|encryptedContent|reasoningEncryptedContent|providerReplay|providerReplayJson)$|apiKey$|token|secret|password/i;
const SENSITIVE_TEXT_KEY_SUFFIX = /(?:authorization|encrypted[_-]?content|provider[_-]?replay(?:[_-]?json)?)$/i;

function sensitiveKey(key: string) {
  return SENSITIVE_KEY.test(key.replace(/[_\s-]/g, ""));
}

function keyCharacter(code: number) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 45;
}

/** Consume each key/value once; never restart a greedy key prefix at each character. */
function redactTextFields(text: string) {
  const parts: string[] = [];
  let copiedUntil = 0;
  for (let cursor = 0; cursor < text.length;) {
    if (!keyCharacter(text.charCodeAt(cursor))) { cursor++; continue; }
    const start = cursor;
    while (cursor < text.length && keyCharacter(text.charCodeAt(cursor))) cursor++;
    const key = text.slice(start, cursor);
    if (!sensitiveKey(key) && !SENSITIVE_TEXT_KEY_SUFFIX.test(key)) continue;
    let valueStart = cursor;
    if (text[valueStart] === '"' || text[valueStart] === "'") valueStart++;
    while (valueStart < text.length && /\s/.test(text[valueStart]!)) valueStart++;
    if (text[valueStart] !== ":" && text[valueStart] !== "=") continue;
    valueStart++;
    while (valueStart < text.length && /\s/.test(text[valueStart]!)) valueStart++;
    if (valueStart === text.length) continue;

    let end = valueStart;
    const quote = text[valueStart];
    if (quote === "{" || quote === "[") {
      // Malformed JSON/text cannot safely expose a sensitive object's remainder.
      end = text.length;
    } else if (quote === '"' || quote === "'") {
      end++;
      while (end < text.length) {
        const character = text[end++];
        if (character === quote) break;
        if (character === "\\" && end < text.length) end++;
      }
    } else {
      while (end < text.length && !/[\s,;}\]]/.test(text[end]!)) end++;
    }
    if (end === valueStart) continue;
    parts.push(text.slice(copiedUntil, valueStart), `"${REDACTED}"`);
    copiedUntil = end;
    cursor = end;
  }
  parts.push(text.slice(copiedUntil));
  return parts.join("");
}

/** Only the response body is accepted here, not an Error, headers or request values. */
function sanitizeBody(body: string, secrets: string[]): string | null {
  // Shared by nested JSON strings and credential replacements, not reset per node.
  let remainingWork = MAX_BODY_PROCESSING_LENGTH * 4;
  const spend = (length: number) => {
    remainingWork -= length;
    if (remainingWork < 0) throw PROCESSING_LIMIT;
  };
  const replaceSecrets = (text: string) => {
    for (const secret of secrets) {
      spend(text.length);
      text = text.split(secret).join(REDACTED);
    }
    return text;
  };
  const sanitizeText = (text: string, depth = 0): string => {
    if (depth > 32) return "[nested content omitted]";
    spend(text.length);
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const sanitized = JSON.stringify(sanitizeJson(JSON.parse(trimmed), depth + 1), null, 2);
        spend(sanitized.length);
        return sanitized;
      } catch (error) {
        if (error === PROCESSING_LIMIT) throw error;
        // Non-JSON response.
      }
    }
    return redactTextFields(replaceSecrets(text)
      .replace(/(https?:\/\/)[^\s/"'<>]*@/gi, `$1${REDACTED}@`)
      .replace(/\b((?:Bearer|Basic)\s+)[^\s"'<>]+/gi, `$1${REDACTED}`));
  };
  const sanitizeJson = (value: unknown, depth: number): unknown => {
    if (depth > 32) return "[nested content omitted]";
    spend(1);
    if (typeof value === "string") return sanitizeText(value, depth + 1);
    if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [replaceSecrets(key), sensitiveKey(key) ? REDACTED : sanitizeJson(item, depth + 1)]));
    }
    return value;
  };
  try {
    return sanitizeText(body).replace(/\0/g, "");
  } catch (error) {
    if (error === PROCESSING_LIMIT) return null;
    throw error;
  }
}

export function buildModelRequestError(error: unknown, options: {
  secrets?: string[];
  timeout?: { kind: "idle" | "total"; durationMs: number };
} = {}): AgentModelRequestError {
  let source: unknown = error;
  let apiError: APICallError | null = null;
  let networkCode: string | null = null;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && source && typeof source === "object" && !seen.has(source); depth++) {
    seen.add(source);
    if (APICallError.isInstance(source) && (!apiError || (apiError.responseBody == null && typeof source.responseBody === "string"))) {
      apiError = source;
    }
    const record = source as Record<string, unknown>;
    if (typeof record.code === "string" && NETWORK_CODES.has(record.code)) networkCode = record.code;
    source = record.cause;
  }
  const status = apiError?.statusCode;
  const statusCode = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const message = options.timeout
    ? `Model ${options.timeout.kind} timeout after ${options.timeout.durationMs}ms`
    : networkCode ? `Model request network error (${networkCode})`
    : statusCode != null ? `Model request failed (HTTP ${statusCode})`
    : "Model request failed; no further safe diagnostic information is available.";
  const rawBody = apiError?.responseBody;
  if (typeof rawBody !== "string") return { statusCode, responseBody: null, message, truncated: false };
  const knownSecrets = options.secrets ?? [];
  if (rawBody.length > MAX_BODY_PROCESSING_LENGTH || knownSecrets.length > 32
    || knownSecrets.reduce((length, value) => length + value.length, 0) > MAX_BODY_PROCESSING_LENGTH) {
    return { statusCode, responseBody: PROCESSING_LIMIT_NOTICE, message, truncated: true };
  }
  // Sanitize before truncation so a credential spanning the cut is never exposed.
  const secrets = [...new Set(knownSecrets.filter((value) => value.length > 0)
    .flatMap((value) => {
      const escaped = JSON.stringify(value).slice(1, -1);
      try { return [value, escaped, encodeURIComponent(value)]; }
      catch { return [value, escaped]; } // Invalid Unicode in configuration must not hide the original failure.
    }))].sort((a, b) => b.length - a.length);
  const sanitized = sanitizeBody(rawBody, secrets);
  return {
    statusCode,
    responseBody: sanitized === null ? PROCESSING_LIMIT_NOTICE : sanitized.slice(0, AGENT_MODEL_ERROR_BODY_MAX_LENGTH),
    message,
    truncated: sanitized === null || sanitized.length > AGENT_MODEL_ERROR_BODY_MAX_LENGTH,
  };
}
