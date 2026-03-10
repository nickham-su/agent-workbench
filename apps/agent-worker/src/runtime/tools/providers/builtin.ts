import fs from "node:fs/promises";
import path from "node:path";
import { runBashCommand } from "../../bash.js";
import { applyPreparedPatch, prepareApplyPatchTool } from "../../applyPatch.js";
import { getBashToolAppendix } from "../../bashTools.js";
import { runReadTool, runWriteTool } from "../../fileTools.js";
import { parseTodolistArgs, toTodolistResult } from "../../todolist.js";
import type { AvailableToolContext, ResolvedToolDefinition, ToolExecutionContext, ToolListContext, ToolProvider } from "../types.js";
import { isBuiltinToolName, type BuiltinToolName } from "../types.js";

const ENV_TIMEOUT_MS_MAX = 2_147_483_647;

type ParsedSubtaskArgs = {
  description: string;
  prompt: string;
  agentId: string;
  session: {
    mode: "new" | "existing" | "fork";
    sessionId?: string;
  };
};

function toRecord(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
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
    throw new Error("subtask.session.mode must be one of: new, existing, fork");
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

function toApplyPatchResult(prepared: Awaited<ReturnType<typeof prepareApplyPatchTool>>) {
  return {
    text: prepared.text,
    summary: prepared.summary,
    files: prepared.files
  };
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
    return ctx.profile.agent.tools.includes(toolName as BuiltinToolName);
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
        const bash = await runBashCommand({
          command,
          cwd,
          timeoutMs: Math.min(ENV_TIMEOUT_MS_MAX, (timeoutSeconds ?? 120) * 1000),
          maxOutputBytes: 512 * 1024,
          signal: ctx.signal
        });
        return {
          command,
          exitCode: bash.code,
          timedOut: bash.timedOut,
          outputLimitExceeded: bash.outputLimitExceeded,
          stdout: bash.stdout,
          stderr: bash.stderr
        };
      }
      case "read": {
        const filePath = requireNonEmptyStringArg(args.filePath, "read.filePath");
        const offset = parseOptionalPositiveIntegerArg(args.offset, "read.offset");
        const limit = parseOptionalPositiveIntegerArg(args.limit, "read.limit");
        return await runReadTool({
          workspacePath: ctx.run.workspacePath,
          filePath,
          offset,
          limit,
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
        let prepared: Awaited<ReturnType<typeof prepareApplyPatchTool>>;
        try {
          prepared = await prepareApplyPatchTool({
            workspacePath: ctx.run.workspacePath,
            patchText,
            signal: ctx.signal
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            message.startsWith("apply_patch verification failed:")
              ? message
              : `apply_patch verification failed: ${message}`
          );
        }
        await applyPreparedPatch({
          workspacePath: ctx.run.workspacePath,
          prepared,
          signal: ctx.signal
        });
        return toApplyPatchResult(prepared);
      }
      case "todolist": {
        const parsed = parseTodolistArgs(args);
        return toTodolistResult(parsed);
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
        const started = await ctx.apiClient.startSubtaskRun({
          workspaceId: ctx.run.workspaceId,
          parentSessionId: ctx.run.sessionId,
          parentRunId: ctx.run.runId,
          parentToolItemId: ctx.pendingTool.itemId,
          description: parsed.description,
          prompt: parsed.prompt,
          agentId: parsed.agentId,
          session: parsed.session
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
              subtaskSessionId: started.sessionId
            }
          }
        });

        await ctx.processNestedRun(
          {
            workspaceId: ctx.run.workspaceId,
            sessionId: started.sessionId,
            runId: started.runId,
            inputText: parsed.prompt,
            workspacePath: started.workspacePath
          },
          ctx.signal
        );

        const subtaskStatus = await ctx.apiClient.getSubtaskStatus({
          workspaceId: ctx.run.workspaceId,
          sessionId: started.sessionId,
          runId: started.runId
        });

        if (ctx.signal.aborted) {
          await ctx.apiClient.completeRun({
            workspaceId: ctx.run.workspaceId,
            sessionId: started.sessionId,
            runId: started.runId,
            status: "cancelled",
            updatedAt: ctx.nowMs()
          });
        } else if (subtaskStatus.status === "running") {
          throw new Error(`subtask did not reach terminal status: ${subtaskStatus.status}`);
        }

        const subtaskResult = await ctx.apiClient.getSubtaskResult({
          workspaceId: ctx.run.workspaceId,
          sessionId: started.sessionId,
          runId: started.runId
        });
        const result = {
          subtaskSessionId: started.sessionId,
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
      default:
        throw new Error(`unsupported tool: ${toolName}`);
    }
  }
}
