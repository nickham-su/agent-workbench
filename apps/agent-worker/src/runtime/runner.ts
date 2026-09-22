import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  APICallError,
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type JSONValue,
  type ModelMessage,
  type StreamTextResult,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateSingleCallText } from "@agent-workbench/shared/llm-single-call";
import { parseAiSdkCallSettings } from "@agent-workbench/shared/llm-ai-sdk-call-settings";
import { AgentApiClient, ApiConflictError, InternalRpcHttpError, InternalRpcNetworkError, InternalRpcTimeoutError, type ExecutionProfile, type PromptContext } from "./apiClient.js";
import { McpManager } from "./mcpManager.js";
import {
  AgentProviderReplayUpdateError,
  assertAgentProviderReplayUpdateCompatible,
  parseAgentProviderReplay,
  serializeAgentProviderReplay,
  type AgentProviderReplayEnvelope,
  type AgentApiFlushAssistantPartsRequest,
  type AgentApiPromptAttachmentRefPart,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { PluginRuntimeManager } from "./plugins/runtimeManager.js";
import { ToolRegistry } from "./tools/registry.js";
import { BuiltinToolProvider } from "./tools/providers/builtin.js";
import { LocalPluginToolProvider } from "./tools/providers/local-plugin.js";
import { RemotePluginToolProvider, REMOTE_PLUGIN_TOOLS_ENABLED } from "./tools/providers/remote-plugin.js";
import { McpToolProvider } from "./tools/providers/mcp.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { isMcpToolName, isPluginToolName } from "./tools/types.js";
import { createToolFailureCaptureIfEnabled, extractPartialToolResults, type ToolFailureCapture } from "./toolErrorCapture.js";
import type { AgentAttachmentStorage } from "./agentAttachmentStorage.js";
import { formatToolErrorStoreWarning } from "./toolErrorStore.js";
import {
  DefaultProviderConversationStateAdapterRegistry,
} from "./providers/conversation-state/registry.js";
import { finalOpenAiModel } from "./providers/openai-responses-replay.js";
import type {
  ProviderConversationStateAdapterRegistry,
  ProviderConversationStatePartUpdate,
  ProviderConversationStateToolCallReplay,
} from "./providers/conversation-state/types.js";
import {
  projectAssistantDebugRecord,
  serializeAssistantDebugRecord,
} from "./debug/project-assistant-debug-record.js";
import { CompactionExecutor } from "./compaction/executor.js";
import type { CompactionCasState, CompactionMode } from "./compaction/types.js";

function nowMs() {
  return Date.now();
}

function parseIntOrDefault(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

const DEBUG_DUMP_RELATIVE_DIR = path.join(".debug", "agent_message_logs");
const LOOP_MAX_STEPS = parseIntOrDefault(process.env.AWB_AGENT_LOOP_MAX_STEPS, 128);
const LOOP_REPEAT_TOOL_CALL_THRESHOLD = parseIntOrDefault(process.env.AWB_AGENT_LOOP_REPEAT_TOOL_CALL_THRESHOLD, 20);
const MODEL_RETRY_BACKOFF_BASE_MS = 2_000;
const CONTROL_WRITE_RETRY_DELAY_MS = 100;
const MODEL_RETRY_BACKOFF_DEFAULT_MAX_MS = 60_000;
const MODEL_RETRY_BACKOFF_MAX_ALLOWED_MS = 3_600_000;
const MODEL_REQUEST_MAX_RETRIES_DEFAULT = 5;
const MODEL_REQUEST_MAX_RETRIES_MAX = 100;
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

export function normalizeRetryBackoffMaxMs(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return MODEL_RETRY_BACKOFF_DEFAULT_MAX_MS;
  }
  return Math.min(MODEL_RETRY_BACKOFF_MAX_ALLOWED_MS, Math.max(MODEL_RETRY_BACKOFF_BASE_MS, raw));
}

function normalizeModelRequestMaxRetries(raw: unknown) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return MODEL_REQUEST_MAX_RETRIES_DEFAULT;
  }
  return Math.min(MODEL_REQUEST_MAX_RETRIES_MAX, Math.max(0, raw));
}

export function computeRetryBackoffMs(attemptIndex: number, rawMaxBackoffMs: unknown = MODEL_RETRY_BACKOFF_DEFAULT_MAX_MS) {
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) return MODEL_RETRY_BACKOFF_BASE_MS;
  const factor = 2 ** Math.floor(attemptIndex);
  const delay = MODEL_RETRY_BACKOFF_BASE_MS * factor;
  return Math.min(normalizeRetryBackoffMaxMs(rawMaxBackoffMs), Math.max(MODEL_RETRY_BACKOFF_BASE_MS, delay));
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

function safeErrorSummary(error: unknown) {
  const source = toErrorRecord(error);
  const apiCallError = APICallError.isInstance(error) ? error : null;
  const name = error instanceof Error && error.name ? error.name : "Error";
  const status = apiCallError?.statusCode
    ?? (typeof source?.statusCode === "number" ? source.statusCode : null)
    ?? (typeof source?.status === "number" ? source.status : null);
  const codes = [
    ...collectErrorCodes(apiCallError?.data),
    ...collectErrorCodes(source),
  ].filter(Boolean);
  const details = [
    status == null ? null : `status=${status}`,
    codes[0] ? `code=${codes[0]}` : null,
  ].filter((value): value is string => value != null);
  return details.length > 0 ? `${name} (${details.join(", ")})` : name;
}

function toolErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message || error.name || "Error";
  return String(error || "Error");
}

class CompactionConflictError extends Error {
  constructor(cause?: unknown) {
    super("compaction conflicts with the current run state");
    this.name = "CompactionConflictError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
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

function formatSubtaskStartError(error: unknown, args: Record<string, unknown>) {
  const session = toRecordObject(args.session);
  if (
    error instanceof InternalRpcHttpError
    && error.apiCode === "AGENT_SUBTASK_SESSION_NOT_FOUND"
    && session?.mode === "existing"
  ) {
    return "指定的 existing 子任务会话不存在或已失效。请改用 session.mode=\"new\" 或 \"fork\"，或者提供当前工作区中有效的 subtask sessionId。\n\n错误码：AGENT_SUBTASK_SESSION_NOT_FOUND\nHTTP 状态：404";
  }
  return toolErrorMessage(error);
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
  toolExecutionId: string;
  toolName: string;
  text: string;
  /** 兼容既有对抗测试：在 rename 前注入路径替换。 */
  beforeArtifactCommit?: () => Promise<void> | void;
  /** 仅供对抗测试覆盖目录/目标在发布各阶段被替换的路径。 */
  onArtifactWritePhase?: (phase: "before_rename" | "after_rename") => Promise<void> | void;
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

  if (!/^[A-Za-z0-9._-]{1,120}$/.test(params.toolExecutionId)) throw new Error("invalid tool execution id for artifact");
  const executionSegment = params.toolExecutionId;

  const relativePath = path.join(
    ".awb",
    "agent",
    "artifacts",
    "by_tool_execution",
    `${executionSegment}.txt`
  );
  const workspaceResolvedPath = path.resolve(params.workspacePath);
  const fullPath = path.resolve(workspaceResolvedPath, relativePath);
  if (!isPathInside(workspaceResolvedPath, fullPath)) {
    throw new Error("artifact path is outside workspace");
  }

  const workspaceRealPath = await fs.realpath(workspaceResolvedPath);
  let parentDirPath = workspaceResolvedPath;
  for (const segment of [".awb", "agent", "artifacts", "by_tool_execution"]) {
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
  // 以已打开目录的 fd 路径创建临时文件、写入和 rename。所有检查均围绕
  // 同一个目录 inode 与仍打开的文件 inode，防止 pathname/symlink 竞态导致
  // 跟随外部目标或错误报告成功。平台无法提供安全 dirfd 路径时 fail-closed。
  const parentDirectoryHandle = await fs.open(parentDirPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  let tempHandle: fs.FileHandle | null = null;
  let tempPath: string | null = null;
  let finalPath: string | null = null;
  let published = false;
  try {
    const fdDirectoryPath = process.platform === "linux"
      ? `/proc/self/fd/${parentDirectoryHandle.fd}`
      : process.platform === "darwin"
        ? `/dev/fd/${parentDirectoryHandle.fd}`
        : null;
    if (!fdDirectoryPath) {
      throw new Error("secure artifact writes require directory fd path support");
    }
    const pinnedParentRealPath = await fs.realpath(fdDirectoryPath);
    if (!isPathInside(workspaceRealPath, pinnedParentRealPath)) {
      throw new Error("artifact parent directory is outside workspace");
    }
    const pinnedParentStat = await fs.stat(fdDirectoryPath);
    const assertCurrentArtifactDirectory = async (phase: string) => {
      const currentParentStat = await fs.stat(parentDirPath);
      const currentParentRealPath = await fs.realpath(parentDirPath);
      if (
        currentParentStat.dev !== pinnedParentStat.dev
        || currentParentStat.ino !== pinnedParentStat.ino
        || !isPathInside(workspaceRealPath, currentParentRealPath)
      ) {
        throw new Error(`artifact parent directory changed during ${phase}`);
      }
    };

    const tempName = `.${executionSegment}.${randomBytes(12).toString("hex")}.tmp`;
    tempPath = path.join(fdDirectoryPath, tempName);
    finalPath = path.join(fdDirectoryPath, `${executionSegment}.txt`);
    tempHandle = await fs.open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await tempHandle.writeFile(artifactBody, { encoding: "utf8" });
    await tempHandle.sync();

    const tempStat = await tempHandle.stat();
    if (!tempStat.isFile()) throw new Error("artifact temp path must be a regular file");
    const tempPathStat = await fs.lstat(tempPath);
    if (
      tempPathStat.isSymbolicLink()
      || !tempPathStat.isFile()
      || tempPathStat.dev !== tempStat.dev
      || tempPathStat.ino !== tempStat.ino
    ) {
      throw new Error("artifact temp path changed during write");
    }
    const assertTempPathStillOwned = async () => {
      const stat = await fs.lstat(tempPath!);
      if (
        stat.isSymbolicLink()
        || !stat.isFile()
        || stat.dev !== tempStat.dev
        || stat.ino !== tempStat.ino
      ) {
        throw new Error("artifact temp path changed before rename");
      }
    };
    const removeOwnedPath = async (candidatePath: string, expected: { dev: number; ino: number }) => {
      const stat = await fs.lstat(candidatePath).catch(() => null);
      if (
        !stat
        || stat.isSymbolicLink()
        || !stat.isFile()
        || stat.dev !== expected.dev
        || stat.ino !== expected.ino
      ) {
        return;
      }
      // unlink 不会解析 symlink；此前还已确认该目录项仍是本次 fd 创建的 inode。
      await fs.unlink(candidatePath).catch(() => undefined);
    };

    await params.beforeArtifactCommit?.();
    await params.onArtifactWritePhase?.("before_rename");
    await assertTempPathStillOwned();
    await assertCurrentArtifactDirectory("pre-rename verification");

    // tempHandle 保持打开直到发布、inode、正文和正式读取路径均验证完成。
    await fs.rename(tempPath, finalPath);
    tempPath = null;
    published = true;
    try {
      await params.onArtifactWritePhase?.("after_rename");
      const finalFdStat = await fs.lstat(finalPath);
      if (
        finalFdStat.isSymbolicLink()
        || !finalFdStat.isFile()
        || finalFdStat.dev !== tempStat.dev
        || finalFdStat.ino !== tempStat.ino
      ) {
        throw new Error("artifact final path changed during publish");
      }
      const formalReadHandle = await fs.open(finalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const formalReadStat = await formalReadHandle.stat();
        if (
          !formalReadStat.isFile()
          || formalReadStat.dev !== tempStat.dev
          || formalReadStat.ino !== tempStat.ino
          || formalReadStat.size !== Buffer.byteLength(artifactBody, "utf8")
        ) {
          throw new Error("artifact final file does not match published inode");
        }
        const formalBody = await formalReadHandle.readFile({ encoding: "utf8" });
        if (formalBody !== artifactBody) throw new Error("artifact final file content does not match publish body");
      } finally {
        await formalReadHandle.close();
      }
      await assertCurrentArtifactDirectory("post-publish verification");
      const formalPathStat = await fs.lstat(fullPath);
      if (
        formalPathStat.isSymbolicLink()
        || !formalPathStat.isFile()
        || formalPathStat.dev !== tempStat.dev
        || formalPathStat.ino !== tempStat.ino
      ) {
        throw new Error("artifact formal read path does not match published inode");
      }
    } catch (error) {
      // fdDirectoryPath 仍锚定原目录。仅移除仍等于本次 temp fd 的目录项，绝不删除
      // 被并发进程替换的未知文件；父目录移动/替换时绝不报告成功。
      await removeOwnedPath(finalPath, tempStat);
      published = false;
      throw error;
    }
  } finally {
    if (tempPath && tempHandle) {
      const tempStat = await tempHandle.stat().catch(() => null);
      if (tempStat) {
        const current = await fs.lstat(tempPath).catch(() => null);
        if (current?.isFile() && !current.isSymbolicLink() && current.dev === tempStat.dev && current.ino === tempStat.ino) {
          await fs.unlink(tempPath).catch(() => undefined);
        }
      }
    }
    if (published && finalPath) {
      // 成功路径保留 artifact；此分支只为明确 final 由本函数负责发布。
    }
    if (tempHandle) await tempHandle.close().catch(() => undefined);
    await parentDirectoryHandle.close();
  }
  // 成功返回后，同 UID 的其他进程仍可任意修改 Workspace 文件；这是常规文件系统
  // 权限模型无法在返回后继续防御的边界。返回前已验证正式读取路径指向本 Worker inode。


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
  runKind?: "user" | "manual_compaction" | "subtask";
  inputText?: string;
  resumeAssistantMessageId?: string | null;
  /** 恢复 continuation 只能在首次真实模型调用前消费一次。 */
  recoveryContinuation?: { messageId: string | null };
  workspacePath: string;
  workspaceRepoDirNames: string[];
};

const STRUCTURED_RESULT_TOOL_NAMES = new Set(["apply_patch", "todolist", "subtask", "write", "scratchpad"]);

type PendingTool = {
  toolExecutionId: string;
  callPartId: string;
  assistantMessageId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
};

type ToolCall = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  callPartId: string;
};

type ProviderReplayFor<T extends AgentProviderReplayEnvelope["item"]["type"]> = AgentProviderReplayEnvelope & {
  item: Extract<AgentProviderReplayEnvelope["item"], { type: T }>;
};

/** Provider stream 的有序转录状态；已切换类型的文本不可回填到早期 Part。 */
type StreamingAssistantPart =
  | { id: string; position: number; type: "text"; text: string; providerReplay?: ProviderReplayFor<"text"> }
  | { id: string; position: number; type: "reasoning"; text: string; providerReplay?: ProviderReplayFor<"reasoning"> }
  | {
    id: string; position: number; type: "tool_call"; toolName: string;
    input: Record<string, unknown>; providerToolCallId: string | null; toolCall: ToolCall;
    providerReplay?: ProviderReplayFor<"function_call">;
  };

type ProviderReplayPartUpdate = ProviderConversationStatePartUpdate;

type RuntimeToolSet = ToolSet;
type RuntimeStreamChunk = TextStreamPart<RuntimeToolSet>;
type RuntimeStreamResult = Pick<StreamTextResult<RuntimeToolSet, never>,
  "fullStream" | "reasoningText" | "usage" | "totalUsage" | "response">;
type RuntimeStreamRequest = Parameters<typeof streamText<RuntimeToolSet>>[0];
type RuntimeStreamText = (request: RuntimeStreamRequest) => RuntimeStreamResult;

type ProviderToolCallReplay = ProviderConversationStateToolCallReplay;

type ToolExecutionBatch = {
  mode: "parallel" | "serial";
  tools: PendingTool[];
};

function isAbortLikeError(err: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  const record = toErrorRecord(err);
  const error = err instanceof Error ? err : null;
  const name = error?.name
    || (typeof record?.name === "string" ? record.name : "");
  const code = typeof record?.code === "string" ? record.code : "";
  const message = error?.message
    || (typeof record?.message === "string" ? record.message : "");
  return name === "AbortError"
    || code === "ABORT_ERR"
    || /\babort(ed)?\b/i.test(message)
    || /\babort(ed)?\b/i.test(name);
}

export class FencedWriteIgnoredError extends Error {
  constructor(operation: string) {
    super(`fenced write ignored: ${operation}`);
    this.name = "FencedWriteIgnoredError";
  }
}

export class FencedWriteMissingError extends Error {
  constructor(operation: string) {
    super(`fenced write missing: ${operation}`);
    this.name = "FencedWriteMissingError";
  }
}

export class ControlWritePermanentError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`control write permanently failed: ${operation}`);
    this.name = "ControlWritePermanentError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class ControlReadPermanentError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`control read permanently failed: ${operation}`);
    this.name = "ControlReadPermanentError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

class CompactionInputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionInputLimitError";
  }
}

function isRetryableControlWriteError(error: unknown) {
  if (error instanceof InternalRpcTimeoutError || error instanceof InternalRpcNetworkError) return true;
  if (!(error instanceof InternalRpcHttpError)) return false;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function isRetryableTerminalControlError(error: unknown) {
  return error instanceof InternalRpcTimeoutError
    || error instanceof InternalRpcNetworkError
    || (error instanceof InternalRpcHttpError && [502, 503, 504].includes(error.status));
}

function assertFencedWriteUpdated(operation: string, response: { result: "updated" | "ignored" | "missing" } | undefined) {
  // 真实 AgentApiClient 对 fenced response 做 schema 校验，生产路径只会得到三种合法结果。
  // 兼容尚未迁移的测试替身：它们返回旧 writeback payload，但不代表真实 fenced 成功。
  if (!response || typeof response.result !== "string") return;
  if (response.result === "updated") return;
  if (response.result === "ignored") throw new FencedWriteIgnoredError(operation);
  throw new FencedWriteMissingError(operation);
}

const EMPTY_PROMPT_CONTEXT: PromptContext = {
  headMessageId: null,
  sessionRevision: 0,
  system: "",
  messages: [],
  tools: [],
  pendingTools: [],
  lastResponseTotalTokens: null,
  uiLocale: null,
  externalSkillRoots: []
};

function isSafeObjectKey(raw: string) {
  if (!raw) return false;
  return raw !== "__proto__" && raw !== "prototype" && raw !== "constructor";
}

function toRecordObject(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function toJsonValue(raw: unknown): JSONValue | undefined {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (Array.isArray(raw)) {
    const values: JSONValue[] = [];
    for (const item of raw) {
      const value = toJsonValue(item);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  const source = toRecordObject(raw);
  if (!source) return undefined;
  const result: Record<string, JSONValue> = {};
  for (const [key, item] of Object.entries(source)) {
    const value = toJsonValue(item);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function providerOptionsKeyByNpm(npm: ExecutionProfile["provider"]["npm"]) {
  if (npm === "@ai-sdk/openai-compatible") return "openaiCompatible";
  return npm === "@ai-sdk/anthropic" ? "anthropic" : "openai";
}

function buildModelRuntimeOptions(profile: ExecutionProfile) {
  const source = toRecordObject(profile.model.options) ?? {};
  const aiSdk = parseAiSdkCallSettings(source.aiSdk);

  if (aiSdk.maxOutputTokens === undefined && source.maxOutputTokens !== undefined) {
    aiSdk.maxOutputTokens = parseAiSdkCallSettings({ maxOutputTokens: source.maxOutputTokens }).maxOutputTokens;
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
    return sdk.responses(providerModelId);
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
  const key = rawKey.replace(/[_-]/g, "").toLowerCase();
  return (
    key === "authorization" ||
    key === "apikey" ||
    key === "encryptedcontent" ||
    key === "reasoningencryptedcontent" ||
    key === "providerreplay" ||
    key === "providerreplayjson" ||
    key.includes("token") ||
    key.includes("secret") ||
    key.includes("password")
  );
}

function sanitizeForDebugDump(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDebugDump(item));
  }
  if (typeof value === "string") {
    const parsed = parseJsonErrorValue(value);
    if (parsed != null) return JSON.stringify(sanitizeForDebugDump(parsed));
    return value
      .replace(/("?(?:encrypted_content|encryptedContent|reasoningEncryptedContent|provider_replay_json|providerReplay)"?\s*[:=]\s*)"[^"\r\n]*"/gi, "$1\"***\"")
      .replace(/((?:encrypted_content|encryptedContent|reasoningEncryptedContent|provider_replay_json|providerReplay)\s*[:=]\s*)[^,}\]\s]+/gi, "$1***");
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Error) {
    return { name: value.name || "Error", summary: safeErrorSummary(value) };
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
  recordId?: string;
  payload: unknown;
  force?: boolean;
}) {
  if (process.env.AWB_AGENT_DEBUG_DUMP !== "1" && !params.force) return;
  const dirPath = path.join(params.workspacePath, DEBUG_DUMP_RELATIVE_DIR, params.kind);
  const filePath = path.join(dirPath, `${safePathSegment(params.recordId ?? "unknown")}.log`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const payload = params.kind === "assistant"
      ? serializeAssistantDebugRecord(params.payload)
      : JSON.stringify(sanitizeForDebugDump(params.payload), null, 2);
    await fs.writeFile(filePath, payload, "utf8");
  } catch (err) {
    params.logger.warn(`[agent-worker] write item log failed: ${safeErrorSummary(err)}`);
  }
}

async function writeAssistantDebugRecord(params: {
  logger: Pick<Console, "warn">;
  workspacePath: string;
  recordId?: string;
  input: Parameters<typeof projectAssistantDebugRecord>[0];
  force?: boolean;
}) {
  await writeItemLog({
    logger: params.logger,
    workspacePath: params.workspacePath,
    kind: "assistant",
    recordId: params.recordId,
    payload: projectAssistantDebugRecord(params.input),
    // 投影或写盘失败只能影响本地调试信息，绝不能改变 Provider 请求、flush 或完成语义。
    force: params.force,
  });
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

function isAttachmentRefPart(value: unknown): value is AgentApiPromptAttachmentRefPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  return part.type === "attachment_ref"
    && typeof part.workspaceId === "string"
    && typeof part.attachmentId === "string"
    && (part.mediaType === "image/png" || part.mediaType === "image/jpeg" || part.mediaType === "image/webp")
    && typeof part.filename === "string";
}

async function materializePromptAttachments(params: {
  messages: PromptContext["messages"];
  attachmentStorage: AgentAttachmentStorage | undefined;
}): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];
  for (const message of params.messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      messages.push(message as ModelMessage);
      continue;
    }

    const content: Extract<ModelMessage, { role: "user" }>["content"] = [];
    for (const part of message.content) {
      if (!isAttachmentRefPart(part)) {
        content.push(part);
        continue;
      }
      if (!params.attachmentStorage) throw new Error("attachment storage is unavailable");
      const attachment = await params.attachmentStorage.read({
        workspaceId: part.workspaceId,
        attachmentId: part.attachmentId,
        mediaType: part.mediaType
      });
      content.push({
        type: "file",
        data: attachment.bytes,
        mediaType: attachment.mediaType,
        filename: part.filename
      });
    }
    messages.push({ role: "user", content });
  }
  return messages;
}

type AgentRunnerDeps = {
  streamText?: RuntimeStreamText;
  nowMs?: () => number;
  warningNowMs?: () => number;
  attachmentStorage?: AgentAttachmentStorage;
  /** 仅用于测试控制面固定短间隔重试，不影响 Provider 退避。 */
  controlWriteSleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  /** Provider 专属适配器扩展点：reasoning/text metadata-only 更新。 */
  providerReplayPartFromChunk?: (chunk: unknown) => ProviderReplayPartUpdate | null;
  /** Provider 专属适配器扩展点：从真实 tool-call chunk 提取 function item metadata。 */
  providerToolCallReplayFromChunk?: (chunk: unknown) => ProviderToolCallReplay | null;
  /** 仅负责 Provider 私有状态协议解释；不参与工具、重试或控制面写入。 */
  providerConversationStateAdapterRegistry?: ProviderConversationStateAdapterRegistry;
};

export class AgentRunner {
  private readonly queue: QueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly activeRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pluginRuntimeManager: PluginRuntimeManager;
  private readonly nestedChildrenByParent = new Map<string, Set<string>>();
  private readonly nestedParentByChild = new Map<string, string>();
  private readonly toolRegistry: ToolRegistry;
  private activeCount = 0;
  private readonly toolErrorWarningLimiter = new Map<string, { windowStartedAt: number; suppressed: number }>();

  private readonly streamTextFn: RuntimeStreamText;
  private readonly nowMsFn: () => number;
  private readonly warningNowMsFn: () => number;
  private readonly attachmentStorage: AgentAttachmentStorage | undefined;
  private readonly controlWriteSleepFn: (ms: number, signal: AbortSignal) => Promise<boolean>;
  private readonly providerReplayPartFromChunkFn: ((chunk: unknown) => ProviderReplayPartUpdate | null) | undefined;
  private readonly providerToolCallReplayFromChunkFn: ((chunk: unknown) => ProviderToolCallReplay | null) | undefined;
  private readonly providerConversationStateAdapterRegistry: ProviderConversationStateAdapterRegistry;

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly mcpManager: McpManager,
    private readonly logger: Pick<Console, "info" | "warn" | "error">,
    private readonly concurrency: number,
    deps: AgentRunnerDeps = {}
  ) {
    this.streamTextFn = deps.streamText ?? streamText<RuntimeToolSet>;
    this.nowMsFn = deps.nowMs ?? nowMs;
    this.warningNowMsFn = deps.warningNowMs ?? nowMs;
    this.attachmentStorage = deps.attachmentStorage;
    this.controlWriteSleepFn = deps.controlWriteSleep ?? sleepMsWithAbort;
    this.providerReplayPartFromChunkFn = deps.providerReplayPartFromChunk;
    this.providerToolCallReplayFromChunkFn = deps.providerToolCallReplayFromChunk;
    this.providerConversationStateAdapterRegistry = deps.providerConversationStateAdapterRegistry
      ?? new DefaultProviderConversationStateAdapterRegistry();
    this.pluginRuntimeManager = new PluginRuntimeManager(this.logger);
    const pluginProvider = REMOTE_PLUGIN_TOOLS_ENABLED
      ? new RemotePluginToolProvider()
      : new LocalPluginToolProvider(this.pluginRuntimeManager);
    this.toolRegistry = new ToolRegistry([new BuiltinToolProvider(), new McpToolProvider(this.mcpManager), pluginProvider]);
  }

  private async retryControlRead<T>(
    operation: string,
    signal: AbortSignal,
    read: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      if (signal.aborted) throw new FencedWriteIgnoredError(operation);
      try {
        return await read();
      } catch (error) {
        if (signal.aborted) throw error;
        if (!isRetryableControlWriteError(error)) {
          if (error instanceof ControlReadPermanentError) throw error;
          throw new ControlReadPermanentError(operation, error);
        }
        const retry = await this.controlWriteSleepFn(CONTROL_WRITE_RETRY_DELAY_MS, signal);
        if (!retry) throw new FencedWriteIgnoredError(operation);
      }
    }
  }

  private async retryControlWrite<T extends { result: "updated" | "ignored" | "missing" } | undefined>(
    operation: string,
    signal: AbortSignal,
    write: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      if (signal.aborted) throw new FencedWriteIgnoredError(operation);
      try {
        const response = await write();
        assertFencedWriteUpdated(operation, response);
        return response;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!isRetryableControlWriteError(error)) {
          if (error instanceof FencedWriteIgnoredError || error instanceof FencedWriteMissingError || error instanceof ControlWritePermanentError) throw error;
          throw new ControlWritePermanentError(operation, error);
        }
        const retry = await this.controlWriteSleepFn(CONTROL_WRITE_RETRY_DELAY_MS, signal);
        if (!retry) throw new FencedWriteIgnoredError(operation);
      }
    }
  }

  /** Retries an API operation whose request has an immutable idempotency key. */
  private async retryIdempotentControlWrite<T>(
    operation: string,
    signal: AbortSignal,
    write: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      if (signal.aborted) throw new FencedWriteIgnoredError(operation);
      try {
        return await write();
      } catch (error) {
        if (signal.aborted) throw error;
        if (!isRetryableControlWriteError(error)) {
          throw new ControlWritePermanentError(operation, error);
        }
        const retry = await this.controlWriteSleepFn(CONTROL_WRITE_RETRY_DELAY_MS, signal);
        if (!retry) throw new FencedWriteIgnoredError(operation);
      }
    }
  }

  enqueueRun(run: QueuedRun) {
    if (this.queuedRunIds.has(run.runId) || this.activeRunIds.has(run.runId)) return;
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

  private collectSessionTree(sessionId: string, collected = new Set<string>()) {
    if (collected.has(sessionId)) return collected;
    collected.add(sessionId);
    for (const childSessionId of this.nestedChildrenByParent.get(sessionId) ?? []) {
      this.collectSessionTree(childSessionId, collected);
    }
    return collected;
  }

  private isSessionTreeIdle(sessionIds: ReadonlySet<string>) {
    return !this.queue.some((run) => sessionIds.has(run.sessionId))
      && ![...this.runningSessions].some((sessionId) => sessionIds.has(sessionId))
      && ![...this.controllers.keys()].some((sessionId) => sessionIds.has(sessionId));
  }

  async cancelSessionAndWait(input: { sessionId: string; timeoutMs: number }): Promise<boolean> {
    const sessionIds = this.collectSessionTree(input.sessionId);
    this.cancelSession(input.sessionId);
    const deadline = Date.now() + input.timeoutMs;
    while (!this.isSessionTreeIdle(sessionIds)) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
    return true;
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
    this.activeRunIds.add(run.runId);
    this.runningSessions.add(run.sessionId);
    let controller: AbortController;
    try {
      controller = new AbortController();
      this.registerController(run.sessionId, controller);
    } catch (err) {
      this.runningSessions.delete(run.sessionId);
      this.activeRunIds.delete(run.runId);
      this.activeCount -= 1;
      this.logger.error(`worker startRun failed: ${safeErrorSummary(err)}`);
      this.pump();
      return;
    }

    void this.processRun(run, controller.signal)
      .catch((err) => {
        this.logger.error(`worker run failed: ${safeErrorSummary(err)}`);
      })
      .finally(() => {
        this.deleteControllerIfSame(run.sessionId, controller);
        this.unlinkNestedChild(run.sessionId);
        this.runningSessions.delete(run.sessionId);
        this.activeRunIds.delete(run.runId);
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
    const writeback = async (role: string, input: {
      status: "running" | "completed" | "failed";
      output: { text?: string; result?: unknown; error?: string; textTruncated?: boolean; textArtifactPath?: string };
    }) => {
      capture?.recordWritebackAttempt(role, input.output);
      try {
        const request = {
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          toolExecutionId: tool.toolExecutionId,
          status: input.status,
          resultPreview: input.output.text,
          structuredResult: STRUCTURED_RESULT_TOOL_NAMES.has(tool.toolName) ? input.output.result : undefined,
          error: input.output.error,
          resultTruncated: input.output.textTruncated,
          resultArtifactPath: input.output.textArtifactPath,
          ...(input.status === "running" ? { startedAt: nowMs() } : { completedAt: nowMs() }),
          updatedAt: nowMs()
        };
        const response = await this.retryControlWrite(`tool execution ${input.status}`, signal, async () =>
          await this.apiClient.updateToolExecution(request)
        );
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
          toolExecutionId: tool.toolExecutionId,
          callPartId: tool.callPartId,
          assistantMessageId: tool.assistantMessageId,
          status: tool.status === "running" ? "running" : "queued",
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
        updateToolExecution: async ({ status, resultPreview, structuredResult }) => {
          if (status !== "running") {
            throw new Error("provider terminal tool writeback is not supported by tool error capture");
          }
          await writeback("provider_running_update", { status, output: { text: resultPreview, result: structuredResult } });
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
          toolExecutionId: tool.toolExecutionId,
          toolName: tool.toolName,
          text: rawSuccessText
        });
      } catch (artifactErr) {
        this.logger.warn(`[agent-worker] persist tool artifact failed(execution=${tool.toolExecutionId}, tool=${tool.toolName}): ${safeErrorSummary(artifactErr)}`);
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
        recordId: tool.toolExecutionId,
        payload: {
          meta: { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, toolExecutionId: tool.toolExecutionId },
          request: { toolName: tool.toolName, toolCallId: tool.toolCallId, args: tool.args },
          status: "completed",
          response: providerResult
        }
      });
      return { paused: false as const };
    } catch (err) {
      if (isAbortLikeError(err, signal)) return { paused: false as const };
      if (err instanceof FencedWriteIgnoredError || err instanceof FencedWriteMissingError) throw err;
      if (err instanceof ControlWritePermanentError) {
        if (phase === "running_writeback") capture?.recordEvent("running_writeback_failed", err);
        else if (phase === "completed_output_build") capture?.recordEvent("completed_output_build_failed", err);
        else capture?.recordEvent("completed_writeback_failed", err);
        throw err;
      }
      if (phase === "running_writeback") capture?.recordEvent("running_writeback_failed", err);
      else if (phase === "provider_execute") {
        capture?.recordEvent("provider_execute_rejected", err);
        for (const partial of extractPartialToolResults(err, tool.toolName)) capture?.recordPartialResult(partial.source, partial.value);
      } else if (phase === "completed_output_build") capture?.recordEvent("completed_output_build_failed", err);
      else capture?.recordEvent("completed_writeback_failed", err);

      const error = tool.toolName === "subtask"
        ? formatSubtaskStartError(err, tool.args)
        : toolErrorMessage(err);
      const errorRecord = toErrorRecord(err);
      const subtaskSessionId = String(errorRecord?.subtaskSessionId || "").trim();
      const subtaskResultText = typeof errorRecord?.subtaskResultText === "string"
        ? errorRecord.subtaskResultText
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
        recordId: tool.toolExecutionId,
        payload: {
          meta: { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, toolExecutionId: tool.toolExecutionId },
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
      toolExecutionId: params.tool.toolExecutionId,
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
      if (err instanceof FencedWriteIgnoredError || err instanceof FencedWriteMissingError || err instanceof ControlWritePermanentError) throw err;
      capture?.recordEvent("runner_outer_unhandled", err);
      const error = toolErrorMessage(err);
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
        const request = {
          workspaceId: params.run.workspaceId,
          sessionId: params.run.sessionId,
          runId: params.run.runId,
          toolExecutionId: params.tool.toolExecutionId,
          status: "failed" as const,
          resultPreview: output.text,
          error: output.error,
          completedAt: nowMs(),
          updatedAt: nowMs()
        };
        const response = await this.retryControlWrite("outer failed tool execution", params.signal, async () =>
          await this.apiClient.updateToolExecution(request)
        );
        capture?.recordWritebackSuccess("outer_failed", response);
      } catch (writebackError) {
        capture?.recordWritebackFailure("outer_failed", writebackError);
        capture?.recordEvent("outer_failed_writeback_failed", writebackError);
        if (writebackError instanceof FencedWriteIgnoredError || writebackError instanceof FencedWriteMissingError || writebackError instanceof ControlWritePermanentError) throw writebackError;
      }
      await writeItemLog({
        logger: this.logger,
        workspacePath: params.run.workspacePath,
        kind: "tool",
        recordId: params.tool.toolExecutionId,
        payload: {
          meta: { workspaceId: params.run.workspaceId, sessionId: params.run.sessionId, runId: params.run.runId, toolExecutionId: params.tool.toolExecutionId },
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
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (rejected) {
      throw rejected.reason;
    }
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
          toolExecutionId: item.toolExecutionId,
          toolCallId: artifactToolCallId,
          toolName: item.toolName,
          toolSource: this.toolSourceForArtifact(item.toolName)
        }, item.args, this.nowMsFn) : null;
        capture?.recordEvent("tool_disabled_pending_precheck", error, { output });
        try {
          capture?.recordWritebackAttempt("policy_failed", output);
          const request = {
            workspaceId: params.run.workspaceId,
            sessionId: params.run.sessionId,
            runId: params.run.runId,
            toolExecutionId: item.toolExecutionId,
            status: "failed" as const,
            resultPreview: output.text,
            error: output.error,
            completedAt: nowMs(),
            updatedAt: nowMs()
          };
          const response = await this.retryControlWrite("disabled pending tool execution", params.signal, async () =>
            await this.apiClient.updateToolExecution(request)
          );
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
        toolExecutionId: item.toolExecutionId,
        callPartId: item.callPartId,
        assistantMessageId: item.assistantMessageId,
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

    if (params.signal.aborted) return { paused: false as const };
    const request = {
      workspaceId: params.run.workspaceId,
      sessionId: params.run.sessionId,
      runId: params.run.runId,
      runNoticeText: "",
      updatedAt: nowMs()
    };
    await this.retryControlWrite("clear tool notice", params.signal, async () =>
      await this.apiClient.updateRunNotice(request)
    );
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

  private async executeCompaction(params: {
    mode: CompactionMode;
    profile: ExecutionProfile;
    run: QueuedRun;
    signal: AbortSignal;
    casState?: CompactionCasState;
  }) {
    const executor = new CompactionExecutor({
      apiClient: this.apiClient,
      nowMs: this.nowMsFn,
      newId: newSortableId,
      isContextLimitError: isContextLengthExceededError,
      generateSummary: async (input) => await this.generateSingleCallSummary({
        profile: input.profile,
        input: {
          system: input.system,
          // Summary requests intentionally have no sessionId: they must not inherit
          // OpenAI Responses replay or main-turn prompt-cache state.
          messages: input.messages,
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
        },
      }),
    });
    return await executor.execute({
      mode: params.mode,
      profile: params.profile,
      workspaceId: params.run.workspaceId,
      sessionId: params.run.sessionId,
      runId: params.run.runId,
      abortSignal: params.signal,
      casState: params.casState,
    });
  }

  protected async generateSingleCallSummary(params: {
    profile: {
      provider: ExecutionProfile["provider"];
      model: ExecutionProfile["model"];
    };
    input: {
      messages: ModelMessage[];
      system?: string;
      sessionId?: string;
      timeoutMs: number | null;
      abortSignal: AbortSignal;
    };
  }) {
    // one-shot summary 若提供 sessionId，则共享主模型请求的 OpenAI 默认 promptCacheKey 策略。
    return generateSingleCallText(params.profile, params.input);
  }

  private async runModelStep(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    step: number;
    signal: AbortSignal;
    recoveryContinuation?: { messageId: string | null };
    repeatedToolCallCounter: Map<string, number>;
  }) {
    const { profile, run, context, step, signal, recoveryContinuation = { messageId: null }, repeatedToolCallCounter } = params;
    if (context.pendingTools.length > 0) {
      throw new Error("cannot invoke model while ToolExecution remains queued or running");
    }
    const conversationStateAdapter = this.providerConversationStateAdapterRegistry.resolve(profile);
    const model = createLanguageModel(profile);
    const runtimeOptions = buildModelRuntimeOptions(profile);
    const turnId = newSortableId("turn");
    let materializedMessages: ModelMessage[];
    const preparedInvocation = conversationStateAdapter?.prepareInvocation({
      profile,
      messages: context.messages as ModelMessage[],
      history: context.providerReplay,
      providerOptions: runtimeOptions.providerOptions,
    }) ?? {
      messages: context.messages as ModelMessage[],
      providerOptions: runtimeOptions.providerOptions,
    };
    const preparedProviderOptions = preparedInvocation.providerOptions;
    const includeRawChunks = preparedInvocation.includeRawChunks === true;
    materializedMessages = await materializePromptAttachments({ messages: preparedInvocation.messages as PromptContext["messages"], attachmentStorage: this.attachmentStorage });

    const modelIdleTimeoutMs = Math.max(0, Math.floor(profile.runtime.modelIdleTimeoutMs));
    const modelTotalTimeoutMs = Math.max(0, Math.floor(profile.runtime.modelTotalTimeoutMs));
    const modelRequestMaxRetries = normalizeModelRequestMaxRetries(profile.runtime.modelRequestMaxRetries);
    const modelRequestRetryBackoffMaxMs = normalizeRetryBackoffMaxMs(profile.runtime.modelRequestRetryBackoffMaxMs);

    const toolDefinitions = await this.toolRegistry.listTools({
      profile,
      promptContext: context,
      apiClient: this.apiClient
    });
    const toolSet: RuntimeToolSet = {};
    for (const item of toolDefinitions) {
      toolSet[item.name] = tool({
        description: item.description,
        inputSchema: jsonSchema(item.inputSchema)
      });
    }
    // 当前 turn 的 availableToolNames 是 builtin + MCP 合并后的快照；pendingTools 执行阶段必须严格按该快照校验，避免越权执行旧工具。
    // TODO(plugin-phase2): 若后续 provider 引入缓存/热更新，需要把该快照显式透传到执行阶段，而不是仅从 promptContext 重新推导。
    const availableToolNames = new Set<string>(Object.keys(toolSet));

    const requestBase: RuntimeStreamRequest = {
      model,
      system: context.system || undefined,
      messages: materializedMessages,
      tools: toolSet,
      ...runtimeOptions.aiSdk,
      maxRetries: 0,
    };
    if (Object.keys(runtimeOptions.providerOptions).length > 0 || profile.provider.npm === "@ai-sdk/openai") {
      const providerOptions = buildProviderOptionsWithPromptCacheKey({
          providerNpm: profile.provider.npm,
          sessionId: run.sessionId,
          providerOptions: preparedProviderOptions
        });
      const jsonProviderOptions: Record<string, JSONValue> = {};
      for (const [key, value] of Object.entries(providerOptions)) {
        const jsonValue = toJsonValue(value);
        if (jsonValue !== undefined) jsonProviderOptions[key] = jsonValue;
      }
      requestBase.providerOptions = {
        [runtimeOptions.providerKey]: jsonProviderOptions,
      };
    }
    // 自定义重试策略由本文件控制,禁用 AI SDK 内建重试避免双重重试。
    if (includeRawChunks) requestBase.includeRawChunks = true;

    let assistantMessageId: string;
    if (recoveryContinuation.messageId) {
      const resumedMessageId = recoveryContinuation.messageId;
      const claim = await this.apiClient.resumeStreamingAssistant({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: resumedMessageId,
      });
      assertFencedWriteUpdated("resume streaming assistant", claim);
      // 成功 claim 后该 continuation 已与本次模型 step 绑定，不能供后续 step 重复使用。
      recoveryContinuation.messageId = null;
      assistantMessageId = resumedMessageId;
    } else {
      assistantMessageId = newSortableId("message");
      const request = {
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: assistantMessageId,
        createdAt: this.nowMsFn(),
      };
      await this.retryIdempotentControlWrite("create streaming assistant", signal, async () =>
        await this.apiClient.createStreamingAssistant(request),
      );
    }

    const assistantStreamFlushIntervalMs = 1_000;
    const assistantStreamFlushCharsThreshold = 160;
    let orderedParts: StreamingAssistantPart[] = [];
    let streamPartVersion = 0;
    let streamedCharsSinceLastFlush = 0;
    const textFromParts = () => orderedParts
      .filter((part): part is Extract<StreamingAssistantPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    const reasoningFromParts = () => orderedParts
      .filter((part): part is Extract<StreamingAssistantPart, { type: "reasoning" }> => part.type === "reasoning")
      .map((part) => part.text)
      .join("");
    const toolCallsFromParts = () => orderedParts
      .filter((part): part is Extract<StreamingAssistantPart, { type: "tool_call" }> => part.type === "tool_call")
      .map((part) => part.toolCall);
    const ensureStreamTextPart = (type: "text" | "reasoning", id: string) => {
      const existing = orderedParts.find((part) => part.id === id);
      if (existing) {
        if (existing.type !== type) throw new AgentProviderReplayUpdateError("provider stream part id changed type");
        return existing;
      }
      const part: Extract<StreamingAssistantPart, { type: typeof type }> = {
        id,
        position: orderedParts.length,
        type,
        text: "",
      } as Extract<StreamingAssistantPart, { type: typeof type }>;
      orderedParts.push(part);
      streamPartVersion += 1;
      return part;
    };
    const appendStreamText = (type: "text" | "reasoning", delta: string, streamId?: string) => {
      const last = orderedParts.at(-1);
      const id = streamId || (last?.type === type ? last.id : `${assistantMessageId}:part:${orderedParts.length}`);
      const part = ensureStreamTextPart(type, id);
      if (orderedParts.at(-1)?.id !== part.id && delta) {
        throw new AgentProviderReplayUpdateError("provider stream attempted to append text to an earlier part");
      }
      if (delta) {
        part.text += delta;
        streamPartVersion += 1;
        streamedCharsSinceLastFlush += delta.length;
      }
    };
    const upsertProviderReplayPart = (update: ProviderReplayPartUpdate) => {
      const existing = update.type === "function_call"
        ? orderedParts.find((part) => part.type === "tool_call" && part.providerToolCallId === update.providerToolCallId)
        : orderedParts.find((part) => part.id === update.id);
      if (existing) {
        if (existing.type === "text" && update.type === "text") {
          const replayChanged = existing.providerReplay == null
            || serializeAgentProviderReplay(existing.providerReplay) !== serializeAgentProviderReplay(update.providerReplay);
          if (existing.providerReplay && replayChanged) assertAgentProviderReplayUpdateCompatible(existing.providerReplay, update.providerReplay);
          if (update.text != null && !update.text.startsWith(existing.text)) {
            throw new Error("provider replay text must extend the existing cumulative text");
          }
          const textChanged = update.text != null && update.text !== existing.text;
          if (!replayChanged && !textChanged) return;
          if (update.text != null) existing.text = update.text;
          existing.providerReplay = update.providerReplay;
        } else if (existing.type === "reasoning" && update.type === "reasoning") {
          const replayChanged = existing.providerReplay == null
            || serializeAgentProviderReplay(existing.providerReplay) !== serializeAgentProviderReplay(update.providerReplay);
          if (existing.providerReplay && replayChanged) assertAgentProviderReplayUpdateCompatible(existing.providerReplay, update.providerReplay);
          if (update.text != null && !update.text.startsWith(existing.text)) {
            throw new Error("provider replay text must extend the existing cumulative text");
          }
          const textChanged = update.text != null && update.text !== existing.text;
          if (!replayChanged && !textChanged) return;
          if (update.text != null) existing.text = update.text;
          existing.providerReplay = update.providerReplay;
        } else if (existing.type === "tool_call" && update.type === "function_call") {
          if (existing.providerReplay) {
            if (serializeAgentProviderReplay(existing.providerReplay) === serializeAgentProviderReplay(update.providerReplay)) return;
            assertAgentProviderReplayUpdateCompatible(existing.providerReplay, update.providerReplay);
          }
          existing.providerReplay = update.providerReplay;
        } else {
          throw new Error("provider replay update does not match streaming part type");
        }
      } else if (update.type === "text") {
        orderedParts.push({ id: update.id, position: orderedParts.length, type: "text", text: update.text ?? "", providerReplay: update.providerReplay });
      } else if (update.type === "reasoning") {
        orderedParts.push({ id: update.id, position: orderedParts.length, type: "reasoning", text: update.text ?? "", providerReplay: update.providerReplay });
      } else {
        throw new AgentProviderReplayUpdateError("function_call replay requires a matching tool_call call_id");
      }
      // metadata-only 也是原生 Provider 输出。版本推进使 flush 与 retry replacement
      // 不再依赖可见文本长度。
      streamPartVersion += 1;
    };
    const appendToolCall = (
      toolName: string,
      toolCallId: string,
      args: Record<string, unknown>,
      providerReplay?: ProviderReplayFor<"function_call">,
    ) => {
      const existing = orderedParts.find((part) => part.type === "tool_call" && part.providerToolCallId === toolCallId);
      if (existing?.type === "tool_call") {
        const sameCall = existing.toolName === toolName && JSON.stringify(existing.input) === JSON.stringify(args);
        if (!sameCall) {
          throw new AgentProviderReplayUpdateError("tool-call call_id was reused with different name or input");
        }
        if (providerReplay) {
          if (existing.providerReplay) {
            if (serializeAgentProviderReplay(existing.providerReplay) === serializeAgentProviderReplay(providerReplay)) return;
            assertAgentProviderReplayUpdateCompatible(existing.providerReplay, providerReplay);
          }
          existing.providerReplay = providerReplay;
          streamPartVersion += 1;
        }
        return;
      }
      const callPartId = `${assistantMessageId}:part:${orderedParts.length}`;
      const toolCall: ToolCall = { toolName, toolCallId, args, callPartId };
      orderedParts.push({
        id: callPartId,
        position: orderedParts.length,
        type: "tool_call",
        toolName,
        input: args,
        providerToolCallId: toolCallId || null,
        toolCall,
        ...(providerReplay == null ? {} : { providerReplay }),
      });
      streamPartVersion += 1;
    };
    const startedAt = this.nowMsFn();
    let responseTotalTokens: number | null = null;

    await writeAssistantDebugRecord({
      logger: this.logger,
      workspacePath: run.workspacePath,
      recordId: assistantMessageId,
      input: {
        status: "running",
        startedAt,
        meta: {
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          step,
          messageId: assistantMessageId
        },
        request: requestBase,
        retryPolicy: {
          firstBackoffMs: MODEL_RETRY_BACKOFF_BASE_MS,
          maxBackoffMs: modelRequestRetryBackoffMaxMs,
        }
      }
    });

    let retryCount = 0;
    let successfulStream: any = null;
    let lastFlushedPartVersion = 0;
    let lastFlushAt = this.nowMsFn();
    let pendingFlush = false;
    let retryNoticePendingClear = false;

    const clearRetryNoticeAfterSuccess = async () => {
      if (!retryNoticePendingClear) return;
      const request = {
        workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId,
        runNoticeText: "", retryCount: 0, nextRetryAt: null, updatedAt: this.nowMsFn()
      };
      await this.retryControlWrite("clear retry notice", signal, async () =>
        await this.apiClient.updateRunNotice(request)
      );
      retryNoticePendingClear = false;
    };

    const flushAssistant = async (force = false, clearRetryNotice = true) => {
      if (!force && streamPartVersion === lastFlushedPartVersion) return;
      const parts: AgentApiFlushAssistantPartsRequest["parts"] = orderedParts.map((part) => {
        if (part.type === "text") {
          return {
            id: part.id, position: part.position, type: "text" as const, text: part.text,
            ...(part.providerReplay == null ? {} : { providerReplay: part.providerReplay }),
          };
        }
        if (part.type === "reasoning") {
          return {
            id: part.id, position: part.position, type: "reasoning" as const, text: part.text,
            ...(part.providerReplay == null ? {} : { providerReplay: part.providerReplay }),
          };
        }
        return {
          id: part.id,
          position: part.position,
          type: "tool_call" as const,
          toolName: part.toolName,
          input: part.input,
          providerToolCallId: part.providerToolCallId,
          ...(part.providerReplay == null ? {} : { providerReplay: part.providerReplay }),
        };
      });
      const request = {
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        messageId: assistantMessageId,
        parts,
        updatedAt: this.nowMsFn()
      };
      await this.retryControlWrite("flush assistant parts", signal, async () =>
        await this.apiClient.flushAssistantParts(request)
      );
      lastFlushedPartVersion = streamPartVersion;
      streamedCharsSinceLastFlush = 0;
      lastFlushAt = this.nowMsFn();
      pendingFlush = false;
      if (clearRetryNotice && (hasVisibleAssistantText(textFromParts()) || reasoningFromParts().length > 0 || toolCallsFromParts().length > 0)) {
        await clearRetryNoticeAfterSuccess();
      }
    };

    const maybeFlushAssistantStreaming = async (force = false) => {
      const now = this.nowMsFn();
      const deltaChars = streamedCharsSinceLastFlush;
      if (
        force
        || deltaChars >= assistantStreamFlushCharsThreshold
        || now - lastFlushAt >= assistantStreamFlushIntervalMs
      ) {
        await flushAssistant(true);
        return;
      }
      pendingFlush = true;
    };

    const replaceAssistantForRetry = async (notice: { runNoticeText: string; retryCount: number; nextRetryAt: number | null }) => {
      const oldMessageId = assistantMessageId;
      const newMessageId = newSortableId("message");
      const request = {
        workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId,
        oldMessageId, newMessageId, runNoticeText: notice.runNoticeText,
        retryCount: notice.retryCount, nextRetryAt: notice.nextRetryAt, createdAt: this.nowMsFn()
      };
      await this.retryControlWrite("replace streaming assistant", signal, async () =>
        await this.apiClient.replaceStreamingAssistant(request)
      );
      assistantMessageId = newMessageId;
      orderedParts = [];
      streamPartVersion = 0;
      streamedCharsSinceLastFlush = 0;
      responseTotalTokens = null;
      lastFlushedPartVersion = 0;
      lastFlushAt = this.nowMsFn();
      pendingFlush = false;
      retryNoticePendingClear = true;
    };

    while (true) {
      if (signal.aborted) {
        return { aborted: true as const, assistantMessageId };
      }

      // 用独立 controller 承载“用户取消”和“空闲/总超时”中止。
      // 仅将“用户取消”(signal.aborted)视为 run cancelled。
      const requestController = new AbortController();
      let idleTimedOut = false;
      let totalTimedOut = false;
      let lastChunkAt = this.nowMsFn();
      const attemptStartPartVersion = streamPartVersion;
      const attemptProducedOutput = () => streamPartVersion > attemptStartPartVersion;
      const conversationStateAttempt = conversationStateAdapter?.createAttempt();
      let attemptStream: RuntimeStreamResult | null = null;
      let attemptResponseTotalTokens: number | null = null;
      let attemptReachedTerminal = false;

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

      const request = {
        ...requestBase,
        abortSignal: requestController.signal,
        messages: materializedMessages
      } satisfies RuntimeStreamRequest;

      try {
        const stream = this.streamTextFn(request);
        attemptStream = stream;
        successfulStream = attemptStream;
        for await (const chunk of stream.fullStream) {
          if (requestController.signal.aborted) break;
          lastChunkAt = this.nowMsFn();
          if (!chunk || typeof chunk !== "object") continue;
          const observedProtocolChunk = conversationStateAttempt?.observeChunk(chunk);
          const providerReplayUpdate = this.providerReplayPartFromChunkFn?.(chunk)
            ?? observedProtocolChunk?.partUpdate;
          if (providerReplayUpdate && providerReplayUpdate.type !== "function_call") {
            ensureStreamTextPart(providerReplayUpdate.type, providerReplayUpdate.id);
            upsertProviderReplayPart(providerReplayUpdate);
            await maybeFlushAssistantStreaming();
          }
          for (const terminalUpdate of observedProtocolChunk?.terminalPartUpdates ?? []) {
            upsertProviderReplayPart(terminalUpdate);
          }
          if ((observedProtocolChunk?.terminalPartUpdates?.length ?? 0) > 0) {
            await maybeFlushAssistantStreaming();
          }
          if (chunk.type === "text-start" || chunk.type === "reasoning-start") {
            ensureStreamTextPart(chunk.type === "text-start" ? "text" : "reasoning", chunk.id);
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (chunk.type === "text-delta") {
            const delta = chunk.text;
            if (!delta) continue;
            appendStreamText("text", delta, chunk.id);
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (chunk.type === "reasoning-delta") {
            const delta = chunk.text;
            if (!delta) continue;
            appendStreamText("reasoning", delta, chunk.id);
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (chunk.type === "text-end" || chunk.type === "reasoning-end") continue;
          if (chunk.type === "tool-call") {
            const toolCallReplay = this.providerToolCallReplayFromChunkFn?.(chunk)
              ?? observedProtocolChunk?.toolCallReplay;
            const toolName = normalizeToolName(chunk.toolName, availableToolNames);
            if (!toolName) continue;
            const rawToolCallId = String(chunk.toolCallId || "").trim();
            const toolCallId = rawToolCallId || `${turnId}_call_${toolCallsFromParts().length + 1}`;
            if (toolCallReplay && toolCallReplay.providerToolCallId !== toolCallId) {
              throw new AgentProviderReplayUpdateError("function_call replay call_id does not match tool-call chunk");
            }
            const args = normalizeToolArgs(chunk.input);
            appendToolCall(toolName, toolCallId, args, toolCallReplay?.providerReplay);
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (providerReplayUpdate?.type === "function_call") {
            upsertProviderReplayPart(providerReplayUpdate);
            await maybeFlushAssistantStreaming();
            continue;
          }
          if (chunk.type === "finish") {
            attemptResponseTotalTokens = extractTotalTokens(chunk.totalUsage) ?? attemptResponseTotalTokens;
            continue;
          }
          if (chunk.type === "error") {
            throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error || "stream error"));
          }
          if (chunk.type === "abort") {
            throw new Error("model stream aborted");
          }
        }
        attemptReachedTerminal = true;
        if (pendingFlush) {
          await flushAssistant(true);
        }

        if (signal.aborted) {
          return { aborted: true as const, assistantMessageId };
        }
        if (totalTimedOut) {
          throw new Error(`model total timeout after ${modelTotalTimeoutMs}ms`);
        }
        if (idleTimedOut) {
          throw new Error(`model idle timeout after ${modelIdleTimeoutMs}ms`);
        }
        const protocolValidation = conversationStateAttempt?.finalizeAttempt();
        if (protocolValidation && !protocolValidation.ok) {
          throw new Error(protocolValidation.message);
        }
        // replay-only 必须基于本次 Assistant 已实际落地的 reasoning Part，而非 Attempt 观察到的原始 chunk。
        // 严格 round-trip 校验避免 text/function identity 或未知工具 metadata 意外放开空 Assistant。
        const hasPersistedOpenAiReasoningReplay = orderedParts.some((part) => {
          if (part.type !== "reasoning" || part.providerReplay == null) return false;
          try {
            const replay = parseAgentProviderReplay(serializeAgentProviderReplay(part.providerReplay));
            return replay?.item.type === "reasoning"
              && replay.provider.npm === "@ai-sdk/openai"
              && replay.provider.api === "responses"
              && replay.provider.providerId === profile.provider.id
              && replay.provider.model === finalOpenAiModel(profile);
          } catch {
            return false;
          }
        });
        // 仅已通过当前协议终态校验且存在已落地兼容 reasoning replay 的 Adapter 可让空可见内容完成。
        // terminal metadata 在此之前已进入 orderedParts 并经上方 flush 持久化。
        const allowsReplayOnlyAssistant = protocolValidation?.ok === true
          && hasPersistedOpenAiReasoningReplay;
        try {
          const finalReasoning = await successfulStream.reasoningText;
          const finalReasoningText = typeof finalReasoning === "string"
            ? finalReasoning
            : "";
          if (finalReasoningText && reasoningFromParts().length === 0) {
            appendStreamText("reasoning", finalReasoningText);
          }
        } catch {
          // 保留流式阶段已经获取的 reasoning；收尾读取失败不应覆盖有效输出。
        }
        if (!hasVisibleAssistantText(textFromParts()) && reasoningFromParts().length === 0 && toolCallsFromParts().length === 0 && !allowsReplayOnlyAssistant) {
          throw new Error("model stream completed without visible text or tool calls");
        }
        if (attemptResponseTotalTokens == null && attemptStream) {
          attemptResponseTotalTokens = await readStreamTotalTokens(attemptStream);
        }
        responseTotalTokens = attemptResponseTotalTokens;

        break;
      } catch (err) {
        if (signal.aborted) {
          await writeAssistantDebugRecord({
            logger: this.logger,
            workspacePath: run.workspacePath,
            recordId: assistantMessageId,
            input: {
              status: "failed",
              startedAt,
              meta: { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, turnId, step, messageId: assistantMessageId, failureKind: "aborted" },
              request: requestBase,
              error: err,
            },
          });
          return { aborted: true as const, assistantMessageId };
        }
        if (err instanceof FencedWriteIgnoredError || err instanceof FencedWriteMissingError || err instanceof ControlWritePermanentError || err instanceof AgentProviderReplayUpdateError) {
          await writeAssistantDebugRecord({
            logger: this.logger,
            workspacePath: run.workspacePath,
            recordId: assistantMessageId,
            input: {
              status: "failed",
              startedAt,
              meta: { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId, turnId, step, messageId: assistantMessageId, failureKind: attemptReachedTerminal ? "assistant-finalization" : "invariant-or-control" },
              request: requestBase,
              error: err,
            },
          });
          throw err;
        }
        if (totalTimedOut) {
          err = new Error(`model total timeout after ${modelTotalTimeoutMs}ms`);
        } else if (idleTimedOut) {
          err = new Error(`model idle timeout after ${modelIdleTimeoutMs}ms`);
        }
        const message = safeErrorSummary(err);

        if (retryCount >= modelRequestMaxRetries) {
          throw err;
        }

        {
          const delayMs = computeRetryBackoffMs(retryCount, modelRequestRetryBackoffMaxMs);
          const retryAttempt = retryCount + 1;
          const noticeText = `Request failed, retrying in ${Math.floor(delayMs / 1000)}s (attempt ${retryAttempt}): ${message}`;
          const nextRetryAt = this.nowMsFn() + delayMs;
          retryCount = retryAttempt;
          if (attemptProducedOutput()) {
            await flushAssistant(true, false);
            await replaceAssistantForRetry({
              runNoticeText: noticeText,
              retryCount: retryAttempt,
              nextRetryAt
            });
          } else {
            const request = {
              workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId,
              runNoticeText: noticeText, retryCount: retryAttempt, nextRetryAt, updatedAt: this.nowMsFn()
            };
            await this.retryControlWrite("update retry notice", signal, async () =>
              await this.apiClient.updateRunNotice(request)
            );
            retryNoticePendingClear = true;
          }

          await writeAssistantDebugRecord({
            logger: this.logger,
            workspacePath: run.workspacePath,
            recordId: assistantMessageId,
            input: {
              status: "failed",
              meta: {
                workspaceId: run.workspaceId,
                sessionId: run.sessionId,
                runId: run.runId,
                turnId,
                step,
                messageId: assistantMessageId,
                retryAttempt,
                nextRetryInMs: delayMs
              },
              request: requestBase,
              error: err,
            }
          });

          const continueRunning = await sleepMsWithAbort(delayMs, signal);
          if (!continueRunning) {
            return { aborted: true as const, assistantMessageId };
          }
          continue;
        }
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

    const recognizedCalls = toolCallsFromParts();
    let terminalFailureLogged = false;
    const writeTerminalFailure = async (failureKind: string, error: unknown) => {
      if (terminalFailureLogged) return;
      terminalFailureLogged = true;
      await writeAssistantDebugRecord({
        logger: this.logger,
        workspacePath: run.workspacePath,
        recordId: assistantMessageId,
        input: {
          status: "failed",
          startedAt,
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            step,
            messageId: assistantMessageId,
            failureKind,
          },
          request: requestBase,
          response: {
            text: textFromParts(),
            reasoningText: reasoningFromParts(),
            toolCalls: recognizedCalls,
          },
          error,
        },
      });
    };
    try {
      const executions: Array<{ id: string; callPartId: string; originSessionId: string; originRunId: string; status: "queued" }> = [];
      for (const call of recognizedCalls) {
        const signature = toolSignature(call.toolName, call.args);
        const count = (repeatedToolCallCounter.get(signature) ?? 0) + 1;
        repeatedToolCallCounter.set(signature, count);
        if (LOOP_REPEAT_TOOL_CALL_THRESHOLD > 0 && count > LOOP_REPEAT_TOOL_CALL_THRESHOLD) {
          throw new Error(`repeated tool call threshold exceeded: ${call.toolName}`);
        }

        executions.push({
          id: newSortableId("tool-execution"),
          callPartId: call.callPartId,
          originSessionId: run.sessionId,
          originRunId: run.runId,
          status: "queued"
        });
      }

      // 已在有效输出校验前读取收尾 reasoning，确保 reasoning-only 响应可正常完成。
      await flushAssistant(true);

      const completeRequest = {
        workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId,
        messageId: assistantMessageId, executions,
        responseTotalTokens, updatedAt: this.nowMsFn()
      };
      const terminalAssistant = executions.length === 0;
      if (terminalAssistant) {
        const code: "run_completed" | "subtask_completed" = run.runKind === "subtask" ? "subtask_completed" : "run_completed";
        const terminalRequest = {
          workspaceId: completeRequest.workspaceId,
          sessionId: completeRequest.sessionId,
          runId: completeRequest.runId,
          messageId: completeRequest.messageId,
          responseTotalTokens: completeRequest.responseTotalTokens,
          intent: { status: "completed" as const, code, detail: null },
          updatedAt: completeRequest.updatedAt,
        };
        await this.retryControlWrite("complete terminal assistant", signal, async () =>
          await this.apiClient.completeTerminalAssistant(terminalRequest)
        );
      } else {
        await this.retryControlWrite("complete assistant", signal, async () =>
          await this.apiClient.completeAssistant(completeRequest)
        );
      }

      await writeAssistantDebugRecord({
        logger: this.logger,
        workspacePath: run.workspacePath,
        recordId: assistantMessageId,
        input: {
          status: "completed",
          startedAt,
          finishedAt: this.nowMsFn(),
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            step,
            messageId: assistantMessageId
          },
          request: requestBase,
          response: {
            text: textFromParts(),
            reasoningText: reasoningFromParts(),
            toolCalls: recognizedCalls,
            usage: responseTotalTokens == null ? null : { totalTokens: responseTotalTokens }
          }
        }
      });
      await clearRetryNoticeAfterSuccess();

      return {
        aborted: false as const,
        toolCallCount: recognizedCalls.length,
        assistantMessageId,
        terminalIntentPersisted: terminalAssistant,
        hasVisibleText: hasVisibleAssistantText(textFromParts()) || reasoningFromParts().length > 0,
        availableToolNames: recognizedCalls.length > 0 ? availableToolNames : undefined
      };
    } catch (err) {
      await writeTerminalFailure("assistant-finalization", err);
      throw err;
    }
  }

  private async processRun(run: QueuedRun, signal: AbortSignal) {
    type TerminalStatus = "completed" | "failed" | "cancelled";
    type TerminalTuple = { status: TerminalStatus; code: import("@agent-workbench/shared").AgentTerminalResultCode; detail: null };
    let terminalTuple: TerminalTuple | null = null;
    let terminalIntentPersisted = false;
    let terminalConverged = false;
    let terminalDeadline: number | null = null;
    let terminalIntentAttempts = 0;
    let terminalConvergenceAttempts = 0;
    const terminalCode = (status: TerminalStatus) => {
      if (status === "cancelled") return "run_cancelled" as const;
      if (run.runKind === "manual_compaction") return status === "completed" ? "compaction_completed" as const : "compaction_failed" as const;
      if (run.runKind === "subtask") return status === "completed" ? "subtask_completed" as const : "subtask_failed" as const;
      return status === "completed" ? "run_completed" as const : "run_failed" as const;
    };
    const finishOnce = async (requested: TerminalStatus | TerminalTuple, options: { intentAlreadyPersisted?: boolean } = {}) => {
      if (terminalConverged) return;
      const tuple = typeof requested === "string"
        ? { status: requested, code: terminalCode(requested), detail: null } as TerminalTuple
        : requested;
      if (terminalTuple && (terminalTuple.status !== tuple.status || terminalTuple.code !== tuple.code || terminalTuple.detail !== tuple.detail)) {
        throw new Error("terminal result conflicts with an already selected tuple");
      }
      terminalTuple ??= tuple;
      terminalIntentPersisted ||= options.intentAlreadyPersisted === true;
      terminalDeadline ??= this.nowMsFn() + 10_000;
      const request = { workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId };
      const retryPhase = async (phase: "intent" | "convergence") => {
        const attempts = () => phase === "intent" ? terminalIntentAttempts : terminalConvergenceAttempts;
        const incrementAttempts = () => {
          if (phase === "intent") terminalIntentAttempts += 1;
          else terminalConvergenceAttempts += 1;
        };
        while (attempts() < 3) {
          const remaining = terminalDeadline! - this.nowMsFn();
          if (remaining <= 0) break;
          try {
            incrementAttempts();
            if (phase === "intent") {
              await this.apiClient.persistRunTerminalIntent({
                ...request,
                ...terminalTuple!,
                updatedAt: this.nowMsFn(),
              }, { timeoutMs: remaining });
            } else {
              await this.apiClient.convergeRunTerminal({
                ...request,
                updatedAt: this.nowMsFn(),
              }, { timeoutMs: remaining });
            }
            return;
          } catch (err) {
            if (!isRetryableTerminalControlError(err)) throw err;
            if (attempts() >= 3 || terminalDeadline! - this.nowMsFn() <= 250) throw err;
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
          }
        }
        throw new Error(`terminal ${phase} control budget exhausted`);
      };
      if (!terminalIntentPersisted) {
        await retryPhase("intent");
        terminalIntentPersisted = true;
      }
      await retryPhase("convergence");
      terminalConverged = true;
    };
    const tryFinishOnce = async (status: TerminalStatus | TerminalTuple, options?: { intentAlreadyPersisted?: boolean }) => {
      try {
        await finishOnce(status, options);
      } catch (err) {
        if (err instanceof ApiConflictError) {
          this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
          return;
        }
        throw err;
      }
    };
    try {
      await this.apiClient.markRunWorkInProgress({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        updatedAt: nowMs(),
      });
      const profile = await this.apiClient.getExecutionProfile({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId
      });

      let step = 0;
      const repeatedToolCallCounter = new Map<string, number>();
      const recoveryContinuation = run.recoveryContinuation ?? { messageId: run.resumeAssistantMessageId ?? null };
      let emptyResponseCount = 0;

      // 手动压缩: 仅执行一次 compaction,不进入正常 step 循环.
      if (run.runKind === "manual_compaction") {
        const notice = await this.apiClient.updateRunNotice({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          runNoticeText: "正在压缩上下文...",
          updatedAt: nowMs()
        });
        assertFencedWriteUpdated("start compaction notice", notice);

        const compacted = await this.executeCompaction({ mode: "manual", profile, run, signal });
        if (signal.aborted) {
          await finishOnce("cancelled");
          return;
        }
        if (compacted.kind === "committed") {
          await finishOnce("completed", { intentAlreadyPersisted: true });
          return;
        }
        if (compacted.kind === "skipped" && compacted.reason === "cas_conflict") throw new CompactionConflictError();
        if (compacted.kind === "unavailable") {
          await finishOnce({ status: "failed", code: "compaction_provider_unavailable", detail: null });
          return;
        }
        if (compacted.kind === "skipped") {
          await finishOnce({
            status: "completed",
            code: compacted.reason === "no_prefix" ? "compaction_not_needed"
              : compacted.reason === "oversized_tail" ? "compaction_oversized_tail"
              : "compaction_no_progress",
            detail: null,
          });
          return;
        }
        if (compacted.kind === "blocked") {
          await finishOnce({ status: "failed", code: "compaction_pending_tools", detail: null });
          return;
        }
        if (compacted.kind === "media_requires_resend") {
          await finishOnce({ status: "completed", code: "compaction_media_requires_resend", detail: null });
          return;
        }
        await finishOnce({ status: "failed", code: "compaction_failed", detail: null });
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

        if (recoveryContinuation.messageId == null && this.shouldAutoCompact({ context, model: profile.model, runtime: profile.runtime })) {
          const compacted = await this.executeCompaction({ mode: "proactive", profile, run, signal });
          if (compacted.kind === "failed" && compacted.reason !== "cancelled") {
            throw new Error(`proactive compaction failed: ${compacted.reason}`);
          }
          if (compacted.kind === "committed" || signal.aborted) {
            if (signal.aborted) await finishOnce("cancelled");
            continue;
          }
        }

        if (shouldStopForMaxSteps(step, LOOP_MAX_STEPS)) {
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
          recoveryContinuation,
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
          await finishOnce("completed", { intentAlreadyPersisted: result.terminalIntentPersisted === true });
          return;
        }
        emptyResponseCount += 1;
        if (emptyResponseCount >= EMPTY_RESPONSE_COMPLETE_THRESHOLD) {
          await finishOnce("completed", { intentAlreadyPersisted: result.terminalIntentPersisted === true });
          return;
        }
      }
      if (signal.aborted) {
        await finishOnce("cancelled");
      }
    } catch (err) {
      if (terminalTuple) {
        this.logger.error(`terminal control failed after tuple selection: ${run.sessionId} ${run.runId}`);
        return;
      }
      if (isAbortLikeError(err, signal)) {
        this.logger.info(`run aborted: ${run.sessionId} ${run.runId}`);
        await tryFinishOnce("cancelled");
        return;
      }
      if (err instanceof FencedWriteIgnoredError) {
        this.logger.info(`run fenced write ignored, stop run: ${run.sessionId} ${run.runId}`);
        return;
      }
      if (err instanceof ApiConflictError) {
        this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
        return;
      }

      const cause = err;
      const failedTuple: TerminalTuple = err instanceof CompactionConflictError && (run.runKind === "user" || run.runKind === "manual_compaction")
        ? { status: "failed", code: "compaction_conflict", detail: null }
        : { status: "failed", code: terminalCode("failed"), detail: null };
      try {
        await tryFinishOnce(failedTuple);
      } catch {
        this.logger.error(`run failed and fallback append failed: ${run.sessionId} ${run.runId} ${safeErrorSummary(cause)}`);
      }
    }
  }
}

export type EnqueuePayload = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  runKind?: "user" | "manual_compaction" | "subtask";
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

export function sanitizeForDebugDumpForTest(value: unknown) {
  return sanitizeForDebugDump(value);
}

export function projectAssistantDebugRecordForTest(input: Parameters<typeof projectAssistantDebugRecord>[0]) {
  return projectAssistantDebugRecord(input);
}

export function serializeAssistantDebugRecordForTest(input: Parameters<typeof projectAssistantDebugRecord>[0]) {
  return serializeAssistantDebugRecord(projectAssistantDebugRecord(input));
}

export async function writeAssistantDebugRecordForTest(params: {
  logger: Pick<Console, "warn">;
  workspacePath: string;
  recordId?: string;
  input: Parameters<typeof projectAssistantDebugRecord>[0];
}) {
  await writeAssistantDebugRecord({ ...params, force: true });
}

export function safeErrorSummaryForTest(value: unknown) {
  return safeErrorSummary(value);
}

export async function writeItemLogForTest(params: {
  logger: Pick<Console, "warn">;
  workspacePath: string;
  kind: "assistant" | "tool";
  recordId?: string;
  payload: unknown;
  force?: boolean;
}) {
  await writeItemLog({ ...params, force: true });
}

export async function finalizeToolTextForTest(params: {
  workspacePath: string;
  toolExecutionId: string;
  toolName: string;
  text: string;
  beforeArtifactCommit?: () => Promise<void> | void;
  onArtifactWritePhase?: (phase: "before_rename" | "after_rename") => Promise<void> | void;
}) {
  return finalizeToolText(params);
}
