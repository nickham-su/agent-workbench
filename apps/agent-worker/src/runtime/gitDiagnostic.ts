import { Value } from "@sinclair/typebox/value";
import { GitRepoNameSchema, GitToolResultSchema, GIT_TOOL_MAX_TIMEOUT_SECONDS, type GitToolResult } from "@agent-workbench/shared/internal-contracts/agent-api";
import { gitSafeErrorCode } from "./gitErrors.js";

const executorResults = new WeakSet<object>();
/** Only the native executor may attest that output has passed its guard. */
export function registerGitDiagnosticResult(result: GitToolResult): GitToolResult {
  Object.freeze(result.warnings);
  Object.freeze(result);
  executorResults.add(result);
  return result;
}

export type GitDiagnosticProjection = {
  toolName: "git";
  repo: string | null;
  argsCount: number | null;
  timeout: number | null;
  stage?: string;
  code?: string;
  result?: GitToolResult;
};

function ownValue(value: unknown, key: string): unknown {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** The sole projection for Git's additional diagnostics, not normal tool-call history. */
export function projectGitDiagnostic(args: unknown, options: { stage?: string; error?: unknown; result?: unknown } = {}): GitDiagnosticProjection {
  const repo = ownValue(args, "repo");
  const argv = ownValue(args, "args");
  const timeout = ownValue(args, "timeout");
  const argsCount = Array.isArray(argv) ? ownValue(argv, "length") : undefined;
  const projection: GitDiagnosticProjection = {
    toolName: "git",
    repo: Value.Check(GitRepoNameSchema, repo) ? repo : null,
    argsCount: typeof argsCount === "number" && Number.isSafeInteger(argsCount) && argsCount >= 0 ? argsCount : null,
    timeout: typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 1 && timeout <= GIT_TOOL_MAX_TIMEOUT_SECONDS ? timeout : null,
  };
  if (options.stage && /^[a-z_]{1,80}$/.test(options.stage)) projection.stage = options.stage;
  if (options.error !== undefined) projection.code = gitSafeErrorCode(options.error);
  try {
    if (options.result && typeof options.result === "object" && executorResults.has(options.result) && Value.Check(GitToolResultSchema, options.result)) {
      // Schema validity alone cannot establish that stdout was guarded. Unknown
      // responses, partial errors and nested raw objects never become snapshots.
      projection.result = structuredClone(options.result);
    }
  } catch { /* An opaque value is never needed for a safe Git diagnostic. */ }
  return projection;
}

export function projectGitDiagnosticDetail(args: unknown, value: unknown, stage: string) {
  return projectGitDiagnostic(args, { stage, result: ownValue(value, "result") ?? ownValue(ownValue(value, "output"), "result") });
}

export function diagnosticToolRequest(toolName: string, toolCallId: string, args: unknown) {
  return toolName === "git"
    ? { toolName, toolCallId, diagnostic: projectGitDiagnostic(args) }
    : { toolName, toolCallId, args };
}

export function diagnosticToolArgs(toolName: string, args: unknown) {
  return toolName === "git" ? projectGitDiagnostic(args) : args;
}
