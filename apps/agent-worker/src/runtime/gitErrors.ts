import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { GitRepoNameSchema } from "@agent-workbench/shared/internal-contracts/agent-api";

export const GIT_ERROR_MESSAGES = {
  GIT_INPUT_INVALID: "Git requires an explicit registered repo, a non-empty string args array without NUL, and timeout in 1..3600 seconds.",
  GIT_TOOL_DISABLED: "Git is disabled for the current agent.",
  GIT_CANCELLED: "Git execution was cancelled before starting.",
  RUN_CONTEXT_INVALID: "The Git execution context is invalid.",
  RUN_NOT_EXECUTABLE: "The run is no longer executable.",
  WORKSPACE_DELETING: "The Workspace is being deleted.",
  REPO_NOT_AVAILABLE: "The selected repository is not currently registered.",
  REPO_PATH_INVALID: "The registered repository directory is unavailable or outside the Workspace.",
  CREDENTIAL_NOT_FOUND: "The repository's bound credential no longer exists.",
  CREDENTIAL_DECRYPT_FAILED: "The repository credential cannot be decrypted.",
  GIT_ENV_PREPARE_FAILED: "The repository Git environment could not be prepared.",
  GIT_ENV_RPC_FAILED: "The repository Git environment response is unavailable or invalid.",
  GIT_LEASE_EXPIRED: "The Git environment lease does not cover the command and settlement deadline.",
  GIT_OUTPUT_GUARD_FAILED: "The trusted Git output guard could not be prepared.",
  GIT_EXECUTION_PLATFORM_UNSUPPORTED: "Git requires verified Linux/POSIX process-group and directory-handle support.",
  GIT_NOT_AVAILABLE: "The Git executable is unavailable.",
  GIT_SPAWN_FAILED: "The Git process could not be started.",
  GIT_PROCESS_STOP_UNCONFIRMED: "The managed Git process group was not confirmed stopped. Its lease remains protected; maintenance may be required.",
  GIT_TOOL_FAILED: "Git tool processing or result writeback failed. Do not automatically repeat the command.",
} as const;

export type GitErrorCode = keyof typeof GIT_ERROR_MESSAGES;

const availableReposSchema = Type.Array(GitRepoNameSchema);
// Only locally constructed, validated errors carry model-visible repo details.
// Arbitrary exceptions and diagnostic snapshots cannot supply this metadata.
const availableReposByError = new WeakMap<object, readonly string[]>();

function formatGitError(code: GitErrorCode, availableRepos?: readonly string[]) {
  const summary = `${code}: ${GIT_ERROR_MESSAGES[code]}`;
  return availableRepos === undefined ? summary : `${summary}\navailableRepos: ${JSON.stringify(availableRepos)}`;
}

export class GitToolError extends Error {
  constructor(readonly code: GitErrorCode, availableRepos?: string[]) {
    const safeRepos = code === "REPO_NOT_AVAILABLE" && Value.Check(availableReposSchema, availableRepos)
      ? Object.freeze([...availableRepos]) : undefined;
    super(formatGitError(code, safeRepos));
    this.name = "GitToolError";
    if (safeRepos !== undefined) availableReposByError.set(this, safeRepos);
  }
}

/** Never copy an exception message, stack, cause, URL, or arbitrary error code. */
export function gitSafeErrorCode(error: unknown): GitErrorCode {
  try {
    const descriptor = error != null && (typeof error === "object" || typeof error === "function")
      ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(GIT_ERROR_MESSAGES, code)
      ? code as GitErrorCode : "GIT_TOOL_FAILED";
  } catch {
    return "GIT_TOOL_FAILED";
  }
}

export function gitSafeErrorText(error: unknown) {
  const code = gitSafeErrorCode(error);
  const availableRepos = code === "REPO_NOT_AVAILABLE" && error !== null && typeof error === "object"
    ? availableReposByError.get(error) : undefined;
  return formatGitError(code, availableRepos);
}
