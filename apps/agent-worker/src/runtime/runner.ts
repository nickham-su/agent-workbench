import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { jsonSchema, streamText, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateSingleCallText } from "@agent-workbench/shared/llm-single-call";
import { runBashCommand } from "./bash.js";
import { getBashToolAppendix } from "./bashTools.js";
import { AgentApiClient, ApiConflictError, type ExecutionProfile, type PromptContext } from "./apiClient.js";
import { runReadTool, runWriteTool } from "./fileTools.js";
import { McpManager } from "./mcpManager.js";
import { applyPreparedPatch, prepareApplyPatchTool, type ApplyPatchPrepared } from "./applyPatch.js";
import { parseTodolistArgs, toTodolistResult } from "./todolist.js";

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
const COMPACTION_USER_PROMPT = [
  "请基于当前会话内容输出一份总结,用于继续当前任务。",
  "重点覆盖:",
  "- 已完成了什么",
  "- 当前正在做什么",
  "- 涉及哪些文件或模块",
  "- 下一步待办",
  "- 需要持续遵守的用户约束与偏好",
  "- 关键技术决策及原因",
  "要求: 只输出总结,不要回答会话中的问题,不要编造未出现的信息。"
].join("\n");

function newSortableId(prefix: string) {
  const ts = Date.now().toString(36).padStart(10, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${ts}${random}`;
}

function computeRetryBackoffMs(attemptIndex: number) {
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) return MODEL_RETRY_BACKOFF_BASE_MS;
  const factor = 2 ** Math.floor(attemptIndex);
  const delay = MODEL_RETRY_BACKOFF_BASE_MS * factor;
  return Math.min(MODEL_RETRY_BACKOFF_MAX_MS, Math.max(MODEL_RETRY_BACKOFF_BASE_MS, delay));
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

type QueuedRun = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  inputText?: string;
  workspacePath: string;
};

type PendingTool = {
  itemId: number;
  status: "queued" | "running" | "awaiting_permission" | "streaming" | "completed" | "failed" | "denied" | "cancelled";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  approved?: boolean;
};

type ToolCall = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
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

function isBuiltinTool(toolName: string) {
  return (
    toolName === "bash" ||
    toolName === "read" ||
    toolName === "write" ||
    toolName === "apply_patch" ||
    toolName === "todolist" ||
    toolName === "archive_search" ||
    toolName === "archive_read"
  );
}

function isSubtaskTool(toolName: string) {
  return toolName === "subtask";
}

function isMcpTool(toolName: string) {
  return toolName.startsWith("mcp_");
}

function isToolEnabledForAgent(profile: ExecutionProfile, toolName: string) {
  if (isBuiltinTool(toolName) || isSubtaskTool(toolName)) {
    return profile.agent.tools.includes(
      toolName as
        | "bash"
        | "read"
        | "write"
        | "apply_patch"
        | "todolist"
        | "subtask"
        | "archive_search"
        | "archive_read"
    );
  }
  if (isMcpTool(toolName)) {
    return true;
  }
  return false;
}

function toRecord(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
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

function requireNonEmptyStringArg(raw: unknown, fieldName: string) {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function parseOptionalPositiveIntegerArg(raw: unknown, fieldName: string) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be an integer >= 1`);
  }
  return parsed;
}

type ParsedSubtaskArgs = {
  description: string;
  prompt: string;
  agentId: string;
  session: {
    mode: "new" | "existing" | "fork";
    sessionId?: string;
  };
};

function parseSubtaskArgs(raw: Record<string, unknown>): ParsedSubtaskArgs {
  const description = requireNonEmptyStringArg(raw.description, "subtask.description");
  if (description.length > 20) {
    throw new Error("subtask.description must be <= 20 characters");
  }
  const prompt = requireNonEmptyStringArg(raw.prompt, "subtask.prompt");
  const agentId = requireNonEmptyStringArg(raw.agentId, "subtask.agentId");
  const sessionRaw = toRecord(raw.session);
  const modeRaw = requireNonEmptyStringArg(sessionRaw.mode, "subtask.session.mode");
  let mode: "new" | "existing" | "fork";
  if (modeRaw === "new" || modeRaw === "existing" || modeRaw === "fork") {
    mode = modeRaw;
  } else {
    throw new Error(`subtask.session.mode must be one of: new, existing, fork`);
  }
  const sessionId = String(sessionRaw.sessionId || "").trim();
  if (mode === "existing" && !sessionId) {
    throw new Error("subtask.session.sessionId is required when mode=existing");
  }
  if ((mode === "new" || mode === "fork") && sessionId) {
    throw new Error(`subtask.session.sessionId is not allowed when mode=${mode}`);
  }

  return {
    description,
    prompt,
    agentId,
    session: {
      mode,
      ...(sessionId ? { sessionId } : {})
    }
  };
}

function toApplyPatchResult(prepared: ApplyPatchPrepared) {
  return {
    text: prepared.text,
    summary: prepared.summary,
    files: prepared.files
  };
}

export class AgentRunner {
  private readonly queue: QueuedRun[] = [];
  private readonly queuedRunIds = new Set<string>();
  private readonly runningSessions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private activeCount = 0;

  constructor(
    private readonly apiClient: AgentApiClient,
    private readonly mcpManager: McpManager,
    private readonly logger: Pick<Console, "info" | "warn" | "error">,
    private readonly concurrency: number
  ) {}

  enqueueRun(run: QueuedRun) {
    if (this.queuedRunIds.has(run.runId)) return;
    this.queue.push(run);
    this.queuedRunIds.add(run.runId);
    this.pump();
  }

  cancelSession(sessionId: string) {
    const controller = this.controllers.get(sessionId);
    if (controller) controller.abort();
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i];
      if (!item || item.sessionId !== sessionId) continue;
      this.queuedRunIds.delete(item.runId);
      this.queue.splice(i, 1);
    }
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
    const controller = new AbortController();
    this.controllers.set(run.sessionId, controller);

    void this.processRun(run, controller.signal)
      .catch((err) => {
        this.logger.error("worker run failed", err);
      })
      .finally(() => {
        this.controllers.delete(run.sessionId);
        this.runningSessions.delete(run.sessionId);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async executeTool(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    tool: PendingTool;
    signal: AbortSignal;
  }) {
    const { profile, run, tool, signal } = params;
    if (signal.aborted) return { paused: false as const };

    const outputBase = {
      type: "tool" as const,
      toolName: tool.toolName,
      toolCallId: tool.toolCallId,
      args: tool.args
    };

    if (!isToolEnabledForAgent(profile, tool.toolName)) {
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "failed",
        output: {
          ...outputBase,
          error: `tool is disabled for current agent: ${tool.toolName}`
        },
        updatedAt: nowMs()
      });
      return { paused: false as const };
    }

    let applyPatchPrepared: ApplyPatchPrepared | null = null;
    if (tool.toolName === "apply_patch") {
      const patchText = requireNonEmptyStringArg(tool.args.patchText, "apply_patch.patchText");
      try {
        applyPatchPrepared = await prepareApplyPatchTool({
          workspacePath: run.workspacePath,
          patchText,
          signal
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const error = message.startsWith("apply_patch verification failed:")
          ? message
          : `apply_patch verification failed: ${message}`;
        await this.apiClient.updateContextItem({
          itemId: tool.itemId,
          status: "failed",
          output: {
            ...outputBase,
            error
          },
          updatedAt: nowMs()
        });
        await writeItemLog({
          logger: this.logger,
          workspacePath: run.workspacePath,
          kind: "tool",
          itemId: tool.itemId,
          payload: {
            meta: {
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              toolItemId: tool.itemId
            },
            request: {
              toolName: tool.toolName,
              toolCallId: tool.toolCallId,
              args: tool.args
            },
            status: "failed",
            error
          }
        });
        return { paused: false as const };
      }
    }

    const needsApproval =
      (tool.toolName === "read" && !profile.agent.permissions.allowRead) ||
      (tool.toolName === "write" && !profile.agent.permissions.allowWrite) ||
      (tool.toolName === "apply_patch" && !profile.agent.permissions.allowWrite) ||
      (tool.toolName === "bash" && !profile.agent.permissions.allowBash);

    const approvalPreview = applyPatchPrepared ? toApplyPatchResult(applyPatchPrepared) : undefined;

    if (tool.status === "awaiting_permission") {
      if (!needsApproval) {
        await this.apiClient.updateContextItem({
          itemId: tool.itemId,
          status: "queued",
          output: {
            ...outputBase,
            ...(approvalPreview ? { result: approvalPreview } : {})
          },
          updatedAt: nowMs()
        });
        await this.apiClient.updateRunState({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          status: "running",
          activeRunId: run.runId,
          activeAssistantItemId: null,
          waitingToolItemId: null,
          updatedAt: nowMs()
        });
      } else {
        await this.apiClient.updateRunState({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          status: "waiting_permission",
          activeRunId: run.runId,
          activeAssistantItemId: null,
          waitingToolItemId: tool.itemId,
          updatedAt: nowMs()
        });
        return { paused: true as const };
      }
    }

    if (needsApproval && tool.approved !== true) {
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "awaiting_permission",
        output: {
          ...outputBase,
          ...(approvalPreview ? { result: approvalPreview } : {})
        },
        updatedAt: nowMs()
      });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            toolItemId: tool.itemId
          },
          request: {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            args: tool.args
          },
          status: "awaiting_permission"
        }
      });
      await this.apiClient.updateRunState({
        workspaceId: run.workspaceId,
        sessionId: run.sessionId,
        status: "waiting_permission",
        activeRunId: run.runId,
        activeAssistantItemId: null,
        waitingToolItemId: tool.itemId,
        updatedAt: nowMs()
      });
      return { paused: true as const };
    }

    await this.apiClient.updateContextItem({
      itemId: tool.itemId,
      status: "running",
      output: {
        ...outputBase,
        ...(approvalPreview ? { result: approvalPreview } : {})
      },
      updatedAt: nowMs()
    });

    let subtaskSessionId: string | undefined;

    try {
      let result: unknown;
      if (tool.toolName === "bash") {
        const command = requireNonEmptyStringArg(tool.args.command, "bash.command");
        const timeout = parseOptionalPositiveIntegerArg(tool.args.timeout, "bash.timeout");
        let cwd = run.workspacePath;
        if (tool.args.workdir !== undefined && tool.args.workdir !== null) {
          if (typeof tool.args.workdir !== "string") {
            throw new Error("bash.workdir must be a non-empty string");
          }
          const workdir = tool.args.workdir.trim();
          if (!workdir) {
            throw new Error("bash.workdir must be a non-empty string");
          }
          cwd = path.isAbsolute(workdir) ? workdir : path.resolve(run.workspacePath, workdir);
        }
        const bash = await runBashCommand({
          command,
          cwd,
          timeoutMs: timeout ?? 120_000,
          maxOutputBytes: 512 * 1024,
          signal
        });
        result = {
          command,
          exitCode: bash.code,
          timedOut: bash.timedOut,
          outputLimitExceeded: bash.outputLimitExceeded,
          stdout: bash.stdout,
          stderr: bash.stderr
        };
      } else if (tool.toolName === "read") {
        const filePath = requireNonEmptyStringArg(tool.args.filePath, "read.filePath");
        const offset = parseOptionalPositiveIntegerArg(tool.args.offset, "read.offset");
        const limit = parseOptionalPositiveIntegerArg(tool.args.limit, "read.limit");
        result = await runReadTool({
          workspacePath: run.workspacePath,
          filePath,
          offset,
          limit,
          signal
        });
      } else if (tool.toolName === "write") {
        const filePath = requireNonEmptyStringArg(tool.args.filePath, "write.filePath");
        if (typeof tool.args.content !== "string") {
          throw new Error("write.content must be a string");
        }
        const content = tool.args.content;
        result = await runWriteTool({
          workspacePath: run.workspacePath,
          filePath,
          content,
          signal
        });
      } else if (tool.toolName === "apply_patch") {
        if (!applyPatchPrepared) {
          throw new Error("apply_patch verification failed: prepared patch is missing");
        }
        await applyPreparedPatch({
          workspacePath: run.workspacePath,
          prepared: applyPatchPrepared,
          signal
        });
        result = toApplyPatchResult(applyPatchPrepared);
      } else if (tool.toolName === "todolist") {
        const parsed = parseTodolistArgs(tool.args);
        result = toTodolistResult(parsed);
      } else if (tool.toolName === "archive_search") {
        const query = requireNonEmptyStringArg(tool.args.query, "archive_search.query");
        const beforePos = parseOptionalPositiveIntegerArg(tool.args.beforePos, "archive_search.beforePos");
        if (beforePos != null && beforePos < 2) {
          throw new Error("archive_search.beforePos must be an integer >= 2");
        }
        const maxHits = parseOptionalPositiveIntegerArg(tool.args.maxHits, "archive_search.maxHits");
        if (maxHits != null && maxHits > 100) {
          throw new Error("archive_search.maxHits must be an integer between 1 and 100");
        }
        const maxChars = parseOptionalPositiveIntegerArg(tool.args.maxChars, "archive_search.maxChars");
        if (maxChars != null && (maxChars < 1000 || maxChars > 10000)) {
          throw new Error("archive_search.maxChars must be an integer between 1000 and 10000");
        }
        if (tool.args.snippet != null && typeof tool.args.snippet !== "boolean") {
          throw new Error("archive_search.snippet must be a boolean");
        }
        const snippet = tool.args.snippet === true;
        const regex = tool.args.regex === true;
        result = await this.apiClient.archiveSearch({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          query,
          beforePos,
          maxHits,
          maxChars,
          snippet,
          regex
        });
      } else if (tool.toolName === "archive_read") {
        const beforePos = parseOptionalPositiveIntegerArg(tool.args.beforePos, "archive_read.beforePos");
        if (beforePos != null && beforePos < 2) {
          throw new Error("archive_read.beforePos must be an integer >= 2");
        }
        const lineCount = parseOptionalPositiveIntegerArg(tool.args.lineCount, "archive_read.lineCount");
        if (lineCount != null && lineCount > 200) {
          throw new Error("archive_read.lineCount must be an integer between 1 and 200");
        }
        const maxChars = parseOptionalPositiveIntegerArg(tool.args.maxChars, "archive_read.maxChars");
        if (maxChars != null && (maxChars < 1000 || maxChars > 10000)) {
          throw new Error("archive_read.maxChars must be an integer between 1000 and 10000");
        }
        result = await this.apiClient.archiveRead({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          beforePos,
          lineCount,
          maxChars
        });
      } else if (tool.toolName === "subtask") {
        const parsed = parseSubtaskArgs(tool.args);
        const started = await this.apiClient.startSubtaskRun({
          workspaceId: run.workspaceId,
          parentSessionId: run.sessionId,
          parentRunId: run.runId,
          parentToolItemId: tool.itemId,
          description: parsed.description,
          prompt: parsed.prompt,
          agentId: parsed.agentId,
          session: parsed.session
        });
        subtaskSessionId = started.sessionId;

        await this.apiClient.updateContextItem({
          itemId: tool.itemId,
          status: "running",
          output: {
            ...outputBase,
            result: {
              subtaskSessionId
            }
          },
          updatedAt: nowMs()
        });

        await this.processRun(
          {
            workspaceId: run.workspaceId,
            sessionId: started.sessionId,
            runId: started.runId,
            inputText: parsed.prompt,
            workspacePath: started.workspacePath
          },
          signal
        );

        const subtaskStatus = await this.apiClient.getSubtaskStatus({
          workspaceId: run.workspaceId,
          sessionId: started.sessionId,
          runId: started.runId
        });

        if (signal.aborted) {
          await this.apiClient.completeRun({
            workspaceId: run.workspaceId,
            sessionId: started.sessionId,
            runId: started.runId,
            status: "cancelled",
            updatedAt: nowMs()
          });
        } else if (subtaskStatus.status === "running" || subtaskStatus.status === "waiting_permission") {
          throw new Error(`subtask did not reach terminal status: ${subtaskStatus.status}`);
        }

        const subtaskResult = await this.apiClient.getSubtaskResult({
          workspaceId: run.workspaceId,
          sessionId: started.sessionId,
          runId: started.runId
        });
        result = {
          subtaskSessionId: started.sessionId,
          resultText: subtaskResult.resultText
        };
      } else if (isMcpTool(tool.toolName)) {
        const mcpResult = await this.mcpManager.callTool(tool.toolName, tool.args);
        result = {
          serverId: mcpResult.serverId,
          toolName: mcpResult.toolName,
          text: mcpResult.text,
          raw: mcpResult.raw
        };
      } else {
        throw new Error(`unsupported tool: ${tool.toolName}`);
      }

      if (signal.aborted) return { paused: false as const };

      const output = {
        ...outputBase,
        result
      };
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "completed",
        output,
        updatedAt: nowMs()
      });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            toolItemId: tool.itemId
          },
          request: {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            args: tool.args
          },
          status: "completed",
          response: result
        }
      });
      return { paused: false as const };
    } catch (err) {
      if (signal.aborted) return { paused: false as const };
      const error = err instanceof Error ? err.message : String(err);
      await this.apiClient.updateContextItem({
        itemId: tool.itemId,
        status: "failed",
        output: {
          ...outputBase,
          ...(subtaskSessionId
            ? {
                result: {
                  subtaskSessionId
                }
              }
            : {}),
          error
        },
        updatedAt: nowMs()
      });
      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "tool",
        itemId: tool.itemId,
        payload: {
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            toolItemId: tool.itemId
          },
          request: {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            args: tool.args
          },
          status: "failed",
          error
        }
      });
      return { paused: false as const };
    }
  }

  private async executePendingTools(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    signal: AbortSignal;
  }) {
    const pending: PendingTool[] = [];
    for (const item of params.context.pendingTools) {
      if (!isToolEnabledForAgent(params.profile, item.toolName)) {
        await this.apiClient.updateContextItem({
          itemId: item.itemId,
          status: "failed",
          output: {
            type: "tool",
            toolName: item.toolName,
            toolCallId: item.toolCallId,
            args: item.args,
            error: `tool is disabled for current agent: ${item.toolName}`
          },
          updatedAt: nowMs()
        });
        continue;
      }
      if (item.status === "running") {
        const outputBase = {
          type: "tool" as const,
          toolName: item.toolName,
          toolCallId: item.toolCallId,
          args: item.args
        };
        const error = "tool execution interrupted, mark failed and wait next step";
        await this.apiClient.updateContextItem({
          itemId: item.itemId,
          status: "failed",
          output: {
            ...outputBase,
            error
          },
          updatedAt: nowMs()
        });
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
      if (item.status !== "queued" && item.status !== "awaiting_permission") continue;
      const toolCallId = String(item.toolCallId || "").trim();
      if (!toolCallId) continue;
      pending.push({
        itemId: item.itemId,
        status: item.status,
        toolName: item.toolName,
        toolCallId,
        args: item.args,
        approved: item.approved === true
      });
    }

    for (const tool of pending) {
      const result = await this.executeTool({
        profile: params.profile,
        run: params.run,
        tool,
        signal: params.signal
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
      waitingToolItemId: null,
      updatedAt: nowMs()
    });
    return { paused: false as const };
  }

  private shouldAutoCompact(params: {
    context: PromptContext;
    runtime: ExecutionProfile["runtime"];
  }) {
    const maxContextTokens = Math.max(1, Math.floor(Number(params.runtime.maxContextTokens || 0)));
    const thresholdPct = Math.max(50, Math.min(90, Math.floor(Number(params.runtime.autoCompactThresholdPct || 80))));
    const lastTotalTokens = typeof params.context.lastResponseTotalTokens === "number"
      ? Math.max(0, Math.floor(params.context.lastResponseTotalTokens))
      : null;
    if (lastTotalTokens == null) return false;
    const threshold = Math.floor(maxContextTokens * (thresholdPct / 100));
    return lastTotalTokens >= threshold;
  }

  private async compactContext(params: {
    profile: ExecutionProfile;
    run: QueuedRun;
    context: PromptContext;
    signal: AbortSignal;
  }) {
    const { profile, run, context, signal } = params;
    const expectedHeadItemId = context.headItemId;
    if (expectedHeadItemId == null) return false;

    const response = await generateSingleCallText(
      {
        provider: profile.provider,
        model: profile.model
      },
      {
        system: context.system || undefined,
        messages: [...context.messages, { role: "user", content: COMPACTION_USER_PROMPT }],
        abortSignal: signal
      }
    );
    const summaryText = String(response.text || "").trim();
    if (!summaryText) return false;

    const compacted = await this.apiClient.compactContext({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      runId: run.runId,
      expectedHeadItemId,
      summaryText
    });

    if (!compacted.compacted) {
      return false;
    }

    await this.apiClient.updateRunState({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      status: "running",
      activeRunId: run.runId,
      activeAssistantItemId: null,
      waitingToolItemId: null,
      lastResponseTotalTokens: null,
      updatedAt: nowMs()
    });
    return true;
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
      createdAt: nowMs()
    });

    await this.apiClient.updateRunState({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      status: "running",
      activeRunId: run.runId,
      activeAssistantItemId: assistant.id,
      waitingToolItemId: null,
      runNoticeText: "",
      updatedAt: nowMs()
    });

    const toolSet: Record<string, any> = {};
    for (const item of context.tools) {
      let description = item.description;
      if (item.name === "bash") {
        const appendix = getBashToolAppendix();
        if (appendix) {
          description = `${description}\n\n${appendix}`;
        }
      }
      toolSet[item.name] = tool({
        description,
        inputSchema: jsonSchema(item.inputSchema)
      });
    }

    const mcpTools = await this.mcpManager.listTools(profile.agent.mcpServers);
    for (const item of mcpTools) {
      toolSet[item.name] = tool({
        description: item.description,
        inputSchema: jsonSchema(item.inputSchema)
      });
    }
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
    if (Object.keys(runtimeOptions.providerOptions).length > 0) {
      requestBase.providerOptions = {
        [runtimeOptions.providerKey]: runtimeOptions.providerOptions
      };
    }
    // 自定义重试策略由本文件控制,禁用 AI SDK 内建重试避免双重重试。
    requestBase.maxRetries = 0;

    let text = "";
    const toolCalls: ToolCall[] = [];
    const startedAt = nowMs();
    let responseTotalTokens: number | null = null;

    await writeItemLog({
      logger: this.logger,
      workspacePath: run.workspacePath,
      kind: "assistant",
      itemId: assistant.id,
      payload: {
        status: "running",
        startedAt,
        meta: {
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          step,
          itemId: assistant.id
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
    while (true) {
      if (signal.aborted) {
        return { aborted: true as const, assistantItemId: assistant.id };
      }

      if (retryCount > 0) {
        try {
          await this.apiClient.updateRunState({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            status: "running",
            activeRunId: run.runId,
            activeAssistantItemId: assistant.id,
            waitingToolItemId: null,
            runNoticeText: "",
            updatedAt: nowMs()
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
      let lastChunkAt = nowMs();
      let attemptReceivedAnyChunk = false;

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
          const elapsed = nowMs() - lastChunkAt;
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

      const request: Record<string, unknown> = {
        ...requestBase,
        abortSignal: requestController.signal
      };

      try {
        const stream = streamText(request as any);
        successfulStream = stream;
        for await (const chunk of stream.fullStream as AsyncIterable<any>) {
          if (requestController.signal.aborted) break;
          attemptReceivedAnyChunk = true;
          lastChunkAt = nowMs();
          if (!chunk || typeof chunk !== "object") continue;
          if (chunk.type === "text-delta") {
            const delta = String(chunk.text || "");
            if (!delta) continue;
            text += delta;
            await this.apiClient.updateContextItem({
              itemId: assistant.id,
              status: "streaming",
              output: {
                type: "assistant_text",
                text
              },
              updatedAt: nowMs()
            });
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

        if (signal.aborted) {
          return { aborted: true as const, assistantItemId: assistant.id };
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
          return { aborted: true as const, assistantItemId: assistant.id };
        }
        if (totalTimedOut) {
          err = new Error(`model total timeout after ${modelTotalTimeoutMs}ms`);
        } else if (idleTimedOut) {
          err = new Error(`model idle timeout after ${modelIdleTimeoutMs}ms`);
        }
        const message = err instanceof Error ? err.message : String(err);

        const canRetry = !attemptReceivedAnyChunk && retryCount < modelRequestMaxRetries;
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
              activeAssistantItemId: assistant.id,
              waitingToolItemId: null,
              runNoticeText: noticeText,
              updatedAt: nowMs()
            });
          } catch {
            // ignore notice update failure
          }

          await writeItemLog({
            logger: this.logger,
            workspacePath: run.workspacePath,
            kind: "assistant",
            itemId: assistant.id,
            payload: {
              status: "retrying",
              meta: {
                workspaceId: run.workspaceId,
                sessionId: run.sessionId,
                runId: run.runId,
                turnId,
                step,
                itemId: assistant.id,
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
          const continueRunning = await sleepMsWithAbort(delayMs, signal);
          if (!continueRunning) {
            return { aborted: true as const, assistantItemId: assistant.id };
          }
          continue;
        }

        const finalMessage = retryCount > 0 ? `failed after ${retryCount} retries: ${message}` : message;
        const failedText = text.trim().length > 0 ? `${text}\n\n[run] ${finalMessage}` : `[run] ${finalMessage}`;
        try {
          await this.apiClient.updateRunState({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            status: "running",
            activeRunId: run.runId,
            activeAssistantItemId: assistant.id,
            waitingToolItemId: null,
            runNoticeText: "",
            updatedAt: nowMs()
          });
        } catch {
          // ignore notice clear failure
        }
        try {
          await this.apiClient.updateContextItem({
            itemId: assistant.id,
            status: "failed",
            output: {
              type: "assistant_text",
              text: failedText
            },
            updatedAt: nowMs()
          });
        } catch {
          // 忽略更新失败，保持原始异常抛出
        }
        await writeItemLog({
          logger: this.logger,
          workspacePath: run.workspacePath,
          kind: "assistant",
          itemId: assistant.id,
          payload: {
            status: "failed",
            startedAt,
            finishedAt: nowMs(),
            meta: {
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId,
              step,
              itemId: assistant.id,
              retries: retryCount
            },
            request,
            response: {
              text,
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
      let prevId = assistant.id;
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
          createdAt: nowMs()
        });
        prevId = toolItem.id;
        await writeItemLog({
          logger: this.logger,
          workspacePath: run.workspacePath,
          kind: "tool",
          itemId: toolItem.id,
          payload: {
            status: "queued",
            meta: {
              workspaceId: run.workspaceId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId,
              step,
              itemId: toolItem.id
            },
            request: {
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              args: call.args
            }
          }
        });
      }

      await this.apiClient.updateContextItem({
        itemId: assistant.id,
        status: "completed",
        output: {
          type: "assistant_text",
          text
        },
        updatedAt: nowMs()
      });

      await writeItemLog({
        logger: this.logger,
        workspacePath: run.workspacePath,
        kind: "assistant",
        itemId: assistant.id,
        payload: {
          status: "completed",
          startedAt,
          finishedAt: nowMs(),
          meta: {
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            step,
            itemId: assistant.id
          },
          request: requestBase,
          response: {
            text,
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
        waitingToolItemId: null,
        lastResponseTotalTokens: responseTotalTokens,
        runNoticeText: "",
        updatedAt: nowMs()
      });

      return { aborted: false as const, toolCallCount: recognizedCalls.length, assistantItemId: assistant.id };
  }

  private async processRun(run: QueuedRun, signal: AbortSignal) {
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
        waitingToolItemId: null,
        runNoticeText: "",
        updatedAt: nowMs()
      });

      let step = 0;
      const repeatedToolCallCounter = new Map<string, number>();

      while (!signal.aborted) {
        const context = await this.apiClient.getPromptContext({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId
        });

        if (context.pendingTools.length > 0) {
          const pendingResult = await this.executePendingTools({
            profile,
            run,
            context,
            signal
          });
          if (pendingResult.paused || signal.aborted) {
            return;
          }
          continue;
        }

        if (this.shouldAutoCompact({ context, runtime: profile.runtime })) {
          const compacted = await this.compactContext({
            profile,
            run,
            context,
            signal
          });
          if (compacted || signal.aborted) {
            continue;
          }
        }

        if (LOOP_MAX_STEPS > 0 && step >= LOOP_MAX_STEPS) {
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
          await this.apiClient.completeRun({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            status: "failed",
            updatedAt: nowMs()
          });
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
          return;
        }
        if (result.toolCallCount === 0) {
          await this.apiClient.completeRun({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            status: "completed",
            updatedAt: nowMs()
          });
          return;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        this.logger.info(`run aborted: ${run.sessionId} ${run.runId}`);
        return;
      }
      if (err instanceof ApiConflictError) {
        this.logger.warn(`run append conflict, stop run: ${run.sessionId} ${run.runId}`);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.apiClient.completeRun({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          runId: run.runId,
          status: "failed",
          updatedAt: nowMs()
        });
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
};
