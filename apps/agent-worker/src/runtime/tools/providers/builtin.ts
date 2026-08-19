import fs from "node:fs/promises";
import path from "node:path";
import { generateSingleCallText } from "@agent-workbench/shared/llm-single-call";
import { renderPromptTemplateFile } from "@agent-workbench/shared/prompts";
import { runBashCommand } from "../../bash.js";
import {
  applyPreparedPatch,
  classifyApplyPatchFailureMessage,
  formatApplyPatchFailureTextFromMessage,
  prepareApplyPatchTool,
  type ApplyPatchPrepared
} from "../../applyPatch.js";
import { getBashToolAppendix } from "../../bashTools.js";
import { runReadTool, runSkillTool, runWriteTool } from "../../fileTools.js";
import { parseTodolistArgs, toTodolistResult } from "../../todolist.js";
import { parseScratchpadArgs, toScratchpadResult } from "../../scratchpad.js";
import type { AvailableToolContext, ResolvedToolDefinition, ToolExecutionContext, ToolListContext, ToolProvider } from "../types.js";
import { isBuiltinToolName, type BuiltinToolName } from "../types.js";

const ENV_TIMEOUT_MS_MAX = 2_147_483_647;
const COMPACTION_TIMEOUT_MS = 300_000;
// Reused children are observed, never re-executed. Polling is bounded so a parent
// tool call can finish without changing the still-running child.
function subtaskReusedPollIntervalMs() {
  const value = Number(process.env.AWB_SUBTASK_REUSED_POLL_INTERVAL_MS || 500);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 500;
}

function subtaskReusedWaitTimeoutMs() {
  const value = Number(process.env.AWB_SUBTASK_REUSED_WAIT_TIMEOUT_MS || COMPACTION_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : COMPACTION_TIMEOUT_MS;
}

const VISUAL_MEDIA_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"]
]);

type VisualAnalyzeInputFile = {
  relativePath: string;
  absolutePath: string;
  mediaType: string;
  bytes: Uint8Array;
};

type ParsedSubtaskArgs = {
  description: string;
  prompt: string;
  agentId: string;
  session: AgentApiSubtaskSession;
};

function toRecord(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

async function sleepMsWithAbort(ms: number, signal: AbortSignal) {
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

function isAbortLikeError(err: unknown, signal: AbortSignal) {
  if (signal.aborted) return true;
  if (!err || typeof err !== "object") return false;
  const name = typeof (err as { name?: unknown }).name === "string" ? String((err as { name: string }).name) : "";
  const code = typeof (err as { code?: unknown }).code === "string" ? String((err as { code: string }).code) : "";
  const message = typeof (err as { message?: unknown }).message === "string" ? String((err as { message: string }).message) : "";
  return name === "AbortError"
    || code === "ABORT_ERR"
    || /\babort(ed)?\b/i.test(name)
    || /\babort(ed)?\b/i.test(message);
}

function parseSkillToolArgs(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("skill is required");
  }
  const record = args as Record<string, unknown>;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
  if (!hasOwn("skillId")) {
    throw new Error("skill is required");
  }
  const ownKeys = Reflect.ownKeys(record);
  const hasUnexpectedField = ownKeys.some((key) => key !== "skillId" && key !== "filePath");
  if (hasUnexpectedField) {
    throw new Error("invalid skill identifier");
  }
  return {
    skillId: record.skillId,
    ...(hasOwn("filePath") ? { filePath: record.filePath } : {})
  };
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

function tokenizeShellCommand(input: string): string[] {
  const s = String(input || "");
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  let mode: "none" | "single" | "double" = "none";
  const push = () => {
    if (cur) tokens.push(cur);
    cur = "";
  };
  while (i < s.length) {
    const ch = s[i] ?? "";
    if (mode === "none") {
      if (ch === "\"" || ch === "'") {
        mode = ch === "'" ? "single" : "double";
        i += 1;
        continue;
      }
      if (ch === "\\") {
        const next = s[i + 1];
        if (next) cur += next;
        i += 2;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        push();
        i += 1;
        while (i < s.length && /\s/.test(s[i] ?? "")) i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (mode === "single") {
      if (ch === "'") {
        mode = "none";
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    // double
    if (ch === "\"") {
      mode = "none";
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = s[i + 1];
      if (next) cur += next;
      i += 2;
      continue;
    }
    cur += ch;
    i += 1;
  }
  push();
  return tokens;
}

function shouldPrepareGitEnvForCommand(command: string) {
  const tokens = tokenizeShellCommand(command.trim());
  if (!tokens.length) return false;
  const whitelist = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);

  // Scan the entire token sequence for a `git <subcommand>` occurrence.
  // This is intentionally heuristic (V1): it does not attempt to parse shell operators.
  for (let start = 0; start < tokens.length; start += 1) {
    if (tokens[start] !== "git") continue;

    // Skip global git options right after `git`.
    // NOTE: This is intentionally minimal for V1.
    let i = start + 1;
    while (i < tokens.length) {
      const t = tokens[i] ?? "";
      if (!t.startsWith("-")) break;
      if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--config-env") {
        i += 2;
        continue;
      }
      if (t.startsWith("-C") && t.length > 2) {
        i += 1;
        continue;
      }
      if (t.startsWith("-c") && t.length > 2) {
        i += 1;
        continue;
      }
      // unknown option: skip it
      i += 1;
    }
    const sub = tokens[i] ?? "";
    if (whitelist.has(sub)) return true;
  }
  return false;
}

function ensureSafeRelativePath(input: unknown, fieldName: string) {
  if (typeof input !== "string") throw new Error(`${fieldName} must be a non-empty string`);
  const value = input.trim();
  if (!value) throw new Error(`${fieldName} must be a non-empty string`);
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${fieldName} is invalid`);
  }
  if (path.isAbsolute(value)) {
    throw new Error(`${fieldName} must be a relative path inside workspace`);
  }
  return value;
}

function isPathInside(rootPath: string, targetPath: string) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(withSep);
}

async function resolveVisualInputFile(params: {
  workspacePath: string;
  relativePath: string;
}): Promise<VisualAnalyzeInputFile> {
  const absolutePath = path.resolve(params.workspacePath, params.relativePath);
  if (!isPathInside(params.workspacePath, absolutePath)) {
    throw new Error(`path is outside workspace: ${params.relativePath}`);
  }
  const [workspaceRealPath, targetRealPath] = await Promise.all([fs.realpath(params.workspacePath), fs.realpath(absolutePath)]);
  if (!isPathInside(workspaceRealPath, targetRealPath)) {
    throw new Error(`path is outside workspace: ${params.relativePath}`);
  }
  const stat = await fs.stat(targetRealPath);
  if (!stat.isFile()) {
    throw new Error(`path is not a file: ${params.relativePath}`);
  }
  const mediaType = VISUAL_MEDIA_TYPES.get(path.extname(params.relativePath).toLowerCase());
  if (!mediaType) {
    throw new Error(`unsupported file type: ${params.relativePath}. Supported: PNG, JPG/JPEG, WEBP, GIF, PDF`);
  }
  const bytes = await fs.readFile(targetRealPath);
  return { relativePath: params.relativePath, absolutePath: targetRealPath, mediaType, bytes };
}

function parseSubtaskArgs(raw: Record<string, unknown>): ParsedSubtaskArgs {
  const description = requireNonEmptyStringArg(raw.description, "subtask.description").slice(0, 50);
  const prompt = requireNonEmptyStringArg(raw.prompt, "subtask.prompt");
  const agentId = requireNonEmptyStringArg(raw.agentId, "subtask.agentId");
  const sessionRaw = toRecord(raw.session);
  const modeRaw = requireNonEmptyStringArg(sessionRaw.mode, "subtask.session.mode");
  let mode: "new" | "existing" | "fork";
  if (modeRaw === "new" || modeRaw === "existing" || modeRaw === "fork") {
    mode = modeRaw;
  } else {
    throw new Error("subtask.session.mode must be one of: new, existing, fork");
  }
  const sessionId = String(sessionRaw.sessionId || "").trim();
  if (mode === "existing" && !sessionId) {
    throw new Error("subtask.session.sessionId is required when mode=existing");
  }
  if ((mode === "new" || mode === "fork") && sessionId) {
    throw new Error(`subtask.session.sessionId is not allowed when mode=${mode}`);
  }

  const session: AgentApiSubtaskSession = mode === "existing"
    ? { mode: "existing", sessionId }
    : mode === "new"
      ? { mode: "new", ...(sessionId ? { sessionId } : {}) }
      : { mode: "fork", ...(sessionId ? { sessionId } : {}) };
  return { description, prompt, agentId, session };
}

function toApplyPatchResult(prepared: Awaited<ReturnType<typeof prepareApplyPatchTool>>) {
  return {
    text: prepared.text,
    summary: prepared.summary,
    files: prepared.files
  };
}

function buildSubtaskPreforkSummaryPrompt(input: { uiLocale: "zh-CN" | "en-US" | null; subtaskPrompt: string }) {
  if (input.uiLocale === "zh-CN") {
    return renderPromptTemplateFile("agent/subtask-prefork-summary-prompt.zh-CN.tmpl.txt", {
      subtaskPrompt: input.subtaskPrompt
    });
  }
  return renderPromptTemplateFile("agent/subtask-prefork-summary-prompt.en-US.tmpl.txt", {
    subtaskPrompt: input.subtaskPrompt
  });
}

function isFormattedApplyPatchFailure(message: string) {
  return message.startsWith("apply_patch verification failed:");
}

function formatApplyPatchProviderFailure(message: string, params: { repairAttempted: boolean }) {
  return isFormattedApplyPatchFailure(message)
    ? message
    : formatApplyPatchFailureTextFromMessage(message, params);
}

async function executeApplyPatchWithSingleRepairAttempt(params: {
  workspacePath: string;
  patchText: string;
  signal?: AbortSignal;
  prepare: (input: { workspacePath: string; patchText: string; signal?: AbortSignal }) => Promise<ApplyPatchPrepared>;
  apply: (input: { workspacePath: string; prepared: ApplyPatchPrepared; signal?: AbortSignal }) => Promise<void>;
}) {
  let repairAttempted = false;
  let prepared: ApplyPatchPrepared;
  try {
    prepared = await params.prepare({ workspacePath: params.workspacePath, patchText: params.patchText, signal: params.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyApplyPatchFailureMessage(message);
    if (!classified.retryable || classified.code !== "IO_RETRYABLE") {
      throw new Error(formatApplyPatchProviderFailure(message, { repairAttempted }));
    }
    repairAttempted = true;
    try {
      prepared = await params.prepare({ workspacePath: params.workspacePath, patchText: params.patchText, signal: params.signal });
    } catch (retryErr) {
      const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(formatApplyPatchProviderFailure(retryMessage, { repairAttempted }));
    }
  }

  try {
    await params.apply({ workspacePath: params.workspacePath, prepared, signal: params.signal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(formatApplyPatchProviderFailure(message, { repairAttempted }));
  }

  return prepared;
}

export class BuiltinToolProvider implements ToolProvider {
  canHandle(toolName: string) {
    return isBuiltinToolName(toolName);
  }

  async listTools(ctx: ToolListContext): Promise<ResolvedToolDefinition[]> {
    return ctx.promptContext.tools
      .filter((item) => isBuiltinToolName(item.name))
      .map((item) => {
        let description = item.description;
        if (item.name === "bash") {
          const appendix = getBashToolAppendix();
          if (appendix) {
            description = `${description}\n\n${appendix}`;
          }
        }
        return {
          name: item.name,
          description,
          inputSchema: item.inputSchema,
          source: "builtin" as const
        };
      });
  }

  isToolEnabled(toolName: string, ctx: AvailableToolContext | ToolExecutionContext) {
    if (!isBuiltinToolName(toolName)) return false;
    if (
      toolName === "read"
      || toolName === "todolist"
      || toolName === "archive_search"
      || toolName === "archive_read"
      || toolName === "skill"
      || toolName === "visual_analyze"
    ) {
      return true;
    }
    return ctx.profile.agent.tools.includes(toolName as BuiltinToolName);
  }

  protected async generateSingleCallSummary(params: {
    profile: {
      provider: ToolExecutionContext["profile"]["provider"];
      model: ToolExecutionContext["profile"]["model"];
    };
    input: {
      messages: Array<{ role: string; content: unknown }>;
      system?: string;
      workspaceId?: string;
      timeoutMs: number;
      abortSignal: AbortSignal;
    };
  }) {
    return generateSingleCallText(params.profile, params.input);
  }

  protected async prepareApplyPatch(params: { workspacePath: string; patchText: string; signal?: AbortSignal }) {
    return prepareApplyPatchTool({
      workspacePath: params.workspacePath,
      patchText: params.patchText,
      signal: params.signal
    });
  }

  protected async applyPreparedPatch(params: { workspacePath: string; prepared: ApplyPatchPrepared; signal?: AbortSignal }) {
    await applyPreparedPatch({
      workspacePath: params.workspacePath,
      prepared: params.prepared,
      signal: params.signal
    });
  }

  async execute(toolName: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    switch (toolName) {
      case "bash": {
        const command = requireNonEmptyStringArg(args.command, "bash.command");
        const timeoutSeconds = parseOptionalPositiveIntegerArg(args.timeout, "bash.timeout");
        let cwd = ctx.run.workspacePath;
        let workdirLabelForError: string | null = null;
        if (args.workdir !== undefined && args.workdir !== null) {
          if (typeof args.workdir !== "string") {
            throw new Error("bash.workdir must be a non-empty string");
          }
          const workdir = args.workdir.trim();
          if (!workdir) {
            throw new Error("bash.workdir must be a non-empty string");
          }
          workdirLabelForError = workdir;
          cwd = path.isAbsolute(workdir) ? workdir : path.resolve(ctx.run.workspacePath, workdir);
        }

        const isUserWorkdir = typeof workdirLabelForError === "string" && workdirLabelForError.length > 0;
        const label = isUserWorkdir ? workdirLabelForError : "workspace root";
        try {
          const stat = await fs.stat(cwd);
          if (!stat.isDirectory()) {
            throw new Error(isUserWorkdir ? `bash.workdir must be a directory: ${label}` : `bash.cwd must be a directory: ${label}`);
          }
        } catch (err: any) {
          const code = err && typeof err === "object" ? String(err.code || "") : "";
          if (code === "ENOENT") {
            throw new Error(isUserWorkdir ? `bash.workdir not found: ${label}` : `bash.cwd not found: ${label}`);
          }
          if (code === "ENOTDIR") {
            throw new Error(isUserWorkdir ? `bash.workdir must be a directory: ${label}` : `bash.cwd must be a directory: ${label}`);
          }
          throw err;
        }

        const timeoutMs = Math.min(ENV_TIMEOUT_MS_MAX, (timeoutSeconds ?? 120) * 1000);
        const needsGitEnv = shouldPrepareGitEnvForCommand(command);

        let extraEnv: Record<string, string> | undefined;
        let leaseId: string | null = null;
        let leaseKind: string | null = null;

        if (needsGitEnv) {
          const prepared = await ctx.apiClient.prepareGitEnvForBash({
            workspaceId: ctx.run.workspaceId,
            cwd,
            purpose: "bash",
            timeoutMs
          });
          if (!prepared.ok) {
            if (prepared.errorCode === "CWD_OUTSIDE_WORKSPACE") {
              // Degrade gracefully: run bash without injected env.
              console.warn(`[agent-worker] git-env prepare skipped: cwd outside workspace (${prepared.errorCode})`);
            } else {
              throw new Error(`git-env prepare failed: ${prepared.error}${prepared.errorCode ? ` (${prepared.errorCode})` : ""}`);
            }
          } else {
            extraEnv = prepared.env;
            leaseId = prepared.leaseId;
            leaseKind = prepared.kind;
          }
        }

        let bash: Awaited<ReturnType<typeof runBashCommand>> | null = null;
        try {
          bash = await runBashCommand({
            command,
            cwd,
            timeoutMs,
            maxOutputBytes: 512 * 1024,
            signal: ctx.signal,
            extraEnv
          });
        } finally {
          if (leaseId) {
            try {
              await ctx.apiClient.cleanupGitEnvLease({ leaseId });
            } catch (err) {
              // best-effort: do not override bash result
              const msg = err instanceof Error ? err.message : String(err);
              // Avoid printing env; only log lease id / kind.
              console.warn(`[agent-worker] git-env cleanup failed (leaseId=${leaseId}, kind=${leaseKind ?? ""}): ${msg}`);
            }
          }
        }

        return {
          command,
          exitCode: bash?.code ?? null,
          timedOut: bash?.timedOut ?? false,
          outputLimitExceeded: bash?.outputLimitExceeded ?? false,
          stdout: bash?.stdout ?? "",
          stderr: bash?.stderr ?? ""
        };
      }
      case "read": {
        const filePath = requireNonEmptyStringArg(args.filePath, "read.filePath");
        const offset = parseOptionalPositiveIntegerArg(args.offset, "read.offset");
        const limit = parseOptionalPositiveIntegerArg(args.limit, "read.limit");
        return await runReadTool({
          workspacePath: ctx.run.workspacePath,
          workspaceRepoDirNames: ctx.run.workspaceRepoDirNames,
          filePath,
          offset,
          limit,
          signal: ctx.signal
        });
      }
      case "skill": {
        const skillArgs = parseSkillToolArgs(args);
        const repoRoot = String(process.env.AWB_AGENT_REPO_ROOT || "").trim() || process.cwd();
        return await runSkillTool({
          workspacePath: ctx.run.workspacePath,
          repoRoot,
          skillId: skillArgs.skillId,
          ...(Object.prototype.hasOwnProperty.call(skillArgs, "filePath")
            ? { filePath: skillArgs.filePath }
            : {}),
          externalSkillRoots: ctx.promptContext.externalSkillRoots,
          signal: ctx.signal
        });
      }

      case "write": {
        const filePath = requireNonEmptyStringArg(args.filePath, "write.filePath");
        if (typeof args.content !== "string") {
          throw new Error("write.content must be a string");
        }
        return await runWriteTool({
          workspacePath: ctx.run.workspacePath,
          filePath,
          content: args.content,
          signal: ctx.signal
        });
      }
      case "apply_patch": {
        const patchText = requireNonEmptyStringArg(args.patchText, "apply_patch.patchText");
        const prepared = await executeApplyPatchWithSingleRepairAttempt({
          workspacePath: ctx.run.workspacePath,
          patchText,
          signal: ctx.signal,
          prepare: (input) => this.prepareApplyPatch(input),
          apply: (input) => this.applyPreparedPatch(input)
        });
        return toApplyPatchResult(prepared);
      }
      case "todolist": {
        const parsed = parseTodolistArgs(args);
        return toTodolistResult(parsed);
      }
      case "scratchpad": {
        const parsed = parseScratchpadArgs(args);
        return toScratchpadResult(parsed);
      }
      case "archive_search": {
        const query = requireNonEmptyStringArg(args.query, "archive_search.query");
        const beforePos = parseOptionalPositiveIntegerArg(args.beforePos, "archive_search.beforePos");
        if (beforePos != null && beforePos < 2) {
          throw new Error("archive_search.beforePos must be an integer >= 2");
        }
        const maxHits = parseOptionalPositiveIntegerArg(args.maxHits, "archive_search.maxHits");
        if (maxHits != null && maxHits > 100) {
          throw new Error("archive_search.maxHits must be an integer between 1 and 100");
        }
        const maxChars = parseOptionalPositiveIntegerArg(args.maxChars, "archive_search.maxChars");
        if (maxChars != null && (maxChars < 1000 || maxChars > 10000)) {
          throw new Error("archive_search.maxChars must be an integer between 1000 and 10000");
        }
        if (args.snippet != null && typeof args.snippet !== "boolean") {
          throw new Error("archive_search.snippet must be a boolean");
        }
        return await ctx.apiClient.archiveSearch({
          workspaceId: ctx.run.workspaceId,
          sessionId: ctx.run.sessionId,
          query,
          beforePos,
          maxHits,
          maxChars,
          snippet: args.snippet === true,
          regex: args.regex === true
        });
      }
      case "archive_read": {
        const beforePos = parseOptionalPositiveIntegerArg(args.beforePos, "archive_read.beforePos");
        if (beforePos != null && beforePos < 2) {
          throw new Error("archive_read.beforePos must be an integer >= 2");
        }
        const lineCount = parseOptionalPositiveIntegerArg(args.lineCount, "archive_read.lineCount");
        if (lineCount != null && lineCount > 200) {
          throw new Error("archive_read.lineCount must be an integer between 1 and 200");
        }
        const maxChars = parseOptionalPositiveIntegerArg(args.maxChars, "archive_read.maxChars");
        if (maxChars != null && (maxChars < 1000 || maxChars > 10000)) {
          throw new Error("archive_read.maxChars must be an integer between 1000 and 10000");
        }
        return await ctx.apiClient.archiveRead({
          workspaceId: ctx.run.workspaceId,
          sessionId: ctx.run.sessionId,
          beforePos,
          lineCount,
          maxChars
        });
      }
      case "subtask": {
        const parsed = parseSubtaskArgs(args);
        const thresholdPct = 95;

        let preforkSummaryText: string | undefined;
        let preforkMeta: {
          thresholdPct: number;
          parentLastResponseTotalTokens: number;
          childContextWindowTokens: number;
        } | undefined;
        if (parsed.session.mode === "fork") {
          try {
            const plan = await ctx.apiClient.getSubtaskPreforkPlan({
              workspaceId: ctx.run.workspaceId,
              parentSessionId: ctx.run.sessionId,
              parentRunId: ctx.run.runId,
              parentToolItemId: ctx.pendingTool.itemId,
              agentId: parsed.agentId,
              thresholdPct
            });
            if (plan.shouldPrefork) {
              const messagesContext = await ctx.apiClient.getMessagesContext({
                workspaceId: ctx.run.workspaceId,
                sessionId: ctx.run.sessionId,
                appendMessage: {
                  role: "user",
                  content: buildSubtaskPreforkSummaryPrompt({
                    uiLocale: null,
                    subtaskPrompt: parsed.prompt
                  })
                }
              });

              const summary = await this.generateSingleCallSummary({
                profile: {
                  provider: ctx.profile.provider,
                  model: ctx.profile.model
                },
                input: {
                  // subtask prefork 是 one-shot 摘要任务，使用 messages-context 提供的通用最小 system。
                  system: messagesContext.system,
                  workspaceId: ctx.run.workspaceId,
                  messages: messagesContext.messages,
                  timeoutMs: COMPACTION_TIMEOUT_MS,
                  abortSignal: ctx.signal
                }
              });
              const summaryText = String(summary.text || "").trim();
              if (summaryText) {
                preforkSummaryText = summaryText;
                preforkMeta = {
                  thresholdPct: plan.thresholdPct,
                  parentLastResponseTotalTokens: plan.parentLastResponseTotalTokens ?? 0,
                  childContextWindowTokens: plan.childContextWindowTokens
                };
              }
            }
          } catch (err) {
            if (isAbortLikeError(err, ctx.signal)) {
              throw err;
            }
            // 只记录固定诊断，不打印 prompt、token、完整 response 或错误 payload。
            console.warn("[agent-worker] subtask prefork summary failed; falling back to normal fork");
          }
        }
        if (ctx.signal.aborted) {
          const abortError = new Error("subtask cancelled by parent abort");
          (abortError as Error & { name: string }).name = "AbortError";
          throw abortError;
        }
        const started = await ctx.apiClient.startSubtaskRun({
          workspaceId: ctx.run.workspaceId,
          parentSessionId: ctx.run.sessionId,
          parentRunId: ctx.run.runId,
          parentToolItemId: ctx.pendingTool.itemId,
          description: parsed.description,
          prompt: parsed.prompt,
          agentId: parsed.agentId,
          session: parsed.session,
          ...(preforkSummaryText ? { preforkSummaryText } : {}),
          ...(preforkMeta ? { preforkMeta } : {})
        });

        await ctx.updateToolItem({
          status: "running",
          output: {
            type: "tool",
            toolName,
            toolCallId: ctx.pendingTool.toolCallId,
            args,
            text: ctx.renderToolText({
              toolName,
              status: "running",
              headers: [["subtask_session_id", started.sessionId]],
              body: "Subtask started."
            }),
            result: {
              subtaskSessionId: started.sessionId,
              subtaskAgentId: parsed.agentId,
              subtaskAgentName: started.agentName
            }
          }
        });

        if (!started.reused) {
          await ctx.processNestedRun(
            {
              workspaceId: ctx.run.workspaceId,
              sessionId: started.sessionId,
              runId: started.runId,
              inputText: parsed.prompt,
              workspacePath: started.workspacePath,
              workspaceRepoDirNames: [...ctx.run.workspaceRepoDirNames]
            },
            ctx.signal
          );
        }

        if (ctx.signal.aborted) {
          const abortError = new Error("subtask cancelled by parent abort");
          (abortError as Error & { name: string }).name = "AbortError";
          throw abortError;
        }

        let subtaskStatus = await ctx.apiClient.getSubtaskStatus({
          workspaceId: ctx.run.workspaceId,
          sessionId: started.sessionId,
          runId: started.runId
        });

        let reusedWaitTimeoutMs: number | null = null;
        if (started.reused && subtaskStatus.status === "running") {
          reusedWaitTimeoutMs = subtaskReusedWaitTimeoutMs();
          const pollIntervalMs = subtaskReusedPollIntervalMs();
          const deadline = Date.now() + reusedWaitTimeoutMs;
          while (subtaskStatus.status === "running" && Date.now() < deadline) {
            if (!(await sleepMsWithAbort(pollIntervalMs, ctx.signal))) {
              const abortError = new Error("subtask cancelled by parent abort");
              (abortError as Error & { name: string }).name = "AbortError";
              throw abortError;
            }
            subtaskStatus = await ctx.apiClient.getSubtaskStatus({
              workspaceId: ctx.run.workspaceId,
              sessionId: started.sessionId,
              runId: started.runId
            });
          }
        }
        if (subtaskStatus.status === "running") {
          if (started.reused) {
            throw new Error(
              `subtask reused-child wait timed out after ${reusedWaitTimeoutMs ?? subtaskReusedWaitTimeoutMs()}ms; child may still be running and was not modified`
            );
          }
          throw new Error(`subtask did not reach terminal status: ${subtaskStatus.status}`);
        }

        const subtaskResult = await ctx.apiClient.getSubtaskResult({
          workspaceId: ctx.run.workspaceId,
          sessionId: started.sessionId,
          runId: started.runId
        });
        const result = {
          subtaskSessionId: started.sessionId,
          subtaskAgentId: parsed.agentId,
          subtaskAgentName: started.agentName,
          resultText: subtaskResult.resultText
        };
        if (subtaskStatus.status === "failed" || subtaskStatus.status === "cancelled") {
          const error = new Error(`subtask ${subtaskStatus.status}`) as Error & {
            subtaskSessionId?: string;
            subtaskResultText?: string;
          };
          error.subtaskSessionId = started.sessionId;
          error.subtaskResultText = typeof subtaskResult.resultText === "string" ? subtaskResult.resultText : undefined;
          throw error;
        }
        return result;
      }
      case "visual_analyze": {
        const pathsRaw = Array.isArray(args.paths) ? args.paths : [];
        if (pathsRaw.length === 0) {
          throw new Error("visual_analyze.paths must contain at least one file path");
        }
        const relativePaths = pathsRaw.map((item, index) => ensureSafeRelativePath(item, `visual_analyze.paths[${index}]`));
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        const files = await Promise.all(
          relativePaths.map((relativePath) => resolveVisualInputFile({ workspacePath: ctx.run.workspacePath, relativePath }))
        );

        const userInstruction = prompt || "Analyze these visual files in order and provide concise, practical findings in natural language.";
        const lines = [
          `You are analyzing ${files.length} visual file(s) from a coding workspace.`,
          "Use the input order as sequence and refer to them as 文件1, 文件2, ... in your response.",
          "Return plain natural language only."
        ];
        const parts: Array<Record<string, unknown>> = [
          {
            type: "text",
            text: `${lines.join("\n")}\n\nUser request:\n${userInstruction}`
          }
        ];
        for (const file of files) {
          parts.push({
            type: "file",
            data: file.bytes,
            mediaType: file.mediaType,
            filename: path.basename(file.relativePath)
          });
        }

        const chosen = ctx.profile.vision ?? {
          source: "agent_default_fallback" as const,
          provider: ctx.profile.provider,
          model: ctx.profile.model
        };
        const timeoutMs = Math.max(30_000, Math.floor(Number(ctx.profile.runtime.modelTotalTimeoutMs || 0)) || 120_000);
        const response = await this.generateSingleCallSummary({
          profile: { provider: chosen.provider, model: chosen.model },
          input: { workspaceId: ctx.run.workspaceId, messages: [{ role: "user", content: parts }], timeoutMs, abortSignal: ctx.signal }
        });
        return {
          text: response.text,
          files: files.map((item) => item.relativePath),
          source: chosen.source
        };
      }
      default:
        throw new Error(`unsupported tool: ${toolName}`);
    }
  }
}
import type { AgentApiSubtaskSession } from "@agent-workbench/shared/internal-contracts/agent-api";
