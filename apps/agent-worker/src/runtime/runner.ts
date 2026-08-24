import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { APICallError, jsonSchema, streamText, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateSingleCallText } from "@agent-workbench/shared/llm-single-call";
import { AgentApiClient, ApiConflictError, type ExecutionProfile, type PromptContext } from "./apiClient.js";
import type { AgentUiLocale } from "@agent-workbench/shared";
import { getPromptText } from "@agent-workbench/shared/prompts";
import { McpManager } from "./mcpManager.js";
import { buildRetryMessages, chunkStartsVisibleOutput, shouldRetryAfterPartialText } from "./modelRetry.js";
import { PluginRuntimeManager } from "./plugins/runtimeManager.js";
import { ToolRegistry } from "./tools/registry.js";
import { BuiltinToolProvider } from "./tools/providers/builtin.js";
import { LocalPluginToolProvider } from "./tools/providers/local-plugin.js";
import { RemotePluginToolProvider, REMOTE_PLUGIN_TOOLS_ENABLED } from "./tools/providers/remote-plugin.js";
import { McpToolProvider } from "./tools/providers/mcp.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { isMcpToolName, isPluginToolName } from "./tools/types.js";
import { createToolFailureCaptureIfEnabled, extractPartialToolResults, type ToolFailureCapture } from "./toolErrorCapture.js";
import { formatToolErrorStoreWarning } from "./toolErrorStore.js";

function nowMs() {
  return Date.now();
}

function parseIntOrDefault(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

const DEBUG_DUMP_ENABLED = process.env.AWB_AGENT_DEBUG_DUMP === "1";
const DEBUG_DUMP_RELATIVE_DIR = path.join(".debug", "agent_context_item_logs");
const LOOP_MAX_STEPS = parseIntOrDefault(process.env.AWB_AGENT_LOOP_MAX_STEPS, 128);
const LOOP_REPEAT_TOOL_CALL_THRESHOLD = parseIntOrDefault(process.env.AWB_AGENT_LOOP_REPEAT_TOOL_CALL_THRESHOLD, 20);
// 运行参数优先从后端 Settings 下发;这里的 env 仅作为全局覆盖开关,方便临时排障。
// 0 表示关闭。
const ENV_TIMEOUT_MS_MAX = 2_147_483_647;
const ENV_MODEL_IDLE_TIMEOUT_MS = Math.min(
  ENV_TIMEOUT_MS_MAX,
  Math.max(0, parseIntOrDefault(process.env.AWB_AGENT_MODEL_IDLE_TIMEOUT_MS, 0))
);
const ENV_MODEL_TOTAL_TIMEOUT_MS = Math.min(
  ENV_TIMEOUT_MS_MAX,
  Math.max(0, parseIntOrDefault(process.env.AWB_AGENT_MODEL_TOTAL_TIMEOUT_MS, 0))
);
const MODEL_RETRY_BACKOFF_BASE_MS = 2_000;
const MODEL_RETRY_BACKOFF_MAX_MS = 60_000;
const EMPTY_RESPONSE_COMPLETE_THRESHOLD = 6;
const TOOL_OUTPUT_TEXT_MAX_CHARS = Math.max(1_000, parseIntOrDefault(process.env.AWB_TOOL_OUTPUT_TEXT_MAX_CHARS, 8_000));
const TOOL_OUTPUT_TEXT_PREVIEW_CHARS = Math.max(
  500,
  Math.min(TOOL_OUTPUT_TEXT_MAX_CHARS, parseIntOrDefault(process.env.AWB_TOOL_OUTPUT_TEXT_PREVIEW_CHARS, 3_000))
);
const TOOL_ARTIFACT_MAX_CHARS = Math.max(
  TOOL_OUTPUT_TEXT_MAX_CHARS,
  parseIntOrDefault(process.env.AWB_TOOL_ARTIFACT_MAX_CHARS, 200_000)
);
const TOOL_OUTPUT_TEXT_UNTRUNCATED_NAMES = new Set(["subtask"]);
const TOOL_PARALLEL_BATCH_LIMIT = 3;

export function buildCompactionUserPrompt(input: { uiLocale: AgentUiLocale | null }) {
  if (input.uiLocale === "zh-CN") {
    return getPromptText("agent/compaction-user-prompt.zh-CN.txt");
  }
  return getPromptText("agent/compaction-user-prompt.en-US.txt");
}
const COMPACTION_TIMEOUT_MS = 600_000;

const MANUAL_COMPACT_SENTINEL = "__awb_compact__";

function newSortableId(prefix: string) {
  const ts = Date.now().toString(36).padStart(10, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${ts}${random}`;
}

function hasVisibleAssistantText(text: string) {
  return text.trim().length > 0;
}

function shouldStopForMaxSteps(step: number, maxSteps: number) {
  return maxSteps > 0 && step >= Math.max(maxSteps, EMPTY_RESPONSE_COMPLETE_THRESHOLD);
}

function computeRetryBackoffMs(attemptIndex: number) {
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) return MODEL_RETRY_BACKOFF_BASE_MS;
  const factor = 2 ** Math.floor(attemptIndex);
  const delay = MODEL_RETRY_BACKOFF_BASE_MS * factor;
  return Math.min(MODEL_RETRY_BACKOFF_MAX_MS, Math.max(MODEL_RETRY_BACKOFF_BASE_MS, delay));
}

function toErrorRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeErrorCode(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s.-]+/g, "_");
}

function parseJsonErrorValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function collectErrorCodes(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string") {
    const parsed = parseJsonErrorValue(value);
    return parsed == null ? [] : collectErrorCodes(parsed, depth + 1);
  }
  const record = toErrorRecord(value);
  if (!record) return [];

  const codes = [normalizeErrorCode(record.code), normalizeErrorCode(record.type)].filter(Boolean);
  for (const key of ["error", "data", "details"] as const) {
    codes.push(...collectErrorCodes(record[key], depth + 1));
  }
  return codes;
}

function collectErrorText(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string") return [value];
  if (value instanceof Error) {
    return [value.message, ...collectErrorText((value as Error & { cause?: unknown }).cause, depth + 1)];
  }
  const record = toErrorRecord(value);
  if (!record) return [];

  const values: string[] = [];
  for (const key of ["message", "responseBody", "body", "error", "data", "details", "cause"] as const) {
    values.push(...collectErrorText(record[key], depth + 1));
  }
  return values;
}

const CONTEXT_LIMIT_ERROR_CODES = new Set([
  "context_length_exceeded",
  "context_limit_exceeded",
  "context_window_exceeded",
  "input_too_long",
  "prompt_too_long",
  "request_too_large"
]);

function hasContextLimitText(text: string) {
  const normalized = text.toLowerCase().replace(/[._-]+/g, " ");
  return (
    /\bcontext[\s_-]*(?:length|window|limit)\b/.test(normalized)
    || /\b(?:prompt|input)\s+(?:is\s+)?too\s+(?:long|large)\b/.test(normalized)
    || /\brequest\s+(?:is\s+)?too\s+large\b/.test(normalized)
    || /\b(?:prompt|input)\b[\s\S]{0,80}\b(?:exceed(?:s|ed)?|maximum|max(?:imum)?|limit)\b/.test(normalized)
    || /\b(?:exceed(?:s|ed)?|maximum|max(?:imum)?|limit)\b[\s\S]{0,80}\b(?:prompt|input)\b/.test(normalized)
  );
}

function isContextLengthExceededError(err: unknown) {
  const apiCallError = APICallError.isInstance(err) ? err : null;
  const record = toErrorRecord(err);
  const codes = [
    ...collectErrorCodes(apiCallError?.data),
    ...collectErrorCodes(record)
  ];
  if (codes.some((code) => CONTEXT_LIMIT_ERROR_CODES.has(code))) return true;

  const statusCode = apiCallError?.statusCode
    ?? (typeof record?.statusCode === "number" ? record.statusCode : null)
    ?? (typeof record?.status === "number" ? record.status : null);
  if (statusCode != null && ![400, 413, 422].includes(statusCode)) return false;

  return [
    ...collectErrorText(apiCallError?.responseBody),
    ...collectErrorText(apiCallError?.data),
    ...collectErrorText(err)
  ].some(hasContextLimitText);
}

function parseHttpStatusFromError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err || "");
  const match = /^request failed:\s*(\d{3})\b/.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

function isRetryableCompactionError(err: unknown) {
  if (isContextLengthExceededError(err)) return false;
  if (err instanceof ApiConflictError) return false;
  const status = parseHttpStatusFromError(err);
  if (status == null) return true;
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function sleepMsWithAbort(ms: number, signal: AbortSignal) {
  if (ms <= 0) return !signal.aborted;
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function buildSubtaskErrorText(params: {
  status: "failed" | "cancelled";
  error: string;
  subtaskSessionId?: string;
  subtaskResultText?: string;
}) {
  return buildToolText({
    toolName: "subtask",
    status: params.status,
    headers: [["subtask_session_id", params.subtaskSessionId]],
    body: typeof params.subtaskResultText === "string" ? `${params.error}\n\n${params.subtaskResultText}` : params.error
  });
}

function normalizeToolText(raw: string) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\0/g, "");
}

function oneLine(raw: string, maxLen = 240) {
  const compact = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 3))}...`;
}

function stringifyResult(raw: unknown) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function buildToolText(params: {
  toolName: string;
  status: string;
  headers?: Array<[string, string | undefined]>;
  body?: string;
}) {
  const lines = [`tool: ${params.toolName}`, `status: ${params.status}`];
  for (const [key, value] of params.headers || []) {
    const normalized = oneLine(String(value || ""), 500);
    if (!normalized) continue;
    lines.push(`${key}: ${normalized}`);
  }
  const body = normalizeToolText(String(params.body || "")).trimEnd();
  if (!body) return lines.join("\n");
  return `${lines.join("\n")}\n\n${body}`;
}

function toIntOrNull(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.floor(raw);
}

function buildToolSuccessText(params: {
  toolName: string;
  status: "completed";
  args: Record<string, unknown>;
  result: unknown;
}) {
  const resultObj = toRecordObject(params.result);

  if (params.toolName === "apply_patch") {
    const summary = toRecordObject(resultObj?.summary);
    const body = typeof resultObj?.text === "string" ? resultObj.text : "apply_patch completed";
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers: [
        ["files", summary && typeof summary.fileCount === "number" ? String(summary.fileCount) : undefined],
        ["additions", summary && typeof summary.additions === "number" ? String(summary.additions) : undefined],
        ["deletions", summary && typeof summary.deletions === "number" ? String(summary.deletions) : undefined]
      ],
      body
    });
  }

  if (params.toolName === "todolist") {
    const summary = toRecordObject(resultObj?.summary);
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers: [
        ["total", summary && typeof summary.total === "number" ? String(summary.total) : undefined],
        ["pending", summary && typeof summary.pending === "number" ? String(summary.pending) : undefined],
        ["in_progress", summary && typeof summary.inProgress === "number" ? String(summary.inProgress) : undefined],
        ["completed", summary && typeof summary.completed === "number" ? String(summary.completed) : undefined],
        ["cancelled", summary && typeof summary.cancelled === "number" ? String(summary.cancelled) : undefined]
      ],
      body: "Todo list updated."
    });
  }

  if (params.toolName === "subtask") {
    const subtaskSessionId = typeof resultObj?.subtaskSessionId === "string" ? resultObj.subtaskSessionId.trim() : "";
    const resultText = typeof resultObj?.resultText === "string" ? resultObj.resultText : "Subtask finished successfully.";
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers: [["subtask_session_id", subtaskSessionId || undefined]],
      body: resultText
    });
  }

  if (params.toolName === "scratchpad") {
    const content = typeof resultObj?.content === "string" ? resultObj.content : "";
    const body = content.length > 0 ? "Scratchpad saved" : "Scratchpad saved (empty content)";
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      body
    });
  }

  if (params.toolName === "read") {
    const source = typeof params.args.filePath === "string" ? params.args.filePath : undefined;
    const actualStart = toIntOrNull(resultObj?.actualStart);
    const actualEnd = toIntOrNull(resultObj?.actualEnd);
    const offsetOutOfRange = resultObj?.offsetOutOfRange === true;
    const range =
      offsetOutOfRange
        ? undefined
        : actualStart != null && actualEnd != null && actualEnd >= actualStart
          ? `${actualStart}-${actualEnd}`
          : actualStart != null
            ? String(actualStart)
            : undefined;
    const body = typeof resultObj?.content === "string"
      ? resultObj.content
      : typeof resultObj?.summary === "string"
        ? resultObj.summary
        : stringifyResult(params.result);
    const headers: Array<[string, string | undefined]> = [["source", source]];
    if (range) {
      headers.push(["range", range]);
    }
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers,
      body
    });
  }

  if (params.toolName === "skill") {
    const skillId = typeof resultObj?.skillId === "string" ? resultObj.skillId : (typeof params.args.skillId === "string" ? params.args.skillId : undefined);
    const filePath = typeof resultObj?.filePath === "string" ? resultObj.filePath : (typeof params.args.filePath === "string" ? params.args.filePath : undefined);
    const truncated = resultObj?.truncated === true;
    const content = typeof resultObj?.content === "string" ? resultObj.content : "";
    // V2 根读取承诺保留正文的 CRLF、孤立 CR 与尾部内容；不能复用通用
    // buildToolText() 的换行规范化和 trimEnd()。
    const headers = [
      `tool: ${params.toolName}`,
      `status: ${params.status}`,
      ...(skillId ? [`skill_id: ${skillId}`] : []),
      ...(filePath ? [`file_path: ${filePath}`] : []),
      `truncated: ${truncated ? "true" : "false"}`
    ];
    return content === "" ? headers.join("\n") : `${headers.join("\n")}\n\n${content}`;
  }

  if (params.toolName === "bash") {
    const command = typeof resultObj?.command === "string" ? resultObj.command : "";
    const exitCode = toIntOrNull(resultObj?.exitCode);
    const timedOut = resultObj?.timedOut === true;
    const outputLimitExceeded = resultObj?.outputLimitExceeded === true;
    const stdout = typeof resultObj?.stdout === "string" ? resultObj.stdout.trimEnd() : "";
    const stderr = typeof resultObj?.stderr === "string" ? resultObj.stderr.trimEnd() : "";
    const blocks: string[] = [];
    if (stdout) blocks.push(`stdout:\n${stdout}`);
    if (stderr) blocks.push(`stderr:\n${stderr}`);
    const body = blocks.length > 0 ? blocks.join("\n\n") : "(no output)";
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers: [
        ["command", command || undefined],
        ["exit_code", exitCode == null ? "null" : String(exitCode)],
        ["timed_out", timedOut ? "true" : undefined],
        ["output_limit_exceeded", outputLimitExceeded ? "true" : undefined]
      ],
      body
    });
  }

  if (params.toolName === "archive_search" || params.toolName === "archive_read") {
    const noArchive = resultObj?.noArchive === true;
    const body = noArchive
      ? "No archive yet."
      : typeof resultObj?.text === "string"
        ? resultObj.text
        : stringifyResult(params.result);
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      body
    });
  }

  if (params.toolName === "write") {
    const target = typeof params.args.filePath === "string" ? params.args.filePath : undefined;
    const body = typeof resultObj?.content === "string"
      ? resultObj.content
      : typeof resultObj?.summary === "string"
        ? resultObj.summary
        : stringifyResult(params.result);
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers: [["target", target]],
      body
    });
  }

  if (params.toolName === "visual_analyze") {
    const files = Array.isArray(resultObj?.files) ? resultObj.files.length : undefined;
    const body = typeof resultObj?.text === "string"
      ? resultObj.text
      : stringifyResult(params.result);
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      headers: [["files", typeof files === "number" ? String(files) : undefined]],
      body
    });
  }

  if (isMcpToolName(params.toolName)) {
    const body = typeof resultObj?.text === "string"
      ? resultObj.text
      : stringifyResult(resultObj?.raw ?? params.result);
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      body
    });
  }

  if (isPluginToolName(params.toolName)) {
    const body = typeof resultObj?.text === "string"
      ? resultObj.text
      : stringifyResult(resultObj?.raw ?? params.result);
    return buildToolText({
      toolName: params.toolName,
      status: params.status,
      body
    });
  }

  return buildToolText({
    toolName: params.toolName,
    status: params.status,
    body: stringifyResult(params.result)
  });
}

function buildToolErrorText(params: { toolName: string; status: "failed" | "cancelled"; error: string }) {
  return buildToolText({
    toolName: params.toolName,
    status: params.status,
    body: params.error
  });
}

function isPathInside(rootPath: string, targetPath: string) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(withSep);
}

function safePathSegment(input: string) {
  const value = String(input || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_");
  if (!value) return "unknown";
  const maxLen = 120;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

async function finalizeToolText(params: {
  workspacePath: string;
  itemId: number;
  toolName: string;
  toolCallId?: string;
  text: string;
}) {
  const normalized = normalizeToolText(params.text).trimEnd();
  if (TOOL_OUTPUT_TEXT_UNTRUNCATED_NAMES.has(params.toolName)) {
    return {
      text: normalized,
      textTruncated: false as const,
      textArtifactPath: undefined as string | undefined
    };
  }
  if (normalized.length <= TOOL_OUTPUT_TEXT_MAX_CHARS) {
    return {
      text: normalized,
      textTruncated: false as const,
      textArtifactPath: undefined as string | undefined
    };
  }

  const toolSegment = safePathSegment(params.toolName);
  const callSegment = typeof params.toolCallId === "string" && params.toolCallId.trim()
    ? safePathSegment(params.toolCallId)
    : "";
  if (!callSegment) {
    const preview = normalized.slice(0, TOOL_OUTPUT_TEXT_PREVIEW_CHARS).trimEnd();
    const text = `${preview}\n\n[truncated]\nartifact: unavailable`.trim();
    return {
      text,
      textTruncated: true as const,
      textArtifactPath: undefined as string | undefined
    };
  }

  const relativePath = path.join(
    ".awb",
    "agent",
    "artifacts",
    "by_tool_call",
    toolSegment,
    `${callSegment}.txt`
  );
  const workspaceResolvedPath = path.resolve(params.workspacePath);
  const fullPath = path.resolve(workspaceResolvedPath, relativePath);
  if (!isPathInside(workspaceResolvedPath, fullPath)) {
    throw new Error("artifact path is outside workspace");
  }

  const workspaceRealPath = await fs.realpath(workspaceResolvedPath);
  let parentDirPath = workspaceResolvedPath;
  for (const segment of [".awb", "agent", "artifacts", "by_tool_call", toolSegment]) {
    parentDirPath = path.join(parentDirPath, segment);
    const stat = await fs.lstat(parentDirPath).catch(() => null);
    if (!stat) {
      try {
        await fs.mkdir(parentDirPath);
      } catch (err: any) {
        if (!err || err.code !== "EEXIST") {
          throw err;
        }
      }
    } else {
      if (stat.isSymbolicLink()) {
        throw new Error("artifact parent directory symlink is not allowed");
      }
      if (!stat.isDirectory()) {
        throw new Error("artifact parent path must be a directory");
      }
    }
    const parentRealPath = await fs.realpath(parentDirPath);
    if (!isPathInside(workspaceRealPath, parentRealPath)) {
      throw new Error("artifact parent directory is outside workspace");
    }
  }

  const existing = await fs.lstat(fullPath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error("artifact target symlink is not allowed");
  }

  const artifactBody =
    normalized.length <= TOOL_ARTIFACT_MAX_CHARS
      ? normalized
      : `${normalized.slice(0, TOOL_ARTIFACT_MAX_CHARS)}\n\n[truncated]`;
  await fs.writeFile(fullPath, artifactBody, { encoding: "utf8" });

  const preview = normalized.slice(0, TOOL_OUTPUT_TEXT_PREVIEW_CHARS).trimEnd();
  const text = `${preview}\n\n[truncated]\nartifact: ${relativePath}`.trim();
  return {
    text,
    textTruncated: true as const,
    textArtifactPath: relativePath
  };
}

type QueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

type PendingTool = {
  itemId: number;
  status: "queued" | "running" | "streaming" | "completed" | "failed" | "cancelled";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
};

type ToolCall = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
};

type ToolExecutionBatch = {
  mode: "parallel" | "serial";
  tools: PendingTool[];
};

function isAbortLikeError(err: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = typeof (err as any).name === "string" ? (err as any).name : "";
  const code = typeof (err as any).code === "string" ? (err as any).code : "";
  const message = typeof (err as any).message === "string" ? (err as any).message : "";
  return name === "AbortError"
    || code === "ABORT_ERR"
    || /\babort(ed)?\b/i.test(message)
    || /\babort(ed)?\b/i.test(name);
}

const EMPTY_PROMPT_CONTEXT: PromptContext = {
  headItemId: null,
  system: "",
  messages: [],
  tools: [],
  pendingTools: [],
  lastResponseTotalTokens: null,
  uiLocale: null,
  externalSkillRoots: []
};

const RESERVED_MODEL_OPTION_KEYS = new Set([
  "model",
  "system",
  "prompt",
  "messages",
  "input",
  "abortSignal",
  "providerOptions",
  "tools",
  "toolChoice"
]);

function isSafeObjectKey(raw: string) {
  if (!raw) return false;
  return raw !== "__proto__" && raw !== "prototype" && raw !== "constructor";
}

function toRecordObject(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function providerOptionsKeyByNpm(npm: ExecutionProfile["provider"]["npm"]) {
  if (npm === "@ai-sdk/openai-compatible") return "openaiCompatible";
  return npm === "@ai-sdk/anthropic" ? "anthropic" : "openai";
}

function buildModelRuntimeOptions(profile: ExecutionProfile) {
  const source = toRecordObject(profile.model.options) ?? {};
  const aiSdkSource = toRecordObject(source.aiSdk) ?? {};
  const aiSdk: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(aiSdkSource)) {
    const key = rawKey.trim();
    if (!isSafeObjectKey(key)) continue;
    if (RESERVED_MODEL_OPTION_KEYS.has(key)) continue;
    aiSdk[key] = value;
  }

  if (aiSdk.maxOutputTokens === undefined && source.maxOutputTokens !== undefined) {
    aiSdk.maxOutputTokens = source.maxOutputTokens;
  }

  const providerOptionsByKey = toRecordObject(source.providerOptionsByKey) ?? {};
  const providerKey = providerOptionsKeyByNpm(profile.provider.npm);
  const providerFromMap = toRecordObject(providerOptionsByKey[providerKey]);
  const providerOptions: Record<string, unknown> = {};
  if (providerFromMap) {
    for (const [rawKey, value] of Object.entries(providerFromMap)) {
      const key = rawKey.trim();
      if (!isSafeObjectKey(key)) continue;
      providerOptions[key] = value;
    }
  }

  if (Object.keys(providerOptions).length === 0) {
    for (const [rawKey, value] of Object.entries(source)) {
      const key = rawKey.trim();
      if (!isSafeObjectKey(key)) continue;
      if (key === "aiSdk" || key === "providerOptionsByKey" || key === "maxOutputTokens") continue;
      providerOptions[key] = value;
    }
  }

  return {
    aiSdk,
    providerOptions,
    providerKey
  };
}

function hasValidPromptCacheKey(providerOptions: Record<string, unknown>) {
  const value = providerOptions.promptCacheKey;
  return typeof value === "string" && value.trim().length > 0;
}

function buildProviderOptionsWithPromptCacheKey(params: {
  providerNpm: ExecutionProfile["provider"]["npm"];
  sessionId: string;
  providerOptions: Record<string, unknown>;
}) {
  if (params.providerNpm !== "@ai-sdk/openai") return params.providerOptions;
  if (hasValidPromptCacheKey(params.providerOptions)) return params.providerOptions;

  return {
    ...params.providerOptions,
    promptCacheKey: `awb:${params.sessionId}`
  };
}

function resolveOpenAiModelFactory(sdk: Record<string, unknown>, apiMode: "responses" | "chatCompletions") {
  const responses = typeof sdk.responses === "function" ? (sdk.responses as (modelId: string) => unknown) : null;
  const chat = typeof sdk.chat === "function" ? (sdk.chat as (modelId: string) => unknown) : null;
  const chatCompletions =
    typeof sdk.chatCompletions === "function" ? (sdk.chatCompletions as (modelId: string) => unknown) : null;

  if (apiMode === "chatCompletions") {
    if (chat) return chat;
    if (chatCompletions) return chatCompletions;
    throw new Error(`openai sdk does not expose chat/chatCompletions model factories for apiMode=${apiMode}`);
  }

  if (responses) return responses;
  throw new Error(`openai sdk does not expose responses model factory for apiMode=${apiMode}`);
}

function normalizeOpenAiApiMode(raw: unknown): "responses" | "chatCompletions" {
  if (raw === "responses" || raw === "chatCompletions") return raw;
  return "responses";
}

function createLanguageModel(profile: ExecutionProfile) {
  const providerModelId =
    typeof profile.model.providerModelId === "string" && profile.model.providerModelId.trim()
      ? profile.model.providerModelId.trim()
      : profile.model.id;

  if (profile.provider.npm === "@ai-sdk/openai") {
    const sdk = createOpenAI({
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    const apiMode = normalizeOpenAiApiMode(profile.provider.options.apiMode);
    const createModel = resolveOpenAiModelFactory(sdk as unknown as Record<string, unknown>, apiMode);
    return createModel(providerModelId);
  }

  if (profile.provider.npm === "@ai-sdk/openai-compatible") {
    const sdk = createOpenAICompatible({
      name: profile.provider.id,
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    return sdk.chatModel(providerModelId);
  }

  if (profile.provider.npm === "@ai-sdk/anthropic") {
    const sdk = createAnthropic({
      apiKey: profile.provider.options.apiKey,
      baseURL: profile.provider.options.baseURL
    });
    return sdk(providerModelId);
  }

  throw new Error(`unsupported provider npm: ${profile.provider.npm}`);
}

function isSensitiveKey(rawKey: string) {
  const key = rawKey.toLowerCase();
  return (
    key === "authorization" ||
    key === "api_key" ||
    key === "apikey" ||
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password")
  );
}

function sanitizeForDebugDump(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDebugDump(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (isSensitiveKey(key)) {
      result[key] = "***";
      continue;
    }
    result[key] = sanitizeForDebugDump(item);
  }
  return result;
}

async function writeItemLog(params: {
  logger: Pick<Console, "warn">;
  workspacePath: string;
  kind: "assistant" | "tool";
  itemId: number;
  payload: unknown;
}) {
  if (!DEBUG_DUMP_ENABLED) return;
  const dirPath = path.join(params.workspacePath, DEBUG_DUMP_RELATIVE_DIR, params.kind);
  const filePath = path.join(dirPath, `${params.itemId}.log`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(sanitizeForDebugDump(params.payload), null, 2), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    params.logger.warn(`[agent-worker] write item log failed: ${message}`);
  }
}

function normalizeToolName(raw: unknown, available: Set<string>): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (!available.has(value)) return null;
  return value;
}

function normalizeToolArgs(raw: unknown) {
  const value = toRecordObject(raw);
  return value ?? {};
}

function toolSignature(toolName: string, args: Record<string, unknown>) {
  return `${toolName}:${JSON.stringify(args)}`;
}

function isSubtaskTool(toolName: string) {
  return toolName === "subtask";
}

function isConcurrentExecutionTool(toolName: string) {
  return toolName === "bash" || toolName === "subtask";
}

function toNonNegativeInt(raw: unknown) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function extractTotalTokens(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return toNonNegativeInt(raw);
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;

  const direct =
    toNonNegativeInt(usage.totalTokens) ??
    toNonNegativeInt(usage.total_tokens) ??
    toNonNegativeInt(usage.total);
  if (direct != null) return direct;

  const input =
    toNonNegativeInt(usage.inputTokens) ??
    toNonNegativeInt(usage.promptTokens) ??
    toNonNegativeInt(usage.input_tokens) ??
    toNonNegativeInt(usage.prompt_tokens);
  const output =
    toNonNegativeInt(usage.outputTokens) ??
    toNonNegativeInt(usage.completionTokens) ??
    toNonNegativeInt(usage.output_tokens) ??
    toNonNegativeInt(usage.completion_tokens);
  if (input != null && output != null) {
    return input + output;
  }

  return null;
}

async function readStreamTotalTokens(stream: unknown): Promise<number | null> {
  const streamObj = stream as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (streamObj.usage !== undefined) candidates.push(streamObj.usage);
  if (streamObj.totalUsage !== undefined) candidates.push(streamObj.totalUsage);
  if (streamObj.response !== undefined) candidates.push(streamObj.response);

  for (const candidate of candidates) {
    try {
      const resolved = candidate && typeof (candidate as Promise<unknown>).then === "function"
        ? await (candidate as Promise<unknown>)
        : candidate;
      const total = extractTotalTokens(resolved);
      if (total != null) return total;

      if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
        const nested = resolved as Record<string, unknown>;
        const usage = nested.usage ?? nested.totalUsage;
        const nestedTotal = extractTotalTokens(usage);
        if (nestedTotal != null) return nestedTotal;
      }
    } catch {
      // ignore usage parse failures
    }
  }

  return null;
}

function buildToolExecutionBatches(tools: PendingTool[], parallelLimit = TOOL_PARALLEL_BATCH_LIMIT): ToolExecutionBatch[] {
  const batches: ToolExecutionBatch[] = [];
  const limit = Math.max(1, Math.floor(parallelLimit));
  let index = 0;

  while (index < tools.length) {
    const current = tools[index];
    if (!current) break;

    if (!isConcurrentExecutionTool(current.toolName)) {
      batches.push({ mode: "serial", tools: [current] });
      index += 1;
      continue;
    }

    const concurrentToolName = current.toolName;
    const concurrentTools: PendingTool[] = [];
    while (index < tools.length) {
      const item = tools[index];
      if (!item || item.toolName !== concurrentToolName) break;
      concurrentTools.push(item);
      index += 1;
    }

    for (let offset = 0; offset < concurrentTools.length; offset += limit) {
      batches.push({
        mode: "parallel",
        tools: concurrentTools.slice(offset, offset + limit)
      });
    }
  }

  return batches;
}

export function buildToolExecutionBatchesForTest(tools: PendingTool[], parallelLimit = TOOL_PARALLEL_BATCH_LIMIT) {
  return buildToolExecutionBatches(tools, parallelLimit);
}

export function buildToolSuccessTextForTest(params: { toolName: string; args: Record<string, unknown>; result: unknown }) {
  return buildToolSuccessText({
    toolName: params.toolName,
    status: "completed",
    args: params.args,
    result: params.result
  });
}

type AgentRunnerDeps = {
  streamText?: typeof streamText;
  nowMs?: () => number;
  warningNowMs?: () => number;
};

type StreamTextResultLike = {
  fullStream: AsyncIterable<unknown>;
  reasoningText?: PromiseLike<unknown>;
  usage?: PromiseLike<unknown> | unknown;
  totalUsage?: PromiseLike<unknown> | unknown;
  response?: PromiseLike<unknown> | unknown;
};

export class AgentRunner {
  private readonly queue: QueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pluginRuntimeManager: PluginRuntimeManager;
  private readonly nestedChildrenByParent = new Map<string, Set<string>>();
  private readonly nestedParentByChild = new Map<string, string>();
  private readonly toolRegistry: ToolRegistry;
  private activeCount = 0;
  private readonly toolErrorWarningLimiter = new Map<string, { windowStartedAt: number; suppressed: number }>();

  private readonly streamTextFn: typeof streamText;
  private readonly nowMsFn: () => number;
  private readonly warningNowMsFn: () => number;

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly mcpManager: McpManager,
    private readonly logger: Pick<Console, "info" | "warn" | "error">,
    private readonly concurrency: number,
    deps: AgentRunnerDeps = {}
  ) {
    this.streamTextFn = deps.streamText ?? streamText;
    this.nowMsFn = deps.nowMs ?? nowMs;
    this.warningNowMsFn = deps.warningNowMs ?? nowMs;
    this.pluginRuntimeManager = new PluginRuntimeManager(this.logger);
    const pluginProvider = REMOTE_PLUGIN_TOOLS_ENABLED
      ? new RemotePluginToolProvider()
      : new LocalPluginToolProvider(this.pluginRuntimeManager);
    this.toolRegistry = new ToolRegistry([new BuiltinToolProvider(), new McpToolProvider(this.mcpManager), pluginProvider]);
  }

  enqueueRun(run: QueuedRun) {
    if (this.queuedRunIds.has(run.runId)) return;
    this.queue.push(run);
    this.queuedRunIds.add(run.runId);
    this.pump();
  }

  private registerController(sessionId: string, controller: AbortController) {
    const existing = this.controllers.get(sessionId);
    if (existing && existing !== controller) {
      this.logger.error(`[agent-worker] controller conflict for session: ${sessionId}`);
      throw new Error(`controller conflict for session: ${sessionId}`);
    }
    this.controllers.set(sessionId, controller);
  }

  private unlinkNestedChild(childSessionId: string) {
    const parentSessionId = this.nestedParentByChild.get(childSessionId);
    if (!parentSessionId) return;
    this.nestedParentByChild.delete(childSessionId);
    const children = this.nestedChildrenByParent.get(parentSessionId);
    if (!children) return;
    children.delete(childSessionId);
    if (children.size === 0) {
      this.nestedChildrenByParent.delete(parentSessionId);
    }
  }

  private linkNestedChild(parentSessionId: string, childSessionId: string) {
    const existingParent = this.nestedParentByChild.get(childSessionId);
    if (existingParent && existingParent !== parentSessionId) {
      this.logger.error(`[agent-worker] nested child already linked: child=${childSessionId} parent=${existingParent} newParent=${parentSessionId}`);
      throw new Error(`nested child already linked: ${childSessionId}`);
    }
    this.nestedParentByChild.set(childSessionId, parentSessionId);
    let children = this.nestedChildrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set<string>();
      this.nestedChildrenByParent.set(parentSessionId, children);
    }
    children.add(childSessionId);
  }

  private deleteControllerIfSame(sessionId: string, controller: AbortController) {
    if (this.controllers.get(sessionId) === controller) {
      this.controllers.delete(sessionId);
    }
  }

  private removeQueuedRunsBySession(sessionId: string) {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      if (!item || item.sessionId !== sessionId) continue;
      this.queuedRunIds.delete(item.runId);
      this.queue.splice(i, 1);
    }
  }

  private abortSessionTree(sessionId: string, visited = new Set<string>()) {
    if (visited.has(sessionId)) return;
    visited.add(sessionId);
    const controller = this.controllers.get(sessionId);
    controller?.abort();
    this.removeQueuedRunsBySession(sessionId);
    const children = this.nestedChildrenByParent.get(sessionId);
    if (!children || children.size === 0) return;
    for (const childSessionId of [...children]) {
      this.abortSessionTree(childSessionId, visited);
    }
  }

  cancelSession(sessionId: string) {
    this.abortSessionTree(sessionId);
  }

  private pump() {
    while (this.activeCount < this.concurrency) {
      const index = this.queue.findIndex((item) => !this.runningSessions.has(item.sessionId));
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1);
      if (!next) return;
      this.queuedRunIds.delete(next.runId);
      this.startRun(next);
    }
  }

  private startRun(run: QueuedRun) {
    this.activeCount += 1;
    this.runningSessions.add(run.sessionId);
    let controller: AbortController;
    try {
      controller = new AbortController();
      this.registerController(run.sessionId, controller);
    } catch (err) {
      this.runningSessions.delete(run.sessionId);
      this.activeCount -= 1;
      this.logger.error("worker startRun failed", err);
      this.pump();
      return;
    }

    void this.processRun(run, controller.signal)
      .catch((err) => {
        this.logger.error("worker run failed", err);
      })
      .finally(() => {
        this.deleteControllerIfSame(run.sessionId, controller);
        this.unlinkNestedChild(run.sessionId);
        this.runningSessions.delete(run.sessionId);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async processNestedRunWithController(params: {
    parentSessionId: string;
    run: QueuedRun;
    parentSignal: AbortSignal;
  }) {
    const childController = new AbortController();
    const onParentAbort = () => {
      childController.abort();
    };
    try {
      this.registerController(params.run.sessionId, childController);
      this.linkNestedChild(params.parentSessionId, params.run.sessionId);
      if (params.parentSignal.aborted) {
        childController.abort();
      } else {
        params.parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
      await this.processRun(params.run, childController.signal);
    } catch (err) {
      this.deleteControllerIfSame(params.run.sessionId, childController);
      this.unlinkNestedChild(params.run.sessionId);
      throw err;
    } finally {
      params.parentSignal.removeEventListener("abort", onParentAbort);
      this.deleteControllerIfSame(params.run.sessionId, childController);
      this.unlinkNestedChild(params.run.sessionId);
    }
  }

  private toolSourceForArtifact(toolName: string) {
    if (isMcpToolName(toolName)) return "mcp" as const;
    if (isPluginToolName(toolName)) return "plugin" as const;
    return "builtin" as const;
  }

  private async warnToolErrorStore(
    results: Awaited<ReturnType<NonNullable<ToolFailureCapture>["publish"]>>,
    workspacePath: string
  ) {
    for (const result of results) {
      if (result.outcome !== "failed") continue;
      await this.warnToolErrorStoreFailure({ ...result, workspacePath });
    }
  }

  private async warnToolErrorStoreFailure(input: {
    operation: string;
    error: unknown;
    relativePath?: string;
    workspacePath?: string;
  }) {
    const now = this.warningNowMsFn();
    const windowMs = 60_000;
    const code = input.error && typeof input.error === "object"
      ? String((input.error as NodeJS.ErrnoException).code ?? "unknown").trim().toUpperCase()
      : "unknown";
    let workspaceKey = "unknown";
    if (input.workspacePath) {
      try {
        workspaceKey = await fs.realpath(input.workspacePath);
      } catch {
        workspaceKey = path.resolve(input.workspacePath);
      }
    }
    const key = `${workspaceKey}\u0000${input.relativePath ?? "unknown"}\u0000${input.operation}\u0000${code}`;
    const current = this.toolErrorWarningLimiter.get(key);
    if (current && now - current.windowStartedAt < windowMs) {
      current.suppressed += 1;
      return;
    }

    const suppressed = current?.suppressed ?? 0;
    this.toolErrorWarningLimiter.set(key, { windowStartedAt: now, suppressed: 0 });
    this.logger.warn(formatToolErrorStoreWarning({
      relativePath: input.relativePath,
      operation: input.operation,
      error: input.error,
      ...(suppressed > 0 ? { suppressed } : {})
    }));
  }

  private async executeTool(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    tool: PendingTool;
    parentSessionId: string;
    signal: AbortSignal;
    availableToolNames?: ReadonlySet<string>;
    promptContext: PromptContext;
    capture?: ToolFailureCapture | null;
  }) {
    const { profile, run, tool, signal, capture } = params;
    if (signal.aborted) return { paused: false as const };

    const outputBase = {
      type: "tool" as const,
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      args: tool.args
    };
    const writeback = async (role: string, input: { status: "running" | "completed" | "failed"; output: any }) => {
      capture?.recordWritebackAttempt(role, input.output);
      try {
        const response = await this.apiClient.updateContextItem({
          itemId: tool.itemId,
          status: input.status,
          output: input.output,
          updatedAt: nowMs()
        });
        capture?.recordWritebackSuccess(role, response);
        return response;
      } catch (error) {
        capture?.recordWritebackFailure(role, error);
        throw error;
      }
    };

    const executionAvailableToolNames = params.availableToolNames ?? (() => {
      const names = new Set<string>();
      for (const name of profile.agent.tools ?? []) names.add(name);
      for (const name of profile.agent.pluginTools ?? []) names.add(name);
      return names;
    })();
    if (!(await this.toolRegistry.isToolEnabled(tool.toolName, {
      profile,
      promptContext: EMPTY_PROMPT_CONTEXT,
      apiClient: this.apiClient,
      availableToolNames: executionAvailableToolNames
    }))) {
      const failedOutput = {
        ...outputBase,
        text: buildToolErrorText({ toolName: tool.toolName, status: "failed", error: `tool is disabled for current agent: ${tool.toolName}` }),
        error: `tool is disabled for current agent: ${tool.toolName}`
      };
      capture?.recordEvent("tool_disabled_execute_check", failedOutput.error, { output: failedOutput });
      const error = `tool is disabled for current agent: ${tool.toolName}`;
      await writeback("policy_failed", {
        status: "failed",
        output: failedOutput
      });
      return { paused: false as const };
    }

    let phase: "running_writeback" | "provider_execute" | "completed_output_build" | "completed_writeback" = "running_writeback";
    let providerResult: unknown;
    let providerReturned = false;
    try {
      await writeback("initial_running", {
        status: "running",
        output: {
          ...outputBase,
          ...(tool.toolName === "apply_patch" ? { text: buildToolText({ toolName: tool.toolName, status: "running", body: "apply_patch running" }) } : {})
        }
      });
      phase = "provider_execute";
      const toolCtx: ToolExecutionContext = {
        profile,
        run,
        pendingTool: {
          itemId: tool.itemId,
          status: tool.status,
          toolName: tool.toolName,
          toolCallId: tool.toolCallId,
          args: tool.args
        },
        signal,
        apiClient: this.apiClient,
        promptContext: params.promptContext,
        processNestedRun: (nestedRun, nestedSignal) => this.processNestedRunWithController({
          parentSessionId: params.parentSessionId,
          run: nestedRun,
          parentSignal: nestedSignal
        }),
        updateToolItem: async ({ status, output }) => {
          if (status !== "running") {
            throw new Error("provider terminal tool writeback is not supported by tool error capture");
          }
          await writeback("provider_running_update", { status, output });
        },
        nowMs,
        reportRunningOutput: async (patch) => {
          await writeback("provider_running_report", {
            status: "running",
            output: { ...outputBase, ...(typeof patch.text === "string" ? { text: patch.text } : {}), ...(patch.result !== undefined ? { result: patch.result } : {}) }
          });
        },
        renderToolText: (input) => buildToolText(input)
      };
      capture?.recordProviderStarted();
      providerResult = await this.toolRegistry.execute(tool.toolName, tool.args, toolCtx);
      providerReturned = true;
      capture?.recordProviderResult(providerResult);

      if (signal.aborted) return { paused: false as const };

      phase = "completed_output_build";
      const rawSuccessText = buildToolSuccessText({
        toolName: tool.toolName,
        status: "completed",
        args: tool.args,
        result: providerResult
      });
      let finalizedText: {
        text: string;
        textTruncated: boolean;
        textArtifactPath?: string;
      };
      try {
        finalizedText = await finalizeToolText({
          workspacePath: run.workspacePath,
          itemId: tool.itemId,
          toolName: tool.toolName,
          toolCallId: tool.toolCallId,
          text: rawSuccessText
        });
      } catch (artifactErr) {
        const message = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
        this.logger.warn(`[agent-worker] persist tool artifact failed(item=${tool.itemId}, tool=${tool.toolName}): ${message}`);
        const needsTruncate = rawSuccessText.length > TOOL_OUTPUT_TEXT_MAX_CHARS;
        const preview = rawSuccessText.slice(0, TOOL_OUTPUT_TEXT_PREVIEW_CHARS).trimEnd();
        finalizedText = {
          text: needsTruncate
            ? `${preview}\n\n[truncated]\nartifact: unavailable`
            : rawSuccessText,
          textTruncated: needsTruncate
        };
      }

      const output = {
        ...outputBase,
        text: finalizedText.text,
        ...(finalizedText.textTruncated ? { textTruncated: true } : {}),
        ...(finalizedText.textArtifactPath ? { textArtifactPath: finalizedText.textArtifactPath } : {}),
        result: providerResult
      };
      phase = "completed_writeback";
      await writeback("completed", { status: "completed", output });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, toolItemId: tool.itemId },
          request: { toolName: tool.toolName, toolCallId: tool.toolCallId, args: tool.args },
          status: "completed",
          response: providerResult
        }
      });
      return { paused: false as const };
    } catch (err) {
      if (isAbortLikeError(err, signal)) return { paused: false as const };
      if (phase === "running_writeback") capture?.recordEvent("running_writeback_failed", err);
      else if (phase === "provider_execute") {
        capture?.recordEvent("provider_execute_rejected", err);
        for (const partial of extractPartialToolResults(err, tool.toolName)) capture?.recordPartialResult(partial.source, partial.value);
      } else if (phase === "completed_output_build") capture?.recordEvent("completed_output_build_failed", err);
      else capture?.recordEvent("completed_writeback_failed", err);

      const error = err instanceof Error ? err.message : String(err);
      const subtaskSessionId = err && typeof err === "object" ? String((err as any).subtaskSessionId || "").trim() : "";
      const subtaskResultText = err && typeof err === "object" && typeof (err as any).subtaskResultText === "string"
        ? (err as any).subtaskResultText as string
        : undefined;
      const isSubtaskWithResult = tool.toolName === "subtask" && (subtaskSessionId || typeof subtaskResultText === "string");
      const errorText = isSubtaskWithResult
        ? buildSubtaskErrorText({ status: "failed", error, subtaskSessionId: subtaskSessionId || undefined, subtaskResultText })
        : buildToolErrorText({ toolName: tool.toolName, status: "failed", error });
      const failedOutput = {
        ...outputBase,
        text: errorText,
        ...(isSubtaskWithResult ? { result: { ...(subtaskSessionId ? { subtaskSessionId } : {}), ...(typeof subtaskResultText === "string" ? { resultText: subtaskResultText } : {}) } } : {}),
        error
      };
      try {
        await writeback("inner_failed", { status: "failed", output: failedOutput });
      } catch (writebackError) {
        capture?.recordEvent("failed_writeback_failed", writebackError);
        throw writebackError;
      }
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, toolItemId: tool.itemId },
          request: { toolName: tool.toolName, toolCallId: tool.toolCallId, args: tool.args },
          status: "failed",
          error
        }
      });
      return { paused: false as const };
    }
  }

  private async executeToolSafely(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    tool: PendingTool;
    parentSessionId: string;
    signal: AbortSignal;
    availableToolNames?: ReadonlySet<string>;
    promptContext: PromptContext;
  }) {
    if (params.signal.aborted) return { paused: false as const };
    const capture = createToolFailureCaptureIfEnabled({
      workspacePath: params.run.workspacePath,
      workspaceId: params.run.workspaceId,
      sessionId: params.run.sessionId,
      runId: params.run.runId,
      itemId: params.tool.itemId,
      toolCallId: params.tool.toolCallId,
      toolName: params.tool.toolName,
      toolSource: this.toolSourceForArtifact(params.tool.toolName)
    }, params.tool.args, this.nowMsFn);
    let aborted = false;
    try {
      return await this.executeTool({ ...params, capture });
    } catch (err) {
      if (params.signal.aborted || isAbortLikeError(err, params.signal)) {
        aborted = true;
        return { paused: false as const };
      }
      capture?.recordEvent("runner_outer_unhandled", err);
      const error = err instanceof Error ? err.message : String(err);
      const output = {
        type: "tool" as const,
        toolName: params.tool.toolName,
        toolCallId: params.tool.toolCallId,
        args: params.tool.args,
        text: buildToolErrorText({ toolName: params.tool.toolName, status: "failed", error }),
        error
      };
      try {
        capture?.recordWritebackAttempt("outer_failed", output);
        const response = await this.apiClient.updateContextItem({ itemId: params.tool.itemId, status: "failed", output, updatedAt: nowMs() });
        capture?.recordWritebackSuccess("outer_failed", response);
      } catch (writebackError) {
        capture?.recordWritebackFailure("outer_failed", writebackError);
        capture?.recordEvent("outer_failed_writeback_failed", writebackError);
      }
      await writeItemLog({
        logger: this.logger,
        workspacePath: params.run.workspacePath,
        kind: "tool",
        itemId: params.tool.itemId,
        payload: {
          meta: { workspaceId: params.run.workspaceId, sessionId: params.run.sessionId, runId: params.run.runId, toolItemId: params.tool.itemId },
          request: { toolName: params.tool.toolName, toolCallId: params.tool.toolCallId, args: params.tool.args },
          status: "failed",
          error
        }
      });
      return { paused: false as const };
    } finally {
      if (aborted || params.signal.aborted) capture?.discard();
      if (capture?.hasEvents()) {
        try {
          await this.warnToolErrorStore(await capture.publish(), params.run.workspacePath);
        } catch (error) {
          await this.warnToolErrorStoreFailure({ operation: "publish", error, workspacePath: params.run.workspacePath });
        }
      }
    }
  }

  private async executeToolBatch(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    batch: ToolExecutionBatch;
    signal: AbortSignal;
    availableToolNames?: ReadonlySet<string>;
    promptContext: PromptContext;
  }) {
    if (params.batch.mode === "serial") {
      const tool = params.batch.tools[0];
      if (!tool) return { paused: false as const };
      return await this.executeToolSafely({ ...params, tool, availableToolNames: params.availableToolNames, parentSessionId: params.run.sessionId });
    }
    const settled = await Promise.allSettled(
      params.batch.tools.map((tool) => this.executeToolSafely({ ...params, tool, availableToolNames: params.availableToolNames, parentSessionId: params.run.sessionId }))
    );
    return { paused: settled.some((item) => item.status === "fulfilled" && item.value.paused) } as const;
  }

  private async executePendingTools(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    availableToolNames?: ReadonlySet<string>;
    signal: AbortSignal;
  }) {
    const promptContextForAvailability = params.context.tools ? params.context : {
      ...EMPTY_PROMPT_CONTEXT,
      ...params.context,
      tools: params.context.tools ?? []
    };
    const availableToolNames = params.availableToolNames ?? new Set<string>((await this.toolRegistry.listTools({
      profile: params.profile,
      promptContext: promptContextForAvailability,
      apiClient: this.apiClient
    })).map((tool) => tool.name));
    const batches: ToolExecutionBatch[] = [];
    let segment: PendingTool[] = [];
    const flushSegment = () => {
      if (segment.length === 0) return;
      batches.push(...buildToolExecutionBatches(segment));
      segment = [];
    };

    for (const item of params.context.pendingTools) {
      if (!(await this.toolRegistry.isToolEnabled(item.toolName, {
        profile: params.profile,
        promptContext: promptContextForAvailability,
        apiClient: this.apiClient,
        availableToolNames
      }))) {
        flushSegment();
        const error = `tool is disabled for current agent: ${item.toolName}`;
        const output = {
          type: "tool" as const,
          toolName: item.toolName,
          toolCallId: item.toolCallId,
          args: item.args,
          text: buildToolErrorText({ toolName: item.toolName, status: "failed", error }),
          error
        };
        const artifactToolCallId = String(item.toolCallId || "").trim();
        const capture = artifactToolCallId ? createToolFailureCaptureIfEnabled({
          workspacePath: params.run.workspacePath,
          workspaceId: params.run.workspaceId,
          sessionId: params.run.sessionId,
          runId: params.run.runId,
          itemId: item.itemId,
          toolCallId: artifactToolCallId,
          toolName: item.toolName,
          toolSource: this.toolSourceForArtifact(item.toolName)
        }, item.args, this.nowMsFn) : null;
        capture?.recordEvent("tool_disabled_pending_precheck", error, { output });
        try {
          capture?.recordWritebackAttempt("policy_failed", output);
          const response = await this.apiClient.updateContextItem({ itemId: item.itemId, status: "failed", output, updatedAt: nowMs() });
          capture?.recordWritebackSuccess("policy_failed", response);
        } catch (writebackError) {
          capture?.recordWritebackFailure("policy_failed", writebackError);
          capture?.recordEvent("failed_writeback_failed", writebackError);
          throw writebackError;
        } finally {
          if (params.signal.aborted) capture?.discard();
          if (capture?.hasEvents()) {
            try { await this.warnToolErrorStore(await capture.publish(), params.run.workspacePath); }
            catch (storeError) { await this.warnToolErrorStoreFailure({ operation: "publish", error: storeError, workspacePath: params.run.workspacePath }); }
          }
        }
        continue;
      }
      if (item.status === "running") {
        flushSegment();
        const outputBase = {
          type: "tool" as const,
          toolName: item.toolName,
          toolCallId: item.toolCallId,
          args: item.args
        };
        const error = "tool execution interrupted, mark failed and wait next step";
        const output = {
          ...outputBase,
          text: buildToolErrorText({ toolName: item.toolName, status: "failed", error }),
          error
        };
        const artifactToolCallId = String(item.toolCallId || "").trim();
        const capture = artifactToolCallId ? createToolFailureCaptureIfEnabled({
          workspacePath: params.run.workspacePath,
          workspaceId: params.run.workspaceId,
          sessionId: params.run.sessionId,
          runId: params.run.runId,
          itemId: item.itemId,
          toolCallId: artifactToolCallId,
          toolName: item.toolName,
          toolSource: this.toolSourceForArtifact(item.toolName)
        }, item.args, this.nowMsFn) : null;
        capture?.recordEvent("running_item_recovered_as_failed", error, { output });
        try {
          capture?.recordWritebackAttempt("recovery_failed", output);
          const response = await this.apiClient.updateContextItem({ itemId: item.itemId, status: "failed", output, updatedAt: nowMs() });
          capture?.recordWritebackSuccess("recovery_failed", response);
        } catch (writebackError) {
          capture?.recordWritebackFailure("recovery_failed", writebackError);
          capture?.recordEvent("failed_writeback_failed", writebackError);
          throw writebackError;
        } finally {
          if (params.signal.aborted) capture?.discard();
          if (capture?.hasEvents()) {
            try { await this.warnToolErrorStore(await capture.publish(), params.run.workspacePath); }
            catch (storeError) { await this.warnToolErrorStoreFailure({ operation: "publish", error: storeError, workspacePath: params.run.workspacePath }); }
          }
        }
        await writeItemLog({
          logger: this.logger,
          workspacePath: params.run.workspacePath,
          kind: "tool",
          itemId: item.itemId,
          payload: {
            meta: {
              workspaceId: params.run.workspaceId,
              sessionId: params.run.sessionId,
              runId: params.run.runId,
              toolItemId: item.itemId
            },
            request: {
              toolName: item.toolName,
              toolCallId: item.toolCallId,
              args: item.args
            },
            status: "failed",
            error
          }
        });
        continue;
      }
      if (item.status !== "queued") {
        flushSegment();
        continue;
      }
      const toolCallId = String(item.toolCallId || "").trim();
      if (!toolCallId) {
        flushSegment();
        continue;
      }
      segment.push({
        itemId: item.itemId,
        status: item.status,
        toolName: item.toolName,
        toolCallId,
        args: item.args
      });
    }

    flushSegment();
    for (const batch of batches) {
      const result = await this.executeToolBatch({
        profile: params.profile,
          run: params.run,
          batch,
          signal: params.signal,
          promptContext: params.context,
          availableToolNames
        });
      if (result.paused) {
        return { paused: true as const };
      }
      if (params.signal.aborted) {
        return { paused: false as const };
      }
    }

    await this.apiClient.updateRunState({
      workspaceId: params.run.workspaceId,
      sessionId: params.run.sessionId,
      status: "running",
      activeRunId: params.run.runId,
      activeAssistantItemId: null,
      updatedAt: nowMs()
    });
    return { paused: false as const };
  }

  private shouldAutoCompact(params: {
    context: PromptContext;
    model: ExecutionProfile["model"];
    runtime: ExecutionProfile["runtime"];
  }) {
    const maxContextTokens = Math.max(1, Math.floor(Number(params.model.contextWindowTokens || 0)));
    const thresholdPct = Math.max(50, Math.min(99, Math.floor(Number(params.runtime.autoCompactThresholdPct || 80))));
    const lastTotalTokens = typeof params.context.lastResponseTotalTokens === "number"
      ? Math.max(0, Math.floor(params.context.lastResponseTotalTokens))
      : null;
    if (lastTotalTokens == null) return false;
    const threshold = Math.floor(maxContextTokens * (thresholdPct / 100));
    return lastTotalTokens >= threshold;
  }

  private selectCompactionModel(params: {
    profile: ExecutionProfile;
    context: PromptContext;
  }) {
    const primary = {
      provider: params.profile.provider,
      model: params.profile.model
    };
    const candidate = params.profile.compaction
      ? {
          provider: params.profile.compaction.provider,
          model: params.profile.compaction.model
        }
      : null;
    if (!candidate) return { profile: primary, isCandidate: false };

    const lastTotalTokens = typeof params.context.lastResponseTotalTokens === "number"
      && Number.isFinite(params.context.lastResponseTotalTokens)
      ? Math.max(0, Math.floor(params.context.lastResponseTotalTokens))
      : null;
    const candidateContextWindow = Math.max(1, Math.floor(Number(candidate.model.contextWindowTokens || 0)));
    if (lastTotalTokens == null || lastTotalTokens <= candidateContextWindow) {
      return { profile: candidate, isCandidate: true };
    }
    return { profile: primary, isCandidate: false };
  }

  private isSameCompactionModelProfile(
    left: { provider: ExecutionProfile["provider"]; model: ExecutionProfile["model"] },
    right: { provider: ExecutionProfile["provider"]; model: ExecutionProfile["model"] }
  ) {
    return left.provider.id === right.provider.id && left.model.id === right.model.id;
  }

  protected async generateSingleCallSummary(params: {
    profile: {
      provider: ExecutionProfile["provider"];
      model: ExecutionProfile["model"];
    };
    input: {
      messages: Array<{ role: string; content: unknown }>;
      system?: string;
      sessionId?: string;
      timeoutMs: number;
      abortSignal: AbortSignal;
    };
  }) {
    // one-shot summary 若提供 sessionId，则共享主模型请求的 OpenAI 默认 promptCacheKey 策略。
    return generateSingleCallText(params.profile, params.input);
  }

  protected async generateCompactionSummary(params: {
    profile: ExecutionProfile;
    context: PromptContext;
    signal: AbortSignal;
  }) {
    const messagesContext = await this.apiClient.getMessagesContext({
      workspaceId: params.profile.resolved.workspaceId,
      sessionId: params.profile.resolved.sessionId,
      appendMessage: {
        role: "user",
        content: buildCompactionUserPrompt({ uiLocale: params.context.uiLocale })
      }
    });
    const primary = {
      provider: params.profile.provider,
      model: params.profile.model
    };
    const selected = this.selectCompactionModel({
      profile: params.profile,
      context: params.context
    });
    const generateSummary = async (profile: typeof primary) => await this.generateSingleCallSummary({
      profile: {
        provider: profile.provider,
        model: profile.model
      },
      input: {
        // compaction 是内部摘要任务，不继承执行态完整 system prompt；使用 messages-context 提供的 one-shot system。
        system: messagesContext.system,
        sessionId: params.profile.resolved.sessionId,
        messages: messagesContext.messages,
        timeoutMs: COMPACTION_TIMEOUT_MS,
        abortSignal: params.signal
      }
    });

    let response;
    try {
      response = await generateSummary(selected.profile);
    } catch (err) {
      if (
        selected.isCandidate
        && !params.signal.aborted
        && !this.isSameCompactionModelProfile(selected.profile, primary)
        && isContextLengthExceededError(err)
      ) {
        response = await generateSummary(primary);
      } else {
        throw err;
      }
    }
    return String(response.text || "").trim();
  }

  private async compactContext(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    signal: AbortSignal;
  }) {
    const { profile, run, context, signal } = params;

    const modelRequestMaxRetries = Math.max(0, Math.floor((profile as any).runtime?.modelRequestMaxRetries ?? 0));
    const clearCompactionNotice = async () => {
      try {
        await this.apiClient.updateRunState({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          status: "running",
          activeRunId: run.runId,
          activeAssistantItemId: null,
          runNoticeText: "",
          updatedAt: nowMs()
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[agent-worker] clear compaction notice failed(session=${run.sessionId}, run=${run.runId}): ${message}`
        );
      }
    };

    const updateCompactionSuccessState = async () => {
      try {
        await this.apiClient.updateRunState({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          status: "running",
          activeRunId: run.runId,
          activeAssistantItemId: null,
          runNoticeText: "",
          lastResponseTotalTokens: null,
          updatedAt: nowMs()
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[agent-worker] update run state after compaction success failed(session=${run.sessionId}, run=${run.runId}): ${message}`
        );
      }
    };

    let retryCount = 0;

    while (!signal.aborted) {
      const expectedHeadItemId = context.headItemId;
      if (expectedHeadItemId == null) return false;

      try {
        const summaryText = await this.generateCompactionSummary({
          profile,
          context,
          signal
        });
        if (!summaryText) {
          await clearCompactionNotice();
          return false;
        }

        const compacted = await this.apiClient.compactContext({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          expectedHeadItemId,
          summaryText
        });
        if (!compacted.compacted) {
          await clearCompactionNotice();
          return false;
        }

        await updateCompactionSuccessState();
        return true;
      } catch (err) {
        if (signal.aborted) return false;
        const canRetry = retryCount < modelRequestMaxRetries && isRetryableCompactionError(err);
        if (!canRetry) {
          throw err;
        }

        const delayMs = computeRetryBackoffMs(retryCount);
        const retryAttempt = retryCount + 1;
        const message = err instanceof Error ? err.message : String(err);
        const noticeText = `Compaction failed, retrying in ${Math.floor(delayMs / 1000)}s (${retryAttempt}/${modelRequestMaxRetries}): ${message}`;
        this.logger.warn(
          `[agent-worker] compaction retry scheduled(session=${run.sessionId}, run=${run.runId}, retry=${retryAttempt}/${modelRequestMaxRetries}): ${message}`
        );
        try {
          await this.apiClient.updateRunState({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            status: "running",
            activeRunId: run.runId,
            activeAssistantItemId: null,
            runNoticeText: noticeText,
            updatedAt: nowMs()
          });
        } catch (noticeErr) {
          const noticeMessage = noticeErr instanceof Error ? noticeErr.message : String(noticeErr);
          this.logger.warn(
            `[agent-worker] update compaction retry notice failed(session=${run.sessionId}, run=${run.runId}, retry=${retryAttempt}/${modelRequestMaxRetries}): ${noticeMessage}`
          );
        }

        retryCount = retryAttempt;
        const continueRunning = await sleepMsWithAbort(delayMs, signal);
        if (!continueRunning) return false;
      }
    }

    return false;
  }

  private async runModelStep(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    step: number;
    signal: AbortSignal;
    repeatedToolCallCounter: Map<string, number>;
  }) {
    const { profile, run, context, step, signal, repeatedToolCallCounter } = params;
    const model = createLanguageModel(profile);
    const runtimeOptions = buildModelRuntimeOptions(profile);
    const turnId = newSortableId("turn");

    const modelIdleTimeoutMs =
      ENV_MODEL_IDLE_TIMEOUT_MS > 0
        ? ENV_MODEL_IDLE_TIMEOUT_MS
        : Math.max(0, Math.floor((profile as any).runtime?.modelIdleTimeoutMs ?? 0));
    const modelTotalTimeoutMs =
      ENV_MODEL_TOTAL_TIMEOUT_MS > 0
        ? ENV_MODEL_TOTAL_TIMEOUT_MS
        : Math.max(0, Math.floor((profile as any).runtime?.modelTotalTimeoutMs ?? 0));
    const modelRequestMaxRetries = Math.max(0, Math.floor((profile as any).runtime?.modelRequestMaxRetries ?? 0));

    const assistant = await this.apiClient.createContextItem({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId,
      step,
      prevId: context.headItemId,
      kind: "assistant",
      status: "streaming",
        output: {
          type: "assistant_text",
          text: ""
        },
      createdAt: this.nowMsFn()
    });
    if (assistant.item == null) {
      return { aborted: true as const, assistantItemId: null };
    }
    const assistantItem = assistant.item;

    await this.apiClient.updateRunState({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      status: "running",
      activeRunId: run.runId,
      activeAssistantItemId: assistantItem.id,
      runNoticeText: "",
      updatedAt: this.nowMsFn()
    });

    const toolDefinitions = await this.toolRegistry.listTools({
      profile,
      promptContext: context,
      apiClient: this.apiClient
    });
    const toolSet: Record<string, any> = {};
    for (const item of toolDefinitions) {
      toolSet[item.name] = tool({
        description: item.description,
        inputSchema: jsonSchema(item.inputSchema)
      });
    }
    // 当前 turn 的 availableToolNames 是 builtin + MCP 合并后的快照；pendingTools 执行阶段必须严格按该快照校验，避免越权执行旧工具。
    // TODO(plugin-phase2): 若后续 provider 引入缓存/热更新，需要把该快照显式透传到执行阶段，而不是仅从 promptContext 重新推导。
    const availableToolNames = new Set<string>(Object.keys(toolSet));

    const requestBase: Record<string, unknown> = {
      model,
      system: context.system || undefined,
      messages: context.messages,
      tools: toolSet
    };

    if (Object.keys(runtimeOptions.aiSdk).length > 0) {
      Object.assign(requestBase, runtimeOptions.aiSdk);
    }
    if (Object.keys(runtimeOptions.providerOptions).length > 0 || profile.provider.npm === "@ai-sdk/openai") {
      requestBase.providerOptions = {
        [runtimeOptions.providerKey]: buildProviderOptionsWithPromptCacheKey({
          providerNpm: profile.provider.npm,
          sessionId: run.sessionId,
          providerOptions: runtimeOptions.providerOptions
        })
      };
    }
    // 自定义重试策略由本文件控制,禁用 AI SDK 内建重试避免双重重试。
    requestBase.maxRetries = 0;

    const assistantStreamFlushIntervalMs = 1_000;
    const assistantStreamFlushCharsThreshold = 160;
    let text = "";
    let reasoningText = "";
    const toolCalls: ToolCall[] = [];
    const startedAt = this.nowMsFn();
    let responseTotalTokens: number | null = null;

    await writeItemLog({
      logger: this.logger,
      workspacePath: run.workspacePath,
      kind: "assistant",
      itemId: assistantItem.id,
      payload: {
        status: "running",
        startedAt,
        meta: {
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          step,
          itemId: assistantItem.id
        },
        request: requestBase,
        retryPolicy: {
          firstBackoffMs: MODEL_RETRY_BACKOFF_BASE_MS,
          maxBackoffMs: MODEL_RETRY_BACKOFF_MAX_MS,
          maxRetries: modelRequestMaxRetries
        }
      }
    });

    let retryCount = 0;
    let successfulStream: any = null;
    let lastFlushedText = "";
    let lastFlushedReasoningText = "";
    let lastFlushAt = this.nowMsFn();
    let pendingFlush = false;

    const flushAssistant = async (status: "streaming" | "completed" | "failed", force = false) => {
      if (
        !force
        && text === lastFlushedText
        && reasoningText === lastFlushedReasoningText
        && status === "streaming"
      ) {
        return;
      }
      await this.apiClient.updateContextItem({
        itemId: assistantItem.id,
        status,
        output: {
          type: "assistant_text",
          text,
          ...(reasoningText ? { reasoning: { text: reasoningText } } : {})
        },
        updatedAt: this.nowMsFn()
      });
      lastFlushedText = text;
      lastFlushedReasoningText = reasoningText;
      lastFlushAt = this.nowMsFn();
      pendingFlush = false;
    };

    const maybeFlushAssistantStreaming = async (force = false) => {
      const now = this.nowMsFn();
      const deltaChars = (text.length - lastFlushedText.length) + (reasoningText.length - lastFlushedReasoningText.length);
      if (
        force
        || deltaChars >= assistantStreamFlushCharsThreshold
        || now - lastFlushAt >= assistantStreamFlushIntervalMs
      ) {
        await flushAssistant("streaming", true);
        return;
      }
      pendingFlush = true;
    };

    const resetVisibleOutputForRetry = async () => {
      const prevText = text;
      const prevReasoningText = reasoningText;
      const prevLastFlushedText = lastFlushedText;
      const prevLastFlushedReasoningText = lastFlushedReasoningText;
      const prevLastFlushAt = lastFlushAt;
      const prevPendingFlush = pendingFlush;

      text = "";
      reasoningText = "";
      try {
        await flushAssistant("streaming", true);
      } catch (err) {
        text = prevText;
        reasoningText = prevReasoningText;
        lastFlushedText = prevLastFlushedText;
        lastFlushedReasoningText = prevLastFlushedReasoningText;
        lastFlushAt = prevLastFlushAt;
        pendingFlush = prevPendingFlush;

        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[agent-worker] reset visible output before retry failed(item=${assistantItem.id}, retry=${retryCount + 1}/${modelRequestMaxRetries}): ${message}`
        );
      }
    };

    while (true) {
      if (signal.aborted) {
        return { aborted: true as const, assistantItemId: assistantItem.id };
      }

      if (retryCount > 0) {
        try {
          await this.apiClient.updateRunState({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
              status: "running",
              activeRunId: run.runId,
              activeAssistantItemId: assistantItem.id,
              runNoticeText: "",
              updatedAt: this.nowMsFn()
            });
          } catch {
            // ignore notice clear failure
        }
      }

      // 用独立 controller 承载“用户取消”和“空闲/总超时”中止。
      // 仅将“用户取消”(signal.aborted)视为 run cancelled。
      const requestController = new AbortController();
      let idleTimedOut = false;
      let totalTimedOut = false;
      let lastChunkAt = this.nowMsFn();
      // 只要本次请求已经开始产生可见输出(文本/tool-call),就不再自动重试。
      // 这样可以避免重试导致的重复内容,以及工具重复执行带来的副作用。
      let attemptStartedVisibleOutput = false;

      const onOuterAbort = () => {
        requestController.abort();
      };
      if (signal.aborted) {
        requestController.abort();
      } else {
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }

      let idleTimer: NodeJS.Timeout | null = null;
      if (modelIdleTimeoutMs > 0) {
        const checkIntervalMs = Math.max(50, Math.min(1000, Math.floor(modelIdleTimeoutMs / 4)));
        idleTimer = setInterval(() => {
          if (requestController.signal.aborted) return;
          const elapsed = this.nowMsFn() - lastChunkAt;
          if (elapsed < modelIdleTimeoutMs) return;
          idleTimedOut = true;
          requestController.abort();
        }, checkIntervalMs);
      }

      let totalTimer: NodeJS.Timeout | null = null;
      if (modelTotalTimeoutMs > 0) {
        totalTimer = setTimeout(() => {
          if (requestController.signal.aborted) return;
          totalTimedOut = true;
          requestController.abort();
        }, modelTotalTimeoutMs);
      }

      const retryMessages = buildRetryMessages({
        baseMessages: context.messages as Array<Record<string, unknown>>,
        text,
        toolCalls: toolCalls.length,
        retryCount,
        maxRetries: modelRequestMaxRetries
      });
      const request: Record<string, unknown> = {
        ...requestBase,
        abortSignal: requestController.signal,
        messages: retryMessages
      };

      try {
        const stream = this.streamTextFn(request as any) as StreamTextResultLike;
        successfulStream = stream;
        for await (const chunk of stream.fullStream as AsyncIterable<any>) {
          if (requestController.signal.aborted) break;
          if (!attemptStartedVisibleOutput && chunkStartsVisibleOutput(chunk, availableToolNames)) {
            attemptStartedVisibleOutput = true;
          }
          lastChunkAt = this.nowMsFn();
          if (!chunk || typeof chunk !== "object") continue;
          if (chunk.type === "text-delta") {
            const delta = String(chunk.text || "");
            if (!delta) continue;
            text += delta;
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (chunk.type === "reasoning-delta") {
            const delta = String(chunk.text || chunk.delta || "");
            if (!delta) continue;
            reasoningText += delta;
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (chunk.type === "tool-call") {
            const toolName = normalizeToolName(chunk.toolName, availableToolNames);
            if (!toolName) continue;
            const rawToolCallId = String(chunk.toolCallId || "").trim();
            const toolCallId = rawToolCallId || `${turnId}_call_${toolCalls.length + 1}`;
            const args = normalizeToolArgs(chunk.input);
            toolCalls.push({ toolName, toolCallId, args });
            continue;
          }
          if (chunk.type === "finish") {
            responseTotalTokens =
              extractTotalTokens((chunk as Record<string, unknown>).usage) ??
              extractTotalTokens((chunk as Record<string, unknown>).totalUsage) ??
              responseTotalTokens;
            continue;
          }
          if (chunk.type === "error") {
            const message = chunk.error instanceof Error ? chunk.error.message : String(chunk.error || "stream error");
            throw new Error(message);
          }
        }
        if (pendingFlush) {
          await flushAssistant("streaming", true);
        }

        if (signal.aborted) {
          return { aborted: true as const, assistantItemId: assistantItem.id };
        }
        if (totalTimedOut) {
          throw new Error(`model total timeout after ${modelTotalTimeoutMs}ms`);
        }
        if (idleTimedOut) {
          throw new Error(`model idle timeout after ${modelIdleTimeoutMs}ms`);
        }

        break;
      } catch (err) {
        if (signal.aborted) {
          return { aborted: true as const, assistantItemId: assistantItem.id };
        }
        if (totalTimedOut) {
          err = new Error(`model total timeout after ${modelTotalTimeoutMs}ms`);
        } else if (idleTimedOut) {
          err = new Error(`model idle timeout after ${modelIdleTimeoutMs}ms`);
        }
        const message = err instanceof Error ? err.message : String(err);

        const canRetry =
          (!attemptStartedVisibleOutput && retryCount < modelRequestMaxRetries)
          || shouldRetryAfterPartialText({ text, toolCalls: toolCalls.length, retryCount, maxRetries: modelRequestMaxRetries });

        if (canRetry) {
          const delayMs = computeRetryBackoffMs(retryCount);
          const retryAttempt = retryCount + 1;
          const noticeText = `Request failed, retrying in ${Math.floor(delayMs / 1000)}s (${retryAttempt}/${modelRequestMaxRetries}): ${message}`;
          try {
            await this.apiClient.updateRunState({
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              status: "running",
              activeRunId: run.runId,
              activeAssistantItemId: assistantItem.id,
              runNoticeText: noticeText,
              updatedAt: this.nowMsFn()
            });
          } catch {
            // ignore notice update failure
          }

          await writeItemLog({
            logger: this.logger,
            workspacePath: run.workspacePath,
            kind: "assistant",
            itemId: assistantItem.id,
            payload: {
              status: "retrying",
              meta: {
                workspaceId: run.workspaceId,
                sessionId: run.sessionId,
                runId: run.runId,
                turnId,
                step,
                itemId: assistantItem.id,
                retryAttempt,
                maxRetries: modelRequestMaxRetries,
                nextRetryInMs: delayMs
              },
              response: {
                error: message
              }
            }
          });

          retryCount = retryAttempt;
          await resetVisibleOutputForRetry();
          const continueRunning = await sleepMsWithAbort(delayMs, signal);
          if (!continueRunning) {
            return { aborted: true as const, assistantItemId: assistantItem.id };
          }
          continue;
        }

        const finalMessage = retryCount > 0 ? `failed after ${retryCount} retries: ${message}` : message;
        try {
          if (pendingFlush) {
            await flushAssistant("streaming", true);
          }
          await this.apiClient.updateRunState({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            status: "running",
            activeRunId: run.runId,
            activeAssistantItemId: assistantItem.id,
            runNoticeText: "",
            updatedAt: this.nowMsFn()
          });
        } catch {
          // ignore notice clear failure
        }
        try {
          await this.apiClient.updateContextItem({
            itemId: assistantItem.id,
            status: "failed",
            output: {
              type: "assistant_text",
              text,
              ...(reasoningText ? { reasoning: { text: reasoningText } } : {}),
              error: finalMessage
            },
            updatedAt: this.nowMsFn()
          });
        } catch {
          // 忽略更新失败，保持原始异常抛出
        }
        await writeItemLog({
          logger: this.logger,
          workspacePath: run.workspacePath,
          kind: "assistant",
          itemId: assistantItem.id,
          payload: {
            status: "failed",
            startedAt,
            finishedAt: this.nowMsFn(),
            meta: {
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId,
              step,
              itemId: assistantItem.id,
              retries: retryCount
            },
            request,
            response: {
              text,
              reasoningText,
              toolCalls,
              error: finalMessage
            }
          }
        });
        throw new Error(finalMessage);
      } finally {
        if (idleTimer) clearInterval(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);
        try {
          signal.removeEventListener("abort", onOuterAbort);
        } catch {
          // ignore
        }
      }
    }

    if (responseTotalTokens == null && successfulStream) {
      responseTotalTokens = await readStreamTotalTokens(successfulStream);
    }

    const recognizedCalls = toolCalls;
      let prevId = assistantItem.id;
      for (const call of recognizedCalls) {
        const signature = toolSignature(call.toolName, call.args);
        const count = (repeatedToolCallCounter.get(signature) ?? 0) + 1;
        repeatedToolCallCounter.set(signature, count);
        if (LOOP_REPEAT_TOOL_CALL_THRESHOLD > 0 && count > LOOP_REPEAT_TOOL_CALL_THRESHOLD) {
          throw new Error(`repeated tool call threshold exceeded: ${call.toolName}`);
        }

        const toolItem = await this.apiClient.createContextItem({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          step,
          prevId,
          kind: "tool",
          status: "queued",
          output: {
            type: "tool",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            args: call.args
          },
          createdAt: this.nowMsFn()
        });
        if (toolItem.item == null) {
          return { aborted: true as const, assistantItemId: assistantItem.id };
        }
        const toolContextItem = toolItem.item;
        prevId = toolContextItem.id;
        await writeItemLog({
          logger: this.logger,
          workspacePath: run.workspacePath,
          kind: "tool",
          itemId: toolContextItem.id,
          payload: {
            status: "queued",
            meta: {
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId,
              step,
              itemId: toolContextItem.id
            },
            request: {
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              args: call.args
            }
          }
        });
      }

      if (successfulStream) {
        try {
          const finalReasoning = await successfulStream.reasoningText;
          const finalReasoningText = typeof finalReasoning === "string"
            ? String(finalReasoning)
            : "";
          reasoningText = finalReasoningText || reasoningText;
        } catch {
          // best-effort: 保留流式阶段已累计的 reasoningText,不要因收尾读取失败打断整轮成功结果
        }
      }

      await flushAssistant("completed", true);

      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "assistant",
        itemId: assistantItem.id,
        payload: {
          status: "completed",
          startedAt,
          finishedAt: this.nowMsFn(),
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            step,
            itemId: assistantItem.id
          },
          request: requestBase,
          response: {
            text,
            reasoningText,
            toolCalls: recognizedCalls,
            usage: responseTotalTokens == null ? null : { totalTokens: responseTotalTokens }
          }
        }
      });

      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "running",
        activeRunId: run.runId,
        activeAssistantItemId: null,
        lastResponseTotalTokens: responseTotalTokens,
        runNoticeText: "",
        updatedAt: this.nowMsFn()
      });

      return {
        aborted: false as const,
        toolCallCount: recognizedCalls.length,
        assistantItemId: assistantItem.id,
        hasVisibleText: hasVisibleAssistantText(text),
        availableToolNames: recognizedCalls.length > 0 ? availableToolNames : undefined
      };
  }

  private async processRun(run: QueuedRun, signal: AbortSignal) {
    let committedTerminalStatus: "completed" | "failed" | "cancelled" | null = null;
    let terminalSubmission: Promise<void> | null = null;
    let terminalSubmittingStatus: "completed" | "failed" | "cancelled" | null = null;
    class TerminalStatusSubmitError extends Error {
      constructor(
        readonly status: "completed" | "failed" | "cancelled",
        cause: unknown
      ) {
        super(`submit terminal status failed: ${status}`);
        this.name = "TerminalStatusSubmitError";
        (this as Error & { cause?: unknown }).cause = cause;
      }
    }
    const finishOnce = async (status: "completed" | "failed" | "cancelled") => {
      if (committedTerminalStatus) return;
      if (terminalSubmission) return await terminalSubmission;
      terminalSubmittingStatus = status;
      terminalSubmission = (async () => {
        try {
          await this.apiClient.completeRun({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            status,
            updatedAt: nowMs()
          });
          committedTerminalStatus = status;
        } catch (err) {
          throw new TerminalStatusSubmitError(status, err);
        } finally {
          terminalSubmission = null;
          terminalSubmittingStatus = null;
        }
      })();
      return await terminalSubmission;
    };
    const tryFinishOnce = async (status: "completed" | "failed" | "cancelled") => {
      try {
        await finishOnce(status);
      } catch (err) {
        const cause = err instanceof TerminalStatusSubmitError ? err.cause : err;
        if (cause instanceof ApiConflictError) {
          this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
          return;
        }
        throw err;
      }
    };
    try {
      const profile = await this.apiClient.getExecutionProfile({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId
      });

      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "running",
        activeRunId: run.runId,
        activeAssistantItemId: null,
          runNoticeText: "",
        updatedAt: nowMs()
      });

      let step = 0;
      const repeatedToolCallCounter = new Map<string, number>();
      let emptyResponseCount = 0;

      // 手动压缩: 仅执行一次 compaction,不进入正常 step 循环.
      if (run.inputText === MANUAL_COMPACT_SENTINEL) {
        const context = await this.apiClient.getPromptContext({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId
        });
        if (context.pendingTools.length > 0) {
          await finishOnce("failed");
          return;
        }

        await this.apiClient.updateRunState({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          status: "running",
          activeRunId: run.runId,
          activeAssistantItemId: null,
              runNoticeText: "正在压缩上下文...",
          updatedAt: nowMs()
        });

        await this.compactContext({
          profile,
          run,
          context,
          signal
        });
        if (signal.aborted) {
          await finishOnce("cancelled");
          return;
        }
        await finishOnce("completed");
        return;
      }

      let pendingToolNamesSnapshot: ReadonlySet<string> | undefined;
      while (!signal.aborted) {
        const context = await this.apiClient.getPromptContext({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId
        });

        // 快照只允许命中“紧接着的一次 pending-tools 检查机会”；若本轮没有 pendingTools，必须立刻丢弃，避免跨 compaction/下一模型 step 泄漏。
        const nextPendingToolNamesSnapshot = pendingToolNamesSnapshot;
        pendingToolNamesSnapshot = undefined;
        if (context.pendingTools.length > 0) {
          const pendingResult = await this.executePendingTools({
            profile,
            run,
            availableToolNames: nextPendingToolNamesSnapshot,
            context,
            signal
          });
          if (pendingResult.paused || signal.aborted) {
            if (signal.aborted) await finishOnce("cancelled");
            return;
          }
          continue;
        }

        if (this.shouldAutoCompact({ context, model: profile.model, runtime: profile.runtime })) {
          const compacted = await this.compactContext({
            profile,
            run,
            context,
            signal
          });
          if (compacted || signal.aborted) {
            if (signal.aborted) await finishOnce("cancelled");
            continue;
          }
        }

        if (shouldStopForMaxSteps(step, LOOP_MAX_STEPS)) {
          const head = context.headItemId;
          if (head != null) {
            await this.apiClient.createContextItem({
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId: null,
              step: null,
              prevId: head,
              kind: "system",
              status: "completed",
              output: {
                type: "system_text",
                text: "[run] max steps exceeded"
              },
              createdAt: nowMs()
            });
          }
          await finishOnce("failed");
          return;
        }

        step += 1;
        const result = await this.runModelStep({
          profile,
          run,
          context,
          step,
          signal,
          repeatedToolCallCounter
        });
        if (result.aborted || signal.aborted) {
          await finishOnce("cancelled");
          return;
        }
        if (result.toolCallCount > 0) {
          emptyResponseCount = 0;
          pendingToolNamesSnapshot = result.availableToolNames;
          continue;
        }
        if (result.hasVisibleText) {
          emptyResponseCount = 0;
          await finishOnce("completed");
          return;
        }
        emptyResponseCount += 1;
        if (emptyResponseCount >= EMPTY_RESPONSE_COMPLETE_THRESHOLD) {
          await finishOnce("completed");
          return;
        }
      }
      if (signal.aborted) {
        await finishOnce("cancelled");
      }
    } catch (err) {
      if (isAbortLikeError(err, signal)) {
        this.logger.info(`run aborted: ${run.sessionId} ${run.runId}`);
        await tryFinishOnce("cancelled");
        return;
      }
      if (err instanceof ApiConflictError) {
        this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
        return;
      }

      const terminalSubmitError = err instanceof TerminalStatusSubmitError ? err : null;
      const fallbackStatus = terminalSubmitError?.status ?? "failed";
      const cause = terminalSubmitError?.cause ?? err;
      const message = cause instanceof Error ? cause.message : String(cause);
      try {
        await tryFinishOnce(fallbackStatus);
      } catch {
        this.logger.error(`run failed and fallback append failed: ${run.sessionId} ${run.runId} ${message}`);
      }
    }
  }
}

export type EnqueuePayload = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
  workspaceRepoDirNames?: string[];
};

export function buildProviderOptionsWithPromptCacheKeyForTest(params: {
  providerNpm: ExecutionProfile["provider"]["npm"];
  sessionId: string;
  providerOptions: Record<string, unknown>;
}) {
  return buildProviderOptionsWithPromptCacheKey(params);
}

export function hasValidPromptCacheKeyForTest(providerOptions: Record<string, unknown>) {
  return hasValidPromptCacheKey(providerOptions);
}

export function hasVisibleAssistantTextForTest(text: string) {
  return hasVisibleAssistantText(text);
}

export function getRegisteredControllerForTest(runner: AgentRunner, sessionId: string) {
  return (runner as any).controllers.get(sessionId) as AbortController | undefined;
}

export function getNestedChildrenForTest(runner: AgentRunner, sessionId: string) {
  const children = (runner as any).nestedChildrenByParent.get(sessionId) as Set<string> | undefined;
  return children ? [...children] : [];
}

export function getNestedParentForTest(runner: AgentRunner, sessionId: string) {
  return (runner as any).nestedParentByChild.get(sessionId) as string | undefined;
}

export async function processNestedRunWithControllerForTest(
  runner: AgentRunner,
  params: { parentSessionId: string; run: QueuedRun; parentSignal: AbortSignal }
) {
  return await (runner as any).processNestedRunWithController(params);
}

export async function processRunForTest(runner: AgentRunner, run: QueuedRun, signal: AbortSignal) {
  return await (runner as any).processRun(run, signal);
}

export async function executeToolForTest(runner: AgentRunner, params: Record<string, unknown>) {
  return await (runner as any).executeTool(params);
}

export async function executeToolSafelyForTest(runner: AgentRunner, params: Record<string, unknown>) {
  return await (runner as any).executeToolSafely(params);
}

export async function warnToolErrorStoreFailureForTest(
  runner: AgentRunner,
  input: { operation: string; error: unknown; relativePath?: string; workspacePath?: string }
) {
  await (runner as any).warnToolErrorStoreFailure(input);
}

export async function warnToolErrorStoreForTest(
  runner: AgentRunner,
  results: Array<{ outcome: "failed"; operation: string; error: unknown; relativePath?: string }>,
  workspacePath: string
) {
  await (runner as any).warnToolErrorStore(results, workspacePath);
}

export function shouldStopForMaxStepsForTest(step: number, maxSteps: number) {
  return shouldStopForMaxSteps(step, maxSteps);
}

export async function finalizeToolTextForTest(params: {
  workspacePath: string;
  itemId: number;
  toolName: string;
  toolCallId?: string;
  text: string;
}) {
  return finalizeToolText(params);
}
