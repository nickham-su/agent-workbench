import { URL } from "node:url";

const MAX_FIELD_BYTES = 4 * 1024;
const MAX_FILENAME_CODE_POINTS = 256;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_DEPTH = 12;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_FIELDS = 128;

export type AssistantDebugStatus = "running" | "completed" | "failed";

export type AssistantDebugRecordInput = {
  status: AssistantDebugStatus;
  startedAt?: number;
  finishedAt?: number;
  meta?: Record<string, unknown>;
  request?: unknown;
  response?: unknown;
  error?: unknown;
  retryPolicy?: unknown;
};

type DebugRecord = Record<string, unknown>;

type ProjectionContext = {
  seen: WeakSet<object>;
  depth: number;
  key?: string;
};

const SENSITIVE_KEY = /(authorization|api[_-]?key|access[_-]?key|secret|password|cookie|token|credential)/i;
const REPLAY_KEY = /(?:provider[_-]?replay|encrypted[_-]?content|reasoning[_-]?encrypted[_-]?content|provider[_-]?metadata)/i;
const RAW_PAYLOAD_KEY = /^(?:raw|rawvalue|responsebody|body|httpbody|sse|eventsource|payload)$/i;
const REASONING_TEXT_KEY = /^(?:reasoning(?:[_-]?(?:text|content))?|analysis(?:[_-]?text)?|thinking(?:[_-]?(?:text|content))?)$/i;
const TOOL_CONTENT_KEY = /^(?:input|args|arguments|result|output|tool[_-]?(?:input|result|response|error))$/i;
const ATTACHMENT_KEY = /(?:attachment|base64|data[_-]?url|binary|bytes|image|audio|video|file[_-]?data|media|content[_-]?bytes)/i;
const FILENAME_KEY = /(?:file[_-]?name|filename|name)$/i;

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function truncateUtf8(value: string, maxBytes = MAX_FIELD_BYTES) {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = `…[truncated:utf8>${maxBytes}]`;
  const contentLimit = Math.max(0, maxBytes - utf8Bytes(suffix));
  let low = 0;
  let high = value.length;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    const code = value.charCodeAt(middle - 1);
    if (code >= 0xD800 && code <= 0xDBFF && middle < value.length) middle += 1;
    if (utf8Bytes(value.slice(0, middle)) <= contentLimit) low = middle;
    else high = middle - 1;
  }
  while (low > 0 && value.charCodeAt(low - 1) >= 0xD800 && value.charCodeAt(low - 1) <= 0xDBFF) low -= 1;
  return `${value.slice(0, low)}${suffix}`;
}

function truncateCodePoints(value: string, maxCodePoints: number) {
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  const suffix = `…[truncated:code-points>${maxCodePoints}]`;
  return `${points.slice(0, Math.max(0, maxCodePoints - codePointLength(suffix))).join("")}${suffix}`;
}

function compactKey(value: string) {
  return truncateCodePoints(value, MAX_FILENAME_CODE_POINTS);
}

function omit(reason: string, extra: Record<string, unknown> = {}) {
  return { omitted: true, reason, ...extra };
}

function isLikelyBase64(value: string) {
  return value.length >= 16
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function redactInlineCredentials(value: string) {
  return value
    .replace(/((?:authorization|x-api-key|api[_-]?key|access[_-]?token|secret|password|cookie)\s*[:=]\s*)([^\s,;"'}\]]+)/gi, "$1***")
    .replace(/(bearer\s+)([^\s,;"'}\]]+)/gi, "$1***")
    .replace(/([?&](?:api[_-]?key|token|access_token|secret|password)=)([^&#\s]+)/gi, "$1***");
}

function isAttachmentRecord(value: Record<string, unknown>, key?: string) {
  if (key && ATTACHMENT_KEY.test(key)) return true;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  return ["image", "file", "audio", "video", "document", "media"].includes(type)
    || "data" in value && ("mediaType" in value || "mimeType" in value || "contentType" in value);
}

function isReasoningPart(value: Record<string, unknown>) {
  return typeof value.type === "string" && value.type.toLowerCase() === "reasoning";
}

function reasoningSummary(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return omit("reasoning-text-not-logged", {
    present: text.length > 0,
    codePointLength: codePointLength(text),
  });
}

function projectString(value: string, key?: string): unknown {
  if (key && REPLAY_KEY.test(key)) return omit("private-provider-state");
  if (key && RAW_PAYLOAD_KEY.test(key)) return omit("raw-payload-not-logged");
  if (key && SENSITIVE_KEY.test(key)) return "***";
  if (key && REASONING_TEXT_KEY.test(key)) return reasoningSummary(value);
  if (key && (TOOL_CONTENT_KEY.test(key) || ATTACHMENT_KEY.test(key))) {
    return omit(TOOL_CONTENT_KEY.test(key) ? "tool-content-not-logged" : "attachment-content-not-logged", {
      present: value.length > 0,
      byteLength: utf8Bytes(value),
    });
  }
  if (/^data:[^,]+,/i.test(value)) return omit("data-url-not-logged");
  if (isLikelyBase64(value)) return omit("base64-not-logged", { byteLength: utf8Bytes(value) });

  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    if (trimmed.length > 1024 * 1024) return omit("json-string-not-logged");
    try {
      return projectValue(JSON.parse(trimmed), { seen: new WeakSet(), depth: 0, key });
    } catch {
      return omit("json-string-not-logged");
    }
  }
  const redacted = redactInlineCredentials(value);
  return key && FILENAME_KEY.test(key)
    ? truncateCodePoints(redacted, MAX_FILENAME_CODE_POINTS)
    : truncateUtf8(redacted);
}

function errorSummary(value: unknown): unknown {
  if (value instanceof Error) {
    const error = value as Error & { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
    return {
      name: typeof error.name === "string" ? truncateUtf8(error.name, 256) : "Error",
      ...(typeof error.code === "string" ? { code: truncateUtf8(error.code, 256) } : {}),
      ...(typeof error.status === "number" && Number.isFinite(error.status) ? { status: error.status } : {}),
      ...(typeof error.statusCode === "number" && Number.isFinite(error.statusCode) ? { statusCode: error.statusCode } : {}),
      omitted: true,
      reason: "error-content-not-logged",
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { name: typeof value === "string" ? "Error" : "UnknownError", omitted: true, reason: "error-content-not-logged" };
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {
    name: typeof record.name === "string" ? truncateUtf8(record.name, 256) : "Error",
    omitted: true,
    reason: "error-content-not-logged",
  };
  if (typeof record.code === "string") result.code = truncateUtf8(record.code, 256);
  if (typeof record.type === "string") result.type = truncateUtf8(record.type, 256);
  if (typeof record.status === "number" && Number.isFinite(record.status)) result.status = record.status;
  if (typeof record.statusCode === "number" && Number.isFinite(record.statusCode)) result.statusCode = record.statusCode;
  return result;
}

function safeUrlSummary(value: string) {
  try {
    const parsed = new URL(value);
    return {
      urlPresent: true,
      scheme: parsed.protocol.slice(0, -1),
      ...(parsed.hostname ? { hostname: parsed.hostname.toLowerCase() } : {}),
    };
  } catch {
    return { urlPresent: true };
  }
}

function projectAttachment(value: Record<string, unknown>) {
  const summary: Record<string, unknown> = { omitted: true, reason: "attachment-content-not-logged" };
  for (const key of ["type", "mediaType", "mimeType", "contentType", "url", "filename", "name", "path"] as const) {
    const item = value[key];
    if (typeof item !== "string") continue;
    if (key === "url") {
      summary.url = safeUrlSummary(item);
      continue;
    }
    if (key === "path") {
      summary.pathPresent = true;
      continue;
    }
    summary[key] = key === "filename" || key === "name"
      ? truncateCodePoints(item, MAX_FILENAME_CODE_POINTS)
      : truncateUtf8(item, 512);
  }
  return summary;
}

function projectValue(value: unknown, context: ProjectionContext): unknown {
  if (context.depth > MAX_DEPTH) return omit("max-depth");
  if (typeof value === "string") return projectString(value, context.key);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return truncateUtf8(`${value}n`);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") return omit("non-serializable");
  if (value instanceof Error) return errorSummary(value);
  if (typeof value !== "object") return truncateUtf8(String(value));
  if (context.seen.has(value)) return omit("circular-reference");
  context.seen.add(value);

  if (Array.isArray(value)) {
    if (context.key && (RAW_PAYLOAD_KEY.test(context.key) || TOOL_CONTENT_KEY.test(context.key) || ATTACHMENT_KEY.test(context.key))) {
      return omit(RAW_PAYLOAD_KEY.test(context.key) ? "raw-payload-not-logged" : "tool-or-attachment-content-not-logged", { itemCount: value.length });
    }
    const projected = value.slice(0, MAX_ARRAY_ITEMS).map((item) => projectValue(item, { ...context, depth: context.depth + 1, key: undefined }));
    if (value.length > MAX_ARRAY_ITEMS) projected.push(omit("array-items-truncated", { omittedItemCount: value.length - MAX_ARRAY_ITEMS }));
    return projected;
  }

  const record = value as Record<string, unknown>;
  if (context.key && RAW_PAYLOAD_KEY.test(context.key)) return omit("raw-payload-not-logged");
  if (context.key && ATTACHMENT_KEY.test(context.key)) return projectAttachment(record);
  if (context.key && (TOOL_CONTENT_KEY.test(context.key) || ATTACHMENT_KEY.test(context.key))) return omit("tool-or-attachment-content-not-logged");
  if (isAttachmentRecord(record, context.key)) return projectAttachment(record);
  if (isReasoningPart(record)) {
    return {
      type: "reasoning",
      ...("text" in record ? { text: reasoningSummary(record.text) } : {}),
      ...(typeof record.id === "string" ? { id: truncateUtf8(record.id, 256) } : {}),
      ...(typeof record.provider === "string" ? { provider: truncateUtf8(record.provider, 256) } : {}),
    };
  }

  const output: Record<string, unknown> = {};
  const keys = Object.keys(record).sort();
  for (const key of keys.slice(0, MAX_OBJECT_FIELDS)) {
    const outputKey = compactKey(key);
    if (REPLAY_KEY.test(key)) output[outputKey] = omit("private-provider-state");
    else if (RAW_PAYLOAD_KEY.test(key)) output[outputKey] = omit("raw-payload-not-logged");
    else if (SENSITIVE_KEY.test(key)) output[outputKey] = "***";
    else if (key === "error") output[outputKey] = errorSummary(record[key]);
    else if (REASONING_TEXT_KEY.test(key)) output[outputKey] = reasoningSummary(record[key]);
    else if (ATTACHMENT_KEY.test(key) && record[key] && typeof record[key] === "object") output[outputKey] = projectAttachment(record[key] as Record<string, unknown>);
    else if (TOOL_CONTENT_KEY.test(key) || ATTACHMENT_KEY.test(key)) output[outputKey] = omit(TOOL_CONTENT_KEY.test(key) ? "tool-content-not-logged" : "attachment-content-not-logged");
    else output[outputKey] = projectValue(record[key], { ...context, depth: context.depth + 1, key });
  }
  if (keys.length > MAX_OBJECT_FIELDS) output._omittedFields = omit("object-fields-truncated", { omittedFieldCount: keys.length - MAX_OBJECT_FIELDS });
  return output;
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function byteLengthPretty(value: unknown) {
  return utf8Bytes(pretty(value));
}

function structure(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[structure-truncated]";
  if (Array.isArray(value)) return { type: "array", length: value.length, sampledItems: value.slice(0, 8).map((item) => structure(item, depth + 1)) };
  if (!value || typeof value !== "object") return typeof value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return {
    type: "object",
    fieldCount: keys.length,
    keys: keys.slice(0, 32).map(compactKey),
  };
}

function finalFallback(status: AssistantDebugStatus): DebugRecord {
  return {
    status,
    projectionOmittedReason: "assistant-debug-record-limit",
    "assistant-debug-record-limit": true,
    omitted: true,
  };
}

function constrainRecord(record: DebugRecord): DebugRecord {
  if (byteLengthPretty(record) <= MAX_RECORD_BYTES) return record;
  const withoutResponse = { ...record, response: omit("record-size-limit", { structure: structure(record.response) }) };
  if (byteLengthPretty(withoutResponse) <= MAX_RECORD_BYTES) return withoutResponse;
  const withoutRequest = { ...withoutResponse, request: omit("record-size-limit", { structure: structure(record.request) }) };
  if (byteLengthPretty(withoutRequest) <= MAX_RECORD_BYTES) return withoutRequest;
  const withoutMeta = { ...withoutRequest, meta: omit("record-size-limit", { structure: structure(record.meta) }) };
  if (byteLengthPretty(withoutMeta) <= MAX_RECORD_BYTES) return withoutMeta;
  return finalFallback(record.status as AssistantDebugStatus);
}

/** 投影最终 AI SDK 调用语义；不是 HTTP body，且不包含 Provider 私有状态或原始载荷。 */
export function projectAssistantDebugRecord(input: AssistantDebugRecordInput): DebugRecord {
  try {
    const record: DebugRecord = {
      status: input.status,
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
      ...(input.meta === undefined ? {} : { meta: projectValue(input.meta, { seen: new WeakSet(), depth: 0, key: "meta" }) }),
      ...(input.request === undefined ? {} : { request: projectValue(input.request, { seen: new WeakSet(), depth: 0, key: "request" }) }),
      ...(input.response === undefined ? {} : { response: projectValue(input.response, { seen: new WeakSet(), depth: 0, key: "response" }) }),
      ...(input.error === undefined ? {} : { error: errorSummary(input.error) }),
      ...(input.retryPolicy === undefined ? {} : { retryPolicy: projectValue(input.retryPolicy, { seen: new WeakSet(), depth: 0, key: "retryPolicy" }) }),
    };
    return constrainRecord(record);
  } catch {
    return { status: input.status, projectionOmittedReason: "assistant-debug-record-projection-failed", omitted: true };
  }
}

/** 对最终将写盘的 pretty JSON 再次测量，保证磁盘记录绝不超过硬上限。 */
export function serializeAssistantDebugRecord(record: unknown) {
  try {
    const constrained = constrainRecord(record && typeof record === "object"
      ? record as DebugRecord
      : finalFallback("failed"));
    const output = pretty(constrained);
    if (utf8Bytes(output) <= MAX_RECORD_BYTES) return output;
  } catch {
    // 最终固定哨兵可保证写盘路径不抛出。
  }
  return pretty(finalFallback("failed"));
}

export const assistantDebugProjectionLimits = {
  maxFieldBytes: MAX_FIELD_BYTES,
  maxFilenameCodePoints: MAX_FILENAME_CODE_POINTS,
  maxRecordBytes: MAX_RECORD_BYTES,
};
